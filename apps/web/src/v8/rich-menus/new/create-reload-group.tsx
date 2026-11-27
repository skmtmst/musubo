'use client'

import {
api
} from '@/lib/api'
import { type Group } from './create-types'


type ReloadMenuGroupContext = {
  hydrate: (g: Group) => void
}

export async function reloadMenuGroup({ hydrate }: ReloadMenuGroupContext, groupId: string) {
    if (typeof groupId !== 'string' || !groupId.trim()) {
      throw new Error('リッチメニューIDを確認できませんでした')
    }
    const res = await api.richMenuGroups.get(groupId)
    if (!res?.success) throw new Error(res?.error ?? '取得失敗')
    const data = res.data as Partial<Group> | null | undefined
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.id !== 'string' || !data.id) {
      throw new Error('リッチメニューのデータを読み込めませんでした')
    }
    hydrate(data as Group)
  }
