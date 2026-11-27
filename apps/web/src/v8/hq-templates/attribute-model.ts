import type { FriendField, HqFriendFieldDefinition, HqFriendAttributeDetail, HqTemplateFolder } from '@line-crm/shared'
import type { SupportMarkListItem } from '@/lib/api'
import type { FieldEditorValues } from '@/v8/tags/public/field-editor/index'

export function fieldOf(detail: Extract<HqFriendAttributeDetail, { definition: HqFriendFieldDefinition }>, count?: number | null): FriendField {
  const field = detail.definition.field
  const definitions = (field.options ?? []).map((option, index) => typeof option === 'string' ? { id: `option_${index + 1}`, label: option } : option)
  return {
    id: detail.template.id, name: field.name, fieldKey: field.fieldKey, type: field.type,
    folderId: detail.template.folder_id ?? null, options: definitions.filter((option) => !('status' in option) || option.status !== 'archived').map((option) => option.label),
    optionDefinitions: definitions, defaultValue: field.defaultValue ?? null, source: field.source ?? 'manual',
    ecFieldPath: field.ecFieldPath ?? null, ecIsMaster: field.ecIsMaster ?? false,
    isPersonal: field.isPersonal ?? false, isStarred: field.isStarred ?? false, displayOrder: field.displayOrder ?? 0,
    createdAt: '', updatedAt: detail.template.updated_at, version: detail.template.revision,
    ...(typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? { usageCount: count } : {}),
  }
}
export function markOf(detail: HqFriendAttributeDetail, count?: number | null): SupportMarkListItem {
  if (!('mark' in detail.definition)) throw new Error('対応マークの保存内容を確認できません')
  return { id: detail.template.id, ...detail.definition.mark, name: detail.template.name,
    color: detail.definition.mark.color ?? '#3B82F6', isDefault: detail.definition.mark.isDefault ?? false,
    autoOnInbound: detail.definition.mark.autoOnInbound ?? false, displayOrder: detail.definition.mark.displayOrder ?? 0,
    createdAt: '', updatedAt: detail.template.updated_at, version: detail.template.revision,
    // 人数未取得は描画時に「—」。0へ読み替えない。
    friendCount: count as number, automationRules: [],
  }
}
export function fieldDefinition(values: FieldEditorValues, previous: HqFriendFieldDefinition | null, folders: HqTemplateFolder[], sameFolder: boolean): HqFriendFieldDefinition {
  const oldOptions = (previous?.field.options ?? []).map((option, index) => typeof option === 'string' ? { id: `option_${index + 1}`, label: option } : option)
  const options = values.options?.map((label, index) => {
    const previousOption = oldOptions.find((option) => values.optionIds?.[index] ? option.id === values.optionIds[index] : option.label === label)
    return { ...previousOption, id: previousOption?.id ?? `option_${crypto.randomUUID()}`, label, status: 'active' as const, displayOrder: index }
  }) ?? []
  const removed = oldOptions.filter((option) => !options.some((next) => next.id === option.id)).map((option) => ({ ...option, status: 'archived' as const }))
  const idFor = (label: string) => options.find((option) => option.label === label)?.id ?? label
  const defaultValue = Array.isArray(values.defaultValue) ? JSON.stringify(values.defaultValue.map(idFor)) : values.type === 'select' && values.defaultValue ? idFor(values.defaultValue) : values.defaultValue
  const folder = folders.find((item) => item.id === values.folderId)
  return { schemaVersion: 1, field: { ...previous?.field, name: values.name, fieldKey: previous?.field.fieldKey ?? values.fieldKey,
    type: previous?.field.type ?? values.type, options: values.options ? [...options, ...removed] : null, defaultValue,
    isPersonal: values.isPersonal, isStarred: values.isStarred, ecIsMaster: values.ecIsMaster, ecFieldPath: values.ecFieldPath || null,
    folderId: sameFolder && previous ? previous.field.folderId : folder?.id ?? null,
  }, folders: sameFolder && previous ? previous.folders : folder ? [{ id: folder.id, name: folder.name, parentId: null }] : [] }
}
