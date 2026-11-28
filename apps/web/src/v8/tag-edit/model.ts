/*
 * ★V8 タグの編集で使う小さな計算（画面から切り出して試験で確かめる）。
 */
import type { Tag } from '@line-crm/shared'
import type { TagDependencies } from '@/lib/api'
import type { LinkedAction } from '@/components/friend-fields/tag-editor-v4'

/** 今後のマイル倍率の選び口（今の画面と同じ値）。10000 で 1.0 倍。 */
export const MULTIPLIERS = [
  { value: '', label: '倍率を設定しない' },
  { value: '12000', label: '1.2倍' },
  { value: '15000', label: '1.5倍' },
  { value: '20000', label: '2.0倍' },
  { value: '30000', label: '3.0倍' },
]

/** 倍率の優先度（0 は標準）。 */
export const PRIORITIES = [0, 1, 2, 3, 4, 5].map((value) => ({ value: String(value), label: value === 0 ? '標準' : `優先度 ${value}` }))

export function multiplierLabel(value: string): string {
  return MULTIPLIERS.find((option) => option.value === value)?.label ?? '倍率を設定しない'
}

/** 動きの種類を短い呼び名に（「シナリオ開始」→「シナリオ」、「対応マーク変更」→「対応マーク」）。 */
export function actionCategory(type: string): string {
  return type.replace(/(開始|停止|追加|解除|変更|送信|更新|切替|通知|付与)$/, '') || type
}

/** タグ連動の畳んだときの1行：「3つの動き（シナリオ・タグ・対応マーク）」。 */
export function actionsSummary(actions: LinkedAction[], linked: boolean): string {
  if (!linked) return '連動はオフです（手動の付与・配信の絞り込みには使えます）'
  if (actions.length === 0) return '動きはまだありません'
  const categories = [...new Set(actions.map((action) => actionCategory(action.type)))]
  return `${actions.length}つの動き（${categories.join('・')}）`
}

/** マイルの畳んだときの1行：「今のマイル倍率 1.2倍」。倍率が無ければ付与の数を出す。 */
export function mileageSummary(multiplier: string, reward: number, referral: number): string {
  if (multiplier) return `今のマイル倍率 ${multiplierLabel(multiplier)}`
  if (reward > 0 || referral > 0) return `付くと本人 ${reward} マイル・紹介者 ${referral} マイル`
  return 'マイルの設定はありません'
}

export interface UsageRow { label: string; count: number; href: string | null; known: boolean }

const ALWAYS = [
  { key: 'broadcasts', kind: 'broadcast', label: '一斉配信' },
  { key: 'forms', kind: 'form', label: '回答フォーム' },
  { key: 'automations', kind: 'automation', label: 'オートメーション' },
] as const
const WHEN_USED = [
  { key: 'scenarios', kind: 'scenario', label: 'シナリオ' },
  { key: 'autoReplies', kind: 'auto_reply', label: '自動応答' },
  { key: 'savedSearches', kind: 'saved_search', label: '保存した検索' },
  { key: 'reminders', kind: 'reminder', label: 'リマインダ' },
  { key: 'richMenus', kind: 'rich_menu', label: 'リッチメニュー' },
  { key: 'templates', kind: 'template', label: 'テンプレート' },
  { key: 'webinars', kind: 'webinar', label: 'ウェビナー' },
  { key: 'commonActions', kind: 'common_action', label: '共通アクション' },
  { key: 'trackedLinks', kind: 'tracked_link', label: '流入リンク' },
  { key: 'entryRoutes', kind: 'entry_route', label: '友だち追加の経路' },
  { key: 'bookingMenus', kind: 'booking_menu', label: '予約メニュー' },
  { key: 'events', kind: 'event', label: 'イベント' },
  { key: 'affiliateOffers', kind: 'affiliate_offer', label: '紹介の特典' },
  { key: 'analyticsFunnels', kind: 'analytics_funnel', label: '分析の流れ' },
  { key: 'friendAddSettings', kind: 'friend_add_setting', label: '友だち追加時の配信' },
] as const

/**
 * 右の列「使っている所」の行。一斉配信・回答フォーム・オートメーションは常に出し、ほかは使っているときだけ。
 * 削除の影響確認（dependencies）の数を使い、取れないときはタグの一覧の数（usedIn）で出す。
 * 数が分からない所は「なし」と言い切らず「—」。
 */
export function buildUsageRows(dependencies: TagDependencies | null, usedIn: Tag['usedIn']): UsageRow[] {
  const counts = dependencies?.referenceCounts as Record<string, number> | undefined
  const fallback = (usedIn ?? {}) as Record<string, number | undefined>
  const references = Array.isArray(dependencies?.references) ? dependencies.references : []
  const hrefOf = (kind: string) => references.find((ref) => ref?.kind === kind)?.href ?? null
  const row = (entry: { key: string; kind: string; label: string }): UsageRow & { invalid: boolean } => {
    const fromDeps = counts?.[entry.key]
    const value = fromDeps != null ? fromDeps : fallback[entry.key]
    const valid = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    return { label: entry.label, count: valid ? value : 0, href: hrefOf(entry.kind), known: valid || (value === undefined && Boolean(counts)), invalid: value !== undefined && !valid }
  }
  return [...ALWAYS.map(row), ...WHEN_USED.map(row).filter((r) => r.count > 0 || r.invalid)].map(({ invalid: _invalid, ...result }) => result)
}
