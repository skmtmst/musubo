import { logger } from '@line-crm/shared/server';
import {
  getMediaUsageMatchTokenMap,
  getMediaUsageMatchTokens,
  getMediaUsageScanState,
  recordMediaUsage,
  recordMediaUsages,
  pruneStaleMediaUsages,
  pruneStaleMediaUsagesBatch,
  saveMediaUsageScanState,
  type MediaRefKind,
} from '@line-crm/db';

import { createFeatureJobGate } from '../../services/feature-enforcement.js';

/**
 * メディアの使用台帳の欠損を補修する。
 *
 * 画像を消す前に「5か所で使われています」と出すための表を作る。
 * 日常の作成・更新・参照解除は保存と同じ原子処理で台帳へ反映する。
 * ここは旧データや一時的な欠損を後から直すための補修経路である。
 *
 * 走査した時点の情報でしかない。それでも「何も分からないまま消す」より
 * はるかにましだ、という判断で入れている。画面にもその旨を書いてある。
 */

/** どのテーブルの、どの列を見るか。 */
const SOURCES: Array<{ refKind: MediaRefKind; table: string; idColumn: string; columns: string[]; mediaIdMatch?: boolean; activeOnly?: boolean }> = [
  {
    refKind: 'template',
    table: 'templates',
    idColumn: 'id',
    columns: ['message_content', 'draft_message_content'],
  },
  {
    refKind: 'broadcast',
    table: 'broadcasts',
    idColumn: 'id',
    columns: ['message_content', 'message_bubbles_json'],
  },
  // 旧 rich_menus 表は存在しない。LINEへ送る実画像はページのR2キーで持つ。
  { refKind: 'rich_menu', table: 'rich_menu_pages', idColumn: 'id', columns: ['image_r2_key'] },
  {
    refKind: 'scenario_step',
    table: 'scenario_steps',
    idColumn: 'id',
    columns: ['message_content', 'message_bubbles_json'],
  },
  { refKind: 'nen_column', table: 'nen_columns', idColumn: 'id', columns: ['image_url'] },
  { refKind: 'event', table: 'events', idColumn: 'id', columns: ['image_url', 'og_image_url'] },
  { refKind: 'webinar', table: 'webinars', idColumn: 'id', columns: ['video_prefix'] },
  { refKind: 'booking_menu', table: 'menus', idColumn: 'id', columns: ['photo_media_id'], mediaIdMatch: true, activeOnly: true },
  { refKind: 'booking_staff', table: 'staff', idColumn: 'id', columns: ['photo_media_id'], mediaIdMatch: true, activeOnly: true },
  { refKind: 'booking_settings', table: 'booking_settings', idColumn: 'id', columns: ['store_photo_media_id', 'store_photo_interior_media_id', 'store_photo_waiting_media_id'], mediaIdMatch: true },
  { refKind: 'form', table: 'forms', idColumn: 'id', columns: ['layout', 'published_layout'] },
];

/** 店の6種類は同じテンプレート参照として点検する。 */
function sourceTable(source: typeof SOURCES[number]): string {
  if (source.refKind === 'form') return `(SELECT f.id,f.layout,v.layout AS published_layout FROM forms f
    LEFT JOIN form_versions v ON v.id=f.current_published_version_id AND v.form_id=f.id)`;
  if (source.activeOnly) return `(SELECT id,${source.columns.join(',')} FROM ${source.table} WHERE deleted_at IS NULL)`;
  if (source.refKind !== 'template') return source.table;
  return `(SELECT id, message_content, draft_message_content FROM templates
    UNION ALL SELECT id, payload_json AS message_content,
      draft_payload_json AS draft_message_content FROM broadcast_message_assets)`;
}

export interface ScanResult {
  scanned: number;
  matched: number;
  pruned: number;
  source?: MediaRefKind;
  sourceRows?: number;
  cycleCompleted?: boolean;
  /** 表そのものが無くて読めなかった読み口。空ならすべての使用先読めた。 */
  skippedTables?: string[];
}

type MediaToScan = { id: string; r2_key: string };

const MAX_SOURCE_ROWS = 4_000;
const MAX_USAGE_WRITES = 4_000;
const MAX_PRUNE_ROWS = 1_000;
/** LIKEのbind数が上限を超えないよう、1問い合わせのトークン数を絞る。 */
const MATCH_TOKEN_CHUNK = 24;

function isMissingSourceTable(error: unknown, table: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('no such table') && message.includes(table);
}

/**
 * メディアを指す本文中の文字列。
 *
 * 固定参照は版ごとのr2_key（旧版を指すものも使用中）、ライブ参照は
 * メディアIDの公開パス `/media/<id>/content`。どちらもr2_key基準の
 * 走査と同じ LIKE 照合で拾えるよう、トークンとしてまとめて渡す。
 */
function usageMatchTokens(item: MediaToScan, versionTokens: string[]): string[] {
  return [...new Set([item.r2_key, ...versionTokens])].filter((token) => token.length > 0);
}

async function findMatches(
  db: D1Database,
  tokens: string[],
  mediaId: string,
): Promise<{
  matches: Array<{ refKind: MediaRefKind; refId: string }>;
  /** 表そのものが無くて読めなかった読み口。 */
  skippedTables: string[];
}> {
  const matches: Array<{ refKind: MediaRefKind; refId: string }> = [];
  const skippedTables: string[] = [];
  const seen = new Set<string>();
  for (const source of SOURCES) {
    try {
      const sourceTokens = source.mediaIdMatch ? [mediaId] : source.refKind === 'form' ? [...tokens, mediaId] : tokens;
      for (let index = 0; index < sourceTokens.length; index += MATCH_TOKEN_CHUNK) {
        const chunk = sourceTokens.slice(index, index + MATCH_TOKEN_CHUNK);
        // LIKE '%...%' だと、R2キーやライブURLのような長いトークンでD1が
        // 「LIKE or GLOB pattern too complex」を返して全読み口が503になる
        // （staging実測：85文字のR2キーで発生、D1側のLIKEパターン長の壁は50文字）。
        // ワイルドカードを使わない単純な部分一致なので instr に替える。
        // 副作用として、トークンに %・_ が含まれていても誤ってワイルドカード
        // として扱われず、検索対象が意図せず広がるのを防ぐ。
        const conditions = source.columns
          .flatMap((col) => chunk.map(() => source.mediaIdMatch ? `${col} = ?` : `instr(${col}, ?) > 0`))
          .join(' OR ');
        const binds = source.columns.flatMap(() => chunk.map((token) => token));
        const rows = await db
          .prepare(
            `SELECT ${source.idColumn} AS ref_id FROM ${sourceTable(source)} WHERE ${conditions}`,
          )
          .bind(...binds)
          .all<{ ref_id: string }>();
        for (const row of rows.results) {
          const key = `${source.refKind}:${row.ref_id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          matches.push({ refKind: source.refKind, refId: row.ref_id });
        }
      }
    } catch (err) {
      // 表そのものが無い読み口だけ飛ばす。全部を例外にすると、どの画像でも
      // 取得が失敗し、読み直しても直らない。一時的なD1障害は
      // 例外のままにして、0件と偽らない。
      if (!isMissingSourceTable(err, source.table)
        && !(source.refKind === 'template' && isMissingSourceTable(err, 'broadcast_message_assets'))) throw err;
      logger.error("services_media_usage_scan_failed");
      skippedTables.push(source.table);
    }
  }
  return { matches, skippedTables };
}

/**
 * 削除確認のため、1件だけを厳密に走査する。
 *
 * 定期走査と違い、1つでも読み口が失敗したら例外にする。途中まで読めた結果を
 * 「使用先0件」にして削除させないため、全問い合わせの成功後にだけ記録を更新する。
 */
export async function scanSingleMediaUsage(
  db: D1Database,
  now: string,
  item: MediaToScan,
): Promise<ScanResult> {
  // 版の表が無い環境では旧版の固定参照まで拾えない。現行キーとライブ参照
  // だけでも走査は続け、その読み残しを呼び出し側へ返す。
  let versionTokens: string[] = [];
  const skippedTables: string[] = [];
  try {
    versionTokens = await getMediaUsageMatchTokens(db, item.id);
  } catch (err) {
    if (!isMissingSourceTable(err, 'media_versions')) throw err;
    logger.error("services_media_usage_scan_failed");
    skippedTables.push('media_versions');
  }
  const found = await findMatches(db, usageMatchTokens(item, versionTokens), item.id);
  skippedTables.push(...found.skippedTables);
  for (const match of found.matches) {
    await recordMediaUsage(db, {
      mediaId: item.id,
      refKind: match.refKind,
      refId: match.refId,
    });
  }
  /*
   * 読み残しがあるときは古い記録を整理しない。読めなかった読み口の使用先を
   * 消すと、使われているのに0件と偽って削除させてしまう。見つけた使用先の
   * 記録（足す側）は安全なので続ける。
   */
  const pruned = skippedTables.length === 0
    ? await pruneStaleMediaUsages(db, now, [item.id])
    : 0;
  return { scanned: 1, matched: found.matches.length, pruned, skippedTables };
}

/**
 * R2のキーで探す。
 *
 * URLではなくキー（media/xxxx.png）で探すのは、同じファイルが
 * 違うドメインのURLで書かれていることがあるため。キーは1つしかない。
 */
export async function scanMediaUsage(
  db: D1Database,
  now: string,
  opts: { limit?: number; sourceRowLimit?: number } = {},
): Promise<ScanResult> {
  const state = await getMediaUsageScanState(db, now);
  const media = await db
    .prepare(
      `SELECT id, r2_key, line_account_id FROM media
        WHERE created_at <= ?
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .bind(state.cycleStartedAt, opts.limit ?? 500)
    .all<{ id: string; r2_key: string; line_account_id: string | null }>();
  // 機能オフのアカウントの素材は走査も整理もしない。再オンで再開する。
  const gate = createFeatureJobGate();
  const enabledMedia = [];
  for (const item of media.results) {
    if (await gate.canRun(db, item.line_account_id, 'media', 'media usage scan')) {
      enabledMedia.push(item);
    }
  }
  if (enabledMedia.length === 0) return { scanned: 0, matched: 0, pruned: 0 };
  media.results = enabledMedia;

  const stateIsValid = state.sourceIndex >= 0 && state.sourceIndex <= SOURCES.length;
  const sourceIndex = stateIsValid ? state.sourceIndex : 0;
  const lastRefId = stateIsValid ? state.lastRefId : '';

  // 参照走査と古い記録の整理を同じcronへ載せると、整理件数分だけ上限を超える。
  // すべての使用先を読み終えた次のcronから、整理だけを上限付きで続ける。
  if (sourceIndex === SOURCES.length) {
    const pruned = await pruneStaleMediaUsagesBatch(
      db,
      state.cycleStartedAt,
      media.results.map((item) => item.id),
      MAX_PRUNE_ROWS,
    );
    const cycleCompleted = pruned < MAX_PRUNE_ROWS;
    await saveMediaUsageScanState(db, cycleCompleted ? {
      sourceIndex: 0,
      lastRefId: '',
      cycleStartedAt: now,
    } : {
      ...state,
      sourceIndex: SOURCES.length,
      lastRefId: '',
    }, now);
    return {
      scanned: media.results.length,
      matched: 0,
      pruned,
      sourceRows: 0,
      cycleCompleted,
    };
  }

  const source = SOURCES[sourceIndex];
  // 固定参照の版r2_key（旧版も）とライブ参照パスをメディアごとの
  // 照合トークンとしてまとめて取る。
  const tokenMap = await getMediaUsageMatchTokenMap(
    db,
    media.results.map((item) => item.id),
  );
  // 参照行と使用先の既存行確認を各4,000件までにし、media 500件・state 1件を
  // 足しても1回のcronで読むDB行を1万件未満に固定する。
  const rowLimit = Math.min(Math.max(opts.sourceRowLimit ?? 1_000, 1), MAX_SOURCE_ROWS);
  const selectedColumns = source.columns.map((column) => `, ${column}`).join('');
  let rows: Array<Record<string, unknown> & { ref_id: string }> = [];
  let sourceMissing = false;
  try {
    const result = await db.prepare(
      `SELECT ${source.idColumn} AS ref_id${selectedColumns}
         FROM ${sourceTable(source)}
        WHERE ${source.idColumn} > ?
        ORDER BY ${source.idColumn} ASC
        LIMIT ?`,
    ).bind(lastRefId, rowLimit).all<Record<string, unknown> & { ref_id: string }>();
    rows = result.results;
  } catch (err) {
    // 古い検証環境などで機能の表がまだ無ければ、その読み口だけ次へ送る。
    // 一時的なD1障害まで「走査済み」にすると、1周後の整理で使用先を消してしまう。
    if (!isMissingSourceTable(err, source.table)
        && !(source.refKind === 'template' && isMissingSourceTable(err, 'broadcast_message_assets'))) throw err;
    logger.error("services_media_usage_scan_failed");
    sourceMissing = true;
  }

  const usages: Array<{ mediaId: string; refKind: MediaRefKind; refId: string }> = [];
  let processedRows = 0;
  let writeBudgetExhausted = false;
  for (const row of rows) {
    const searchable = source.columns
      .map((column) => row[column])
      .filter((value): value is string => typeof value === 'string')
      .join('\n');
    const rowUsages: typeof usages = [];
    for (const item of media.results) {
      const tokens = [...usageMatchTokens(item, tokenMap.get(item.id) ?? []), ...(source.refKind === 'form' ? [item.id] : [])];
      const matches = source.mediaIdMatch
        ? source.columns.some(column => row[column] === item.id)
        : tokens.some((token) => searchable.includes(token));
      if (matches) {
        rowUsages.push({ mediaId: item.id, refKind: source.refKind, refId: String(row.ref_id) });
      }
    }
    if (usages.length + rowUsages.length > MAX_USAGE_WRITES) {
      writeBudgetExhausted = true;
      break;
    }
    usages.push(...rowUsages);
    processedRows += 1;
  }
  await recordMediaUsages(db, usages, now);

  const sourceCompleted = sourceMissing || (!writeBudgetExhausted && rows.length < rowLimit);
  let cycleCompleted = false;
  let pruned = 0;
  if (sourceCompleted && sourceIndex === SOURCES.length - 1) {
    // 整理は読込予算を分けるため、次のcronへ送る。
    await saveMediaUsageScanState(db, {
      sourceIndex: SOURCES.length,
      lastRefId: '',
      cycleStartedAt: state.cycleStartedAt,
    }, now);
  } else if (sourceCompleted) {
    await saveMediaUsageScanState(db, {
      ...state,
      sourceIndex: sourceIndex + 1,
      lastRefId: '',
    }, now);
  } else {
    await saveMediaUsageScanState(db, {
      ...state,
      sourceIndex,
      lastRefId: String(rows[processedRows - 1]?.ref_id ?? lastRefId),
    }, now);
  }

  return {
    scanned: media.results.length,
    matched: usages.length,
    pruned,
    source: source.refKind,
    sourceRows: rows.length,
    cycleCompleted,
  };
}
