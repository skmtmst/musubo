'use client'

import type { Folder } from '@line-crm/shared'
import { FolderMovePermissionError, useFolderMove } from '@/components/shared/use-folder-move'
import { api, type ApiBroadcast } from '@/lib/api'
import { canEditBroadcastNow, captureBroadcastWriteAccess, isFromHeadquarters } from './write-access'

export function useBroadcastFolderSelection({ accountId, canEdit, lockedReason, broadcasts, folders, onChanged }: {
  accountId: string | null
  canEdit: boolean
  lockedReason?: string
  broadcasts: ApiBroadcast[]
  folders: Folder[]
  onChanged: () => Promise<void>
}) {
  const permitted = captureBroadcastWriteAccess()
  const items = Array.isArray(broadcasts)
    ? broadcasts
        .filter((broadcast): broadcast is ApiBroadcast => Boolean(broadcast && typeof broadcast === 'object' && !isFromHeadquarters(broadcast)))
        .map(broadcast => ({ ...broadcast, name: broadcast.title }))
    : []
  const selection = useFolderMove({
    accountId, canEdit, items, folders, onChanged,
    permission: { lockedReason, canWriteNow: canEditBroadcastNow },
    move: async (item, folderId) => {
      if (!permitted(item)) throw new FolderMovePermissionError()
      const response = await api.broadcasts.update(item.id, { folderId, expectedVersion: item.version ?? 0 })
      if (!response.success) throw new Error(response.error || 'フォルダへ移せませんでした')
    },
  })
  return {
    isSelected: selection.isSelected,
    pageCheckbox: items.length ? selection.pageCheckbox : null,
    checkbox: (broadcast: ApiBroadcast) => broadcast && typeof broadcast === 'object' && items.some(item => item.id === broadcast.id)
      ? selection.checkbox({ ...broadcast, name: broadcast.title }) : null,
    overlays: selection.overlays,
  }
}
