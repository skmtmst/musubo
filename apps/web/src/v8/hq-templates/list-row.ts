import { messageTypeText } from '@/v8/templates/public/words/index'
import { emptyValue } from '@/components/shared/empty-value'
import type { HqTemplate } from '@/lib/hq-templates-api'

/**
 * 統括のひな形一覧の行に出す小さい字。
 * 名前の下は内容の要約（例「本文・画像 1」）。要約が無い古い返事・読めない内容は今までどおり説明か種類名。
 */
export function templateSubLine(row: Pick<HqTemplate, 'content_summary' | 'description'>, typeLabel: string): string {
  const summary = row.content_summary
  if (summary != null && typeof summary !== 'string') return '内容を確認できません'
  const description = row.description
  if (!summary && description != null && typeof description !== 'string') return '内容を確認できません'
  return summary || description || typeLabel
}

/**
 * 配布先の列の2行目（例「本店・渋谷店・イベント」）。名前が4件以上なら残りを「ほか N」で足す。
 * 配っていない・名前が届かない古い返事のときは出さない（null）。
 */
export function distributedAccountsLine(row: Pick<HqTemplate, 'distributed_account_names' | 'distributed_account_more'>): string | null {
  const names = row.distributed_account_names ?? []
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) return '配布先を確認できません'
  const more = row.distributed_account_more ?? 0
  if (typeof more !== 'number' || !Number.isSafeInteger(more) || more < 0) return '配布先を確認できません'
  if (names.length === 0) return more > 0 ? '配布先を確認できません' : null
  return more > 0 ? `${names.join('・')} ほか ${more}` : names.join('・')
}

/** メッセージのタブでも、保存された形はテキスト・画像・カード型と異なる。 */
export function hqMessageTypeLabel(row: Pick<HqTemplate, 'message_type'>): string {
  return row.message_type ? messageTypeText(row.message_type) : emptyValue('unknown')
}
