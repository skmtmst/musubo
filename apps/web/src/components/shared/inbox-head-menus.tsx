'use client'

import { StatusDot, SUPPORT_STATUS_TONES } from '@/components/shared/status-pill'
import Select from '@/components/shared/select'
import { buildOperatorRows, type OperatorOption } from '@/components/chats/inbox-dropdown'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'


/*
 * ★V8 会話の頭の「担当」「対応状況」（ XqSvX の頭・段2「5. 会話の頭のメニュー」）。
 *
 * どちらも1つだけ選ぶもの。共通の選ぶ欄（shared/select）を使う。V8 の選ぶ欄は
 * 四角い箱を出さず、選んでいる行は ✓ だけ（オーナー指摘：複数選べないのにチェックボックス）。
 * 対応状況は先頭に状態の色の点。LINE の会話もメールの会話も、この同じ部品を使う。
 */

export type HeadStatus = 'unread' | 'in_progress' | 'on_hold' | 'resolved'

export const HEAD_STATUS_LABEL: Record<HeadStatus, string> = {
  unread: '未対応',
  in_progress: '対応中',
  on_hold: '保留',
  resolved: '対応済み',
}
const STATUS_ORDER: HeadStatus[] = ['unread', 'in_progress', 'on_hold', 'resolved']

/** 絵の担当の箱の幅（担当：Kenta）。名前が長いときは省略し、全文は title で読める。 */
const OPERATOR_WIDTH = 116
/**
 * 絵の対応状況の箱は中身の幅（● 未対応 ⌄ ＝101、● 対応済み ⌄ ＝114）。
 * 左右の余白・丸・矢印・間で 62、文字は13px の全角で 1字13。
 */
const STATUS_FIXED_WIDTH = 62
const STATUS_CHAR_WIDTH = 13

export function HeadOperatorMenu({
  value,
  operators,
  onChange,
  ariaLabel = '担当者を変える',
  compact = false,
  lockedReason,
}: {
  /** 担当者ID。未割り当ては 'unassigned' */
  value: string
  operators: OperatorOption[]
  onChange: (next: string) => void
  ariaLabel?: string
  compact?: boolean
  /** 変えられない理由。隠さず灰色にして、乗せた時・焦点を当てた時に吹き出しで出す。 */
  lockedReason?: string
}) {
  const rows = buildOperatorRows(operators, false, value)
  return (
    <span data-compact-operator={compact || undefined} title={`担当：${rows.find(row => row.id === value)?.name ?? '未割り当て'}`} data-initial={(rows.find(row => row.id === value)?.name ?? '未').charAt(0)}><SaveErrorField names={["value", "operatorId", "operator_id"]}><EntitySelect
      aria-label={ariaLabel}
      label="担当"
      width={compact ? 36 : OPERATOR_WIDTH}
      actionHidden
      valuePrefix="担当："
      value={value}
      onChange={onChange}
      lockedReason={lockedReason}
      options={rows.map((row) => ({ ...entityOptionMetadata(row), value: row.id, label: row.name, disabled: row.disabled }))}
    /></SaveErrorField></span>
  )
}

export function HeadStatusMenu({
  value,
  onChange,
  ariaLabel = '対応状況を変える',
  lockedReason,
}: {
  value: HeadStatus
  onChange: (next: HeadStatus) => void
  ariaLabel?: string
  /** 変えられない理由。隠さず灰色にして、乗せた時・焦点を当てた時に吹き出しで出す。 */
  lockedReason?: string
}) {
  return (
    <SaveErrorField names={["value", "status"]}><Select
      aria-label={ariaLabel}
      width={STATUS_FIXED_WIDTH + STATUS_CHAR_WIDTH * HEAD_STATUS_LABEL[value].length}
      treatment="pill"
      icon={<StatusDot tone={SUPPORT_STATUS_TONES[value]} />}
      value={value}
      lockedReason={lockedReason}
      onChange={(next) => onChange(next as HeadStatus)}
      // 開いた中身の行にも状態の色の点（jvb3W「5. 会話の頭のメニュー」）。
      options={STATUS_ORDER.map((status) => ({
        value: status,
        label: HEAD_STATUS_LABEL[status],
        tone: SUPPORT_STATUS_TONES[status],
        leading: <StatusDot tone={SUPPORT_STATUS_TONES[status]} />,
      }))}
    /></SaveErrorField>
  )
}
