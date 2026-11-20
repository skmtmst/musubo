#!/usr/bin/env tsx
/**
 * Migration safety static analysis.
 *
 * Enforces the additive-only migration policy (see CONTRIBUTING.md).
 * Scans SQL migration files for forbidden destructive constructs:
 *
 *   - DROP TABLE
 *   - DROP COLUMN
 *   - ALTER COLUMN ... TYPE ...
 *   - ALTER TABLE ... RENAME TO ... (rename table)
 *   - RENAME COLUMN
 *   - ADD COLUMN ... NOT NULL  (without DEFAULT after NOT NULL)
 *   - ADD UNIQUE / ADD CONSTRAINT ... UNIQUE
 *
 * Allowed:
 *   - CREATE TABLE
 *   - ALTER TABLE ... ADD COLUMN  (NULL or with DEFAULT)
 *   - CREATE [UNIQUE] INDEX
 *   - INSERT (seed data)
 *   - 表の作り直し（`-- migration-policy: table-rebuild` と書いた場合だけ）
 *     SQLite は CHECK を後から変えられないので、この手順しか無い。
 *
 * Library API:
 *   checkMigration(sql, fileName?) → { ok: true } | { ok: false, violation: string }
 *
 * CLI:
 *   tsx scripts/check-migrations.ts [--all] [file.sql ...]
 *
 * - No args → scans packages/db/migrations/*.sql, filtered to files whose
 *   numeric prefix is >= POLICY_CUTOFF_PREFIX (older migrations are
 *   grandfathered; the additive-only policy is forward-looking — see
 *   CONTRIBUTING.md §Migration Policy).
 * - `--all` → scans all .sql files in the default directory, no cutoff.
 *   Escape hatch for ad-hoc analysis. Cannot be combined with explicit
 *   file args (file args always bypass the cutoff anyway).
 * - With file args → checks the listed files exactly (bypasses cutoff).
 * - Prints "[FAIL] <file>: <violation>" per bad file, summary, exit 1
 * - Prints "OK — N migrations pass." on success
 */

import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv, exit, stderr, stdout } from 'node:process';

export type CheckResult = { ok: true } | { ok: false; violation: string };

interface Rule {
  // Human-readable violation prefix; the matched text is appended for context.
  label: string;
  // Matches against the comment-stripped SQL. Use case-insensitive regex.
  pattern: RegExp;
  /**
   * 表の作り直し（`-- migration-policy: table-rebuild`）でだけ見逃す。
   *
   * 見逃すのはこの2つだけ。作り直しのファイルに、ついでに `DROP COLUMN` を
   * 混ぜられると、印が「何でも通る札」になる。
   */
  allowedInRebuild?: true;
}

// Order matters: more specific rules first so messages are useful.
const RULES: Rule[] = [
  {
    label: 'DROP TABLE is forbidden (additive-only migrations)',
    pattern: /\bDROP\s+TABLE\b/i,
    allowedInRebuild: true,
  },
  {
    label: 'DROP COLUMN is forbidden (additive-only migrations)',
    pattern: /\bDROP\s+COLUMN\b/i,
  },
  {
    label: 'RENAME COLUMN is forbidden (additive-only migrations)',
    pattern: /\bRENAME\s+COLUMN\b/i,
  },
  {
    label: 'ALTER COLUMN TYPE is forbidden (additive-only migrations)',
    // `ALTER COLUMN <name> TYPE <type>` and variants.
    pattern: /\bALTER\s+COLUMN\s+\S+\s+TYPE\b/i,
  },
  {
    label: 'RENAME TABLE is forbidden (additive-only migrations)',
    // `ALTER TABLE x RENAME TO y` — distinct from RENAME COLUMN.
    pattern: /\bALTER\s+TABLE\s+\S+\s+RENAME\s+TO\b/i,
    allowedInRebuild: true,
  },
  {
    label:
      'ADD COLUMN ... NOT NULL without DEFAULT is forbidden (would break existing rows)',
    // Match `ADD COLUMN <name> <type...> NOT NULL` not followed by DEFAULT
    // on the same column definition (i.e. before the next `,` `;` or end).
    // The DEFAULT must come after NOT NULL on the same column def.
    pattern: /\bADD\s+COLUMN\s+\S+[^,;]*?\bNOT\s+NULL\b(?![^,;]*\bDEFAULT\b)/i,
  },
  {
    label: 'ADD UNIQUE constraint is forbidden (may violate existing rows)',
    // `ADD UNIQUE (...)` — explicit unique constraint via ALTER TABLE.
    // Note: `CREATE UNIQUE INDEX` is intentionally allowed (separate path).
    pattern: /\bADD\s+UNIQUE\b/i,
  },
  {
    label: 'ADD CONSTRAINT ... UNIQUE is forbidden (may violate existing rows)',
    pattern: /\bADD\s+CONSTRAINT\s+\S+\s+UNIQUE\b/i,
  },
  {
    // pragma_table_info(...) / pragma_foreign_key_list(...) などの
    // テーブル値関数形式は引数が固定でも、括弧無しの `FROM pragma_x` でも
    // D1 の authorizer が SQLITE_AUTH で拒否する。
    // 文形式の `PRAGMA name` はこの規則に掛からない。
    label:
      'pragma table-valued function is forbidden (D1 authorizer rejects pragma_* with SQLITE_AUTH)',
    pattern: /\bpragma_\w+/i,
  },
  {
    // `PRAGMA foreign_key_check` は D1 が拒否した実績があり、行を返すだけで
    // 失敗にもならない。FK の最終確認はコミット時の強制と
    // `PRAGMA defer_foreign_keys = off` に委ねる。
    label:
      'PRAGMA foreign_key_check is forbidden (D1 rejects it; use commit-time enforcement)',
    pattern: /\bpragma\s+foreign_key_check\b/i,
  },
  {
    // D1 は常に foreign_keys=on 相当で、ユーザー文からの切替は拒否される。
    label:
      'PRAGMA foreign_keys is forbidden (D1 always enforces foreign keys)',
    pattern: /\bpragma\s+foreign_keys\b/i,
  },
];

/**
 * Strip `--` line comments. Block comments (`/* ... *\/`) are rare in
 * D1 migrations and ignored for now; if they appear we still get correct
 * results because the rules match real DDL anyway. Keeping the stripper
 * simple avoids accidentally hiding real code inside `/* ... *\/`.
 */
function stripLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/**
 * SQLite で CHECK 制約を変えるには、表を作り直すしかない。
 *
 * `ALTER TABLE ... ALTER COLUMN` が無いので、
 *   新しい表を作る → 中身を写す → 古い表を落とす → 名前を付け替える
 * という手順になる。この途中に `DROP TABLE` と `RENAME TO` が必ず入るので、
 * additive-only の規則と真正面からぶつかる。
 *
 * 禁止を外すのではなく、**その手順だと書いた場合だけ**通す。ファイルの
 * どこかに次の1行を入れる。
 *
 *   -- migration-policy: table-rebuild
 *
 * こうしておくと、うっかりの `DROP TABLE` は今までどおり止まり、
 * 意図した作り直しは `grep 'table-rebuild'` で全部数えられる。
 *
 * **落とす表と作る表が同じでなければ通さない。** 印を書けば何でも
 * 落とせる、では印の意味が無い。`broadcasts_new` を作って `broadcasts` を
 * 落とし、`broadcasts_new` を `broadcasts` に改名する、という組でだけ許す。
 */
const REBUILD_MARKER = /--\s*migration-policy:\s*table-rebuild\b/i;

/**
 * 作り直しの中だけで「作る→写す→元の子へ戻す→落とす」ために使う
 * 一時退避表の許可リスト。**ファイル名ごとに**名指しでだけ許す。
 * ここに無い `*_backup` の DROP は今までどおり止まる。
 */
const SIDECAR_BACKUP_TABLES: Record<string, ReadonlySet<string>> = {
  '736_line_account_tag_color_check.sql': new Set([
    'migration_736_account_folder_refs_backup',
    'migration_736_account_tag_links_backup',
  ]),
  // イメージマップ種類追加：D1のCASCADE履歴とログの参照を退避・復元する。
  '595_imagemap_message_kinds.sql': new Set([
    'migration_595_broadcast_after_action_runs_backup',
    'migration_595_broadcast_approval_events_backup',
    'migration_595_broadcast_insights_backup',
    'migration_595_broadcast_lifecycle_events_backup',
    'migration_595_broadcast_send_claims_backup',
    'migration_595_broadcast_tracked_links_backup',
    'migration_595_scenario_actions_backup',
    'migration_595_scenario_action_fires_backup',
    'migration_595_message_refs_backup',
    'migration_595_template_versions_backup',
    'migration_595_template_references_backup',
    'migration_595_template_publish_keys_backup',
    'migration_595_auto_replies_template_refs_backup',
    'migration_595_scenario_steps_template_refs_backup',
  ]),
  // 予約の受付元に「来店（walk_in）」を足す作り直しで、来店印を退避・復元する。
  '596_restaurant_walk_in.sql': new Set([
    'migration_596_seat_visit_marks_backup',
  ]),
  // 媒体の種類を増やす作り直しで、予約・取り込みメール・日次件数の参照を退避・復元する。
  '597_restaurant_media_links.sql': new Set([
    'migration_597_reservations_media_backup',
    'migration_597_inbound_emails_backup',
    'migration_597_email_digests_backup',
  ]),
  // 予約媒体のCHECK制約拡張で、既存予約と日次件数の参照を退避・復元する。
  '545_restaurant_channels.sql': new Set([
    'migration_545_media_links_backup',
    'migration_545_digests_backup',
  ]),
  '382_tags_account_name_scope.sql': new Set([
    'migration_382_tag_refs_backup',
    'migration_382_friend_tags_backup',
    'migration_382_friend_tag_side_effect_runs_backup',
  ]),
  // conversion_points 再構築で CASCADE の子表（conversion_events /
  // dedup_claims / revisions）を一時退避し、新表へ戻してから片付ける。
  '440_conversion_draft_and_ingest.sql': new Set([
    'migration_440_conversion_events_backup',
    'migration_440_dedup_claims_backup',
    'migration_440_revisions_backup',
  ]),
};

/** 印のあるファイルが、ほんとうに表の作り直しになっているか。 */
function isCoherentRebuild(stripped: string, fileName?: string): boolean {
  const created = [...stripped.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["\[`]?(\w+)["\]`]?/gi)]
    .map((m) => m[1]);
  const dropped = [...stripped.matchAll(/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["\[`]?(\w+)["\]`]?/gi)]
    .map((m) => m[1]);
  const renamed = [...stripped.matchAll(/\bALTER\s+TABLE\s+["\[`]?(\w+)["\]`]?\s+RENAME\s+TO\s+["\[`]?(\w+)["\]`]?/gi)]
    .map((m) => ({ from: m[1], to: m[2] }));

  // 落とすだけ・改名するだけは通さない。作り直しは必ず両方そろう。
  for (const table of dropped) {
    // D1 disallows TEMP tables. Migration 382 uses these three transaction-local
    // sidecars to detach FK references before replacing tags, then restores and
    // checks them before cleanup. Migration 440 backs up the CASCADE children of
    // conversion_points for the same reason. Never permit arbitrary
    // backup-table drops — only the names listed here, only in their own file.
    const sidecars = SIDECAR_BACKUP_TABLES[fileName ?? ''];
    if (sidecars?.has(table)) {
      const create = new RegExp(`\\bCREATE\\s+TABLE\\s+${table}\\s*(?:\\(|AS\\s+SELECT\\b)`, 'i').exec(stripped);
      const drop = new RegExp(`\\bDROP\\s+TABLE\\s+${table}\\s*;`, 'i').exec(stripped);
      if (created.filter(name => name === table).length === 1
        && dropped.filter(name => name === table).length === 1
        && create && drop && create.index < drop.index) continue;
      return false;
    }
    const back = renamed.find((r) => r.to === table);
    if (!back) return false;
    // 改名の元は、作り直し用と分かる `<表名>_new` / `<表名>_next` に限る。
    if (![`${table}_new`, `${table}_next`].includes(back.from)) return false;
  }
  for (const r of renamed) {
    if (![`${r.to}_new`, `${r.to}_next`].includes(r.from)) return false;
    // 改名先の表を、この一連で落としているか、既にあるか。落としていない
    // のに同じ名前へ改名すると、その時点で失敗する。
  }
  // 印だけ書いて何もしない、も通さない。
  if (dropped.length === 0 && renamed.length === 0 && created.length === 0) return false;
  return true;
}

/**
 * 印が付く前に検証・本番へ当ててしまった作り直し。
 *
 * 規則で「適用済みのマイグレーションは改名・書き換えしない」と決めている
 * ので、後から印を足せない。ここに名前で置いて通す。
 *
 * **新しく足さないこと。** これから書くものは印を使う。
 */
const GRANDFATHERED_REBUILDS = new Set([
  '134_step_message_kinds_swap.sql',
  '135_step_message_kinds_rename.sql',
  '139_step_carousel_swap.sql',
  '140_step_carousel_rename.sql',
  // いずれも印が付く前に検証・本番へ当てた
  // 作り直しで、release.yml の安全検査を毎回落としていた。
  '189_analytics_cross.sql',
  '192_inbox_v6_foundation.sql',
  '202_ec_event_account_and_identity.sql',
  '265_nen_shared_friend_add_coupon.sql',
  // 354 は旧形式の作り直し（印なし・`_v1` 命名の逆向き手順）で、
  // 検証 D1 へ適用済み（380・381 まで適用、382 のみ未適用）。
  // 適用済みのため本体は書き換えず、ここで救済する。実質は正しい作り直し
  // （全行を世代0埋めで写してから旧表を落とす）で、禁止規則・coherence 条件
  // 自体は弱めない。これ以降の追加はしないこと（新規は印を使う）。
  '354_analytics_cross_lease_generation.sql',
]);

export function checkMigration(sql: string, fileName?: string): CheckResult {
  const stripped = stripLineComments(sql);

  if (fileName && GRANDFATHERED_REBUILDS.has(fileName)) return { ok: true };

  const rebuild = REBUILD_MARKER.test(sql);
  if (rebuild && !isCoherentRebuild(stripped, fileName)) {
    return {
      ok: false,
      violation:
        'table-rebuild の印があるが、作り直しの形になっていない'
        + '（`<表名>_new` または `<表名>_next` を作って、同じ表を落とし、'
        + '`<表名>` へ改名する組でのみ許される）',
    };
  }

  for (const rule of RULES) {
    // 作り直しで見逃すのは、作り直しに必要な2つだけ。
    if (rebuild && rule.allowedInRebuild) continue;
    const m = stripped.match(rule.pattern);
    if (m) {
      return { ok: false, violation: `${rule.label} (matched: "${m[0].trim()}")` };
    }
  }
  return { ok: true };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const DEFAULT_MIGRATIONS_DIR = 'packages/db/migrations';

/**
 * The additive-only Migration Policy (CONTRIBUTING.md) is forward-looking:
 * it applies to migrations numbered >= this prefix. Earlier migrations have
 * already been applied to production D1 and cannot be rewritten — they are
 * grandfathered. Bump this only when starting a new policy era.
 *
 * ファイル名は通常3桁でゼロ埋めするが、1000以降も同じ検査へ含めるため、
 * 比較するときは文字列ではなく数値へ直す。
 */
export const POLICY_CUTOFF_PREFIX = '041';

/**
 * Filter the list of migration filenames (basenames, not full paths) to those
 * that fall under the active policy. With `all = true`, returns the input
 * unchanged (escape hatch for ad-hoc full scans).
 *
 * Files whose numeric prefix is >= POLICY_CUTOFF_PREFIX pass. Numeric prefix
 * が読めない名前は、命名を変えて検査を迂回できないよう検査対象へ残す。
 */
export function filterMigrationsByPolicy(
  names: string[],
  options: { all?: boolean } = {},
): string[] {
  if (options.all) return names;
  const cutoff = Number(POLICY_CUTOFF_PREFIX);
  return names.filter((name) => {
    const match = /^(\d+)_/.exec(name);
    if (!match) return true;
    return Number(match[1]) >= cutoff;
  });
}

function listDefaultMigrations(options: { all?: boolean } = {}): string[] {
  const dir = resolve(DEFAULT_MIGRATIONS_DIR);
  const allNames = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const names = filterMigrationsByPolicy(allNames, options);
  return names.map((f) => join(dir, f));
}

function main(rawArgs: string[]): void {
  const all = rawArgs.includes('--all');
  const fileArgs = rawArgs.filter((a) => a !== '--all');

  const usingDefaults = fileArgs.length === 0;
  const files = usingDefaults ? listDefaultMigrations({ all }) : fileArgs;

  if (usingDefaults) {
    stdout.write(
      `Policy: additive-only applied to migrations >= ${POLICY_CUTOFF_PREFIX} (CONTRIBUTING.md §Migration Policy).\n` +
        `Older migrations grandfathered. Run with --all to override.\n`,
    );
  }

  if (files.length === 0) {
    stderr.write('check-migrations: no migration files found\n');
    exit(1);
  }

  const failures: { file: string; violation: string }[] = [];
  for (const file of files) {
    const sql = readFileSync(file, 'utf8');
    const result = checkMigration(sql, basename(file));
    if (!result.ok) {
      failures.push({ file, violation: result.violation });
      stdout.write(`[FAIL] ${file}: ${result.violation}\n`);
    }
  }

  if (failures.length > 0) {
    stdout.write(`\n${failures.length} of ${files.length} migrations failed safety check.\n`);
    exit(1);
  }

  stdout.write(`OK — ${files.length} migrations pass.\n`);
}

const isCliEntry = (() => {
  if (!argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === argv[1];
  } catch {
    return false;
  }
})();

if (isCliEntry) {
  try {
    main(argv.slice(2));
  } catch (err) {
    stderr.write(`check-migrations: ${(err as Error).message}\n`);
    exit(1);
  }
}
