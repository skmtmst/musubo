/**
 * D1 マイグレーションの適用。
 *
 * 既存のデプロイ手順（staging-deploy.sh）はマイグレーションを扱わない。
 * preflight の確認項目にも入っていない。つまりデータベースの変更だけが
 * ゲートの外側にあった。ここでそれを内側に入れる。
 *
 *   scripts/deploy/migrate.ts status  staging      いまの状態を見る
 *   scripts/deploy/migrate.ts seed    staging      現物から _migrations を作る
 *   scripts/deploy/migrate.ts apply   staging      未適用を当てる（--apply で実行）
 *
 * 既定は dry-run。実際に書くには --apply が要る。
 * 反射で叩いたときに何も起きないほうがよい。
 *
 * 本番は `--approved-by` と `--approval-ref` を必須にする。
 * docs/DEPLOY-GATE.md の本番デプロイと同じ扱いにするため。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  columnsOf,
  describeMarker,
  judge,
  markersOf,
  schemaFromSqliteMaster,
  type Marker,
  type Schema,
  type SqliteMasterRow,
} from './migrate-state';
import { ENV_POLICY, PRODUCTION_APPROVERS } from './preflight';
import { type DeployEnv, isDeployEnv } from './deploy-lock';

const MIGRATIONS_DIR = 'packages/db/migrations';
const BOOTSTRAP = 'packages/db/bootstrap.sql';

/** wrangler が返す JSON の前後に飾りが混ざるので、配列の部分だけ取り出す。 */
export function extractJson(raw: string): unknown {
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end < 0) throw new Error(`wrangler の出力を読めませんでした:\n${raw.slice(0, 400)}`);
  return JSON.parse(raw.slice(start, end + 1));
}

/**
 * Time Travel のブックマークを取り出す。
 *
 * wrangler の出力の形は版によって変わるので、素直な JSON、包まれた JSON、
 * ログ混じり、JSON でないもの、のどれでも拾えるようにする。
 * どれでも取れないときは空を返し、呼び出し側が止める。戻る先が無いまま
 * 当てるほうが危ない。
 */
export function extractBookmark(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { bookmark?: string; result?: { bookmark?: string } };
    const found = parsed.bookmark ?? parsed.result?.bookmark;
    if (found) return found;
  } catch {
    // JSON でないこともある。下の走査に任せる。
  }
  const match = /[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}/i.exec(raw);
  return match ? match[0] : '';
}

function wrangler(args: string[]): string {
  return execFileSync('./node_modules/.bin/wrangler', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

interface Target {
  env: DeployEnv;
  database: string;
  config: string;
}

/** wrangler 設定から database_name を読む。名前を二重に持つと片方だけ変更したときに設定と名前がずれる。 */
export function databaseNameOf(configText: string): string {
  const match = /\[\[d1_databases\]\][\s\S]*?database_name\s*=\s*"([^"]+)"/.exec(configText);
  if (!match) throw new Error('wrangler 設定から database_name を読めませんでした');
  return match[1];
}

function resolveTarget(env: DeployEnv): Target {
  const config = ENV_POLICY[env].config;
  return { env, database: databaseNameOf(readFileSync(config, 'utf8')), config };
}

function query(target: Target, sql: string): Record<string, unknown>[] {
  const raw = wrangler([
    'd1', 'execute', target.database, '--remote', '--config', target.config,
    '--command', sql, '--json',
  ]);
  const parsed = extractJson(raw) as Array<{ results?: Record<string, unknown>[] }>;
  return parsed[0]?.results ?? [];
}

function liveSchema(target: Target): Schema {
  const rows = query(target, 'SELECT type, name, sql FROM sqlite_master') as unknown as SqliteMasterRow[];
  return schemaFromSqliteMaster(rows);
}

/**
 * `bootstrap.sql`（最終形）を読む。
 *
 * 列の取り出しは現物側と同じ `columnsOf` を使う。ここだけ別の書き方にすると、
 * 片方が取りこぼしたときに「最終形に無い」と見なされて目印が消え、
 * そのマイグレーションが「データのみ」に落ちる。実際に一度そうなった:
 * 行末の書式に頼った正規表現が 127 表のうち 24 表を取りこぼし、
 * スキーマを変えるマイグレーション 30 件が「判定不能」に化けた。
 */
function finalSchema(): Schema {
  const text = readFileSync(BOOTSTRAP, 'utf8');
  const tables = new Map<string, Set<string>>();
  const indexes = new Set<string>();
  for (const m of text.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+["[`]?(\w+)["\]`]?\s*\(/gi)) {
    tables.set(m[1], columnsOf(text.slice(m.index)));
  }
  for (const m of text.matchAll(/CREATE(?:\s+UNIQUE)?\s+INDEX(?: IF NOT EXISTS)?\s+["[`]?(\w+)/gi)) {
    indexes.add(m[1]);
  }
  return { tables, indexes };
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
}

interface Row {
  file: string;
  state: string;
  missing: Marker[];
  recorded: boolean;
}

function inspect(target: Target): Row[] {
  const live = liveSchema(target);
  const final = finalSchema();
  let recorded = new Set<string>();
  try {
    recorded = new Set(query(target, 'SELECT name FROM _migrations').map((r) => String(r.name)));
  } catch {
    // _migrations がまだ無い。seed がその状態を想定している。
  }
  return migrationFiles().map((file) => {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    // CHECK 制約だけを直す再建は列・索引だけでは判定できない。
    // D1 がファイル単位で原子的に適用し、その後 _migrations に記録する。
    const ledgerOnly = /^-- migration-state: ledger-only\s*$/m.test(sql);
    const verdict = ledgerOnly
      ? { state: recorded.has(file) ? 'applied' : 'missing', missing: [] as Marker[] }
      : judge(markersOf(sql, final), live);
    return {
      file,
      state: verdict.state,
      missing: verdict.state === 'partial' ? verdict.missing : [],
      recorded: recorded.has(file),
    };
  });
}

function report(target: Target, rows: Row[]): void {
  const count = (s: string) => rows.filter((r) => r.state === s).length;
  console.log(`対象: ${target.database} (${target.env})`);
  console.log(`  マイグレーション ${rows.length} 件`);
  console.log(`  スキーマ上   適用済み ${count('applied')} / 未適用 ${count('missing')} / 部分 ${count('partial')} / 判定不能 ${count('unknown')}`);
  console.log(`  _migrations に記録済み ${rows.filter((r) => r.recorded).length} 件`);

  const partial = rows.filter((r) => r.state === 'partial');
  if (partial.length > 0) {
    console.log('\n[要確認] 一部だけ入っているもの。途中で落ちた跡かもしれません。');
    console.log('人が中を見るまで、このスクリプトは何もしません。');
    for (const r of partial) {
      console.log(`  ${r.file}`);
      for (const m of r.missing) console.log(`      欠け: ${describeMarker(m)}`);
    }
  }

  const pending = rows.filter((r) => !r.recorded && r.state !== 'applied');
  if (pending.length > 0) {
    console.log(`\nこれから当たるもの ${pending.length} 件:`);
    for (const r of pending) console.log(`  ${r.file}  (${r.state === 'unknown' ? 'データのみ' : '未適用'})`);
  }
}

function requireProductionApproval(env: DeployEnv, argv: string[]): void {
  if (env !== 'production') return;
  const approvedBy = valueOf(argv, '--approved-by');
  const approvalRef = valueOf(argv, '--approval-ref');
  const problems: string[] = [];
  if (!approvedBy) problems.push('--approved-by がありません');
  else if (!PRODUCTION_APPROVERS.includes(approvedBy)) {
    problems.push(`承認者として認められていないログインです: ${approvedBy}`);
  }
  if (!approvalRef) problems.push('--approval-ref（承認記録のURL）がありません');
  if (problems.length > 0) {
    console.error('本番には承認が要ります（docs/DEPLOY-GATE.md）:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nなお --approved-by は実行者が自分で打てるので、それ単独では承認の証明になりません。');
    process.exit(1);
  }
}

function valueOf(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

function seed(target: Target, rows: Row[], write: boolean): void {
  const toRecord = rows.filter((r) => r.state === 'applied' && !r.recorded);
  console.log(`\n_migrations に記録する: ${toRecord.length} 件`);
  console.log('（スキーマもデータも変えません。記録するだけです）');
  if (toRecord.length === 0) return;
  if (!write) {
    console.log('dry-run です。実際に書くには --apply を付けてください。');
    return;
  }
  wrangler(['d1', 'execute', target.database, '--remote', '--config', target.config, '--command',
    'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)']);
  // D1 は複合 SELECT の項数に上限があるので、まとめて入れるときも小分けにする。
  for (let i = 0; i < toRecord.length; i += 20) {
    const values = toRecord.slice(i, i + 20).map((r) => `('${r.file}', datetime('now'))`).join(', ');
    wrangler(['d1', 'execute', target.database, '--remote', '--config', target.config,
      '--command', `INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES ${values}`]);
    console.log(`  ${Math.min(i + 20, toRecord.length)}/${toRecord.length}`);
  }
}

function apply(target: Target, rows: Row[], write: boolean): void {
  const partial = rows.filter((r) => r.state === 'partial');
  if (partial.length > 0) {
    console.error('\n一部だけ入っているものがあります。自動では進めません。');
    console.error('中途半端な状態に上書きすると、何が入っているか分からなくなります。');
    process.exit(1);
  }
  const pending = rows.filter((r) => !r.recorded && r.state !== 'applied');
  if (pending.length === 0) {
    console.log('\n当てるものはありません。');
    return;
  }
  if (!write) {
    console.log('\ndry-run です。実際に当てるには --apply を付けてください。');
    return;
  }

  const bookmark = extractBookmark(
    wrangler(['d1', 'time-travel', 'info', target.database, '--config', target.config, '--json']),
  );
  if (!bookmark) {
    console.error('Time Travel のブックマークを取れませんでした。戻る先が無いので中止します。');
    process.exit(1);
  }
  console.log(`\n復元点: ${bookmark}`);
  console.log('戻すとき:');
  console.log(`  wrangler d1 time-travel restore ${target.database} --config ${target.config} --bookmark=${bookmark}`);
  console.log('  ※ この時点まで巻き戻すので、当てたあとに入ったデータも消えます。\n');

  for (const r of pending) {
    console.log(`当てる: ${r.file}`);
    wrangler(['d1', 'execute', target.database, '--remote', '--config', target.config,
      '--file', join(MIGRATIONS_DIR, r.file)]);
    wrangler(['d1', 'execute', target.database, '--remote', '--config', target.config, '--command',
      `INSERT OR IGNORE INTO _migrations (name, applied_at) VALUES ('${r.file}', datetime('now'))`]);
  }
  console.log(`\n${pending.length} 件を当てました。復元点は上に出ています。`);
}

function main(): void {
  const argv = process.argv.slice(2);
  const [command, envArg] = argv;
  if (!command || !envArg || !isDeployEnv(envArg)) {
    console.error('使い方: migrate.ts <status|seed|apply> <staging|production> [--apply]');
    process.exit(1);
  }
  const env = envArg;
  requireProductionApproval(env, argv);
  const write = argv.includes('--apply');
  const target = resolveTarget(env);
  const rows = inspect(target);
  report(target, rows);

  if (command === 'status') return;
  if (command === 'seed') return seed(target, rows, write);
  if (command === 'apply') return apply(target, rows, write);
  console.error(`不明なコマンド: ${command}`);
  process.exit(1);
}

if (process.argv[1]?.endsWith('migrate.ts')) main();
