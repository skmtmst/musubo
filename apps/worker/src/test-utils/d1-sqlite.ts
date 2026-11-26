/*
 * テスト用の D1 もどき。
 *
 * better-sqlite3 を D1Database の形にかぶせる。手書きのモックだと
 * 「SQL が正しいか」を確かめられない。条件ビルダーやアクションのように
 * **SQL そのものが仕様**のものは、本物の SQLite に当てないと意味がない。
 *
 * 実装しているのは実際に使っている口だけ（prepare / bind / first / all / run / batch）。
 */
import Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useSqliteClock } from './sqlite-clock.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DB_PKG_ROOT = join(__dirname, '../../../../packages/db')

export interface SqliteD1 {
  db: D1Database
  raw: Database.Database
}

function isSelect(sql: string): boolean {
  return /^\s*(SELECT|WITH|PRAGMA)/i.test(sql) || /\bRETURNING\b/i.test(sql)
}

/*
 * 実 D1 は `?1 ?2` の番号付き束縛に正式対応しているが、手元の
 * better-sqlite3 は番号付きへ位置で値を渡すと「多すぎる」と投げる。
 * D1 と同じ意味になるよう、番号順に並べ替えて `?` に直してから渡す。
 */
function rewriteNumbered(sql: string, args: unknown[]): { sql: string; args: unknown[] } {
  if (!/\?\d/.test(sql)) return { sql, args }
  const order: number[] = []
  const rewritten = sql.replace(/\?(\d+)/g, (_m, n: string) => {
    order.push(Number(n))
    return '?'
  })
  return { sql: rewritten, args: order.map((n) => args[n - 1]) }
}

/** 公開メソッドは Promise の契約を保ち、batch 内の SQL 書込間では制御を譲らない。 */
function promiseMethod<T>(sync:()=>T):(()=>Promise<T>) & {sync:()=>T} {
  return Object.assign(async()=>sync(),{sync});
}
function wrap(raw: Database.Database, sql: string, args: unknown[]) {
  const rewritten = rewriteNumbered(sql, args)
  sql = rewritten.sql
  args = rewritten.args
  const normalized = args.map((a) => {
    if (a === undefined) return null
    if (typeof a === 'boolean') return a ? 1 : 0
    return a as never
  })
  return {
    first: promiseMethod(<T = unknown>(): T | null => {
      const row = raw.prepare(sql).get(...normalized)
      return (row as T) ?? null
    }),
    all: promiseMethod(<T = unknown>(): { results: T[]; meta?: { changes:number; last_row_id:number } } => {
      const rows = raw.prepare(sql).all(...normalized)
      if (/\bRETURNING\b/i.test(sql) && !/^\s*(SELECT|PRAGMA)/i.test(sql)) {
        const meta=raw.prepare('SELECT changes() AS changes,last_insert_rowid() AS last_row_id').get() as {changes:number;last_row_id:number};
        return {results:rows as T[],meta};
      }
      return { results: rows as T[] }
    }),
    run: promiseMethod(() => {
      const info = raw.prepare(sql).run(...normalized)
      return { meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) } }
    }),
  }
}

/**
 * bootstrap.sql を流した空のDBを作る。
 *
 * `file` を渡すとファイルのDBを開く。**別々の接続を2本開けば、
 * 2つの実行主体が同じDBを取り合う競合を実際に再現できる。**
 * `attach` を渡した場合は既にあるDBへ繋ぐだけで、schemaは流さない。
 */
export function createTestD1(
  options?: { loginPolicy?: 'off'; foreignKeys?: boolean; file?: string; attach?: boolean; now?: () => Date },
): SqliteD1 {
  const raw = new Database(options?.file ?? ':memory:')
  if (options?.now) useSqliteClock(raw, options.now)
  if (options?.file) {
    /*
     * 実DBと同じ見え方のまま、テストのディスク待ちだけ削る。
     *
     * **schema を流す前に立てること。** bootstrap.sql には BEGIN/COMMIT が
     * 無く、900本を超える DDL が1文ずつ暗黙トランザクションで走る。既定の
     * ロールバックジャーナルのままだと、その1文ごとにジャーナルファイルを
     * 作って書いて消す。手元の実測で中央値 1,117ms かかり、journal_mode を
     * 先に WAL へ倒すだけで 162ms(7分の1)になった。効いているのは
     * journal_mode で、synchronous は12%しか効かない(= fsync の回数ではなく
     * ファイル操作の回数が主因)。CI のような遅いファイルシステムでは
     * さらに悪化し、`beforeAll` が 10 秒の hookTimeout を超えてゲートを
     * 落としていた。
     *
     * 順序を変えても出来上がるスキーマは変わらない。d1-sqlite.test.ts で
     * bootstrap.sql をそのまま流したものと sqlite_master が一致することを
     * 固定してある。
     */
    raw.pragma('journal_mode = WAL')
    raw.pragma('synchronous = OFF')
    raw.pragma('busy_timeout = 2000')
  }
  if (!options?.attach) raw.exec(readFileSync(join(DB_PKG_ROOT, 'bootstrap.sql'), 'utf8'))
  // 参照整合性は本番の D1 と同じく既定で切っておく。ここだけ厳しくすると
  // テストのためだけに余分な行を用意することになり、読みにくくなる。
  // ただし外部キーに関わる不整合 (誤った通 ID の保存など) は OFF では隠れる。
  // その種の回帰テストは { foreignKeys: true } で作り、実 D1 と同じ制約で確かめる。
  raw.pragma(`foreign_keys = ${options?.foreignKeys ? 'ON' : 'OFF'}`)
  // 権限専用の既存試験は明示的な MFA 無効設定を選ぶ。通常の fixture は既定有効を保ち、認証実装や許可条件は変えず実設定行だけを使う。
  if (options?.loginPolicy === 'off') {
    raw.exec(`INSERT OR REPLACE INTO platform_settings(key,value)
      SELECT 'auth.mfa.required:'||id,'false' FROM tenants;
      CREATE TEMP TRIGGER fixture_login_policy_off AFTER INSERT ON tenants BEGIN
        INSERT OR REPLACE INTO platform_settings(key,value) VALUES ('auth.mfa.required:'||NEW.id,'false');
      END;`)
  }


  let batchTail:Promise<unknown>=Promise.resolve();
  const db = {
    prepare: (sql: string) => ({
      // batch が SELECT へ .all を振り分けられるよう、元の SQL を残しておく。
      bind: (...args: unknown[]) => {
        if (args.length > 100) throw new Error(`D1 bind limit exceeded: ${args.length} > 100`)
        return { ...wrap(raw, sql, args), sql }
      },
      sql,
      ...(isSelect(sql) ? wrap(raw, sql, []) : wrap(raw, sql, [])),
    }),
    batch: (statements: D1PreparedStatement[]) => {
      const run=async()=>{
      raw.exec('BEGIN IMMEDIATE')
      try {
        const results = []
        for (const statement of statements) {
          /*
           * 実 D1 の batch は SELECT 文でも .results を返す。ここで一律
           * .run すると .results が無く、batch 内で SELECT を投げる
           * 呼び出し側（使用先のまとめ集計など）が黙って壊れる。
           */
          const sql = (statement as unknown as { sql?: string }).sql ?? '';
          const invoke=(method:'run'|'all')=>{
            const callback=statement[method] as unknown as (()=>unknown) & {sync?:()=>unknown};
            return callback.sync ? callback.sync() : callback.call(statement);
          };
          if (!isSelect(sql)) {
            const result=invoke('run');results.push(result && typeof (result as Promise<unknown>).then==='function'?await result:result);
            continue;
          }
          try {
            const result=invoke('all');results.push(result && typeof (result as Promise<unknown>).then==='function'?await result:result);
          } catch (error) {
            if(!String((error as {message?:unknown})?.message).includes('does not return data'))throw error;
            // WITH x AS (...) INSERT ... のように WITH で始まる書き込みもある。
            // returnsData が無い文に .all すると実行前に失敗するので .run へ倒す。
            const result=invoke('run');results.push(result && typeof (result as Promise<unknown>).then==='function'?await result:result);
          }
        }
        raw.exec('COMMIT')
        return results
      } catch (error) {
        raw.exec('ROLLBACK')
        throw error
      }
      };
      const result=batchTail.then(run);batchTail=result.catch(()=>undefined);return result;
    },
  } as unknown as D1Database

  return { db, raw }
}

/** 友だちを1人作る。テストで要る列だけ埋める。 */
export function insertFriend(
  raw: Database.Database,
  id: string,
  overrides: Record<string, unknown> = {},
): void {
  const row: Record<string, unknown> = {
    id,
    line_user_id: `U${id}`,
    display_name: id,
    is_following: 1,
    created_at: '2026-01-01T00:00:00.000',
    updated_at: '2026-01-01T00:00:00.000',
    ...overrides,
  }
  const cols = Object.keys(row)
  raw
    .prepare(
      `INSERT INTO friends (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    )
    .run(...cols.map((c) => row[c] as never))
}
