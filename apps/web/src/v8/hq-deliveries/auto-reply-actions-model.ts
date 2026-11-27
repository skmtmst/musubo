import type { HqDeliveryTemplateDefinition } from '@line-crm/shared'
import type { HqResourceSearchResult } from '@/lib/api/helpers/hq-resource-search'

export type HqActionResource = HqResourceSearchResult['items'][number] & { kind: 'tag' | 'scenario' }
export type HqSavedAction = Record<string, unknown>
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const kinds: Record<string, string> = { assetId: 'coupon', templateId: 'template', formId: 'form', scenarioId: 'scenario', tagIds: 'tag', tagId: 'tag', targetTagId: 'tag', visibleTagId: 'tag', fieldId: 'friend_field', triggerFieldId: 'friend_field', markId: 'mark', markIds: 'mark', eventId: 'event', triggerEventId: 'event', reminderId: 'reminder', routeIds: 'entry_route', varKey: 'common_var', folderId: 'tag_folder', notificationRuleId: 'notification_rule' }
const conditionKinds: Record<string, string> = { tag_exists: 'tag', tag_not_exists: 'tag', tag_all: 'tag', tag_not_all: 'tag', scenario_subscribed: 'scenario', form_answered: 'form', tag: 'tag', friend_field: 'friend_field', support_mark: 'mark', scenario: 'scenario', event_booking: 'event', reminder: 'reminder' }
const actionKinds: Record<string, string> = { add_tag: 'tag', remove_tag: 'tag', start_scenario: 'scenario', set_friend_field: 'friend_field', add_support_mark: 'mark', use_common_var: 'common_var' }
/** Match the existing delivery parser's reference vocabulary, including serialized conditions. */
function usedReferences(value: unknown, used = new Set<string>()): Set<string> {
  if (Array.isArray(value)) { value.forEach(item => usedReferences(item, used)); return used }
  if (!object(value)) return used
  for (const [key, child] of Object.entries(value)) {
    const kind = kinds[key] ?? (key === 'targetId' ? actionKinds[String(value.type)] : undefined)
      ?? (key === 'messageText' && ['template', 'form', 'scenario'].includes(String(value.messageType)) ? String(value.messageType) : undefined)
      ?? (key === 'value' && (typeof child === 'string' || Array.isArray(child)) ? conditionKinds[String(value.type)] : undefined)
    if (kind) for (const id of Array.isArray(child) ? child : [child]) if (typeof id === 'string' && id) used.add(`${kind}:${id}`)
    if (['responseContent', 'friendCondition', 'config_json', 'condition', 'config'].includes(key) && (key !== 'responseContent' || value.responseType === 'coupon') && typeof child === 'string') {
      try { usedReferences(JSON.parse(child), used) } catch { /* Preserve invalid saved values for the normal save validator. */ }
    } else usedReferences(child, used)
  }
  return used
}
/** Actions and their declarations are one draft change; unrelated saved references/settings stay intact. */
export function replaceHqAutoReplyActions(definition: HqDeliveryTemplateDefinition, actions: unknown[], resources: HqActionResource[]): HqDeliveryTemplateDefinition {
  const settings = { ...definition.settings, actions }
  const used = usedReferences(settings)
  const removed = usedReferences(definition.settings.actions)
  const references = (definition.references ?? []).filter(ref => !removed.has(`${ref.kind}:${ref.sourceId}`) || used.has(`${ref.kind}:${ref.sourceId}`))
  for (const resource of resources) {
    if (!used.has(`${resource.kind}:${resource.id}`) || references.some(ref => ref.sourceId === resource.id)) continue
    references.push({ sourceId: resource.id, kind: resource.kind, name: resource.name, accountId: resource.accountId })
  }
  return { ...definition, settings, references }
}
export function actionResourceIds(action: HqSavedAction): string[] {
  if (!object(action.config)) return []
  if (action.actionType === 'tag') return Array.isArray(action.config.tagIds) ? action.config.tagIds.filter((id): id is string => typeof id === 'string') : []
  return action.actionType === 'scenario' && typeof action.config.scenarioId === 'string' ? [action.config.scenarioId] : []
}
export function selectableAction(action: unknown): action is HqSavedAction {
  return object(action) && object(action.config) && (action.onFailure === undefined || action.onFailure === 'stop' || action.onFailure === 'continue') && ((action.actionType === 'tag' && (action.config.op === undefined || action.config.op === 'add' || action.config.op === 'remove')) || (action.actionType === 'scenario' && action.config.op === 'start'))
}
