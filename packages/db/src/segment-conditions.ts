import {asString,asStringArray,asRecord,buildDateRange} from './segment-condition-values.js';
import { sqlIdSet } from './id-queries.js';
/*
 * 友だちの絞り込み条件を SQL に組み立てる。
 *
 * 成果の「数えない条件」でも
 * 同じ条件を記録時・試算時に評価する必要があるため、packages/db 側に置く。
 * worker からは `services/segment-query.js` の再公開を通して従来どおり
 * 使える。実体はここ1つ。
 *
 * 呼ばれる場所。
 *   - 一斉配信の配信対象
 *   - シナリオ全体の配信対象
 *   - シナリオ1通ごとの配信対象
 *   - シナリオのアクション1つごとの実行条件
 *   - 成果地点の数えない条件(記録・試算)
 *
 * 条件の形を1つにそろえてあるので、画面側も同じ部品で書ける。増やすときは
 * ここに1か所足せばすべてに効く。
 */

/** 友だち情報欄・共通情報で使う比較。 */
export type FieldOperator =
  | 'equals'
  | 'contains'
  | 'exists'
  | 'not_exists'
  | 'not_equals'
  | 'not_contains'
  | 'gte'
  | 'gt'
  | 'lte'
  | 'lt'

import type { SegmentCondition, SegmentRule } from '@line-crm/shared';
export type { SegmentCondition, SegmentRule } from '@line-crm/shared';

/** 名前をどの欄から探すか。 */
const NAME_COLUMNS: Record<string, string> = {
  display: 'f.display_name',
  real: 'f.real_name',
  system: 'f.system_display_name',
}

/** 反応状態。messages_log の incoming をどう数えるか。 */
const REACTION_STATES = ['any', 'reply_or_postback', 'reply', 'postback', 'none'] as const
export type ReactionState = (typeof REACTION_STATES)[number]

/** 対応状況。chats.status の値。友だち一覧・受信箱の状態名とそろえる。 */
const CHAT_STATUSES = ['unread', 'in_progress', 'on_hold', 'resolved'] as const
export type ChatStatus = (typeof CHAT_STATUSES)[number]





/**
 * 値の比較。友だち情報欄で使う。
 *
 * 数値比較 (gte/gt/lte/lt) は CAST する。友だち情報欄の値は TEXT で持って
 * いるので、文字列のまま比較すると "10" < "9" になる。
 */
function buildValueComparison(
  valueExpr: string,
  op: FieldOperator,
  text: string,
): { sql: string; bindings: unknown[] } {
  switch (op) {
    case 'equals':
      return { sql: `${valueExpr} = ?`, bindings: [text] }
    case 'not_equals':
      return { sql: `(${valueExpr} IS NULL OR ${valueExpr} != ?)`, bindings: [text] }
    case 'contains':
      return { sql: `${valueExpr} LIKE ?`, bindings: [`%${text}%`] }
    case 'not_contains':
      return { sql: `(${valueExpr} IS NULL OR ${valueExpr} NOT LIKE ?)`, bindings: [`%${text}%`] }
    case 'exists':
      return { sql: `(${valueExpr} IS NOT NULL AND ${valueExpr} != '')`, bindings: [] }
    case 'not_exists':
      return { sql: `(${valueExpr} IS NULL OR ${valueExpr} = '')`, bindings: [] }
    case 'gte':
      return { sql: `CAST(${valueExpr} AS REAL) >= ?`, bindings: [Number(text)] }
    case 'gt':
      return { sql: `CAST(${valueExpr} AS REAL) > ?`, bindings: [Number(text)] }
    case 'lte':
      return { sql: `CAST(${valueExpr} AS REAL) <= ?`, bindings: [Number(text)] }
    case 'lt':
      return { sql: `CAST(${valueExpr} AS REAL) < ?`, bindings: [Number(text)] }
    default: {
      const exhaustive: never = op
      throw new Error(`Unknown operator: ${exhaustive}`)
    }
  }
}

/** 1つのルールを WHERE 句の断片にする。 */
function buildRuleClause(rule: SegmentRule): { sql: string; bindings: unknown[] } {
  const bindings: unknown[] = []

  switch (rule.type) {
    case 'customer_segment': {
      const v=asRecord(rule.value,rule.type),r=Number(v.r),f=Number(v.f),basis=v.basis??'both',measure=v.measure??'count';
      if(![r,f].every(n=>Number.isInteger(n)&&n>=1&&n<=5)||!['visit','purchase','both'].includes(String(basis))||!['count','amount'].includes(String(measure)))throw new Error('invalid customer segment');
      return {sql:`EXISTS(SELECT 1 FROM customer_activity_daily c WHERE c.account_id=f.line_account_id AND c.friend_id=f.id AND c.basis=? AND c.r_bucket=? AND c.${measure==='amount'?'m_bucket':'f_bucket'}=?)`,bindings:[basis,r,f]};
    }
    case 'visit_count': case 'purchase_amount': {
      const v=asRecord(rule.value,rule.type),min=Number(v.min??0),max=v.max===undefined?Number.MAX_SAFE_INTEGER:Number(v.max);
      if(!Number.isFinite(min)||!Number.isFinite(max)||min<0||max<min)throw new Error('invalid customer activity range');
      const column=rule.type==='visit_count'?'activity_count':'amount',basis=rule.type==='visit_count'?'visit':'purchase';
      return {sql:`EXISTS(SELECT 1 FROM customer_activity_daily c WHERE c.account_id=f.line_account_id AND c.friend_id=f.id AND c.basis=? AND c.${column} BETWEEN ? AND ?)`,bindings:[basis,min,max]};
    }
    case 'last_activity_at': {
      const range=buildDateRange('c.last_activity_at',rule.value,rule.type);
      return {sql:`EXISTS(SELECT 1 FROM customer_activity_daily c WHERE c.account_id=f.line_account_id AND c.friend_id=f.id AND c.basis='both' AND ${range.sql})`,bindings:range.bindings};
    }
    case 'member_tier': return {sql:'EXISTS(SELECT 1 FROM member_ranks r WHERE r.account_id=f.line_account_id AND r.friend_id=f.id AND r.tier_id=?)',bindings:[asString(rule.value,rule.type)]};

    case 'friend_id_in': {
      const ids = [...new Set(asStringArray(rule.value, 'friend_id_in'))];
      // IDごとの ? を並べるとD1のbind上限へ当たる。JSONは1 bindで展開する。
      bindings.push(JSON.stringify(ids));
      return { sql: `f.id IN (SELECT value FROM json_each(?))`, bindings };
    }
    /*
     * タグIDが空のまま通すと、誰にも一致しない条件が黙って保存される。
     * 「タグで絞ったのに1人も届かない」という形で出るので、原因に辿り
     * つきにくい。書けない条件として断る。
     *
     * scenario_subscribed は空文字に「どれか1つでも」という意味があるので、
     * そちらは別扱い（下）。
     */
    case 'tag_exists': {
      const tagId = asString(rule.value, 'tag_exists')
      if (tagId === '') throw new Error('tag_exists rule requires a tag ID')
      bindings.push(tagId)
      return {
        sql: `EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)`,
        bindings,
      }
    }

    case 'tag_not_exists': {
      const tagId = asString(rule.value, 'tag_not_exists')
      if (tagId === '') throw new Error('tag_not_exists rule requires a tag ID')
      bindings.push(tagId)
      return {
        sql: `NOT EXISTS (SELECT 1 FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id = ?)`,
        bindings,
      }
    }

    /* 選択したタグを全て含む人。 */
    case 'tag_all': {
      const ids = asStringArray(rule.value, 'tag_all')
      const placeholders = sqlIdSet(ids).sql
      bindings.push(...(ids.length ? sqlIdSet(ids).binds : []), ids.length)
      return {
        sql: `(SELECT COUNT(DISTINCT ft.tag_id) FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id IN (${placeholders})) = ?`,
        bindings,
      }
    }

    /* 選択したタグを全て含む人を除外。 */
    case 'tag_not_all': {
      const ids = asStringArray(rule.value, 'tag_not_all')
      const placeholders = sqlIdSet(ids).sql
      bindings.push(...(ids.length ? sqlIdSet(ids).binds : []), ids.length)
      return {
        sql: `(SELECT COUNT(DISTINCT ft.tag_id) FROM friend_tags ft WHERE ft.friend_id = f.id AND ft.tag_id IN (${placeholders})) < ?`,
        bindings,
      }
    }

    case 'metadata_equals': {
      const mv = asRecord(rule.value, 'metadata_equals')
      if (typeof mv.key !== 'string' || typeof mv.value !== 'string') {
        throw new Error('metadata_equals rule requires { key: string; value: string }')
      }
      bindings.push(`$.${mv.key}`, mv.value)
      return { sql: `json_extract(f.metadata, ?) = ?`, bindings }
    }

    case 'metadata_not_equals': {
      const mv = asRecord(rule.value, 'metadata_not_equals')
      if (typeof mv.key !== 'string' || typeof mv.value !== 'string') {
        throw new Error('metadata_not_equals rule requires { key: string; value: string }')
      }
      bindings.push(`$.${mv.key}`, `$.${mv.key}`, mv.value)
      return { sql: `(json_extract(f.metadata, ?) IS NULL OR json_extract(f.metadata, ?) != ?)`, bindings }
    }

    case 'ref_code': {
      const code = asString(rule.value, 'ref_code')
      if (code === '') throw new Error('ref_code rule requires a value')
      bindings.push(code)
      return { sql: `f.ref_code = ?`, bindings }
    }

    case 'is_following': {
      if (typeof rule.value !== 'boolean') {
        throw new Error('is_following rule requires a boolean value')
      }
      bindings.push(rule.value ? 1 : 0)
      return { sql: `f.is_following = ?`, bindings }
    }

    case 'is_hidden': {
      if (typeof rule.value !== 'boolean') {
        throw new Error('is_hidden rule requires a boolean value')
      }
      bindings.push(rule.value ? 1 : 0)
      return { sql: `f.is_hidden = ?`, bindings }
    }

    /*
     * 対応状況（chats.status）。友だち一覧の「対応」絞り込みと同じ台帳を
     * 見る。行が無い人は chats 一覧の決まりどおり 'resolved' 扱い。
     * 友だち一覧からの条件引継ぎで使う。画面の条件ビルダーには出さない。
     */
    case 'chat_status': {
      const v = asString(rule.value, 'chat_status')
      if (!CHAT_STATUSES.includes(v as ChatStatus)) {
        throw new Error(`Unknown chat_status: ${v}`)
      }
      bindings.push(v)
      return {
        sql: `COALESCE((SELECT c.status FROM chats c WHERE c.friend_id = f.id), 'resolved') = ?`,
        bindings,
      }
    }

    /*
     * 対応の担当者（chats.operator_id）。友だち一覧の「担当者」絞り込みと
     * 同じ EXISTS 条件。友だち一覧からの条件引継ぎで使う。
     * 画面の条件ビルダーには出さない。
     */
    case 'operator_id': {
      const v = asString(rule.value, 'operator_id')
      if (v === '') throw new Error('operator_id rule requires a non-empty value')
      bindings.push(v)
      return {
        sql: `EXISTS (SELECT 1 FROM chats c WHERE c.friend_id = f.id AND COALESCE(CASE WHEN c.assignee_staff_id IS NOT NULL THEN 'staff:' || c.assignee_staff_id END, c.operator_id) = ?)`,
        bindings,
      }
    }

    /*
     * いまシナリオを購読している人。
     *
     * value が空文字なら「どれか1つでも購読していれば対象」。シナリオIDを
     * 入れると、そのシナリオを購読している人だけになる。
     *
     * 'delivering' も購読中に数える。配信の処理中というだけの状態で、
     * 外すと配信のタイミングによって対象人数が動く。'paused' と
     * 'completed' は購読中ではないので入れない。
     */
    case 'scenario_subscribed': {
      const id = asString(rule.value, 'scenario_subscribed')
      if (id === '') {
        return {
          sql: `EXISTS (SELECT 1 FROM friend_scenarios fs WHERE fs.friend_id = f.id AND fs.status IN ('active','delivering'))`,
          bindings,
        }
      }
      bindings.push(id)
      return {
        sql: `EXISTS (SELECT 1 FROM friend_scenarios fs WHERE fs.friend_id = f.id AND fs.status IN ('active','delivering') AND fs.scenario_id = ?)`,
        bindings,
      }
    }

    /*
     * シナリオの購読状態。scenario_subscribed より細かく指定する。
     *   subscribed     … いま購読中
     *   not_subscribed … いま購読していない（読み終えた人も含む）
     *   completed      … 読み終えた
     *   ever           … 1度でも購読したことがある
     */
    case 'scenario_state': {
      const v = asRecord(rule.value, 'scenario_state')
      const scenarioId = typeof v.scenarioId === 'string' ? v.scenarioId : ''
      const state = typeof v.state === 'string' ? v.state : 'subscribed'
      if (scenarioId === '') {
        throw new Error('scenario_state rule requires a scenarioId')
      }
      const scoped = `SELECT 1 FROM friend_scenarios fs WHERE fs.friend_id = f.id AND fs.scenario_id = ?`
      switch (state) {
        case 'subscribed':
          bindings.push(scenarioId)
          return { sql: `EXISTS (${scoped} AND fs.status IN ('active','delivering'))`, bindings }
        case 'not_subscribed':
          bindings.push(scenarioId)
          return { sql: `NOT EXISTS (${scoped} AND fs.status IN ('active','delivering'))`, bindings }
        case 'completed':
          bindings.push(scenarioId)
          return { sql: `EXISTS (${scoped} AND fs.status = 'completed')`, bindings }
        case 'ever':
          bindings.push(scenarioId)
          return { sql: `EXISTS (${scoped})`, bindings }
        default:
          throw new Error(`Unknown scenario_state: ${state}`)
      }
    }

    /*
     * 名前。どの欄から探すかを選べる。半角スペースで区切ると、いずれかに
     * あてはまる人が対象になる（OR）。
     */
    case 'name': {
      const v = asRecord(rule.value, 'name')
      const text = typeof v.text === 'string' ? v.text.trim() : ''
      if (text === '') {
        throw new Error('name rule requires a non-empty text')
      }
      const rawTargets = Array.isArray(v.targets) ? (v.targets as unknown[]) : []
      const targets = rawTargets.filter(
        (t): t is string => typeof t === 'string' && t in NAME_COLUMNS,
      )
      /*
       * targets の指定と未指定を区別する。空配列は「選んでいない」
       * 状態のまま保存されたもので、全欄への拡大はしない（fail-closed。
       * 空文字や空IDと同じく作り直しを促す）。未指定（古い保存形）は
       * これまでどおり全欄で探す。
       */
      if (Array.isArray(v.targets) && targets.length === 0) {
        throw new Error('name rule requires at least one target')
      }
      const columns = (targets.length > 0 ? targets : Object.keys(NAME_COLUMNS)).map(
        (t) => NAME_COLUMNS[t],
      )
      const words = text.split(/[\s　]+/).filter(Boolean)
      const perWord = words.map((word) => {
        const perColumn = columns.map((col) => {
          bindings.push(`%${word}%`)
          return `${col} LIKE ?`
        })
        return `(${perColumn.join(' OR ')})`
      })
      return { sql: `(${perWord.join(' OR ')})`, bindings }
    }

    // 保存済み条件の名前は互換性のため維持し、内容は受信箱のメモだけで探す。
    case 'private_memo': {
      const text = asString(rule.value, 'private_memo')
      if (text === '') throw new Error('private_memo rule requires a non-empty value')
      bindings.push(`%${text}%`)
      return { sql: `EXISTS (SELECT 1 FROM chats memo_chat WHERE memo_chat.friend_id = f.id AND memo_chat.notes LIKE ?)`, bindings }
    }

    case 'status_message': {
      const text = asString(rule.value, 'status_message')
      if (text === '') throw new Error('status_message rule requires a non-empty value')
      bindings.push(`%${text}%`)
      return { sql: `f.status_message LIKE ?`, bindings }
    }

    case 'registered_at':
      return buildDateRange('f.created_at', rule.value, 'registered_at')

    /* 対応マーク。複数選んだら「いずれかに一致」。 */
    case 'support_mark': {
      const v = asRecord(rule.value, 'support_mark')
      const ids = asStringArray(v.markIds, 'support_mark')
      const placeholders = sqlIdSet(ids).sql
      bindings.push(...(ids.length ? sqlIdSet(ids).binds : []))
      const inClause = `f.support_mark_id IN (${placeholders})`
      return { sql: v.exclude === true ? `(f.support_mark_id IS NULL OR NOT ${inClause})` : inClause, bindings }
    }

    /*
     * 友だち情報欄。
     *
     * 「登録なし」だけは EXISTS を反転させる必要がある。行そのものが無い人と、
     * 行はあるが空の人の両方を拾わないと、画面の見た目と食い違う。
     */
    case 'friend_field': {
      const v = asRecord(rule.value, 'friend_field')
      const fieldId = typeof v.fieldId === 'string' ? v.fieldId : ''
      if (fieldId === '') throw new Error('friend_field rule requires a fieldId')
      const op = (typeof v.op === 'string' ? v.op : 'contains') as FieldOperator
      const text = typeof v.text === 'string' ? v.text : ''
      if (op === 'not_exists') {
        bindings.push(fieldId)
        return {
          sql: `NOT EXISTS (SELECT 1 FROM friend_field_values ffv WHERE ffv.friend_id = f.id AND ffv.field_id = ? AND ffv.value IS NOT NULL AND ffv.value != '')`,
          bindings,
        }
      }
      const cmp = buildValueComparison('ffv.value', op, text)
      bindings.push(fieldId, ...cmp.bindings)
      return {
        sql: `EXISTS (SELECT 1 FROM friend_field_values ffv WHERE ffv.friend_id = f.id AND ffv.field_id = ? AND ${cmp.sql})`,
        bindings,
      }
    }

    case 'form_answered': {
      const formId = asString(rule.value, 'form_answered')
      if (formId === '') {
        return {
          sql: `EXISTS (SELECT 1 FROM form_submissions fsub WHERE fsub.friend_id = f.id)`,
          bindings,
        }
      }
      bindings.push(formId)
      return {
        sql: `EXISTS (SELECT 1 FROM form_submissions fsub WHERE fsub.friend_id = f.id AND fsub.form_id = ?)`,
        bindings,
      }
    }

    /* 最終反応日。こちらからの送信ではなく、友だちからの反応だけを見る。 */
    case 'last_reaction_at':
      return buildDateRange(
        `(SELECT MAX(ml.created_at) FROM messages_log ml WHERE ml.friend_id = f.id AND ml.direction = 'incoming')`,
        rule.value,
        'last_reaction_at',
      )

    /*
     * 反応状態。
     *
     * postback は source 列で見分ける。webhook 側が postback の incoming に
     * source='postback' を入れているので、それ以外の incoming を「返信」とする。
     */
    case 'reaction_state': {
      const state = asString(rule.value, 'reaction_state') as ReactionState
      if (!REACTION_STATES.includes(state)) {
        throw new Error(`Unknown reaction_state: ${state}`)
      }
      const anyIncoming = `EXISTS (SELECT 1 FROM messages_log ml WHERE ml.friend_id = f.id AND ml.direction = 'incoming')`
      const reply = `EXISTS (SELECT 1 FROM messages_log ml WHERE ml.friend_id = f.id AND ml.direction = 'incoming' AND (ml.source IS NULL OR ml.source != 'postback'))`
      const postback = `EXISTS (SELECT 1 FROM messages_log ml WHERE ml.friend_id = f.id AND ml.direction = 'incoming' AND ml.source = 'postback')`
      switch (state) {
        case 'any':
          return { sql: '1=1', bindings }
        case 'reply_or_postback':
          return { sql: anyIncoming, bindings }
        case 'reply':
          return { sql: reply, bindings }
        case 'postback':
          return { sql: `(${postback} AND NOT ${reply})`, bindings }
        case 'none':
          return { sql: `NOT ${anyIncoming}`, bindings }
      }
      break
    }

    /*
     * 行動スコア。friends.score は現在値の投影で、配信確定時にも同じ条件を
     * 再評価する。min / max の片方だけでもよいが、空の条件は断る。
     */
    case 'score_range': {
      const v = asRecord(rule.value, 'score_range')
      const min = typeof v.min === 'number' && Number.isInteger(v.min) ? v.min : null
      const max = typeof v.max === 'number' && Number.isInteger(v.max) ? v.max : null
      if (min === null && max === null) {
        throw new Error('score_range rule requires min or max')
      }
      if (min !== null && max !== null && min > max) {
        throw new Error('score_range rule requires min <= max')
      }
      const clauses: string[] = []
      if (min !== null) {
        clauses.push('f.score >= ?')
        bindings.push(min)
      }
      if (max !== null) {
        clauses.push('f.score <= ?')
        bindings.push(max)
      }
      /*
       * 行動スコア一覧の帯は「点数がついている人」だけを数える
       * （`f.score != 0 OR 履歴あり`）。低い帯の引き継ぎで未採点の0点まで
       * 拾わないよう、引き継ぎ側が `scoredOnly: true` を付けて同じ定義にする。
       * 付けない既存の条件は従来どおり（点数範囲だけ）。
       */
      if (v.scoredOnly === true) {
        clauses.push('(f.score != 0 OR EXISTS (SELECT 1 FROM friend_scores scored_only WHERE scored_only.friend_id = f.id))')
      }
      return { sql: `(${clauses.join(' AND ')})`, bindings }
    }

    /*
     * 分析の一時対象者。member 表の所属に加えて、アカウントと期限を
     * 評価のたびに確かめる。期限切れ・他アカウント・消えた対象者は
     * 誰にも一致しない（fail-closed）。保存・送信の直前には
     * assertAnalyticsAudiencesUsable が明示的に拒否する。
     */
    case 'analytics_audience': {
      const v = asRecord(rule.value, 'analytics_audience')
      const audienceId = typeof v.audienceId === 'string' ? v.audienceId.trim() : ''
      if (audienceId === '') {
        throw new Error('analytics_audience rule requires an audienceId')
      }
      bindings.push(audienceId, new Date().toISOString())
      return {
        sql: `EXISTS (SELECT 1 FROM analytics_result_audience_members arm
                JOIN analytics_result_audiences ara ON ara.id = arm.audience_id
               WHERE arm.friend_id = f.id AND ara.id = ?
                 AND ara.line_account_id = f.line_account_id
                 AND ara.expires_at > ?)`,
        bindings,
      }
    }

    /*
     * その配信を受け取った人のうち、計測リンクを押した人／押さなかった人。
     * 「届いた」の正本は messages_log（送信ごとに書く）。「押した」の正本は
     * broadcast_tracked_links 経由の link_clicks。押した記録が無い人は
     * 「押さなかった」側へ入る。
     */
    case 'broadcast_link_clicked': {
      const v = asRecord(rule.value, 'broadcast_link_clicked')
      const broadcastId = typeof v.broadcastId === 'string' ? v.broadcastId.trim() : ''
      if (broadcastId === '') {
        throw new Error('broadcast_link_clicked rule requires a broadcastId')
      }
      const clicked = v.clicked === true
      bindings.push(broadcastId, broadcastId)
      return {
        sql: `EXISTS (SELECT 1 FROM messages_log ml WHERE ml.friend_id = f.id AND ml.broadcast_id = ? AND ml.direction = 'outgoing')
          ${clicked ? 'AND' : 'AND NOT'} EXISTS (
            SELECT 1 FROM link_clicks lc
            JOIN broadcast_tracked_links btl ON btl.tracked_link_id = lc.tracked_link_id
            WHERE lc.friend_id = f.id AND btl.broadcast_id = ?)`,
        bindings,
      }
    }

    default: {
      throw new Error(`Unknown segment rule type: ${rule.type}`)
    }
  }
  throw new Error(`Unhandled segment rule: ${String(rule.type)}`)
}

/**
 * 条件を WHERE 句にする。グループがあれば再帰する。
 *
 * 条件が1つも無いときは 1=1 を返す。ここで 1=0 にしてしまうと、
 * 「絞り込みなし＝全員」の意味が反転して誰にも届かなくなる。
 */
export function buildSegmentWhere(condition: SegmentCondition): { sql: string; bindings: unknown[] } {
  const bindings: unknown[] = []
  const clauses: string[] = []

  for (const rule of condition.rules ?? []) {
    const built = buildRuleClause(rule)
    clauses.push(built.sql)
    bindings.push(...built.bindings)
  }

  for (const group of condition.groups ?? []) {
    const built = buildSegmentWhere(group)
    // 中身が空のグループは足さない。1=1 を AND でつなぐぶんには無害だが、
    // OR でつなぐと全員に一致してしまう。
    if ((group.rules?.length ?? 0) === 0 && (group.groups?.length ?? 0) === 0) continue
    clauses.push(`(${built.sql})`)
    bindings.push(...built.bindings)
  }

  const separator = condition.operator === 'AND' ? ' AND ' : ' OR '
  return { sql: clauses.length > 0 ? clauses.join(separator) : '1=1', bindings }
}

export function buildSegmentQuery(condition: SegmentCondition): { sql: string; bindings: unknown[] } {
  const where = buildSegmentWhere(condition)
  return {
    sql: `SELECT f.id, f.line_platform_user_id AS line_user_id, f.display_name FROM friends f WHERE ${where.sql} ORDER BY f.created_at ASC, f.id ASC`,
    bindings: where.bindings,
  }
}

/**
 * 画面や公開APIから受け取る条件を組み立てる。
 * `friend_id_in` はイベント申込者を表示時のsnapshotへ固定する内部契約であり、
 * 任意のID列を受け取る一般の条件保存口では許可しない。
 */
export function buildPublicSegmentQuery(condition: SegmentCondition): { sql: string; bindings: unknown[] } {
  const visit = (node: SegmentCondition): void => {
    for (const rule of node.rules ?? []) {
      if (rule.type === 'friend_id_in') throw new Error('friend_id_in is reserved for internal snapshots');
    }
    for (const group of node.groups ?? []) visit(group);
  };
  visit(condition);
  return buildSegmentQuery(condition);
}

/**
 * 1人が条件にあてはまるかを見る。
 *
 * 配信の直前と、アクションの実行前に呼ぶ。一覧用の SQL を組み立て直さずに
 * 同じ WHERE を使い回すので、「一覧に出た人」と「実際に届く人」がずれない。
 */
export async function matchesCondition(
  db: D1Database,
  friendId: string,
  condition: SegmentCondition | null,
): Promise<boolean> {
  if (!condition) return true
  const hasAnything = (condition.rules?.length ?? 0) > 0 || (condition.groups?.length ?? 0) > 0
  if (!hasAnything) return true

  const where = buildSegmentWhere(condition)
  const row = await db
    .prepare(`SELECT 1 AS ok FROM friends f WHERE f.id = ? AND (${where.sql}) LIMIT 1`)
    .bind(friendId, ...where.bindings)
    .first<{ ok: number }>()
  return !!row
}

/**
 * 保存されている JSON を条件として読む。
 *
 * 壊れた JSON は「条件なし」ではなく null を返して呼び出し側に判断させる。
 * 壊れているのに全員に配ってしまうのがいちばん困る。
 */
export function parseCondition(raw: string | null | undefined): SegmentCondition | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as SegmentCondition
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.operator !== 'AND' && parsed.operator !== 'OR') return null
    if (!Array.isArray(parsed.rules)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 条件が実質空か。空なら「絞り込みなし」と同じ扱いにする。
 *
 * 空の条件を持たせたまま数えると、画面は絞り込んでいるように見えて
 * 全員が対象になる。保存時もここで空を落とす。
 */
export function isEmptySegmentCondition(
  condition: SegmentCondition | null | undefined,
): boolean {
  if (!condition) return true;
  if ((condition.rules?.length ?? 0) > 0) return false;
  return !(condition.groups ?? []).some((group) => !isEmptySegmentCondition(group));
}
