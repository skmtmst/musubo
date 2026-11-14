'use client'
import { describeApiFailure } from '@/components/shared/api-error-message'
import ListState from '@/components/shared/list-state'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from '@/components/shared/list-navigation'
import { useSearchParams } from 'next/navigation'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { Check, Copy, Plus, RefreshCw, TriangleAlert, Users, X, Trash2 } from 'lucide-react'
import { isSavedSearchOpAllowed, isSavedSearchValueOptionalOp } from '@line-crm/shared'
import type { FriendField, SavedSearch, SavedSearchCondition, SavedSearchConditionKind, SavedSearchConditions, Scenario, SupportMark, Tag } from '@line-crm/shared'
import { api, ApiError, type SavedSearchDetail, type SavedSearchMatchPreview } from '@/lib/api'
import { createResponseGate } from '@/lib/latest-request'
import { useAccount } from '@/contexts/account-context'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { StickyBarAction } from '@/components/shared/sticky-bar'
import { CreatePage } from '@/components/templates'
import TargetMissing from '@/components/shared/target-missing'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { TextField } from '@/components/shared/text-field'
import { Field } from '@/components/shared/form-controls'
import DateField from '@/components/shared/date-field'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import SegmentedControl from '@/components/shared/segmented'
import IconButton from '@/components/shared/icon-button'
import HelpTip from '@/components/shared/help-tip'
import Notice from '@/components/shared/notice'
import Select from '@/components/shared/select'
import { EntityKindField } from '@/components/shared/entity-picker-sources'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { savedSearchSummary, type SavedSearchConditionLabels } from '@/components/friends/saved-search-utils'
import { AttributeKindGuide, DuplicateNameNote, findDuplicateNames } from '@/components/friend-fields/attribute-kind-guide'
import { formatDateTime, formatNumber as polishFormatNumber } from '@/lib/format'
import { optionsWithCurrent, usageRowsOf, headUsageText } from './search-model'
import styles from './search-edit.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { SettingsFormRow } from '@/components/shared/settings-form-card'

/*
 * ★V8 タグ：保存した検索の編集（一から書いた画面・2026-10-07）。Pencil 。
 *
 * 型は「作る」（CreatePage）：頭（戻る・条件名・人数と共有と使っている所）→ 左に「名前と共有」「条件」
 * 「友だち一覧での見せ方」、右に「当てはまる人」「使っている所」、下の帯（削除は左端・中央にキャンセル／複製して保存する／保存する）。
 * 動き（読み込み・切り替え時の捨て方・人数の数え直し・保存前の検査・複製・削除・未保存の確認）は
 * 今の画面（src/v8/tag-edit/search-edit）と同じ。条件の部品と検査はそこから写した。
 */

/*
 * R185: 友だち画面で作れる条件はここでも編集できるようにする。実行側
 * （saved-search-filter）が解釈できる種類はすべて並べ、知らない種類を
 * 先頭の「タグ」へ置換表示しない。回答フォーム・購入履歴は実行できる
 * ので「未接続」として削除を迫らない。
 */
const EDITABLE_KINDS: Array<{ value: SavedSearchConditionKind; label: string }> = [
  { value: 'tag', label: 'タグ' },
  { value: 'name', label: '名前' },
  { value: 'field', label: '友だち情報' },
  { value: 'status_message', label: 'ステータスメッセージ' },
  { value: 'mark', label: '対応マーク' },
  { value: 'scenario', label: 'シナリオ' },
  { value: 'assignee', label: '担当' },
  { value: 'event_booking', label: 'イベント予約' },
  { value: 'calendar_booking', label: 'カレンダー予約' },
  { value: 'form', label: '回答フォーム' },
  { value: 'purchase', label: '購入履歴' },
  { value: 'last_activity', label: '最終反応日' },
  { value: 'reminder', label: 'リマインダ' },
  { value: 'memo', label: 'メモ' },
  { value: 'common_event', label: 'その他のイベント' },
  { value: 'chat_status', label: '対応状況' },
  { value: 'following', label: '友だち状態' },
  { value: 'created_at', label: '友だち追加日' },
]

/** 存在確認だけの種類（値が無くても「ある／ない」が成立する）。 */
const EXISTENCE_KINDS = new Set<SavedSearchConditionKind>([
  'event_booking', 'calendar_booking', 'form', 'purchase', 'reminder',
])

/** 日付の範囲・前後で絞る種類。 */
const DATE_RANGE_KINDS = new Set<SavedSearchConditionKind>(['created_at', 'last_activity'])

/*
 * R185: 保存済みの旧表記（has/eq 等）を画面の主表記へ寄せる。
 * 実行側は両方を同じ意味で解釈するため、付け替えで意味は変わらない。
 */
function canonicalExistenceOp(op: string): 'exists' | 'not_exists' {
  return ['not_exists', 'not_has', 'ne'].includes(op) ? 'not_exists' : 'exists'
}

function dateRangeOf(condition: SavedSearchCondition): { from: string; to: string } {
  if (condition.value && typeof condition.value === 'object') {
    const range = condition.value as { from?: unknown; to?: unknown }
    return {
      from: typeof range.from === 'string' ? range.from : '',
      to: typeof range.to === 'string' ? range.to : '',
    }
  }
  const single = typeof condition.value === 'string' ? condition.value : ''
  if (condition.op === 'before') return { from: '', to: single }
  return { from: single, to: '' }
}

/*
  保存前の検査は実行側と同じ演算子表で合わせる（ATTR-13）。
  ここを通るのに実行で断られる組み合わせがあると、保存した本人が
  画面を離れたあとに検索が壊れる。
*/
function conditionProblem(condition: SavedSearchCondition): string | null {
  if (!isSavedSearchOpAllowed(condition.kind, condition.op)) {
    return `${EDITABLE_KINDS.find((item) => item.value === condition.kind)?.label ?? '条件'}では使えない比較方法です`
  }
  if (condition.kind === 'following') return typeof condition.value === 'boolean' ? null : '友だち状態を選んでください'
  if (DATE_RANGE_KINDS.has(condition.kind)) {
    const label = condition.kind === 'last_activity' ? '最終反応日' : '友だち追加日'
    const { from, to } = dateRangeOf(condition)
    if (!from && !to) return `${label}を入力してください`
    /* R183: 逆転期間は0人として扱わず、保存の前に断る。片側だけは許す。 */
    if (from && to && from > to) return '期間の開始日が終了日より後になっています'
    return null
  }
  if (condition.kind === 'field' && !condition.key?.trim()) return '友だち情報の項目名を入力してください'
  /*
    「登録あり／なし」は値を取らない。値の必須チェックへ落とさない。
    友だち画面で作った存在確認（予約・回答・リマインダ等）は値なしで
    保存されるため、実行側が値を要らない種類だけ値なしを許す（R185）。
    タグ等の値は引き続き必須（空で保存すると実行時に止まる）。
  */
  if ((condition.kind === 'field' || condition.kind === 'memo' || EXISTENCE_KINDS.has(condition.kind))
    && isSavedSearchValueOptionalOp(condition.op)) return null
  if (condition.kind === 'common_event' && !(typeof condition.value === 'string' && condition.value.trim())) {
    return 'その他のイベントの種類を入力してください'
  }
  return typeof condition.value === 'string' && condition.value.trim()
    ? null
    : `${EDITABLE_KINDS.find((item) => item.value === condition.kind)?.label ?? '条件'}の値を選んでください`
}

function defaultCondition(tags: Tag[]): SavedSearchCondition {
  return { kind: 'tag', op: 'includes', value: tags[0]?.id ?? '' }
}

function normalizeForEdit(search: SavedSearch): SavedSearchConditions {
  return {
    ...search.conditions,
    all: [...(search.conditions.all ?? [])],
    any: [...(search.conditions.any ?? [])],
    list: {
      columns: search.conditions.list?.columns ?? ['名前', 'タグ', '担当'],
      sort: search.conditions.list?.sort ?? 'recent',
      limit: search.conditions.list?.limit ?? 20,
    },
  }
}

/*
 * R185: 日付の範囲・前後を1つの編集欄で扱う。友だち画面は「以降」
 * （after＋日付1つ）で保存するため、文字列の値も範囲へ読み替える。
 * R183: 逆転期間は欄の下で知らせる（保存前の検査でも断る）。
 */
function DateRangeEditor({
  condition,
  onChange,
}: {
  condition: SavedSearchCondition
  onChange: (next: SavedSearchCondition) => void
}) {
  const { from, to } = dateRangeOf(condition)
  const op = condition.op === 'after' || condition.op === 'before' ? condition.op : 'between'
  const setOp = (next: string) => {
    if (next === 'after') onChange({ ...condition, op: 'after', value: from || to })
    else if (next === 'before') onChange({ ...condition, op: 'before', value: to || from })
    else onChange({ ...condition, op: 'between', value: { from, to } })
  }
  const setFrom = (v: string) => {
    if (op === 'after') onChange({ ...condition, op: 'after', value: v })
    else onChange({ ...condition, op: 'between', value: { from: v, to } })
  }
  const setTo = (v: string) => {
    if (op === 'before') onChange({ ...condition, op: 'before', value: v })
    else onChange({ ...condition, op: 'between', value: { from, to: v } })
  }
  const reversed = Boolean(from && to && from > to)
  return (
    <div className={styles.grow}>
      <div className={styles.dateRow}>
        <SaveErrorField names={["op"]}><Select aria-label="日付の比べ方" value={op} onChange={setOp} options={[{ value: 'between', label: '期間' }, { value: 'after', label: '以降' }, { value: 'before', label: '以前' }]} width={120} /></SaveErrorField>
        <Field label={<>{op === 'before' ? '終了日' : '開始日'}</>}><SaveErrorField names={["to","from"]}><DateField aria-label={op === 'before' ? '終了日' : '開始日'} value={op === 'before' ? to : from} onChange={op === 'before' ? setTo : setFrom} /></SaveErrorField></Field>
        {op === 'between' ? (
          <>
            <span className={styles.dateDash} aria-hidden="true">〜</span>
            <Field label="終了日"><SaveErrorField names={["to"]}><DateField aria-label="終了日" value={to} onChange={setTo} /></SaveErrorField></Field>
          </>
        ) : null}
      </div>
      {reversed ? <Notice tone="warn" role="alert">開始日が終了日より後になっています。入れ替えてください。</Notice> : null}
    </div>
  )
}

/** ★V8: 条件の中身の選ぶ欄・値。行の外に「かつ／または」と × を置く。 */
function ConditionControls({
  condition,
  tags,
  marks,
  scenarios,
  fields,
  forms,
  operators,
  referenceErrors,
  onChange,
}: {
  condition: SavedSearchCondition
  tags: Tag[]
  marks: SupportMark[]
  scenarios: Scenario[]
  fields: FriendField[]
  forms: Array<{ id: string; name: string }>
  operators: Array<{ id: string; name: string }>
  referenceErrors: { marks: boolean; scenarios: boolean; fields: boolean; forms: boolean; operators: boolean }
  onChange: (next: SavedSearchCondition) => void
}) {
  const changeKind = (kind: SavedSearchConditionKind) => {
    if (kind === 'tag') onChange({ kind, op: 'includes', value: tags[0]?.id ?? '' })
    else if (kind === 'field') onChange({ kind, key: fields[0]?.fieldKey ?? '', op: 'eq', value: '' })
    else if (kind === 'mark') onChange({ kind, op: 'eq', value: marks[0]?.id ?? '' })
    else if (kind === 'scenario') onChange({ kind, op: 'eq', value: scenarios[0]?.id ?? '' })
    else if (kind === 'assignee') onChange({ kind, op: 'eq', value: operators[0]?.id ?? '' })
    else if (kind === 'form') onChange({ kind, op: 'exists', value: '' })
    else if (kind === 'following') onChange({ kind, op: 'eq', value: true })
    else if (kind === 'memo') onChange({ kind, op: 'exists', value: '' })
    else if (kind === 'common_event') onChange({ kind, op: 'exists', value: '' })
    else if (EXISTENCE_KINDS.has(kind)) onChange({ kind, op: 'exists', value: '' })
    else if (DATE_RANGE_KINDS.has(kind)) onChange({ kind, op: 'between', value: { from: '', to: '' } })
    else onChange({ kind, op: kind === 'name' || kind === 'status_message' ? 'contains' : 'eq', value: '' })
  }
  const rawValue = typeof condition.value === 'string' ? condition.value : ''

  return (
    <>
      <SaveErrorField names={["kind","condition.kind"]}><Select aria-label="条件の種類" value={EDITABLE_KINDS.some((item) => item.value === condition.kind) ? condition.kind : ''} onChange={(value) => changeKind(value as SavedSearchConditionKind)} options={[{ value: '', label: '種類を選ぶ', disabled: true }, ...EDITABLE_KINDS]} width={140} /></SaveErrorField>

      {condition.kind === 'tag' ? (
        <>
          <SaveErrorField names={["op","condition.op"]}><Select aria-label="タグの比較" value={condition.op} onChange={(op) => onChange({ ...condition, op })} options={[{ value: 'includes', label: 'を含む' }, { value: 'excludes', label: 'を含まない' }]} width={120} /></SaveErrorField>
          <div className={styles.grow}>
            <SaveErrorField names={["rawValue"]}><EntityKindField kind="tag" label="タグ" value={rawValue} onChange={(value) => onChange({ ...condition, value })} options={tags} /></SaveErrorField>
          </div>
        </>
      ) : condition.kind === 'field' ? (
        <>
          <SaveErrorField names={["key","condition.key"]}><EntitySelect
            aria-label="友だち情報の項目"
            value={condition.key ?? ''}
            disabled={referenceErrors.fields}
            onChange={(key) => onChange({ ...condition, key })}
            options={optionsWithCurrent(
              fields.map((field) => ({ ...entityOptionMetadata(field), value: field.fieldKey, label: field.name })),
              condition.key ?? '',
              '選択済みの友だち情報',
              referenceErrors.fields ? '友だち情報を読み込めませんでした' : fields.length ? '友だち情報を選ぶ' : '友だち情報がありません',
            )}
            className={styles.grow}
          /></SaveErrorField>
          {/*
            実行側が解釈できるものだけを選べるようにする（ATTR-13）。
            「登録あり／なし」と大小比較は以前は画面から作れず、
            保存済みの条件に混ざると表示も保存も壊れていた。
          */}
          <SaveErrorField names={["op","condition.op"]}><Select
            aria-label="友だち情報の比較"
            value={condition.op}
            onChange={(op) => onChange({ ...condition, op, value: isSavedSearchValueOptionalOp(op) ? '' : condition.value })}
            options={[
              { value: 'eq', label: '等しい' },
              { value: 'ne', label: '等しくない' },
              { value: 'contains', label: '含む' },
              { value: 'not_contains', label: '含まない' },
              { value: 'gte', label: '以上' },
              { value: 'gt', label: 'より大きい' },
              { value: 'lte', label: '以下' },
              { value: 'lt', label: 'より小さい' },
              { value: 'exists', label: '登録あり' },
              { value: 'not_exists', label: '登録なし' },
            ]}
            width={120}
          /></SaveErrorField>
          {isSavedSearchValueOptionalOp(condition.op) ? (
            <span className={styles.growNote}>値の有無だけで絞ります。入力は不要です。</span>
          ) : (
            <SaveErrorField names={["rawValue","raw_value"]}><TextField value={rawValue} onChange={(event) => onChange({ ...condition, value: event.target.value })} placeholder="値" className={styles.grow} /></SaveErrorField>
          )}
        </>
      ) : condition.kind === 'mark' ? (
        <SaveErrorField names={["rawValue","raw_value"]}><EntitySelect
          aria-label="対応マーク"
          value={rawValue}
          disabled={referenceErrors.marks}
          onChange={(value) => onChange({ ...condition, value })}
          options={optionsWithCurrent(
            marks.map((mark) => ({ ...entityOptionMetadata(mark), value: mark.id, label: mark.name })),
            rawValue,
            '選択済みの対応マーク',
            referenceErrors.marks ? '対応マークを読み込めませんでした' : marks.length ? '対応マークを選ぶ' : '対応マークがありません',
          )}
          className={styles.grow}
        /></SaveErrorField>
      ) : condition.kind === 'scenario' ? (
        <div className={styles.grow}>
          <SaveErrorField names={["rawValue"]}><EntityKindField
            kind="scenario"
            label="シナリオ"
            value={rawValue}
            disabled={referenceErrors.scenarios}
            placeholder={referenceErrors.scenarios ? '（シナリオを読み込めませんでした）' : scenarios.length ? undefined : '（シナリオがありません）'}
            onChange={(value) => onChange({ ...condition, value })}
            options={scenarios}
          /></SaveErrorField>
        </div>
      ) : condition.kind === 'following' ? (
        <Select aria-label="友だち状態" value={condition.value === false ? 'false' : 'true'} onChange={(value) => onChange({ ...condition, value: value === 'true' })} options={[{ value: 'true', label: '友だち中' }, { value: 'false', label: 'ブロック済み' }]} className={styles.grow} />
      ) : condition.kind === 'chat_status' ? (
        <SaveErrorField names={["rawValue","raw_value"]}><Select aria-label="対応状況" value={rawValue} onChange={(value) => onChange({ ...condition, value })} options={[{ value: '', label: '対応状況を選ぶ' }, { value: 'unread', label: '未対応' }, { value: 'in_progress', label: '対応中' }, { value: 'on_hold', label: '保留' }, { value: 'resolved', label: '対応済み' }]} className={styles.grow} /></SaveErrorField>
      ) : condition.kind === 'assignee' ? (
        <>
          <Select
            aria-label="担当者の比較"
            value={condition.op === 'ne' ? 'ne' : 'eq'}
            onChange={(op) => onChange({ ...condition, op })}
            options={[{ value: 'eq', label: '次の担当' }, { value: 'ne', label: '次以外' }]}
            width={120}
          />
          <div className={styles.grow}>
            <SaveErrorField names={["rawValue"]}><EntityKindField
              kind="staff"
              label="担当"
              value={rawValue}
              candidatesStatus={referenceErrors.operators ? 'error' : 'ready'}
              disabled={referenceErrors.operators}
              placeholder={referenceErrors.operators ? '（担当者を読み込めませんでした）' : operators.length ? '（担当者を選ぶ）' : '（担当者がいません）'}
              onChange={(value) => onChange({ ...condition, value })}
              options={operators}
            /></SaveErrorField>
          </div>
        </>
      ) : condition.kind === 'form' ? (
        <>
          <SaveErrorField names={["op","condition.op"]}><Select
            aria-label="回答フォームの有無"
            value={canonicalExistenceOp(condition.op)}
            onChange={(op) => onChange({ ...condition, op })}
            options={[{ value: 'exists', label: '回答がある' }, { value: 'not_exists', label: '回答がない' }]}
            width={120}
          /></SaveErrorField>
          <SaveErrorField names={["rawValue","raw_value"]}><EntitySelect kind="form"
            aria-label="回答フォーム"
            value={rawValue}
            disabled={referenceErrors.forms}
            onChange={(value) => onChange({ ...condition, value })}
            options={optionsWithCurrent(
              forms.map((form) => ({ ...entityOptionMetadata(form), value: form.id, label: form.name })),
              rawValue,
              '選択済みの回答フォーム',
              referenceErrors.forms ? '回答フォームを読み込めませんでした' : 'すべての回答フォーム',
            )}
            className={styles.grow}
          /></SaveErrorField>
        </>
      ) : condition.kind === 'purchase' ? (
        <>
          <SaveErrorField names={["op","condition.op"]}><Select
            aria-label="購入履歴の有無"
            value={canonicalExistenceOp(condition.op)}
            onChange={(op) => onChange({ ...condition, op })}
            options={[{ value: 'exists', label: '購入がある' }, { value: 'not_exists', label: '購入がない' }]}
            width={120}
          /></SaveErrorField>
          <SaveErrorField names={["rawValue","raw_value"]}><TextField value={rawValue} onChange={(event) => onChange({ ...condition, value: event.target.value })} placeholder="空欄はすべての購入" aria-label="購入イベントの種類（空欄可）" className={styles.grow} /></SaveErrorField>
        </>
      ) : condition.kind === 'common_event' ? (
        <>
          <SaveErrorField names={["op","condition.op"]}><Select
            aria-label="その他のイベントの有無"
            value={canonicalExistenceOp(condition.op)}
            onChange={(op) => onChange({ ...condition, op })}
            options={[{ value: 'exists', label: '発生がある' }, { value: 'not_exists', label: '発生がない' }]}
            width={120}
          /></SaveErrorField>
          <SaveErrorField names={["rawValue","raw_value"]}><TextField value={rawValue} onChange={(event) => onChange({ ...condition, value: event.target.value })} placeholder="イベント種別（例：conversion）" aria-label="イベント種別" className={styles.grow} /></SaveErrorField>
        </>
      ) : condition.kind === 'memo' ? (
        <>
          <SaveErrorField names={["op","condition.op"]}><Select
            aria-label="メモの比較"
            value={['exists', 'has', 'not_exists', 'not_has', 'eq', 'contains'].includes(condition.op) ? condition.op : 'exists'}
            onChange={(op) => onChange({ ...condition, op, value: isSavedSearchValueOptionalOp(op) ? '' : condition.value })}
            options={[
              { value: 'exists', label: 'メモがある' },
              { value: 'not_exists', label: 'メモがない' },
              { value: 'eq', label: '等しい' },
              { value: 'contains', label: '含む' },
            ]}
            width={120}
          /></SaveErrorField>
          {isSavedSearchValueOptionalOp(condition.op) ? (
            <span className={styles.growNote}>有無だけで絞ります。入力は不要です。</span>
          ) : (
            <SaveErrorField names={["rawValue","raw_value"]}><TextField value={rawValue} onChange={(event) => onChange({ ...condition, value: event.target.value })} placeholder="メモの内容" aria-label="メモの内容" className={styles.grow} /></SaveErrorField>
          )}
        </>
      ) : EXISTENCE_KINDS.has(condition.kind) ? (
        <SaveErrorField names={["op","condition.op"]}><Select
          aria-label={`${EDITABLE_KINDS.find((item) => item.value === condition.kind)?.label ?? '条件'}の有無`}
          value={canonicalExistenceOp(condition.op)}
          onChange={(op) => onChange({ ...condition, op })}
          options={[{ value: 'exists', label: 'ある' }, { value: 'not_exists', label: 'ない' }]}
          width={120}
        /></SaveErrorField>
      ) : DATE_RANGE_KINDS.has(condition.kind) ? (
        <DateRangeEditor condition={condition} onChange={onChange} />
      ) : (
        <SaveErrorField names={["rawValue","raw_value"]}><TextField value={rawValue} onChange={(event) => onChange({ ...condition, value: event.target.value })} placeholder="値を入力" className={styles.grow} /></SaveErrorField>
      )}
    </>
  )
}

/** 条件1行：つなぎ（最初／かつ／または）・種類140・比べ方120・値・×（28角）。 */
function ConditionRow({
  label,
  condition,
  tags,
  marks,
  scenarios,
  fields,
  forms,
  operators,
  referenceErrors,
  onChange,
  onDelete,
  errorMessage,
}: {
  label: '最初' | 'かつ' | 'または'
  condition: SavedSearchCondition
  tags: Tag[]
  marks: SupportMark[]
  scenarios: Scenario[]
  fields: FriendField[]
  forms: Array<{ id: string; name: string }>
  operators: Array<{ id: string; name: string }>
  referenceErrors: { marks: boolean; scenarios: boolean; fields: boolean; forms: boolean; operators: boolean }
  onChange: (next: SavedSearchCondition) => void
  onDelete: () => void
  errorMessage?: string
}) {
  return (
    <Field error={errorMessage}>
    <div className={styles.conditionRow}>
      <span className={label === '最初' ? styles.opFirst : label === 'かつ' ? styles.opAnd : styles.opOr}>{label}</span>
      <ConditionControls condition={condition} tags={tags} marks={marks} scenarios={scenarios} fields={fields} forms={forms} operators={operators} referenceErrors={referenceErrors} onChange={onChange} />
      <IconButton size="small" aria-label="この条件を削除する" title="この条件を削除する" onClick={onDelete}>
        <X size={16} aria-hidden="true" />
      </IconButton>
    </div>
    </Field>
  )
}

export default function SavedSearchEditV8() {
  const saveErrors = useSaveFormErrors()

  const staffRole = useStaffRole()
  const router = useRouter()
  const params = useSearchParams()
  const id = params.get('id') ?? ''
  const { selectedAccountId, selectedAccount } = useAccount()
  const [original, setOriginal] = useState<SavedSearchDetail | null>(null)
  const [tags, setTags] = useState<Tag[]>([])
  const [marks, setMarks] = useState<SupportMark[]>([])
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [fields, setFields] = useState<FriendField[]>([])
  /* R185: 回答フォーム・担当者の条件も名前で選ぶための候補。 */
  const [forms, setForms] = useState<Array<{ id: string; name: string }>>([])
  const [operators, setOperators] = useState<Array<{ id: string; name: string }>>([])
  const [referenceErrors, setReferenceErrors] = useState({ marks: false, scenarios: false, fields: false, forms: false, operators: false })
  const [name, setName] = useState('')
  const [nameError, setNameError] = useState('')
  const [conditionsError, setConditionsError] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const conditionsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!conditionsError) return
    const first = conditionsRef.current?.querySelector<HTMLElement>('[aria-invalid="true"], input, [role="combobox"], button')
    first?.focus()
    first?.scrollIntoView({ block: 'center' })
  }, [conditionsError])
  const [conditions, setConditions] = useState<SavedSearchConditions>({ all: [], any: [] })
  const [isShared, setIsShared] = useState(false)
  /** 保存済みの総数。上限50件までの残りを共有範囲の下に出すために持つ。 */
  const [savedCount, setSavedCount] = useState<number | null>(null)
  /** IDEA-04: 同名の検索がすでにあるか確かめるための、ほかの検索の名前。 */
  const [siblingSearches, setSiblingSearches] = useState<Array<{ id: string; name: string }>>([])
  const [previewCount, setPreviewCount] = useState<number | null>(null)
  const [preview, setPreview] = useState<SavedSearchMatchPreview | null>(null)
  const [previewStale, setPreviewStale] = useState(false)
  /** 計算失敗と「まだ計算していない」を分ける。黙って0扱いしない。 */
  const [previewError, setPreviewError] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [deleteOpen, setDeleteOpen] = useState(false)
  const deleteTicket = useRef<object | null>(null)
  const renderedDeleteTicket = deleteTicket.current
  const deleteLock = useRef(false)
  /** 404・空で見つからないとき。取得の失敗（error）とは分ける。 */
  const [searchMissing, setSearchMissing] = useState(false)
  /** 失敗したあとの「もう一度読み込む」で取り直すための番号。 */
  const [reloadKey, setReloadKey] = useState(0)

  usePageTitle(original?.name ?? '保存した検索を編集')
  usePageCrumbs([{ label: 'ホーム', href: '/' }, { label: 'タグ', href: '/tags' }, { label: '保存した検索', href: '/tags?tab=searches' }])

  /*
    ATTR-12: 再計算の連打・条件変更・アカウント切替で、古い計算結果が
    新しい条件の人数を上書きしてはいけない。要求ごとに世代の印を取り、
    応答時に「いまの条件の要求か」「いまのアカウントか」を照合する。
  */
  const gateRef = useRef(createResponseGate())
  const accountRef = useRef(selectedAccountId)
  accountRef.current = selectedAccountId
  /*
   * R518: アカウントまたは検索IDの切替で飛んだ読み直しの世代。
   * 古い応答が届いても今の対象のものでなければ捨て、前のアカウントの
   * 内容を表示しない。
   */
  const loadGenerationRef = useRef(0)

  /*
   * R179: 保存直後の再計算は、保存応答の新しい版と正規化済み条件を
   * 明示的に渡す。以前は `setOriginal` の直後に保存前の `recount` を
   * 呼んでおり、クロージャの古い版で計算して409になり、人数が
   * 「未計算・人数を計算できませんでした」になっていた。
   */
  const recount = useCallback(async (next?: { revision?: number; conditions?: SavedSearchConditions }) => {
    if (!selectedAccountId || !id) return
    const account = selectedAccountId
    const token = gateRef.current.begin()
    setPreviewError('')
    try {
      const res = await api.savedSearches.preview(account, {
        savedSearchId: id,
        conditions: next?.conditions ?? conditions,
        revision: next?.revision ?? original?.revision,
      })
      if (!gateRef.current.current(token) || accountRef.current !== account) return
      setPreviewCount(res.success ? res.data.match.total : null)
      setPreview(res.success ? res.data.match : null)
      setPreviewStale(false)
      /* 応答は成功でも中身の計算が失敗していることがある（match.error）。 */
      if (!res.success) setPreviewError(res.error)
      else setPreviewError(res.data.match.error ?? '')
    } catch (saveFailure) {
      if (!gateRef.current.current(token) || accountRef.current !== account) return
      const fieldFailure = saveErrors.capture(saveFailure)
      setPreviewCount(null)
      setPreview(null)
      { if (!fieldFailure)
      setPreviewError('人数を計算できませんでした。条件を確かめて再計算してください。') }
    }
  }, [conditions, id, original?.revision, selectedAccountId, saveErrors])

  useEffect(() => {
    const generation = loadGenerationRef.current + 1
    loadGenerationRef.current = generation
    let cancelled = false
    /*
     * R518: アカウントまたは検索IDの切替時点で、前対象の表示・操作を
     * 無効にする。読み直しが終わるまで `original` を空にし、取得に失敗
     * しても前の名前・条件と複製・保存・削除が残らないようにする。
     * 飛んでいる人数の再計算も今の対象のものではないので無効にする。
     */
    gateRef.current.invalidate()
    deleteTicket.current = null
    setDeleteOpen(false)
    setOriginal(null)
    setName('')
    setConditions({ all: [], any: [] })
    setIsShared(false)
    setTags([])
    setMarks([])
    setScenarios([])
    setFields([])
    setForms([])
    setOperators([])
    setReferenceErrors({ marks: false, scenarios: false, fields: false, forms: false, operators: false })
    setSavedCount(null)
    setSiblingSearches([])
    setPreviewCount(null)
    setPreview(null)
    setPreviewStale(false)
    setPreviewError('')
    setLoading(true)
    setError('')
    setSearchMissing(false)
    if (!selectedAccountId || !id) {
      setLoading(false)
      return
    }
    void Promise.all([
      api.savedSearches.detail(id, selectedAccountId),
      api.savedSearches.list(selectedAccountId, { limit: 50 }),
      // R23横展開: タグ候補も今のアカウントだけ（条件の表示名の取り違え防止）。
      api.tags.list({ accountId: selectedAccountId }),
      api.supportMarks.list(selectedAccountId, { suppressFeatureDisabledEvent: true }).catch(() => null),
      api.scenarios.list({ accountId: selectedAccountId }).catch(() => null),
      api.friendFields.list(selectedAccountId, undefined, { suppressFeatureDisabledEvent: true }).catch(() => null),
      api.forms.list(selectedAccountId).catch(() => null),
      api.operators.list(selectedAccountId).catch(() => null),
    ]).then(([detail, searches, tagResult, markResult, scenarioResult, fieldResult, formResult, operatorResult]) => {
      // R518: 切替後に届いた古い応答は捨てる。今の対象の再試行だけを描く。
      if (cancelled || generation !== loadGenerationRef.current) return
      if(!searches.success || !tagResult.success)throw new Error('references unavailable')
      setTags(tagResult.data)
      setMarks(markResult?.success ? markResult.data : [])
      setScenarios(scenarioResult?.success ? scenarioResult.data : [])
      setFields(fieldResult?.success ? fieldResult.data : [])
      setForms(formResult?.success ? formResult.data : [])
      setOperators(operatorResult?.success ? operatorResult.data : [])
      setReferenceErrors({
        marks: markResult?.success !== true,
        scenarios: scenarioResult?.success !== true,
        fields: fieldResult?.success !== true,
        forms: formResult?.success !== true,
        operators: operatorResult?.success !== true,
      })
      setSavedCount(searches.summary.total)
      setSiblingSearches(searches.items.map((item) => ({ id: item.id, name: item.name })))
      const found = detail.success ? detail.data : null
      if (!found) {
        setError('保存した検索が見つかりません')
        setSearchMissing(true)
        return
      }
      /*
       * R184: 別の検索へ移ったときは未計算の印と前の検索の失敗を捨てる。
       * 以前は残り続け、保存済みのコピーにも「変更後は未計算」と出て
       * 不要な再読込を要求していた。飛んでいる再計算も今の検索の
       * ものではないので無効にする。
       */
      gateRef.current.invalidate()
      setPreviewStale(false)
      setOriginal(found)
      setName(found.name)
      setConditions(normalizeForEdit(found))
      setIsShared(found.isShared)
      setPreviewCount(found.matchCount ?? null)
      setPreview(found.match)
      /* IDEA-04: 計算に失敗している保存値を「計算済み」の時点付きで見せない。 */
      setPreviewError(found.match.error ?? '')
    }).catch((caught: unknown) => {
      // R518: 古い対象の失敗で今の画面を上書きしない。前の内容は既に消してある。
      if (cancelled || generation !== loadGenerationRef.current) return
      if (caught instanceof ApiError && caught.status === 404) {
        setError('保存した検索が見つかりません')
        setSearchMissing(true)
      } else {
        setError('保存した検索を読み込めませんでした')
      }
    }).finally(() => {
      if (!cancelled && generation === loadGenerationRef.current) setLoading(false)
    })
    return () => { cancelled = true }
  }, [id, reloadKey, selectedAccountId])

  const dirty = useMemo(() => {
    if (!original) return false
    return name !== original.name || isShared !== original.isShared
      || JSON.stringify(conditions) !== JSON.stringify(normalizeForEdit(original))
  }, [conditions, isShared, name, original])
  /*
   * 未保存の条件変更がある間、画面を離れる操作を止める共通の番兵（DETAIL-04系）。
   * 「保存した検索へ」「キャンセル」「該当者を確認」などのリンクも同じ確認対話へ寄せる。
   */
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy: saving })

  /*
   * IDEA-04: 変更前後の条件を人が読める形で並べる。
   * IDのまま出すと「何が変わったか」が読めないので、一覧と同じ
   * `describeSavedCondition`（savedSearchSummary）で言葉にする。
   */
  const conditionLabels = useMemo<SavedSearchConditionLabels>(() => ({
    marks: Object.fromEntries(marks.map((mark) => [mark.id, mark.name])),
    scenarios: Object.fromEntries(scenarios.map((scenario) => [scenario.id, scenario.name])),
    fields: Object.fromEntries(fields.map((field) => [field.fieldKey, field.name])),
    forms: Object.fromEntries(forms.map((form) => [form.id, form.name])),
    assignees: Object.fromEntries(operators.map((operator) => [operator.id, operator.name])),
  }), [marks, scenarios, fields, forms, operators])
  const beforeSummary = useMemo(
    () => (original ? savedSearchSummary(original.conditions, tags, conditionLabels) : []),
    [original, tags, conditionLabels],
  )
  const afterSummary = useMemo(
    () => savedSearchSummary(conditions, tags, conditionLabels),
    [conditions, tags, conditionLabels],
  )
  const nameDuplicates = useMemo(
    () => findDuplicateNames(siblingSearches, name, id),
    [siblingSearches, name, id],
  )

  const patchConditions = (next: SavedSearchConditions) => {
    /*
      条件が変わった時点で、飛んでいる再計算は今の条件のものではない。
      応答が届いても人数を上書きさせない（ATTR-12）。
    */
    gateRef.current.invalidate()
    setConditions(next)
    setConditionsError('')
    setPreviewStale(true)
  }

  const save = async () => {
    if (!selectedAccountId || !id || saving || !canManageRole(staffRole)) return
    if (!name.trim()) { setNameError('条件名を入力してください'); setError(''); nameRef.current?.focus(); nameRef.current?.scrollIntoView({ block: 'center' }); return }
    setNameError('')
    const editableConditions = [...(conditions.all ?? []), ...(conditions.any ?? [])]
    const problem = editableConditions.length === 0
      ? '条件を1つ以上追加してください'
      : editableConditions.map(conditionProblem).find(Boolean)
    if (problem) {
      setConditionsError(problem)
      setError('')
      return
    }
    setSaving(true)
    setError('')
    try {
      const res = await api.savedSearches.update(id, selectedAccountId, { name: name.trim(), conditions, isShared, expectedRevision: original?.revision ?? 1 })
      if (!res.success) { setError(res.error); return }
      const refreshed = await api.savedSearches.detail(id, selectedAccountId)
      if (!refreshed.success) throw new Error(refreshed.error)
      setOriginal(refreshed.data)
      const normalized = normalizeForEdit(refreshed.data)
      setConditions(normalized)
      setPreviewStale(false)
      /* R179: 保存応答の新しい版と正規化済み条件で数え直す。古い版では409になる。 */
      await recount({ revision: refreshed.data.revision, conditions: normalized })
    } catch (saveError) {
      const fieldFailure = saveErrors.capture(saveError)

      { if (!fieldFailure)

      setError(describeApiFailure(saveError, '保存')) }
    } finally {
      setSaving(false)
    }
  }

  const duplicate = async () => {
    if (!selectedAccountId || saving || !canManageRole(staffRole)) return
    const editableConditions = [...(conditions.all ?? []), ...(conditions.any ?? [])]
    const problem = editableConditions.length === 0
      ? '条件を1つ以上追加してください'
      : editableConditions.map(conditionProblem).find(Boolean)
    if (problem) { setConditionsError(problem); setError(''); return }
    setSaving(true)
    setError('')
    try {
      const res = await api.savedSearches.create({ name: `${name.trim() || '保存した検索'} のコピー`, accountId: selectedAccountId, conditions, isShared: false })
      /* 失敗を黙って捨てない。捨てると押しても画面が変わらず次行動が分からない。 */
      if (!res.success) { setError(res.error); return }
      router.push(`/tags/searches/edit?id=${encodeURIComponent(res.data.id)}`)
    } catch (duplicateError) {
      const fieldFailure = saveErrors.capture(duplicateError)

      { if (!fieldFailure)

      setError(describeApiFailure(duplicateError, '複製')) }
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!selectedAccountId || selectedAccountId !== accountRef.current || original?.lineAccountId !== selectedAccountId || !id || original.canDelete !== true || !canManageRole(staffRole) || !renderedDeleteTicket || renderedDeleteTicket !== deleteTicket.current || deleteLock.current) return false
    deleteLock.current = true
    try {
      await api.savedSearches.delete(id, selectedAccountId)
      if (renderedDeleteTicket !== deleteTicket.current || selectedAccountId !== accountRef.current) return false
      deleteTicket.current = null
      router.push('/tags?tab=searches')
      return true
    } catch (deleteError) {
      if (renderedDeleteTicket !== deleteTicket.current || selectedAccountId !== accountRef.current) return false
      const fieldFailure = saveErrors.capture(deleteError)

      { if (!fieldFailure)

      setError(describeApiFailure(deleteError, '削除')) }
      return false
    } finally {
      deleteLock.current = false
    }
  }

  if (loading) {
    return <SaveErrorScope errors={saveErrors}><ListState kind="loading" title="読み込み中…" /></SaveErrorScope>
  }
  if (!id) {
    return (
      <SaveErrorScope errors={saveErrors}><TargetMissing
        kind="unspecified"
        title="編集する保存した検索が指定されていません"
        description="一覧から編集する検索を選び直してください。"
        backHref="/tags?tab=searches"
        backLabel="保存した検索の一覧へ戻る"
      /></SaveErrorScope>
    )
  }
  if (!selectedAccountId) return <SaveErrorScope errors={saveErrors}><Notice tone="warn">上部でLINE公式アカウントを選んでください。</Notice></SaveErrorScope>
  /* #975 U069: 見つからないときも行き止まりにしない。一覧へ戻る道を出す。 */
  if (!original && (searchMissing || !error)) {
    return (
      <SaveErrorScope errors={saveErrors}><TargetMissing
        kind="not-found"
        title="保存した検索が見つかりません"
        description="削除されたか、別のLINEアカウントの検索です。一覧から選び直せます。"
        accountName={selectedAccount?.name}
        backHref="/tags?tab=searches"
        backLabel="保存した検索の一覧へ戻る"
      /></SaveErrorScope>
    )
  }
  if (!original) {
    return (
      <SaveErrorScope errors={saveErrors}><TargetMissing
        kind="error"
        title="保存した検索を読み込めませんでした"
        description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。"
        onRetry={() => setReloadKey((k) => k + 1)}
      /></SaveErrorScope>
    )
  }

  const allConditions = conditions.all ?? []
  const anyConditions = conditions.any ?? []
  const usageRows = usageRowsOf(original.usedIn)
  const hasLive = original.usedIn?.some((usage) => usage.mode === 'live') ?? false
  const inUse = (original.usedIn?.length ?? 0) > 0
  const countNote = previewError || preview?.error
    ? '人数をまだ数えていません。数え直してください。'
    : preview?.calculatedAt
      ? `${formatDateTime(preview.calculatedAt)} に数えた数（LINE ${preview.byChannel.line ?? emptyValue('unknown')}人・MAIL ${preview.byChannel.mail ?? emptyValue('unknown')}人）。数え直している間は古い数を出しません`
      : '保存した条件でまだ数えていません。数え直すと出ます'
  const deleteReason = original.canDelete === true ? 'この条件を削除' : original.usedIn === undefined ? '使っている所を確かめられないため削除できません' : original.usedIn.length > 0 ? `使っている所があるため削除できません（${polishFormatNumber(original.usedIn.length)} 件）` : '削除できるか確かめられません'

  const side = (
    <div className={styles.side}>
      <div className={styles.sideHead}><h2 className={styles.sideTitle}>当てはまる人</h2></div>
      <p className={styles.count}>
        {previewCount === null ? <span className={styles.countNum}>{emptyValue('unknown')}</span> : <span className={styles.countNum}>{polishFormatNumber(previewCount)}</span>}
        <span className={styles.countUnit}>人</span>
      </p>
      {previewError ? <Notice tone="danger" >{previewError}</Notice> : null}
      {previewStale ? (
        <Notice tone="warn" role="status" heading={<>条件を変えました。上の人数は変える前の条件のもので、変えたあとの条件はまだ数えていません。</>}>
          <p className={styles.staleLine}>{`変える前：${beforeSummary.length ? beforeSummary.join('・') : '条件なし'}`}</p>
          <p className={styles.staleLine}>{`変えたあと：${afterSummary.length ? afterSummary.join('・') : '条件なし'}`}</p>
        </Notice>
      ) : <p className={styles.countNote}>{countNote}</p>}
      <div className={styles.sideButtons}>
        <Button type="button" onClick={() => recount()} busyLabel="処理中…"><RefreshCw size={16} aria-hidden="true" />数え直す</Button>
        <Button href={`/friends?savedSearch=${encodeURIComponent(id)}`}><Users size={16} aria-hidden="true" />当てはまる人を見る</Button>
      </div>
      <div className={styles.sideHead}>
        <h2 className={styles.sideTitle}>使っている所</h2>
        <HelpTip label="使っている所の説明">ライブ参照：使うたびに条件で数え直し、人の出入りを反映します。固定：保存した時点の人を使い、あとから条件を変えても対象は変えません。</HelpTip>
      </div>
      <dl className={styles.useList}>
        {usageRows.map((usage) => (
          <div key={usage.label} className={styles.useRow}>
            <dt>{usage.label}</dt>
            <dd title={usage.value}>{usage.value}</dd>
          </div>
        ))}
      </dl>
      <Notice tone="info" icon={<TriangleAlert size={16} aria-hidden="true" />}>
        <span>{hasLive ? '条件を変えると、上の配信の宛先も変わります。' : inUse ? '固定で使っている所は、条件を変えても宛先は変わりません。' : '使っている所はないので、条件を変えてもほかに影響しません。'}{inUse ? '使っている間は削除できません。' : ''}</span>
      </Notice>
    </div>
  )

  if (!canManageRole(staffRole)) return <CreatePage boardId="AqDWN" title={original.name} readOnly footerActions={<Button href="/tags?tab=searches">一覧へ戻る</Button>}>{null}</CreatePage>

  return (
    <SaveErrorScope errors={saveErrors}><div className={styles.page}>
      <CreatePage
        title={original.name}
        identity={<></>}
        help={[
          previewCount === null ? '人数はまだ数えていません' : `${polishFormatNumber(previewCount)} 人が当てはまる`,
          original.isShared ? '全員に共有' : '自分だけ',
          headUsageText(original.usedIn),
        ].join('・')}
        previewLabel="検索結果と使用状況を見る"
        previewTitle="検索結果と使っている所"
        preview={side}
        destructive={(
          <StickyBarAction destructive label="削除する" icon={Trash2} disabledReason={original.canDelete === true ? undefined : deleteReason} onClick={() => { deleteTicket.current = {}; setError(''); setDeleteOpen(true) }} />
        )}
        status={dirty ? '変更内容を確かめて保存してください' : undefined}
        footerActions={(
          <>
            <Button href="/tags?tab=searches">キャンセル</Button>
            <Button type="button" disabled={saving} onClick={() => void duplicate()} busy={Boolean(saving)} busyLabel="処理中…"><Copy size={16} aria-hidden="true" />複製して保存する</Button>
            <Button type="button" variant="primary" disabled={saving || !dirty} title={!dirty ? '変更した内容はありません' : undefined} onClick={() => void save()} busy={saving}><Check size={16} aria-hidden="true" />保存する</Button>
          </>
        )} dirty={false}
      >
        {error ? <Notice tone="danger" message={error} /> : null}
        <Card variant="form" gap="normal" aria-label="名前と共有">
          <CardHeader size="stacked" title="名前と共有" />
          <Field label="条件名" required error={nameError}><SaveErrorField names={["name"]}><TextField ref={nameRef} value={name} maxLength={80} onChange={(event) => { setName(event.target.value); setNameError('') }} aria-label="条件名" /></SaveErrorField>
<DuplicateNameNote duplicates={nameDuplicates} kindLabel="保存した検索" /></Field>
          <Field label="説明"><SaveErrorField names={["description","conditions.description"]}><TextField value={conditions.description ?? ''} maxLength={300} onChange={(event) => patchConditions({ ...conditions, description: event.target.value })} placeholder="この検索を使う目的" aria-label="説明" className={styles.input} /></SaveErrorField></Field>
          <div className={styles.field}>
            <span className={styles.labelRow}>
              <span className={styles.label}>共有</span>
              {/* 設計 XBkiQ：共有を選ぶ場所で、上限と共有すると何が起きるかを先に言う。 */}
              <HelpTip label="共有の説明">{`${savedCount === null ? '保存できるのは50件までです。' : `保存できるのは50件までです（いま${polishFormatNumber(savedCount)} 件）。`}共有すると、一斉配信・オートメーションの対象条件からも呼び出せます。`}</HelpTip>
            </span>
            <SegmentedControl fit="content" aria-label="共有" value={isShared ? 'all' : 'self'} options={[{ value: 'all', label: '全員' }, { value: 'self', label: '自分だけ' }]} onChange={(value) => setIsShared(value === 'all')} />
          </div>
        </Card>

        <div ref={conditionsRef}><Card variant="form" gap="normal" aria-label="条件">
          <CardHeader size="stacked" title="条件" meta="「かつ」はすべて満たす人、「または」はどれかを満たす人に当てはまります。" />
          {allConditions.length === 0 && anyConditions.length === 0 ? <p className={styles.hint} role={conditionsError ? 'alert' : undefined}>{conditionsError || '条件はまだありません。下のボタンで足します。'}</p> : null}
          {allConditions.map((condition, index) => (
            <ConditionRow
              key={`all-${index}`}
              label={index === 0 ? '最初' : 'かつ'}
              condition={condition}
              errorMessage={conditionsError && condition === [...allConditions, ...anyConditions].find((item) => conditionProblem(item)) ? conditionsError : undefined}
              tags={tags}
              marks={marks}
              scenarios={scenarios}
              fields={fields}
              forms={forms}
              operators={operators}
              referenceErrors={referenceErrors}
              onChange={(next) => patchConditions({ ...conditions, all: allConditions.map((item, i) => i === index ? next : item) })}
              onDelete={() => patchConditions({ ...conditions, all: allConditions.filter((_, i) => i !== index) })}
            />
          ))}
          {anyConditions.map((condition, index) => (
            <ConditionRow
              key={`any-${index}`}
              label={allConditions.length === 0 && index === 0 ? '最初' : 'または'}
              condition={condition}
              errorMessage={conditionsError && condition === [...allConditions, ...anyConditions].find((item) => conditionProblem(item)) ? conditionsError : undefined}
              tags={tags}
              marks={marks}
              scenarios={scenarios}
              fields={fields}
              forms={forms}
              operators={operators}
              referenceErrors={referenceErrors}
              onChange={(next) => patchConditions({ ...conditions, any: anyConditions.map((item, i) => i === index ? next : item) })}
              onDelete={() => patchConditions({ ...conditions, any: anyConditions.filter((_, i) => i !== index) })}
            />
          ))}
          <div className={styles.addButtons}>
            <Button type="button" variant="text" onClick={() => patchConditions({ ...conditions, all: [...allConditions, defaultCondition(tags)] })}><Plus size={16} aria-hidden="true" />かつの条件を足す</Button>
            <Button type="button" variant="text" onClick={() => patchConditions({ ...conditions, any: [...anyConditions, defaultCondition(tags)] })}><Plus size={16} aria-hidden="true" />またはの条件を足す</Button>
          </div>
        </Card></div>

        <Card variant="form" gap="normal" aria-label="友だち一覧での見せ方">
          <CardHeader size="stacked" title="友だち一覧での見せ方" />
          <SettingsFormRow layout="columns">
            <div className={styles.field}>
              <span className={styles.label}>並び順</span>
              {/* R188：一覧の実装は友だち追加日順。最終接触と書くと運用者の意図とずれる。 */}
              <SaveErrorField names={["sort","conditions.list?.sort","list?.sort"]}><Select aria-label="並び順" value={conditions.list?.sort ?? 'recent'} onChange={(value) => patchConditions({ ...conditions, list: { ...conditions.list, sort: value as 'recent' | 'oldest' } })} options={[{ value: 'recent', label: '友だち追加の新しい順' }, { value: 'oldest', label: '友だち追加の古い順' }]} width={220} /></SaveErrorField>
            </div>
            <div className={styles.field}>
              <span className={styles.label}>表示件数</span>
              <SaveErrorField names={["limit","conditions.list?.limit","list?.limit"]}><Select aria-label="表示件数" value={String(conditions.list?.limit ?? 20)} onChange={(value) => patchConditions({ ...conditions, list: { ...conditions.list, limit: Number(value) as 10 | 20 | 30 | 40 | 50 } })} options={[10, 20, 30, 40, 50].map((size) => ({ value: String(size), label: `${size} 件` }))} width={120} /></SaveErrorField>
            </div>
          </SettingsFormRow>
          <p className={styles.hint}>{`表示列：${conditions.list?.columns?.join('・') || '名前・タグ・担当者'}`}</p>
        </Card>
        {/* IDEA-04：印ならタグ・値なら情報欄・条件の保存は保存した検索、という違いを編集の場所でも確かめられる。 */}
        <AttributeKindGuide current="search" />
      </CreatePage>
      <ConfirmDialog open={deleteOpen && original.canDelete === true} title={`「${name}」を削除しますか？`} description="使っている所が無いことをサーバーで確かめてあります。保存した条件だけを削除し、友だちは削除しません。" confirmLabel="削除する" destructive onCancel={() => { if (!deleteLock.current) { deleteTicket.current = null; setDeleteOpen(false) } }} error={error || undefined} onSuccess={() => { deleteTicket.current = null; setDeleteOpen(false) }} onConfirm={() => remove()}><OperationTargetSummary accounts={[{ id: original.lineAccountId ?? '', name: original.lineAccountId === selectedAccountId ? selectedAccount?.name : null }]} /></ConfirmDialog>
      <UnsavedLeaveDialog open={leaveTarget !== null} subject="検索条件への変更" busy={saving} onConfirm={confirmLeave} onCancel={cancelLeave} />
    </div></SaveErrorScope>
  )
}
