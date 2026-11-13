'use client'
export { LARGE_PAGE_SIZE_SELECT_OPTIONS as PAGE_SIZE_OPTIONS } from '@/components/shared/page-size-options'

import { actionShortWord } from './words'



/*
 * ★V8 自動応答の一覧（Pencil「★V8 画面の地図」の自動応答の行：
 * 一覧 、行の「…」は 、止めるは 、削除は 、
 * 状態の板は ）。
 *
 * 管理画面 の一覧（app/auto-replies/page.tsx 内の AutoRepliesPageV7）とは
 * 別の部品として持つ。データの口は同じ。違いは置き場と見せ方だけ——
 * 「ルールを作る」は左のフォルダの列の上、行の右端は「…」（編集・実行結果・
 * 複製・止める/再開・フォルダへ移す・削除）、行の左の □ を選ぶと表の下に
 * まとめての帯（止める・再開・フォルダへ移す）。
 * 管理画面 を直す必要が出たら page.tsx 側も同じ判断を入れる（V8 完成までの二重管理）。
 */

/** 未分類を表す印。空文字は「すべて」なので別の値にする。 */
export const UNFILED = '__unfiled__'

export interface AutoReply {
  id: string
  keyword: string
  matchType: 'exact' | 'contains'
  responseType: string
  responseContent: string
  templateId: string | null
  lineAccountId: string | null
  isActive: boolean
  confirmationRevision: number
  activeFrom: string | null
  activeUntil: string | null
  cooldownMinutes: number | null
  skipWhenOperatorActive: boolean
  priority: number
  messageKinds: string[] | null
  receiveSources: Array<'line' | 'email'>
  actions: unknown[] | null
  responseWeekdays: number[] | null
  responseHolidayRule: string | null
  oncePerFriend: boolean
  keywords: unknown[] | null
  friendConditions: unknown | null
  respondToAll: boolean
  name: string | null
  keywordMatchMode: string
  folderId: string | null
  internalMemo: string | null
  /** 'draft'（未公開）| 'published' | 'stopped'。再開の可否を分けるのに使う。 */
  lifecycleStatus: string
  stoppedAt: string | null
  stoppedByStaffId: string | null
  stoppedByStaffName: string | null
  stopReason: string | null
  hits?: { period: number; total: number }
  actionExecutionCount?: number | null
  /** 同じ受信に当たり得る、有効な別ルールの数。 */
  conflictAttentionCount?: number | null
  createdAt: string
}

export interface TemplateLite {
  id: string
  name: string
  messageType: string
  messageContent: string
}

export interface PendingDelete {
  item: AutoReply
  /** 削除対象を選んだ時点のアカウント。切替後に古い対象を消さないために固定する。 */
  accountId: string | null
}

export interface PendingToggle {
  /** 単体なら1件、まとめてなら選んだ分。 */
  ids: string[]
  names: string[]
  /** 'stop' は専用の停止口、'resume' は再開。 */
  kind: 'stop' | 'resume'
  /** 対象を選んだ時点のアカウント。切替後に古い対象へ作用しないために固定する。 */
  accountId: string | null
  generation?: number
  allAccounts?: boolean
  targetAccountIds?: string[]
  versions?: Record<string, number>
}

/**
 * よく使う絞り込みの選ぶ欄（設計の札3つ＋選ぶ欄）。
 * 札は独立してON/OFFできる。選ぶ欄は「よく使う」1種だけ（数えられるものだけ）。
 */
export const SAVED_FILTER_OPTIONS = [
  { value: '', label: 'よく使う絞り込み' },
  { value: 'used', label: 'よく使う（今月1回以上当たった）' },
]

/**
 * 応答したときに行うことを、短い言葉で並べる（管理画面 page.tsx の actionSummary と同じ）。
 */
export function actionSummary(rule: { actions: unknown[] | null }): string[] {
  if (!Array.isArray(rule.actions)) return []
  return rule.actions.flatMap((item): string[] => {
    if (!item || typeof item !== 'object') return []
    const r = item as Record<string, unknown>
    const type = r.actionType ?? r.action_type
    if (typeof type !== 'string') return []
    return [actionShortWord(type)]
  })
}

/** 行の表示名。名前があればそれ、無ければキーワード。一律応答はキーワードが無い。 */
export function displayName(r: AutoReply): string {
  return r.name || (r.respondToAll ? 'すべてのメッセージ' : r.keyword)
}

/** 閲覧のみでも出す行の「…」の項目（見るだけのもの）。 */
export const VIEW_ONLY_MENU_IDS = new Set(['runs'])
