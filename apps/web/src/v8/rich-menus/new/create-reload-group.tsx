'use client'

import {
api
} from '@/lib/api'
import { V8_LAYOUT_KEYS } from './create-options'
import { type Group } from './create-types'


type ReloadMenuGroupContext = {
  hydrate: (g: Group) => void
}

function isHydratablePage(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const page = value as Record<string, unknown>
  if (typeof page.id !== 'string' || typeof page.name !== 'string' || !Array.isArray(page.areas)) return false
  return page.areas.every((area) => area !== null && typeof area === 'object' && !Array.isArray(area) && typeof (area as Record<string, unknown>).id === 'string')
}

function isHydratableGroup(value: unknown): value is Group {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const data = value as Record<string, unknown>
  if (typeof data.id !== 'string' || !data.id) return false
  if (typeof data.name !== 'string' || typeof data.chatBarText !== 'string') return false
  if (typeof data.size !== 'string' || !Object.prototype.hasOwnProperty.call(V8_LAYOUT_KEYS, data.size)) return false
  if (data.defaultOpen !== undefined && typeof data.defaultOpen !== 'boolean') return false
  if (data.isDefaultForAll !== undefined && typeof data.isDefaultForAll !== 'boolean') return false
  if (data.targetingEnabled !== undefined && typeof data.targetingEnabled !== 'boolean') return false
  if (data.targetingPriority !== undefined && (typeof data.targetingPriority !== 'number' || !Number.isFinite(data.targetingPriority))) return false
  if (!Array.isArray(data.pages) || !data.pages.every(isHydratablePage)) return false
  return true
}

export async function reloadMenuGroup({ hydrate }: ReloadMenuGroupContext, groupId: string) {
    if (typeof groupId !== 'string' || !groupId.trim()) {
      throw new Error('リッチメニューIDを確認できませんでした')
    }
    const res = await api.richMenuGroups.get(groupId)
    if (!res?.success) throw new Error(res?.error ?? '取得失敗')
    if (!isHydratableGroup(res.data)) {
      throw new Error('リッチメニューのデータを読み込めませんでした')
    }
    hydrate(res.data)
  }
