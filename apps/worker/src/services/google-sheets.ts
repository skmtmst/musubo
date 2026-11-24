import { jstDate as japanDate } from '@line-crm/shared';
import { logger, tracedFetch as fetch } from '@line-crm/shared/server';

/**
 *  第2段: Google Sheets への直接書き出し。
 *
 * - OAuth・トークン・再試行は services/google-business.ts の実装を使う。
 *   ここでは Sheets API の形（タブ・行の upsert）と同期の流れだけを持つ。
 * - 連携はLINE公式アカウントごとに1件。別のアカウントと出力先が重なる場合は友だちの同期を止める。
 * - データ種別ごとに1タブ・固定列。主キー列を読んで、ある行は上書き・
 *   無い行は末尾に足す（upsert）。増分は種別ごとのカーソルで進める。
 * - access token は保存しない。同期のたびに refresh_token から取り直す。
 * - 'running' の sync_runs 行は同時実行を防ぐ鍵。手動と定期が重なっても
 *   片方は始めない。30分動いていない running は失敗として畳む。
 */
import {
  decryptCredential,
  isAccountFeatureEnabled,
  type LineAccount,
} from '@line-crm/db';

import type { Env } from '../worker-env.js';
import {
  GoogleBusinessError,
  authorizedJson,
  refreshAccessToken,
  type FetchLike,
  type GoogleOAuthClient,
  type RequestOptions,
} from './google-business.js';
import { createFeatureJobGate } from './feature-enforcement.js';

export const GOOGLE_SHEETS_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'openid',
  'email',
] as const;

/**
 * 接続時に必ず許可されていないといけないスコープ。
 * `openid` / `email` は表示用なので必須にしない。
 */
export const GOOGLE_SHEETS_REQUIRED_SCOPES = ['https://www.googleapis.com/auth/spreadsheets'] as const;

const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';
const PAGE_SIZE = 500;
/** 書き込みと書き込みの間の待機。Sheets API の分あたり上限に余裕を持たせる。 */
const PACE_MS = 200;
/** 30分動いた形跡のない running は死んでいるとみなす。 */
const RUN_STALE_MS = 30 * 60 * 1000;
/** 手動実行が応答を待てる時間の目安。超えたら途中点を保存して partial で切る。 */
export const MANUAL_SYNC_BUDGET_MS = 25 * 1000;
export const SCHEDULED_SYNC_BUDGET_MS = 10 * 60 * 1000;

class SharedFriendsExportTarget extends Error {}

export type GoogleSheetsDataType = 'friends' | 'form_answers';
export const GOOGLE_SHEETS_DATA_TYPES: readonly GoogleSheetsDataType[] = [
  'friends',
  'form_answers',
];

export interface GoogleSheetsIntegrationRow {
  id: string;
  line_account_id: string;
  tenant_id: string | null;
  google_account_email: string | null;
  refresh_token_enc: string;
  status: 'pending_target' | 'connected' | 'expired';
  spreadsheet_id: string | null;
  spreadsheet_title: string | null;
  sync_cursor_json: string;
  last_synced_at: string | null;
  last_sync_status: 'ok' | 'partial' | 'error' | null;
  last_sync_error: string | null;
  consecutive_failures: number;
  connected_by_staff_id: string | null;
  connected_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SyncCursor {
  after: string;
  lastId: string;
}

interface SourceRow {
  key: string;
  values: (string | null)[];
  cursor: SyncCursor;
}

// ---------- スプレッドシート指定の解析 ----------

/**
 * 設定画面で貼る値（URL or 生ID）から spreadsheet ID を取り出す。
 * `docs.google.com/spreadsheets/d/<id>` または ID そのもの以外は弾く。
 */
export function parseSpreadsheetId(input: string): string | null {
  const value = input.trim();
  if (!value) return null;
  const fromUrl = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,80})(?:[/?#]|$)/.exec(value);
  if (fromUrl) return fromUrl[1] ?? null;
  if (/^[a-zA-Z0-9_-]{20,80}$/.test(value)) return value;
  return null;
}

// ---------- OAuthクライアント ----------

/**
 * Sheets 専用の OAuth クライアントが無い環境では、同じ Google プロジェクトの
 * Googleビジネス用クライアントを共用する。OAuthクライアントは「このアプリ」を表す
 * 資格情報で、実際に何を許可するかは認可のたびに渡すスコープ側で決まるため、
 * 用途ごとにクライアントを分けなくても要求する権限は変わらない。
 * 共用する場合でも、Google側にこのコールバックURLの登録は必要。
 * 専用クライアントを設定した環境ではそちらが優先される。
 */
export function sheetsOauthClient(
  env: Pick<
    Env['Bindings'],
    | 'GOOGLE_SHEETS_OAUTH_CLIENT_ID'
    | 'GOOGLE_SHEETS_OAUTH_CLIENT_SECRET'
    | 'GOOGLE_BUSINESS_OAUTH_CLIENT_ID'
    | 'GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET'
  >,
  redirectUri: string,
): GoogleOAuthClient | null {
  // IDとシークレットは必ず同じクライアントの組で使う。
  // 片方だけ設定された環境で別クライアントの相方と混ざると認可が必ず失敗するため。
  const pairs: Array<[string | undefined, string | undefined]> = [
    [env.GOOGLE_SHEETS_OAUTH_CLIENT_ID, env.GOOGLE_SHEETS_OAUTH_CLIENT_SECRET],
    [env.GOOGLE_BUSINESS_OAUTH_CLIENT_ID, env.GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET],
  ];
  for (const [rawId, rawSecret] of pairs) {
    const clientId = rawId?.trim();
    const clientSecret = rawSecret?.trim();
    if (clientId && clientSecret) return { clientId, clientSecret, redirectUri };
  }
  return null;
}

// ---------- データ種別の定義（固定マッピング） ----------

interface DataSource {
  type: GoogleSheetsDataType;
  sheetTitle: string;
  header: string[];
  fetchPage(db: D1Database, lineAccountId: string, cursor: SyncCursor | null): Promise<SourceRow[]>;
}

const FRIENDS_HEADER = ['LINEユーザーID', 'LINE表示名', '本名', 'システム表示名', 'フォロー状態', '登録日', '更新日'];
const ANSWERS_HEADER = ['回答ID', 'フォーム名', '友だち表示名', 'LINEユーザーID', '回答日時', '回答内容'];

function changedAfterClause(alias: string, column: string): string {
  return `(${alias}.${column} > ? OR (${alias}.${column} = ? AND ${alias}.id > ?))`;
}

const friendsSource: DataSource = {
  type: 'friends',
  sheetTitle: '友だち',
  header: FRIENDS_HEADER,
  async fetchPage(db, lineAccountId, cursor) {
    const binds: unknown[] = [lineAccountId];
    let where = 'f.line_account_id = ?';
    if (cursor) {
      where += ` AND ${changedAfterClause('f', 'updated_at')}`;
      binds.push(cursor.after, cursor.after, cursor.lastId);
    }
    const rows = await db.prepare(
      `SELECT f.id, f.line_platform_user_id AS line_user_id, f.display_name, f.real_name, f.system_display_name,
              f.is_following, f.created_at, f.updated_at
         FROM friends f
        WHERE ${where}
        ORDER BY f.updated_at, f.id
        LIMIT ${PAGE_SIZE}`,
    ).bind(...binds).all<{
      id: string; line_user_id: string; display_name: string | null;
      real_name: string | null; system_display_name: string | null;
      is_following: number; created_at: string; updated_at: string;
    }>();
    return rows.results.map((row) => ({
      key: row.line_user_id,
      values: [
        row.line_user_id,
        row.display_name,
        row.real_name,
        row.system_display_name,
        row.is_following === 1 ? 'フォロー中' : 'ブロック',
        row.created_at,
        row.updated_at,
      ],
      cursor: { after: row.updated_at, lastId: row.id },
    }));
  },
};

const formAnswersSource: DataSource = {
  type: 'form_answers',
  sheetTitle: '回答',
  header: ANSWERS_HEADER,
  async fetchPage(db, lineAccountId, cursor) {
    const binds: unknown[] = [lineAccountId, lineAccountId];
    /*
     * フォームが複数アカウントへ共有されていても、書き出すのはこの
     * アカウントの友だちの回答だけ。管理画面の回答一覧と同じ
     * 所属条件（回答した友だちの所属アカウント）に揃える。
     * 友だちが消えて所属が分からない回答は、どのアカウントにも出さない。
     */
    let where = 'fa.line_account_id = ? AND fr.line_account_id = ?';
    if (cursor) {
      where += ` AND ${changedAfterClause('s', 'created_at')}`;
      binds.push(cursor.after, cursor.after, cursor.lastId);
    }
    const rows = await db.prepare(
      `SELECT s.id, s.created_at, s.data, fm.name AS form_name,
              fr.display_name AS friend_display_name, fr.line_platform_user_id AS line_user_id
         FROM form_submissions s
         JOIN forms fm ON fm.id = s.form_id
         JOIN form_accounts fa ON fa.form_id = fm.id
         LEFT JOIN friends fr ON fr.id = s.friend_id
        WHERE ${where}
        ORDER BY s.created_at, s.id
        LIMIT ${PAGE_SIZE}`,
    ).bind(...binds).all<{
      id: string; created_at: string; data: string; form_name: string;
      friend_display_name: string | null; line_user_id: string | null;
    }>();
    return rows.results.map((row) => ({
      key: row.id,
      values: [
        row.id,
        row.form_name,
        row.friend_display_name,
        row.line_user_id,
        row.created_at,
        row.data,
      ],
      cursor: { after: row.created_at, lastId: row.id },
    }));
  },
};

const DATA_SOURCES: Record<GoogleSheetsDataType, DataSource> = {
  friends: friendsSource,
  form_answers: formAnswersSource,
};

// ---------- Sheets API ----------

const enc = encodeURIComponent;

interface SheetsMeta {
  sheets?: Array<{ properties?: { title?: string } }>;
}

async function ensureTab(
  options: RequestOptions,
  spreadsheetId: string,
  source: DataSource,
): Promise<void> {
  const meta = await authorizedJson<SheetsMeta>(
    options,
    `${SHEETS_API}/${enc(spreadsheetId)}?fields=sheets.properties`,
  );
  if (!meta.sheets?.some((sheet) => sheet.properties?.title === source.sheetTitle)) {
    await authorizedJson(
      options,
      `${SHEETS_API}/${enc(spreadsheetId)}:batchUpdate`,
      { method: 'POST', body: { requests: [{ addSheet: { properties: { title: source.sheetTitle } } }] } },
    );
  }
  const head = await authorizedJson<{ values?: string[][] }>(
    options,
    `${SHEETS_API}/${enc(spreadsheetId)}/values/${enc(`'${source.sheetTitle}'!A1:Z1`)}`,
  );
  if (!head.values?.[0]?.length) {
    await authorizedJson(
      options,
      `${SHEETS_API}/${enc(spreadsheetId)}/values:batchUpdate`,
      {
        method: 'POST',
        body: {
          valueInputOption: 'RAW',
          data: [{ range: `'${source.sheetTitle}'!A1`, values: [source.header] }],
        },
      },
    );
  }
}

/** キー列（A列、2行目以降）を読み、値 → 行番号（1始まり）の対応表を返す。 */
async function readKeyColumn(
  options: RequestOptions,
  spreadsheetId: string,
  sheetTitle: string,
): Promise<Map<string, number>> {
  const body = await authorizedJson<{ values?: string[][] }>(
    options,
    `${SHEETS_API}/${enc(spreadsheetId)}/values/${enc(`'${sheetTitle}'!A2:A`)}?fields=values`,
  );
  const map = new Map<string, number>();
  (body.values ?? []).forEach((row, index) => {
    const key = row[0];
    if (typeof key === 'string' && key) map.set(key, index + 2);
  });
  return map;
}

/** 既存行の上書き（1回の values:batchUpdate にまとめる）。 */
async function updateRows(
  options: RequestOptions,
  spreadsheetId: string,
  sheetTitle: string,
  rows: Array<{ rowIndex: number; values: (string | null)[] }>,
): Promise<void> {
  if (rows.length === 0) return;
  await authorizedJson(
    options,
    `${SHEETS_API}/${enc(spreadsheetId)}/values:batchUpdate`,
    {
      method: 'POST',
      body: {
        valueInputOption: 'RAW',
        data: rows.map((row) => ({
          range: `'${sheetTitle}'!A${row.rowIndex}`,
          values: [row.values],
        })),
      },
    },
  );
}

async function appendRows(
  options: RequestOptions,
  spreadsheetId: string,
  sheetTitle: string,
  rows: (string | null)[][],
): Promise<void> {
  if (rows.length === 0) return;
  /*
   * append は「行を足す」操作なので自動再試行しない。
   * Google が保存した直後に応答だけ落ちたとき、そのまま再送すると
   * 同じ行が二度並ぶ。送達不明のまま失敗扱いにし、次の同期が
   * キー列を読み直して既に入った分を上書きへ回すので欠落しない。
   */
  await authorizedJson(
    options,
    `${SHEETS_API}/${enc(spreadsheetId)}/values/${enc(`'${sheetTitle}'!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: { values: rows }, retry: false },
  );
}

/** 接続検証用：スプレッドシートのタイトルを取る（アクセス可否の確認を兼ねる）。 */
export async function fetchSpreadsheetTitle(
  options: RequestOptions,
  spreadsheetId: string,
): Promise<string | null> {
  const meta = await authorizedJson<{ properties?: { title?: string } }>(
    options,
    `${SHEETS_API}/${enc(spreadsheetId)}?fields=properties.title`,
  );
  return meta.properties?.title ?? null;
}

// ---------- アクセストークン ----------

export async function sheetsAccessToken(
  env: Env['Bindings'],
  integration: GoogleSheetsIntegrationRow,
  fetchFn: FetchLike,
): Promise<string> {
  const key = env.LINE_CREDENTIAL_ENCRYPTION_KEY;
  const refreshToken = await decryptCredential(integration.refresh_token_enc, key);
  const client = sheetsOauthClient(env, 'https://localhost/unused');
  if (!client) throw new GoogleBusinessError('unavailable', null, 'google_sheets_oauth_not_configured');
  const tokens = await refreshAccessToken({
    client,
    refreshToken,
    fetch: fetchFn,
    requiredScopes: GOOGLE_SHEETS_REQUIRED_SCOPES,
  });
  return tokens.accessToken;
}

// ---------- カーソル ----------

/**
 * 再開点は出力先（スプレッドシートID）ごとに持つ。
 * `{ "targets": { "<spreadsheetId>": { "friends": {...}, "form_answers": {...} } } }`。
 *
 * 出力先を切り替えた直後の新しいシートでは再開点が無い＝全件を書き出す
 * （キー列で upsert するので行は重ならない）。切り替え前に走っていた同期が
 * あとからカーソルを書いても旧出力先の欄に置かれ、新しい出力先の
 * 再開点を汚さない。切り替え前の古い形（種別名が直上のキー）は、どの
 * 出力先のものか確かめられないため信用しない。
 */
interface SyncCursorStore {
  targets?: Record<string, Record<string, SyncCursor | undefined> | undefined>;
}

export function readSyncCursor(integration: GoogleSheetsIntegrationRow, type: GoogleSheetsDataType): SyncCursor | null {
  const spreadsheetId = integration.spreadsheet_id;
  if (!spreadsheetId) return null;
  try {
    const parsed = JSON.parse(integration.sync_cursor_json || '{}') as SyncCursorStore;
    const cursor = parsed.targets?.[spreadsheetId]?.[type];
    if (cursor && typeof cursor.after === 'string' && typeof cursor.lastId === 'string') return cursor;
  } catch {
    // 壊れたカーソルは全件やり直し（upsert なので再実行しても安全）。
  }
  return null;
}

async function writeSyncCursor(
  db: D1Database,
  integration: GoogleSheetsIntegrationRow,
  type: GoogleSheetsDataType,
  cursor: SyncCursor,
  now: string,
): Promise<void> {
  let parsed: SyncCursorStore = {};
  try {
    const candidate = JSON.parse(integration.sync_cursor_json || '{}') as SyncCursorStore;
    if (candidate && typeof candidate === 'object' && candidate.targets && typeof candidate.targets === 'object') {
      parsed = candidate;
    }
  } catch {
    // 上と同じく、壊れていれば作り直す。
  }
  const spreadsheetId = integration.spreadsheet_id;
  if (!spreadsheetId) return;
  const targets = { ...(parsed.targets ?? {}) };
  targets[spreadsheetId] = { ...(targets[spreadsheetId] ?? {}), [type]: cursor };
  parsed = { targets };
  await db.prepare(
    'UPDATE google_sheets_integrations SET sync_cursor_json = ?, updated_at = ? WHERE id = ?',
  ).bind(JSON.stringify(parsed), now, integration.id).run();
  integration.sync_cursor_json = JSON.stringify(parsed);
}

// ---------- 同期 ----------

export type SyncRunStatus = 'ok' | 'partial' | 'error' | 'already_running' | 'skipped';

export interface SyncOneResult {
  dataType: GoogleSheetsDataType;
  status: SyncRunStatus;
  rowsWritten: number;
  error?: string;
}

function jstDate(iso: string): string {
  return japanDate(new Date(iso));
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 死んでいる running 行を畳み、それでも生きている running が残れば null。
 * 手動・定期・他プロセスの重複をここで1回だけ断る。
 *
 * 空を読んでから INSERT する並びだと、同時に始まった2処理がどちらも
 * 空を見て実行権を持ってしまう。先に自分の行を入れ、連携内で
 * もっとも先に入った running 行だけを勝者にする。負けた側は自分の行を
 * 消して null を返すので、履歴に「失敗した実行」が勝手に増えない。
 */
export async function acquireSyncRun(
  db: D1Database,
  integrationId: string,
  type: GoogleSheetsDataType,
  input: {
    kind: 'manual' | 'scheduled';
    now: string;
    /** 定期実行の所属日（JSTの日付）。同日の定期実行はこれで絞る。 */
    runDate?: string | null;
    /** この実行が書き出す先。履歴でどの出力先への結果か分かるようにする。 */
    spreadsheetId?: string | null;
  },
): Promise<{ id: string } | null> {
  const staleBefore = new Date(Date.parse(input.now) - RUN_STALE_MS).toISOString();
  await db.prepare(
    `UPDATE google_sheets_sync_runs
        SET status = 'error', error = 'stale_run', finished_at = ?
      WHERE integration_id = ? AND status = 'running' AND started_at < ?`,
  ).bind(input.now, integrationId, staleBefore).run();
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT INTO google_sheets_sync_runs
       (id, integration_id, kind, data_type, status, started_at, run_date, spreadsheet_id)
     VALUES (?, ?, ?, ?, 'running', ?, ?, ?)`,
  ).bind(id, integrationId, input.kind, type, input.now, input.runDate ?? null, input.spreadsheetId ?? null).run();
  const winner = await db.prepare(
    `SELECT id FROM google_sheets_sync_runs
      WHERE integration_id = ? AND status = 'running' ORDER BY rowid LIMIT 1`,
  ).bind(integrationId).first<{ id: string }>();
  if (winner?.id !== id) {
    await db.prepare('DELETE FROM google_sheets_sync_runs WHERE id = ?').bind(id).run();
    return null;
  }
  return { id };
}

async function finishRun(
  db: D1Database,
  runId: string,
  input: { status: 'ok' | 'partial' | 'error'; rowsWritten: number; error?: string; cursor?: SyncCursor | null; now: string },
): Promise<void> {
  await db.prepare(
    `UPDATE google_sheets_sync_runs
        SET status = ?, rows_written = ?, error = ?, cursor_json = ?, finished_at = ?
      WHERE id = ?`,
  ).bind(
    input.status,
    input.rowsWritten,
    input.error ?? null,
    input.cursor ? JSON.stringify(input.cursor) : null,
    input.now,
    runId,
  ).run();
}

/**
 * 1データ種別の同期本体。カーソル以降をページ単位で読み、
 * 既存行は update・新しい行は append で upsert する。
 * ページごとにカーソルを保存するので、途中で止まっても次回は続きから。
 */
export async function syncOneDataType(
  env: Env['Bindings'],
  integration: GoogleSheetsIntegrationRow,
  type: GoogleSheetsDataType,
  input: {
    kind: 'manual' | 'scheduled';
    now: string;
    fetch?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    deadlineMs?: number;
  },
): Promise<SyncOneResult> {
  const db = env.DB;
  const fetchFn = input.fetch ?? fetch;
  const sleep = input.sleep ?? defaultSleep;
  const source = DATA_SOURCES[type];
  const run = await acquireSyncRun(db, integration.id, type, {
    kind: input.kind,
    now: input.now,
    runDate: input.kind === 'scheduled' ? jstDate(input.now) : null,
    spreadsheetId: integration.spreadsheet_id,
  });
  if (!run) return { dataType: type, status: 'already_running', rowsWritten: 0 };

  let rowsWritten = 0;
  let cursor = readSyncCursor(integration, type);
  try {
    const spreadsheetId = integration.spreadsheet_id;
    if (!spreadsheetId) throw new GoogleBusinessError('invalid_request', null, 'no_spreadsheet_target');
    // 友だちタブの既存行はLINEユーザーIDで識別する。別アカウントの行を上書きしない。
    if (type === 'friends' && await db.prepare(`SELECT 1 FROM google_sheets_integrations
      WHERE spreadsheet_id = ? AND line_account_id <> ? LIMIT 1`)
      .bind(spreadsheetId, integration.line_account_id).first()) {
      throw new SharedFriendsExportTarget();
    }
    const accessToken = await sheetsAccessToken(env, integration, fetchFn);
    const options: RequestOptions = { fetch: fetchFn, accessToken, sleep };
    await ensureTab(options, spreadsheetId, source);
    await sleep(PACE_MS);
    const keys = await readKeyColumn(options, spreadsheetId, source.sheetTitle);

    let deadlineHit = false;
    for (;;) {
      const page = await source.fetchPage(db, integration.line_account_id, cursor);
      if (page.length === 0) break;
      const updates: Array<{ rowIndex: number; values: (string | null)[] }> = [];
      const appends: (string | null)[][] = [];
      for (const row of page) {
        const rowIndex = keys.get(row.key);
        if (rowIndex !== undefined) {
          updates.push({ rowIndex, values: row.values });
        } else {
          appends.push(row.values);
          // このrunの中で同じキーがまた出てきたとき、新規行のままだと二重行になる。
          // append した行は「末尾に置いた」として対応表にも足しておく。
          keys.set(row.key, keys.size + 2);
        }
      }
      await updateRows(options, spreadsheetId, source.sheetTitle, updates);
      await appendRows(options, spreadsheetId, source.sheetTitle, appends);
      await sleep(PACE_MS);
      rowsWritten += page.length;
      cursor = page[page.length - 1]!.cursor;
      await writeSyncCursor(db, integration, type, cursor, input.now);
      if (input.deadlineMs !== undefined && Date.now() + PAGE_SIZE * 2 > input.deadlineMs) {
        deadlineHit = true;
        break;
      }
    }

    const status = deadlineHit ? 'partial' : 'ok';
    await finishRun(db, run.id, { status, rowsWritten, cursor, now: new Date().toISOString() });
    return { dataType: type, status, rowsWritten };
  } catch (error) {
    const kind = error instanceof SharedFriendsExportTarget ? 'friends_target_shared'
      : error instanceof GoogleBusinessError ? error.kind : 'unknown';
    await finishRun(db, run.id, {
      status: rowsWritten > 0 ? 'partial' : 'error',
      rowsWritten,
      error: kind,
      cursor,
      now: new Date().toISOString(),
    });
    if (error instanceof GoogleBusinessError && error.kind === 'auth_expired') {
      await db.prepare(
        `UPDATE google_sheets_integrations
            SET status = 'expired', last_sync_error = 'auth_expired', updated_at = ?
          WHERE id = ?`,
      ).bind(new Date().toISOString(), integration.id).run();
      integration.status = 'expired';
    }
    return { dataType: type, status: rowsWritten > 0 ? 'partial' : 'error', rowsWritten, error: kind };
  }
}

/**
 * 連携1件の全データ種別を順に同期し、連携側の同期結果カウンタを更新する。
 * 手動・定期のどちらからも呼ぶ。戻り値は種別ごとの結果。
 */
export async function syncGoogleSheetsIntegration(
  env: Env['Bindings'],
  integration: GoogleSheetsIntegrationRow,
  input: {
    kind: 'manual' | 'scheduled';
    now: string;
    fetch?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    deadlineMs?: number;
  },
): Promise<SyncOneResult[]> {
  const db = env.DB;
  const results: SyncOneResult[] = [];
  for (const type of GOOGLE_SHEETS_DATA_TYPES) {
    results.push(await syncOneDataType(env, integration, type, input));
    // 要再接続へ落ちたら残りの種別は試さない。
    if (integration.status === 'expired') break;
  }
  const ok = results.filter((r) => r.status === 'ok').length;
  const partial = results.filter((r) => r.status === 'partial').length;
  const failed = results.filter((r) => r.status === 'error').length;
  const total = ok + partial + failed;
  // 全部 already_running（別の同期が走っている）なら、何も書かずに終わる。
  // ここで連携行を 'ok' にすると、実際には動いていないのに「前回の同期：成功」
  // と表示され、失敗カウンタまでリセットされてしまう。
  if (total === 0) return results;
  const status: 'ok' | 'partial' | 'error' =
    failed === total && total > 0 ? 'error' : partial > 0 || failed > 0 ? 'partial' : 'ok';
  const now = new Date().toISOString();
  await db.prepare(
    `UPDATE google_sheets_integrations
        SET last_synced_at = ?, last_sync_status = ?, last_sync_error = ?,
            consecutive_failures = ?, updated_at = ?
      WHERE id = ?`,
  ).bind(
    now,
    status,
    status === 'ok' ? null : results.find((r) => r.error)?.error ?? 'partial',
    status === 'ok' ? 0 : integration.consecutive_failures + 1,
    now,
    integration.id,
  ).run();
  return results;
}

/**
 * 定期実行（cron）。その日(JST)の scheduled 実行がまだ無い連携を全部回す。
 * 機能「external_integrations」がオフのアカウントは gate で止める。
 */
export async function processDueGoogleSheetsSyncs(
  env: Env['Bindings'],
  input: { now: string; fetch?: FetchLike; sleep?: (ms: number) => Promise<void> },
): Promise<{ synced: number; skipped: number; failed: number }> {
  const db = env.DB;
  const today = jstDate(input.now);
  const gate = createFeatureJobGate();
  const integrations = await db.prepare(
    `SELECT * FROM google_sheets_integrations
      WHERE status = 'connected' AND spreadsheet_id IS NOT NULL
      ORDER BY line_account_id`,
  ).all<GoogleSheetsIntegrationRow>();

  let synced = 0;
  let skipped = 0;
  let failed = 0;
  for (const integration of integrations.results) {
    try {
      if (!await gate.canRun(db, integration.line_account_id, 'external_integrations', 'google sheets sync')) {
        skipped += 1;
        continue;
      }
      /*
       * 実行日は日本時間で持つ。started_at のUTC日付と比べると、
       * JSTの0時〜9時に走った分と同日の9時以降の分が別日扱いになり、
       * 同じJST日に定期同期が二度走っていた。
       * 出力先も条件に入れる。出力先を変えた日に、変える前のシートへの
       * 定期実行が残っていても、新しい出力先への初回実行を止めない。
       * run_date が NULL の古い行は判定に使わない（導入前の行は一度だけ
       * 同日の再実行を許すが、同じ行を二度書き込むわけではない）。
       */
      const already = await db.prepare(
        `SELECT id FROM google_sheets_sync_runs
          WHERE integration_id = ? AND kind = 'scheduled'
            AND run_date = ? AND spreadsheet_id = ? LIMIT 1`,
      ).bind(integration.id, today, integration.spreadsheet_id).first<{ id: string }>();
      if (already) {
        skipped += 1;
        continue;
      }
      const results = await syncGoogleSheetsIntegration(env, integration, {
        kind: 'scheduled',
        now: input.now,
        fetch: input.fetch,
        sleep: input.sleep,
        deadlineMs: Date.now() + SCHEDULED_SYNC_BUDGET_MS,
      });
      if (results.some((r) => r.status === 'error' || r.status === 'partial')) {
        failed += 1;
      } else {
        synced += 1;
      }
    } catch (error) {
      failed += 1;
      // 詳細メッセージは応答内容を含み得るので、種別名だけを記録する。
      logger.error("google_sheets.sync_failed");
    }
  }
  return { synced, skipped, failed };
}
