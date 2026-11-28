import { automationWaitLabel } from '@line-crm/shared'
import type { CommonActionStep, CommonActionResources } from '@/lib/api'

/** 処理の行の2行目（どれを・どれだけ）。選んでいないときは「〇〇を選ぶ」。 */
export function stepSummary(step: CommonActionStep, resources: CommonActionResources): string {
  if (!step || typeof step !== 'object') return ''
  const params =
    step.params && typeof step.params === 'object' && !Array.isArray(step.params)
      ? (step.params as Record<string, unknown>)
      : {}
  const res = resources && typeof resources === 'object' ? resources : ({} as Partial<CommonActionResources>)
  const nameOf = (list: unknown, id: unknown, label: string) => {
    const key = typeof id === 'string' ? id : typeof id === 'number' && Number.isFinite(id) ? String(id) : ''
    if (!key || !Array.isArray(list)) return `${label}を選ぶ`
    const found = list.find(
      (item) => item && typeof item === 'object' && (item as { id?: unknown }).id === key,
    ) as { name?: unknown } | undefined
    return found && typeof found.name === 'string' && found.name ? `${label}「${found.name}」` : `${label}を選ぶ`
  }
  switch (step.type) {
    case 'add_tag':
    case 'remove_tag':
      return nameOf(res.tags, params.tagId, 'タグ')
    case 'start_scenario':
    case 'stop_scenario':
    case 'resume_scenario':
      return nameOf(res.scenarios, params.scenarioId, 'シナリオ')
    case 'send_webhook':
      return nameOf(res.webhooks, params.webhookId, '送信先')
    case 'switch_rich_menu':
      return nameOf(res.richMenus, params.richMenuPageId, 'リッチメニュー')
    case 'common_action':
      return nameOf(res.commonActions, params.commonActionId, '共通アクション')
    case 'send_message': {
      const hasTemplateId =
        (typeof params.templateId === 'string' && params.templateId.trim() !== '') ||
        (typeof params.templateId === 'number' && Number.isFinite(params.templateId))
      if (hasTemplateId) return nameOf(res.templates, params.templateId, 'テンプレート')
      const content = typeof params.content === 'string' ? params.content.trim() : ''
      return content ? content.slice(0, 40) : '送る文を入れる'
    }
    case 'wait': return automationWaitLabel(params)
    case 'set_metadata': {
      const rawValues = params.values
      const keys =
        rawValues && typeof rawValues === 'object' && !Array.isArray(rawValues)
          ? Object.keys(rawValues as Record<string, unknown>).filter((key) => key.trim() !== '')
          : []
      return keys.length ? `友だち情報「${keys.join('・')}」` : '友だち情報を選ぶ'
    }
    case 'branch':
      return '条件に合うとき・合わないときで分ける'
    default:
      return ''
  }
}
