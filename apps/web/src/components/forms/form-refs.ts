'use client'

/**
 * ビルダーが参照する、他の機能の一覧。
 *
 * タグ・友だち情報欄・シナリオ・リマインダ・テンプレートは、フォームの
 * あちこち（選択肢の動作・登録先・回答後の動作）から同じものを引く。
 * 画面ごとに読み直すと、同じ一覧を何度も取りに行くことになるので、
 * 編集画面で1回だけ読んで、この形で下へ配る。
 */
export interface FormRefs {
  tags: { id: string; name: string }[]
  friendFields: { id: string; name: string; ecIsMaster: boolean }[]
  scenarios: { id: string; name: string }[]
  reminders: { id: string; name: string }[]
  templates: { id: string; name: string; type: string }[]
  /** 「予約を入れる」欄のメニュー選び。HQなど持たない画面では空のまま */
  bookingMenus?: { id: string; name: string; durationMinutes: number }[]
  bookingGroups?: { id: string; name: string; menuIds?: string[] }[]
  routingMenus?: { id: string; name: string; durationMinutes: number }[]
  routingMenuStaff?: Record<string, { id: string; name: string }[]>
  bookingGroupsError?: boolean
  /** メニューごとの担当選び。読んでいないメニューは不在＝まだ読んでいない */
  bookingMenuStaff?: Record<string, { id: string; name: string }[]>
}

export const EMPTY_REFS: FormRefs = {
  tags: [],
  friendFields: [],
  scenarios: [],
  reminders: [],
  templates: [],
}

/** 入力欄の見た目。編集画面のどこでも同じ枠にする。 */
export const fieldInput =
  'border-hairline rounded-control bg-canvas text-ink focus:ring-accent w-full border px-3 py-2 text-sm focus:ring-2 focus:outline-none'

export const fieldSelect =
  'border-hairline rounded-control bg-canvas text-ink focus:ring-accent border px-3 py-2 text-sm focus:ring-2 focus:outline-none'

/** 小さめの入力欄。表の中で使う。 */
export const cellInput =
  'border-hairline rounded-control bg-canvas text-ink focus:ring-accent w-full border px-2 py-1.5 text-sm focus:ring-2 focus:outline-none'

/** 押せる小さなボタン（追加・複製など）。 */
export const miniButton =
  'text-accent-deep hover:bg-accent-soft rounded-control px-2 py-1 text-xs font-medium transition-colors'
