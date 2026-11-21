import type { TabItem } from '@/components/shared/tabs'
import { MessageSquare, GalleryHorizontalEnd, Image as ImageIcon, HelpCircle, Ticket, ClipboardList } from 'lucide-react'
import type { TemplateKind } from '@line-crm/shared'
import type { TemplateType } from '@/lib/hq-templates-api'
/*
 * ★V8 統括のひな形の一覧を「店の同じ機能の一覧と同じ形」で出す（オーナー 2026-10-08・〜・・）。
 * 絵：テンプレート （V8.pen の行「統括」）・（V8-B 版）、回答フォーム 、タグ 、リッチメニュー 。
 *
 * 店の一覧（src/v8/templates/list.tsx）と同じ型（ListPage）・同じ共通部品（数の帯・種類のタブ・フォルダの列・表・ページ送り）・
 * 同じ見た目（店の一覧の CSS をそのまま読む）で組む。違いは「配る」口だけ：
 *   - 表の「使っている所」の代わりに「配布先」（N アカウント・まだ配っていない）
 *   - 全種類の行の右端「…」の左に［配る］（共通部品 RowQuickAction。「…」の中にも同じ項目。オーナー 2026-10-08）
 *   - 数の帯は配ったアカウントの数
 * 読み書き（一覧・分類・複製・削除・配る）は呼ぶ側（console.tsx）が今までどおり持つ。ここは見せ方と押した知らせだけ。
 */

/** 店のテンプレートと同じ6種類（上のタブ）。 */
export const KIND_TABS: { kind: TemplateKind; label: string; icon: typeof MessageSquare }[] = [
  { kind: 'message', label: 'メッセージ', icon: MessageSquare },
  { kind: 'carousel', label: 'カルーセル', icon: GalleryHorizontalEnd },
  { kind: 'rich_message', label: 'リッチメッセージ', icon: ImageIcon },
  { kind: 'rich_video', label: 'リッチビデオ', icon: ImageIcon },
  { kind: 'question', label: '質問', icon: HelpCircle },
  { kind: 'coupon', label: 'クーポン', icon: Ticket },
  { kind: 'research', label: 'リサーチ', icon: ClipboardList },
]

export const REWARD_TAB: TabItem = { label: 'マイルの景品', href: '/hq/templates?type=mileage_reward' }
export const STARTER_SET_TAB: TabItem = { label: '初期セット', href: '/hq/templates/starter-sets' }
export function hqTemplateTabsForStarterSets(): TabItem[] {
  return [...KIND_TABS.map((tab) => ({ label: tab.label, href: `/hq/templates?kind=${tab.kind}` })), REWARD_TAB, { ...STARTER_SET_TAB, current: true }]
}

export const KIND_LABEL: Record<TemplateKind, string> = Object.fromEntries(KIND_TABS.map((tab) => [tab.kind, tab.label])) as Record<TemplateKind, string>

/** 種類ごとの言葉（店の同じ機能の一覧と同じ）。 */
export const WORDS: Record<TemplateType, { title: string; item: string; create: string; search: string; description: string; column: string }> = {
  template: { title: 'テンプレート', item: 'テンプレート', create: 'テンプレートを作る', search: '名前・本文・差し込みで探す', column: 'テンプレート', description: 'メッセージのひな形を作り、各 LINE アカウントへ配ります。配ったあとに直すと、配った先へ新しい版として届きます。' },
  form: { title: '回答フォーム', item: 'フォーム', create: 'フォームを作る', search: 'フォーム名・質問文', column: 'フォーム（質問の数）', description: '回答フォームのひな形を作り、各 LINE アカウントへ配ります。配ったあとに直すと、新しい版として届きます。' },
  tag: { title: 'タグ', item: 'タグ', create: 'タグを作る', search: 'タグ名・用途で探す', column: 'タグ', description: 'タグ（タグ・入力してもらう項目・対応の印）のひな形を作り、各 LINE アカウントへ配ります。配った先で同じ名前・色で使えます。' },
  rich_menu: { title: 'リッチメニュー', item: 'メニュー', create: 'メニューを作る', search: 'メニュー名・ボタン名', column: 'メニュー', description: 'リッチメニューのひな形を作り、各 LINE アカウントへ配ります。配った先では、そのアカウントの条件で出し分けます。' },
  scenario: { title: 'シナリオ', item: 'シナリオ', create: 'シナリオを作る', search: 'シナリオ名で探す', column: 'シナリオ', description: 'シナリオのひな形を作り、停止中の下書きとして各 LINE アカウントへ配ります。' },
}

export type TagQuickFilter = 'outdated' | 'cleanup'

export const TAG_QUICK_FILTERS: readonly (readonly [TagQuickFilter, string])[] = [['outdated', '新しい版を未配布'], ['cleanup', '整理の候補（未使用・名前が重なっている）']]
