import { knownValue } from '@/lib/known-value'
import type { FriendFieldType } from '@line-crm/shared';
import { FIELD_TYPE_LABELS } from '@/components/friend-fields/field-list';

export type LoadStatus = 'loading' | 'ready' | 'error' | 'forbidden'
export const UNFILED = '__unfiled__'
export function fieldTypeWord(type: FriendFieldType): string {
  if (type === 'select') return '1つ選ぶ'
  if (type === 'multi_select') return 'いくつも選ぶ'
  return typeof type === 'string' ? knownValue(FIELD_TYPE_LABELS, type, type) : '種類を確認できません'
}
