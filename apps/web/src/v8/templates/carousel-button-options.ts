import type { InlineAction } from '@/components/auto-replies/draft-fields'
import { ACTION_KINDS } from '@/components/scenarios/action-editor'

/** 「動きを実行する」の中身の1行（絵：「タグ「夏セット興味」を付ける」）。 */
export function inlineActionsText(actions: InlineAction[], tags: Array<{ id: string; name: string }>): string {
  if (actions.length === 0) return '何もしない（決める）'
  const first = actions[0]
  const config = (first.config ?? {}) as Record<string, unknown>
  let text = first.actionType === 'notify_staff' ? '担当者へ通知' : ACTION_KINDS.find((kind) => kind.type === first.actionType)?.label ?? '動きを確認できません'
  if (first.actionType === 'tag') {
    const ids = Array.isArray(config.tagIds) ? (config.tagIds as unknown[]).map(String) : []
    const tag = tags.find((item) => item.id === ids[0])
    const verb = config.op === 'remove' ? '外す' : config.op === 'add' ? '付ける' : null
    if (!verb) text = 'タグの操作を確認できません'
    else if (tag) text = `タグ「${tag.name}」を${verb}${ids.length > 1 ? ` ほか${ids.length - 1}つ` : ''}`
  }
  return actions.length > 1 ? `${text} ほか${actions.length - 1}` : text
}
