import { getMediaVersionKeys } from './storage-keys.js';
import { type Media, mediaLiveContentPath, USAGE_REPLACE_PAIR_CHUNK, type MediaRefKind } from './primitives.js';
import { type MediaReplacementPlan, type MediaReplacementApplyScope, type MediaReplacementApplyResult } from './types.js';


/**
 * 使用先本文の中でメディアを指している文字列の置き換え対。
 *
 * 固定参照は版ごとのr2_key（旧版を指すものも使用中）、ライブ参照は
 * メディアIDの公開パス。どちらも文字列置換で差し替え先へ付け替えられる。
 */
export function mediaReferenceReplacePairs(
  sourceId: string,
  sourceKeys: string[],
  replacement: Media,
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const key of sourceKeys) pairs.push([key, replacement.r2_key]);
  pairs.push([mediaLiveContentPath(sourceId), mediaLiveContentPath(replacement.id)]);
  return pairs;
}

export function usageReplaceStatements(
  db: D1Database,
  opts: {
    table: string;
    columns: string[];
    scopeSql: string;
    scopeBinds: unknown[];
    idSubquery: string;
    idSubqueryBinds: unknown[];
    pairs: Array<[string, string]>;
  },
): D1PreparedStatement[] {
  if (opts.pairs.length <= USAGE_REPLACE_PAIR_CHUNK) {
    const setClause = opts.columns
      .map((column) => `${column} = ${opts.pairs.reduce((expr) => `REPLACE(${expr}, ?, ?)`, column)}`)
      .join(', ');
    const binds = opts.columns.flatMap(() => opts.pairs.flatMap(([from, to]) => [from, to]));
    return [db.prepare(
      `UPDATE ${opts.table} SET ${opts.table === 'templates' ? 'confirmation_revision=confirmation_revision+1, ' : ''}${setClause}
        WHERE ${opts.scopeSql} AND id IN (${opts.idSubquery})`,
    ).bind(...binds, ...opts.scopeBinds, ...opts.idSubqueryBinds)];
  }
  const statements: D1PreparedStatement[] = [];
  for (const column of opts.columns) {
    for (let index = 0; index < opts.pairs.length; index += USAGE_REPLACE_PAIR_CHUNK) {
      const chunk = opts.pairs.slice(index, index + USAGE_REPLACE_PAIR_CHUNK);
      const expression = chunk.reduce((expr) => `REPLACE(${expr}, ?, ?)`, column);
      // LIKE '%...%' は使わない。R2キーのような長いトークンだとD1が
      // 「LIKE or GLOB pattern too complex」で落ちる（上限50文字、実測85文字）。
      // ワイルドカード不要の部分一致なので instr にする。%・_ を
      // 誤ってワイルドカード扱いしなくなる利点もある。
      const guard = chunk.map(() => `instr(${column}, ?) > 0`).join(' OR ');
      statements.push(db.prepare(
        `UPDATE ${opts.table} SET ${opts.table === 'templates' ? 'confirmation_revision=confirmation_revision+1, ' : ''}${column} = ${expression}
          WHERE ${opts.scopeSql} AND id IN (${opts.idSubquery}) AND (${guard})`,
      ).bind(
        ...chunk.flatMap(([from, to]) => [from, to]),
        ...opts.scopeBinds,
        ...opts.idSubqueryBinds,
        ...chunk.map(([from]) => from),
      ));
    }
  }
  return statements;
}

/**
 * 使用先の書き換え対象（種類ごとの表・列・アカウント境界）。
 * 共有される配信・イベントはこの画面から書き換えない決まりなので、
 * 単一アカウント所有の行だけを対象にする条件を含む。
 */
export const REPLACEMENT_TARGET_KINDS: Record<MediaRefKind, {
  table: string;
  columns: string[];
  scopeSql: string;
} | null> = {
  template: { table: 'templates', columns: ['message_content'], scopeSql: 'line_account_id = ?' },
  broadcast: {
    table: 'broadcasts',
    columns: ['message_content', 'message_bubbles_json'],
    scopeSql: 'line_account_id = ? AND (account_ids IS NULL OR json_array_length(account_ids) <= 1)',
  },
  rich_menu: {
    table: 'rich_menu_pages',
    columns: ['image_r2_key'],
    scopeSql: `EXISTS (SELECT 1 FROM rich_menu_groups g
      WHERE g.id = rich_menu_pages.group_id AND g.account_id = ?)`,
  },
  scenario_step: {
    table: 'scenario_steps',
    columns: ['message_content', 'message_bubbles_json'],
    scopeSql: `EXISTS (SELECT 1 FROM scenarios s
      WHERE s.id = scenario_steps.scenario_id AND s.line_account_id = ?)`,
  },
  nen_column: { table: 'nen_columns', columns: ['image_url'], scopeSql: 'line_account_id = ?' },
  event: {
    table: 'events',
    columns: ['image_url', 'og_image_url'],
    scopeSql: 'line_account_id = ? AND (account_ids IS NULL OR json_array_length(account_ids) <= 1)',
  },
  // ウェビナー動画は配信用の一式を持つため対象外（describeMediaReplacementUsage
  // が必ず unsupported_reference を付けるので、ここへは到達しない）。
  webinar: null,
  booking_menu: null,
  booking_staff: null,
  booking_settings: null,
  // 公開フォームの固定版は書き換えず、編集して再公開する。
  form: null,
};

/**
 * 1文あたりの対象使用先IDの上限。
 * 版数が多いと本文置き換え文のbindが 48(置換対) + 24(LIKE) + scope に
 * なるため、IDは20件ずつに分けても最悪ケースで100 bindを超えない。
 */
export const USAGE_TARGET_ID_CHUNK = 20;
/** 台帳の付け替え条件は (ref_kind, ref_id) の組をORで並べる。2 bind/件。 */
export const USAGE_LEDGER_PAIR_CHUNK = 40;

/**
 * 影響確認済みの使用先をD1の1回のbatchで差し替える。
 *
 * 対象は計画時点のsnapshotに固定する。影響確認と実行のあいだに台帳へ
 * 増えた使用先を暗黙に含めない（含めると「確認した範囲だけ替えた」と
 * 言えなくなる）。増えた分は元メディアを指し続け、残存件数として報告する。
 *
 * `scope: 'replaceable'` は置換可能な使用先だけを替える部分実行。
 * 置換不可の使用先の本文と台帳行には一切触れない。
 */
export async function applyMediaReplacementPlan(
  db: D1Database,
  plan: MediaReplacementPlan,
  lineAccountId: string,
  opts: { scope?: MediaReplacementApplyScope } = {},
): Promise<MediaReplacementApplyResult> {
  const scope = opts.scope ?? 'all';
  // 差し替え元と先の組み合わせ自体が不正なら、全件・部分のどちらでも止める。
  if (plan.impact.blockers.includes('same_media')
    || plan.impact.blockers.includes('different_kind')) {
    throw new Error('media_replacement_blocked');
  }
  if (scope === 'all' && !plan.impact.canReplace) {
    throw new Error('media_replacement_blocked');
  }

  // references は usages と同じ順で作っている（getMediaReplacementPlan）。
  // 置換可否は計画時点の判定をそのまま使い、実行時に再判定しない。
  const targets = plan.usages.filter((usage, index) => (
    scope === 'all' ? true : plan.impact.references[index]?.replaceable === true
  ));
  if (scope === 'replaceable' && targets.length === 0) {
    throw new Error('media_replacement_blocked');
  }

  const idsByKind = new Map<MediaRefKind, string[]>();
  for (const usage of targets) {
    const kind = usage.ref_kind as MediaRefKind;
    if (!REPLACEMENT_TARGET_KINDS[kind]) {
      // 書き換え先の表が決まっていない種類を黙って残すと「替えた」と
      // 誤認する。計画側の判定と食い違う場合は実行しない。
      throw new Error('media_replacement_blocked');
    }
    const list = idsByKind.get(kind) ?? [];
    if (!list.includes(usage.ref_id)) list.push(usage.ref_id);
    idsByKind.set(kind, list);
  }

  const sourceId = plan.source.id;
  // 現行版だけでなく旧版を指す固定参照とライブ参照も同じ使用先なので、
  // 版の全r2_keyとライブ参照パスをまとめて差し替え先へ置き換える。
  const sourceKeys = [
    ...new Set([
      plan.source.r2_key,
      ...(await getMediaVersionKeys(db, sourceId)),
    ]),
  ].filter((key) => key.length > 0);
  const pairs = mediaReferenceReplacePairs(sourceId, sourceKeys, plan.replacement);

  const statements: D1PreparedStatement[] = [];
  const scenarioRevisionUpdates: D1PreparedStatement[] = [];
  for (const [kind, refIds] of idsByKind) {
    const target = REPLACEMENT_TARGET_KINDS[kind]!;
    for (let index = 0; index < refIds.length; index += USAGE_TARGET_ID_CHUNK) {
      const chunk = refIds.slice(index, index + USAGE_TARGET_ID_CHUNK);
      // 台帳に行が残っていることも条件にする。snapshot確定後に使用先から
      // 外れた行まで書き換えると、外したはずの本文が戻る。
      const idSubquery = `SELECT ref_id FROM media_usages
        WHERE media_id = ? AND ref_kind = '${kind}'
          AND ref_id IN (${chunk.map(() => '?').join(',')})`;
      statements.push(...usageReplaceStatements(db, {
        table: target.table,
        columns: target.columns,
        scopeSql: target.scopeSql,
        scopeBinds: [lineAccountId],
        idSubquery,
        idSubqueryBinds: [sourceId, ...chunk],
        pairs,
      }));
      if (kind === 'scenario_step') scenarioRevisionUpdates.push(db.prepare(
        `UPDATE scenarios SET content_revision=content_revision+1 WHERE line_account_id=? AND id IN (
          SELECT scenario_id FROM scenario_steps WHERE id IN (${idSubquery})
        )`,
      ).bind(lineAccountId, sourceId, ...chunk));
    }
  }
  const contentStatementCount = statements.length;
  statements.push(...scenarioRevisionUpdates);

  // 台帳の付け替えも対象だけに絞る。置換不可の使用先は元メディアを
  // 指し続けるので、ここで消したり移したりしない。
  for (let index = 0; index < targets.length; index += USAGE_LEDGER_PAIR_CHUNK) {
    const chunk = targets.slice(index, index + USAGE_LEDGER_PAIR_CHUNK);
    const condition = chunk.map(() => '(ref_kind = ? AND ref_id = ?)').join(' OR ');
    const binds = chunk.flatMap((usage) => [usage.ref_kind, usage.ref_id]);
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO media_usages (media_id, ref_kind, ref_id, scanned_at)
       SELECT ?, ref_kind, ref_id, ? FROM media_usages
        WHERE media_id = ? AND (${condition})`,
    ).bind(plan.replacement.id, plan.impact.checkedAt, sourceId, ...binds));
    statements.push(db.prepare(
      `DELETE FROM media_usages WHERE media_id = ? AND (${condition})`,
    ).bind(sourceId, ...binds));
  }

  const results = await db.batch(statements);
  // 末尾はmedia_usagesの付け替えなので、本文を書き換えた件数だけ数える。
  const changedRows = results.slice(0, contentStatementCount)
    .reduce((sum, result) => sum + Number(result.meta?.changes ?? 0), 0);
  return {
    changedRows,
    appliedUsageCount: targets.length,
    skippedUsageCount: plan.usages.length - targets.length,
    mode: scope === 'all' ? 'all' : 'partial',
  };
}
