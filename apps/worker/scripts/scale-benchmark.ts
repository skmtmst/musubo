/**
 * 大きいデータの速度の見張り（報告だけ）。
 *
 * 手元で使い捨てるローカル D1（Miniflare。wrangler --local と同じ仕組み）だけを使う。
 * 検証・本番の DB にはつながず、LINE の API にも出ていかない（外への fetch は作り物の応答で止める）。
 *
 * 友だち 50,000・タグ 200・友だちとタグの結び付き（1人平均5）・トーク 100,000 件・一斉配信 500 件を
 * 決まった種から作り、管理画面が最初に呼ぶ口を 5 回ずつ測って中央値を出す。
 * 目安（既定 3,000ms）を超えた口は、その口が投げた SQL の EXPLAIN QUERY PLAN から
 * 索引を使わずに表を走査している所（SCAN）を並べる。PR は止めない。
 *
 *   pnpm --filter worker scale:benchmark
 *
 * 設定は環境変数で渡す（vitest の引数と混ぜないため）。
 *   SCALE_RUNS=5 SCALE_THRESHOLD_MS=3000 SCALE_SEED=20261025 SCALE_FACTOR=1
 *   SCALE_SUMMARY=<markdown の出力先> SCALE_JSON=<json の出力先> SCALE_SLOW_CONTROL=1
 *
 * 共有パッケージの dist は拡張子なしの import で出ていて Node では直接読めないので、
 * Worker の試験と同じ vite の解決で動かす（vitest.scale.config.ts と scale-benchmark.scale.ts）。
 *
 * SCALE_SLOW_CONTROL は対照。タグの一覧の口にだけ、わざと重い SQL を1本足す。
 * その口が「超えた」側に出ることで、表が本当に見張っているかを確かめる。
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { Miniflare } from 'miniflare';
import { Hono } from 'hono';
import type { Env } from '../src/worker-env.js';
import { friends } from '../src/routes/friends.js';
import { chats } from '../src/routes/chats.js';
import { tags } from '../src/routes/tags.js';
import { broadcasts } from '../src/routes/broadcasts.js';
import { dashboard } from '../src/routes/dashboard.js';

type Options = {
  runs: number; thresholdMs: number; seed: number; scale: number;
  summary?: string; json?: string; slowControl: boolean;
};

export function readOptions(env: Record<string, string | undefined>): Options {
  const number = (name: string, fallback: number) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} は正の数で指定してください`);
    return parsed;
  };
  return {
    runs: Math.round(number('SCALE_RUNS', 5)),
    thresholdMs: number('SCALE_THRESHOLD_MS', 3000),
    seed: Math.round(number('SCALE_SEED', 20261025)),
    scale: number('SCALE_FACTOR', 1),
    summary: env.SCALE_SUMMARY || undefined,
    json: env.SCALE_JSON || undefined,
    slowControl: env.SCALE_SLOW_CONTROL === '1',
  };
}

let options: Options = readOptions({});
const ACCOUNT_ID = 'scale-account';
const STAFF_ID = 'scale-owner';
const NOW = '2026-10-25T03:00:00.000Z';
const countsFor = (scale: number) => ({
  friends: Math.round(50_000 * scale),
  tags: 200,
  tagsPerFriend: 5,
  talkFriends: Math.round(20_000 * scale),
  messages: Math.round(100_000 * scale),
  broadcasts: 500,
});
let COUNTS = countsFor(1);

/*
 * 種から決まる疑似乱数を SQL の式で作る。x（行番号）と k（何本目か）と種だけで決まるので、
 * 何度走らせても同じ行が入る。31bit に収めて SQLite の整数の範囲を越えないようにする。
 */
function hashSql(x: string, k: number): string {
  return `((((${x}) * 1103515245 + ${options.seed} + ${k} * 2654435761) % 2147483647 + 2147483647) % 2147483647)`;
}
function unitSql(x: string, k: number): string {
  return `(${hashSql(hashSql(x, k), k + 1)} * 1.0 / 2147483647)`;
}

/** bootstrap.sql の表・索引・引き金・ビューと初期行を、作った順に D1 へ流す文にする。 */
function bootstrapStatements(): string[] {
  const schema = new Database(':memory:');
  schema.exec(readFileSync(new URL('../../../packages/db/bootstrap.sql', import.meta.url), 'utf8'));
  const objects = schema.prepare(`SELECT type, name, sql FROM sqlite_master
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`).all() as Array<{ type: string; name: string; sql: string }>;
  const order = { table: 0, index: 1, view: 2, trigger: 3 } as Record<string, number>;
  const statements = objects
    .sort((a, b) => (order[a.type] ?? 9) - (order[b.type] ?? 9))
    .map(object => object.sql);
  for (const { name } of objects.filter(object => object.type === 'table')) {
    const rows = schema.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>;
    for (const row of rows) {
      const columns = Object.keys(row);
      const values = columns.map(column => {
        const cell = row[column];
        if (cell === null || cell === undefined) return 'NULL';
        if (typeof cell === 'number' || typeof cell === 'bigint') return String(cell);
        return `'${String(cell).replaceAll("'", "''")}'`;
      });
      statements.push(`INSERT OR IGNORE INTO "${name}" (${columns.map(column => `"${column}"`).join(',')}) VALUES (${values.join(',')})`);
    }
  }
  schema.close();
  return statements;
}

async function runChunks(db: D1Database, statements: string[], size = 50): Promise<void> {
  for (let start = 0; start < statements.length; start += size) {
    await db.batch(statements.slice(start, start + size).map(sql => db.prepare(sql)));
  }
}

/** 1..total を step ごとに区切って、行番号 x の再帰 CTE で流し込む。 */
async function insertRange(db: D1Database, total: number, body: (from: number, to: number) => string, step = 5_000): Promise<void> {
  for (let start = 1; start <= total; start += step) {
    const end = Math.min(total, start + step - 1);
    await db.prepare(body(start, end)).run();
  }
}
const range = (from: number, to: number) => `WITH RECURSIVE n(x) AS (VALUES(${from}) UNION ALL SELECT x + 1 FROM n WHERE x < ${to})`;

async function seed(db: D1Database): Promise<Record<string, number>> {
  await db.prepare(`INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret, is_default, tenant_id)
    SELECT ?, 'scale-channel', '大きいデータの店', 'fixture-token', 'fixture-secret', 1, id FROM tenants ORDER BY created_at LIMIT 1`)
    .bind(ACCOUNT_ID).run();

  // 友だち：50人に1人の名に「山田」を入れる（名前で探す口の見本）。登録した時刻は過去およそ二年に散らす。
  await insertRange(db, COUNTS.friends, (from, to) => `${range(from, to)}
    INSERT INTO friends (id, line_user_id, display_name, is_following, line_account_id, score, created_at, updated_at, metadata)
    SELECT printf('f%06d', x), printf('Uscale%06d', x),
      CASE WHEN x % 50 = 0 THEN printf('山田 %d', x) ELSE printf('友だち %d', x) END,
      CASE WHEN ${hashSql('x', 1)} % 10 = 0 THEN 0 ELSE 1 END,
      '${ACCOUNT_ID}', ${hashSql('x', 2)} % 100,
      strftime('%Y-%m-%dT%H:%M:%f', '${NOW}', printf('-%d minutes', ${hashSql('x', 3)} % 1051200)),
      '${NOW}', '{}'
    FROM n`);

  await insertRange(db, COUNTS.tags, (from, to) => `${range(from, to)}
    INSERT INTO tags (id, name, normalized_name, line_account_id, display_order, created_at)
    SELECT printf('t%03d', x), printf('タグ %03d', x), printf('タグ %03d', x), '${ACCOUNT_ID}', x, '${NOW}' FROM n`);

  // 結び付き：1人に5本。番号の若いタグほど多く付く（二乗で偏らせる）。重なりは捨てるので平均は5より少し下がる。
  for (let k = 0; k < COUNTS.tagsPerFriend; k += 1) {
    await insertRange(db, COUNTS.friends, (from, to) => `${range(from, to)}
      INSERT OR IGNORE INTO friend_tags (friend_id, tag_id, assigned_at)
      SELECT printf('f%06d', x), printf('t%03d', 1 + CAST(${COUNTS.tags} * ${unitSql('x', 10 + k)} * ${unitSql('x', 10 + k)} AS INTEGER) % ${COUNTS.tags}), '${NOW}'
      FROM n`, 10_000);
  }

  // トーク：talkFriends 人に散らして messages 件。最近 90 日に散らし、6 割が受信。
  await insertRange(db, COUNTS.messages, (from, to) => `${range(from, to)}
    INSERT INTO messages_log (id, friend_id, direction, message_type, content, delivery_type, line_account_id, created_at)
    SELECT printf('m%07d', x), printf('f%06d', 1 + ${hashSql('x', 20)} % ${COUNTS.talkFriends}),
      CASE WHEN ${hashSql('x', 21)} % 10 < 6 THEN 'incoming' ELSE 'outgoing' END,
      'text', printf('メッセージ %d です', x), CASE WHEN ${hashSql('x', 21)} % 10 < 6 THEN NULL ELSE 'push' END, '${ACCOUNT_ID}',
      strftime('%Y-%m-%dT%H:%M:%fZ', '${NOW}', printf('-%d seconds', ${hashSql('x', 22)} % 7776000))
    FROM n`);

  // 会話の行：トークのある人ごとに1行。状態は 4 割が未対応。
  await insertRange(db, COUNTS.talkFriends, (from, to) => `${range(from, to)}
    INSERT INTO chats (id, friend_id, status, last_message_at, created_at, updated_at, line_account_id)
    SELECT printf('c%06d', x), printf('f%06d', x),
      CASE ${hashSql('x', 30)} % 10 WHEN 0 THEN 'unread' WHEN 1 THEN 'unread' WHEN 2 THEN 'unread' WHEN 3 THEN 'unread'
        WHEN 4 THEN 'in_progress' WHEN 5 THEN 'on_hold' ELSE 'resolved' END,
      (SELECT MAX(created_at) FROM messages_log WHERE friend_id = printf('f%06d', x)),
      '${NOW}', '${NOW}', '${ACCOUNT_ID}'
    FROM n`, 2_000);

  // 既読：担当者がトークのある人の半分を読んだことにする。
  await insertRange(db, COUNTS.talkFriends, (from, to) => `${range(from, to)}
    INSERT INTO inbox_staff_reads (staff_id, channel, conversation_id, last_read_at, updated_at)
    SELECT '${STAFF_ID}', 'line', printf('f%06d', x), '${NOW}', '${NOW}' FROM n WHERE x % 2 = 0`);

  await insertRange(db, COUNTS.broadcasts, (from, to) => `${range(from, to)}
    INSERT INTO broadcasts (id, title, message_type, message_content, target_type, target_tag_id, status, scheduled_at, sent_at,
      total_count, success_count, created_at, line_account_id)
    SELECT printf('b%04d', x), printf('配信 %d', x), 'text', '{"text":"お知らせ"}',
      CASE WHEN x % 3 = 0 THEN 'tag' ELSE 'all' END, CASE WHEN x % 3 = 0 THEN printf('t%03d', 1 + x % ${COUNTS.tags}) END,
      CASE x % 10 WHEN 0 THEN 'draft' WHEN 1 THEN 'scheduled' ELSE 'sent' END,
      strftime('%Y-%m-%dT%H:%M:%fZ', '${NOW}', printf('-%d hours', x * 12)),
      CASE WHEN x % 10 >= 2 THEN strftime('%Y-%m-%dT%H:%M:%fZ', '${NOW}', printf('-%d hours', x * 12)) END,
      ${COUNTS.friends}, ${COUNTS.friends} - x, strftime('%Y-%m-%dT%H:%M:%fZ', '${NOW}', printf('-%d hours', x * 12 + 1)),
      '${ACCOUNT_ID}'
    FROM n`);

  const counted: Record<string, number> = {};
  for (const table of ['friends', 'tags', 'friend_tags', 'messages_log', 'chats', 'broadcasts']) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
    counted[table] = Number(row?.n ?? 0);
  }
  return counted;
}

type Recorded = { sql: string; args: unknown[]; rowsRead: number };

/**
 * 口が投げた文と、D1 が数えた読んだ行（rows_read）を記録する D1。測る回とは別の1回だけで使う。
 * 計画は後で EXPLAIN QUERY PLAN を別に取る。書き込みの文は二度走らせない。
 */
function recordingDb(db: D1Database, sink: Recorded[]): D1Database {
  const original = new WeakMap<object, { statement: D1PreparedStatement; sql: string; args: unknown[] }>();
  const record = (sql: string, args: unknown[], result: unknown) => {
    const meta = (result as { meta?: { rows_read?: number } } | null)?.meta;
    sink.push({ sql, args, rowsRead: Number(meta?.rows_read ?? 0) });
  };
  const isRead = (sql: string) => /^\s*(SELECT|WITH)/i.test(sql) && !/\b(INSERT|UPDATE|DELETE)\b/i.test(sql);
  const wrapStatement = (statement: D1PreparedStatement, sql: string, args: unknown[]): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, prop) {
        if (prop === 'bind') return (...next: unknown[]) => wrapStatement(target.bind(...next), sql, next);
        if (prop === 'all' || prop === 'run') {
          return async (...rest: unknown[]) => {
            const result = await (target[prop] as (...input: unknown[]) => Promise<unknown>).apply(target, rest);
            record(sql, args, result);
            return result;
          };
        }
        if (prop === 'first' || prop === 'raw') {
          return async (...rest: unknown[]) => {
            // first() と raw() は meta を返さない。読むだけの文は all() でもう一度読んで rows_read を取る。
            if (isRead(sql)) record(sql, args, await target.all());
            else record(sql, args, null);
            return (target[prop] as (...input: unknown[]) => unknown).apply(target, rest);
          };
        }
        const valueOf = Reflect.get(target, prop, target);
        return typeof valueOf === 'function' ? valueOf.bind(target) : valueOf;
      },
    });
    original.set(proxy, { statement, sql, args });
    return proxy;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql: string) => wrapStatement(target.prepare(sql), sql, []);
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          const unwrapped = statements.map(statement => original.get(statement));
          const results = await target.batch(statements.map((statement, index) => unwrapped[index]?.statement ?? statement));
          results.forEach((result, index) => record(unwrapped[index]?.sql ?? '', unwrapped[index]?.args ?? [], result));
          return results;
        };
      }
      const valueOf = Reflect.get(target, prop, target);
      return typeof valueOf === 'function' ? valueOf.bind(target) : valueOf;
    },
  });
}

type Probe = { key: string; label: string; screen: string; path: string; slow?: boolean };

const PROBES: Probe[] = [
  { key: 'friends-page1', label: '友だちの一覧（1ページ目）', screen: '友だち', path: `/api/friends?offset=0&limit=20&lineAccountId=${ACCOUNT_ID}&includeChatStatus=true&sort=recent` },
  { key: 'friends-tag', label: '友だちの一覧（タグで絞る）', screen: '友だち', path: `/api/friends?offset=0&limit=20&lineAccountId=${ACCOUNT_ID}&includeChatStatus=true&sort=recent&tagId=t001` },
  { key: 'friends-search', label: '友だちの一覧（名前で探す）', screen: '友だち', path: `/api/friends?offset=0&limit=100&lineAccountId=${ACCOUNT_ID}&includeChatStatus=true&sort=recent&search=${encodeURIComponent('山田')}` },
  { key: 'inbox-unread-first', label: '受信箱の一覧（未読が先・1ページ目）', screen: '受信箱', path: `/api/chats?lineAccountId=${ACCOUNT_ID}&limit=200` },
  { key: 'inbox-latest', label: '受信箱の一覧（最新順・既読の続き）', screen: '受信箱', path: `/api/chats?lineAccountId=${ACCOUNT_ID}&limit=200&beforeUnread=0&beforeAt=${encodeURIComponent('2099-01-01T00:00:00.000Z')}&beforeId=zzzz` },
  { key: 'inbox-counts', label: '受信箱の件数（すべて・要返信）', screen: '受信箱', path: `/api/chats/quick-counts?lineAccountId=${ACCOUNT_ID}&channel=line` },
  { key: 'tags', label: 'タグの一覧（人数つき）', screen: 'タグ', path: `/api/tags?withCounts=1&lineAccountId=${ACCOUNT_ID}`, slow: true },
  { key: 'broadcasts', label: '一斉配信の一覧', screen: '一斉配信', path: `/api/broadcasts?lineAccountId=${ACCOUNT_ID}&limit=20` },
  { key: 'dashboard', label: 'ダッシュボードの数（30日）', screen: 'ダッシュボード', path: `/api/dashboard/overview?period=last30&account_id=${ACCOUNT_ID}` },
];

/** 対照用の重い SQL。数秒かかる数え上げで、読んだ行と走査の欄にも対照の跡が出る。 */
const SLOW_CONTROL_SQL = `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 25000000) SELECT COUNT(*) AS n FROM c`;

function buildApp(slowControl: boolean): Hono<Env> {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('staff', { id: STAFF_ID, name: '大きいデータの担当', role: 'owner', readOnly: false });
    await next();
  });
  if (slowControl) {
    app.use('/api/tags', async (c, next) => {
      await c.env.DB.prepare(SLOW_CONTROL_SQL).first();
      // 機械が速くても必ず目安を超えるよう、目安より 0.5 秒長く待つ。
      await new Promise(resolve => setTimeout(resolve, options.thresholdMs + 500));
      await next();
    });
  }
  for (const routes of [friends, chats, tags, broadcasts, dashboard]) app.route('/', routes);
  return app;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** 外へ出る fetch（LINE の送信枠など）は測る対象ではないので、作り物の応答ですぐ返す。 */
function stubExternalFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/^https:\/\/api(-data)?\.line\.me\//.test(url)) {
      const body = url.includes('/quota/consumption') ? { totalUsage: 0 } : { type: 'limited', value: 5000 };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) return original(input, init);
    throw new Error(`scale benchmark blocks external fetch: ${new URL(url).host}`);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

type ProbeResult = Probe & {
  status: number; medianMs: number; runsMs: number[]; rows: number | null; queries: number; rowsRead: number;
  overThreshold: boolean; scans: string[]; heaviest: Array<{ rowsRead: number; sql: string; plan: string[] }>;
};

async function measure(db: D1Database, app: Hono<Env>, probe: Probe): Promise<ProbeResult> {
  const runsMs: number[] = [];
  let status = 0;
  let rows: number | null = null;
  // 1回目の前に1度通して、SQL の準備と JIT の差を中央値に混ぜない。
  await app.request(probe.path, {}, { DB: db } as unknown as Env['Bindings']);
  for (let run = 0; run < options.runs; run += 1) {
    const started = performance.now();
    const response = await app.request(probe.path, {}, { DB: db } as unknown as Env['Bindings']);
    const body = await response.text();
    runsMs.push(Math.round((performance.now() - started) * 10) / 10);
    status = response.status;
    try {
      const parsed = JSON.parse(body) as { data?: unknown };
      const data = parsed.data as { items?: unknown[] } | unknown[] | undefined;
      rows = Array.isArray(data) ? data.length : Array.isArray(data?.items) ? data.items.length : null;
    } catch { rows = null; }
  }
  const sink: Recorded[] = [];
  await app.request(probe.path, {}, { DB: recordingDb(db, sink) } as unknown as Env['Bindings']);
  const medianMs = median(runsMs);
  const overThreshold = medianMs > options.thresholdMs || status >= 500;
  // 索引の候補は全部の口で拾っておく（表に出すのは超えた口だけ。JSON には全部残す）。
  const scans = await scansFor(db, sink.filter(entry => /^\s*(SELECT|WITH)/i.test(entry.sql)));
  const rowsRead = sink.reduce((total, entry) => total + entry.rowsRead, 0);
  const heaviest = await Promise.all([...sink].sort((a, b) => b.rowsRead - a.rowsRead).slice(0, 3)
    .map(async entry => ({ rowsRead: entry.rowsRead, sql: entry.sql.replace(/\s+/g, ' ').trim().slice(0, 160), plan: await planOf(db, entry) })));
  return { ...probe, status, medianMs, runsMs, rows, queries: sink.length, rowsRead, overThreshold, scans, heaviest };
}

async function planOf(db: D1Database, { sql, args }: Recorded): Promise<string[]> {
  try {
    const plan = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>();
    return plan.results.map(row => row.detail);
  } catch {
    return [];
  }
}

/** 索引を使わない走査（SCAN <表または別名>）を拾う。CTE の別名も混ざるので、読んだ行の多い文と合わせて読む。 */
async function scansFor(db: D1Database, statements: Recorded[]): Promise<string[]> {
  const found = new Set<string>();
  for (const { sql, args } of statements) {
    try {
      const plan = await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...args).all<{ detail: string }>();
      for (const { detail } of plan.results) {
        // 索引で順に読む走査・JSON の展開・副問い合わせの読み直しは候補にしない。
        if (/^SCAN /.test(detail) && !/USING (COVERING )?INDEX|VIRTUAL TABLE|^SCAN \(subquery-|^SCAN CONSTANT ROW/.test(detail)) found.add(detail);
      }
    } catch { /* 計画を取れない文は飛ばす */ }
  }
  return [...found];
}

function table(results: ProbeResult[], counts: Record<string, number>, seedMs: number): string {
  const over = results.filter(result => result.overThreshold);
  const lines = [
    '## 大きいデータの速度（報告だけ）',
    '',
    `ローカル D1（Miniflare）に作り物のデータを入れて測った。種 ${options.seed}・各口 ${options.runs} 回の中央値・目安 ${options.thresholdMs.toLocaleString()}ms。${options.slowControl ? '**対照（わざと遅くした回）**。' : ''}`,
    '',
    `入れた行：友だち ${counts.friends.toLocaleString()}・タグ ${counts.tags}・結び付き ${counts.friend_tags.toLocaleString()}・トーク ${counts.messages_log.toLocaleString()}・会話 ${counts.chats.toLocaleString()}・一斉配信 ${counts.broadcasts}（作成 ${(seedMs / 1000).toFixed(1)} 秒）`,
    '',
    over.length ? `**目安を超えた口：${over.length} 件**` : '目安を超えた口はありません。',
    '',
    `| 画面 | 口 | 中央値 | ${options.runs}回 | 返した行 | SQL | 読んだ行 | 判定 |`,
    '| --- | --- | ---: | --- | ---: | ---: | ---: | --- |',
    ...results.map(result => `| ${result.screen} | ${result.label} | ${result.medianMs.toLocaleString()}ms | ${result.runsMs.join(' / ')} | ${result.rows ?? '-'} | ${result.queries} | ${result.rowsRead.toLocaleString()} | ${result.status >= 400 ? `応答 ${result.status}` : result.overThreshold ? '超えた' : '目安内'} |`),
  ];
  const screens = [...new Set(results.map(result => result.screen))];
  // 同じ画面の口は絞り方ちがいの別の開き方なので足さない。画面ごとに一番遅い口を出す。
  lines.push('', '画面ごとの一番遅い口：' + screens.map(screen => {
    const slowest = Math.max(...results.filter(result => result.screen === screen).map(result => result.medianMs));
    return `${screen} ${slowest.toLocaleString()}ms`;
  }).join('・'));
  if (over.length) {
    lines.push('', '### 超えた口の走査（索引を使っていない所）', '');
    for (const result of over) {
      lines.push(`- ${result.label}`);
      for (const scan of result.scans.length ? result.scans : ['（SCAN は見つからなかった）']) lines.push(`  - \`${scan}\``);
      for (const heavy of result.heaviest) lines.push(`  - 読んだ行 ${heavy.rowsRead.toLocaleString()}：\`${heavy.sql.replaceAll('`', "'")}\``);
    }
  }
  return `${lines.join('\n')}\n`;
}

export type ScaleBenchmarkReport = { markdown: string; counts: Record<string, number>; results: ProbeResult[] };

export async function runScaleBenchmark(input: Options): Promise<ScaleBenchmarkReport> {
  options = input;
  COUNTS = countsFor(input.scale);
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("local scale benchmark"); } };',
    compatibilityDate: '2026-03-17',
    d1Databases: ['DB'],
  });
  const restoreFetch = stubExternalFetch();
  try {
    const db = await mf.getD1Database('DB');
    const seedStarted = performance.now();
    await runChunks(db, bootstrapStatements());
    const counts = await seed(db);
    const seedMs = performance.now() - seedStarted;
    const app = buildApp(options.slowControl);
    const results: ProbeResult[] = [];
    for (const probe of PROBES) {
      const result = await measure(db, app, probe);
      results.push(result);
      console.error(`${result.label}: ${result.medianMs}ms (${result.status})`);
    }
    const markdown = table(results, counts, seedMs);
    if (options.summary) appendFileSync(options.summary, markdown);
    if (options.json) {
      writeFileSync(options.json, `${JSON.stringify({
        runtime: 'local Miniflare D1 (not remote staging)', seed: options.seed, runs: options.runs,
        thresholdMs: options.thresholdMs, slowControl: options.slowControl, counts, seedMs: Math.round(seedMs), results,
      }, null, 2)}\n`);
    }
    return { markdown, counts, results };
  } finally {
    restoreFetch();
    await mf.dispose();
  }
}
