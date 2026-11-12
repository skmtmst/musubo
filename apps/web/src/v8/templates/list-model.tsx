'use client'

import { PAGE_SIZE_SELECT_OPTIONS } from '@/components/shared/page-size-select'
import { type BroadcastAssetKind,type BroadcastBubble,type TemplateQuestion } from '@/lib/api'
import { contentExcerpt } from '@/lib/broadcast-summary'
import { formatNumber } from '@/lib/format'
import { ClipboardList,GalleryHorizontalEnd,HelpCircle,LayoutGrid,MessageSquare,Ticket,Video } from 'lucide-react'


/*
 * ★V8 テンプレートの一覧（Pencil「★V8 画面の地図」のテンプレートの行）。
 * 一覧 ・1152 ・閲覧のみ ・削除の確認 ・
 * 削除できない ・作る種類を選ぶ ・状態の板 。
 *
 * 動き（呼ぶ API・権限・失敗の扱い・URL の指定）は今までの V8 一覧
 * を型（ListPage）と部品で組む。
 * 動きの一覧は同じ場所の BEHAVIOR.md。
 */

/** 一覧のタブ。message/question は同じテンプレートの束を中身で分ける。 */
export type FolderCountSection = 'message' | 'question' | 'rich_video'
export type Section = FolderCountSection | BroadcastAssetKind

/** 絞り込み札。独立に切り替える（1通のみと複数通だけは片方）。 */
export type ChipKey = 'single' | 'multiple' | 'variables' | 'unused'

export interface Template {
  id: string
  confirmationRevision?: number
  accountId?: string | null
  name: string
  category: string
  messageType: string
  messageContent: string
  messageBubbles?: BroadcastBubble[] | null
  draftMessageBubbles?: BroadcastBubble[] | null
  /** 最新の下書き本文。公開版だけのときは null。 */
  draftMessageContent?: string | null
  /** 置き場。未分類は null。 */
  folderId: string | null
  question: TemplateQuestion | null
  questionStatus: 'draft' | 'published'
  usageCount: number
  tapCount: number
  monthlySendCount: number | null
  totalSendCount: number | null
  /** 公開待ちの下書きがあるか。 */
  hasDraft?: boolean
  /** 最後に公開した日時。未公開は null。 */
  publishedAt?: string | null
  createdAt: string
  updatedAt: string
}

export interface PendingDelete {
  item: Template
  /** 削除対象を選んだ時点のアカウント。切替後に古い対象を消さないために固定する。 */
  accountId: string | null
}

/** 「よく使う絞り込み」。一覧の手元のデータで数えられるものだけ。 */
export const SAVED_FILTER_OPTIONS = [
  { value: '', label: 'よく使う絞り込み' },
  { value: 'used', label: '使っている所がある' },
  { value: 'draft-changes', label: '未公開の変更あり' },
  { value: 'draft-only', label: '下書きだけ' },
]

/** 表示件数（決まり：ページ送りのある一覧は 10・20・50 件）。 */
export const PAGE_SIZE_OPTIONS = PAGE_SIZE_SELECT_OPTIONS

/** 削除できない窓に並べる行の数（残りは「ほか N か所」）。 */
export const BLOCKED_ROWS_SHOWN = 2

/** 作る種類と、それぞれの作成先。 */
export const KIND_CARDS: Array<{
  key: string
  title: string
  icon: typeof MessageSquare
  desc: string
  useFor: string
  cannot: string
  href: string
}> = [
  { key: 'message', title: 'メッセージ', icon: MessageSquare, desc: 'テキスト。差し込みも使える', useFor: 'いちばんよく使う', cannot: 'できない：答えを集める（→ 質問・リサーチ）', href: '/templates/edit' },
  { key: 'card_message', title: 'カルーセル', icon: GalleryHorizontalEnd, desc: '横にめくるカードを最大10枚', useFor: '商品の紹介に', cannot: 'できない：1枚の画像を面に分ける（→ リッチ）', href: '/templates/carousel' },
  { key: 'rich_message', title: 'リッチメッセージ', icon: LayoutGrid, desc: '1枚の画像を面に分けて、押すと動く', useFor: 'キャンペーンの告知に', cannot: 'できない：文字だけの本文（→ メッセージ）', href: '/templates/edit?kind=rich_message' },
  { key: 'rich_video', title: 'リッチビデオ', icon: Video, desc: 'トーク画面で自動で流れる動画。見終わったらボタンで案内', useFor: '新商品・お店の紹介に', cannot: 'できない：画像を面に分ける（→ リッチメッセージ）', href: '/templates/edit?kind=rich_video' },
  { key: 'question', title: '質問', icon: HelpCircle, desc: 'ボタンで答えてもらい、答えでタグなどを付ける', useFor: '好みを聞くときに', cannot: 'できない：何問も続けて聞く（→ リサーチ）', href: '/templates/questions/new' },
  { key: 'coupon', title: 'クーポン', icon: Ticket, desc: '期間・回数・抽選を決めて配る', useFor: '来店・購入のきっかけに', cannot: 'できない：本文を自由に組む（→ メッセージ）', href: '/templates/edit?kind=coupon' },
  { key: 'research', title: 'リサーチ', icon: ClipboardList, desc: 'いくつかの質問にまとめて答えてもらう', useFor: '満足度の調査に', cannot: 'できない：答えですぐタグを付ける（→ 質問）', href: '/templates/edit?kind=research' },
]

/** 検索欄と検索対象を、大小文字・全半角・空白の違いで外れない形へそろえる。 */
export function normalizeTemplateSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('ja-JP').trim().replace(/\s+/gu, ' ')
}

/** 一覧・検索は「いまの最新」を対象にする（下書きがあれば下書き）。 */
export function latestContentOf(t: Template): string {
  return t.draftMessageContent ?? t.messageContent
}

/** 一覧の本文の抜粋。テキスト以外は中身が JSON なので見て分かる1行にする（画像は「画像 1枚」）。 */
export function excerptOf(t: Template): string {
  if (t.messageType === 'image') return '画像 1枚'
  return contentExcerpt(t.messageType, latestContentOf(t), 60)
}

/** 今月送った数。数えられていないもの・一度も公開していない（送れない）ものは「—」（下書きだけの行）。 */
export function sendCountText(t: Template): string {
  if (typeof t.monthlySendCount !== 'number') return '—'
  if (t.publishedAt == null && t.monthlySendCount === 0) return '—'
  return `${formatNumber(t.monthlySendCount)} 通`
}

/** 公開の札（：公開中／未公開の変更／下書きだけ）。 */
export function publishStateOf(t: Template): { label: string; tone: 'live' | 'changes' | 'draft' } {
  if (t.publishedAt == null) return { label: '下書きだけ', tone: 'draft' }
  if (t.hasDraft) return { label: '未公開の変更', tone: 'changes' }
  return { label: '公開中', tone: 'live' }
}


export function isRichVideoTemplate(template: Template): boolean {
  if (template.messageType !== 'imagemap') return false
  try { return Boolean(JSON.parse(latestContentOf(template)).video) } catch { return false }
}

/** 本文の空行やカルーセルは複数メッセージではない。公開版か下書きのいずれかに複数通があるかを見る。 */
export function hasMultipleMessages(t: Template): boolean {
  return (t.messageBubbles?.length ?? 0) > 1 || (t.hasDraft && (t.draftMessageBubbles?.length ?? 0) > 1) === true
}
