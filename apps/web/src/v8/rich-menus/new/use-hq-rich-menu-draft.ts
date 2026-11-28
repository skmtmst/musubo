'use client'

import { useEffect, useRef, useState } from 'react'
import { readHqRichMenuDraft, writeHqRichMenuDraft } from '@/lib/hq-rich-menu-draft-store'
import type { Group, Page, PendingImage } from './create-types'
import type { StepKey } from './create-options'

export type HqMenuDraft = {
  version: 1; step: StepKey; maxStepIndex: number; group: Group | null; pages: Page[]; activePageId: string | null; selectedAreaId: string | null
  name: string; chatBarText: string; folderId: string; size: 'large' | 'compact'; tabCount: number; templateKey: string
  pendingImages: Array<PendingImage | null>; tabNames: string[]; audience: 'all' | 'targeted' | 'none' | 'tag'
  hqTagName: string; targetingPriority: number; defaultOpen: boolean; selectedIds: string[]; uploadedKeys: string[]; duplicateMode: 'overwrite' | 'alias'
}
function valid(value: unknown): value is HqMenuDraft {
  if (!value || typeof value !== 'object') return false
  const d = value as HqMenuDraft
  return d.version === 1 && ['shape', 'buttons', 'audience', 'publish'].includes(d.step)
    && Number.isInteger(d.maxStepIndex) && d.maxStepIndex >= 0 && d.maxStepIndex <= 3
    && typeof d.name === 'string' && typeof d.chatBarText === 'string' && typeof d.folderId === 'string'
    && ['large','compact'].includes(d.size) && Number.isInteger(d.tabCount) && d.tabCount >= 0 && d.tabCount <= 2
    && typeof d.templateKey === 'string' && Array.isArray(d.pages) && Array.isArray(d.pendingImages) && d.pendingImages.length <= 3
    && Array.isArray(d.tabNames) && d.tabNames.every(x => typeof x === 'string') && ['all','targeted','none','tag'].includes(d.audience)
    && typeof d.hqTagName === 'string' && Number.isFinite(d.targetingPriority) && typeof d.defaultOpen === 'boolean'
    && Array.isArray(d.selectedIds) && d.selectedIds.every(x => typeof x === 'string') && Array.isArray(d.uploadedKeys) && d.uploadedKeys.every(x => typeof x === 'string') && ['overwrite','alias'].includes(d.duplicateMode)
    && (d.activePageId === null || typeof d.activePageId === 'string') && (d.selectedAreaId === null || typeof d.selectedAreaId === 'string')
    && d.pages.length <= 3 && d.pages.every(page => page && typeof page.id === 'string' && typeof page.name === 'string'
      && (page.imageR2Key === null || typeof page.imageR2Key === 'string') && Array.isArray(page.areas))
    && d.pendingImages.every(image => image === null || (typeof image === 'object'
      && (image.file === null || image.file instanceof File) && (image.media === null || typeof image.media === 'object')))
    && (d.group === null || (typeof d.group === 'object' && Array.isArray(d.group.pages) && typeof d.group.size === 'string'))
}
export function useHqRichMenuDraft(scope: string | undefined, snapshot: HqMenuDraft, restore: (draft: HqMenuDraft) => void) {
  const [readyScope, setReadyScope] = useState<string | undefined>()
  const [failedScope, setFailedScope] = useState<string | undefined>()
  const failed = Boolean(scope && failedScope === scope)
  const restoreRef = useRef(restore)
  restoreRef.current = restore
  useEffect(() => {
    if (!scope) {
      setReadyScope(undefined)
      setFailedScope(undefined)
      return
    }
    let active = true
    const restoredUrls: string[] = []
    setReadyScope(undefined)
    setFailedScope((prev) => (prev === scope ? undefined : prev))
    void readHqRichMenuDraft(scope).then(value => {
      if (!active) return
      if (value !== undefined) {
        if (!valid(value)) { setFailedScope(scope); return }
        restoreRef.current({ ...value, pendingImages: value.pendingImages.map(image => {
          if (!image) return null
          const url = image.file ? URL.createObjectURL(image.file) : null
          if (url) restoredUrls.push(url)
          return { ...image, url }
        }) })
      }
    }).catch(() => { if (active) setFailedScope(scope) }).finally(() => { if (active) setReadyScope(scope) })
    return () => { active = false; restoredUrls.forEach(url => URL.revokeObjectURL(url)) }
  }, [scope])
  useEffect(() => {
    if (!scope || readyScope !== scope || failed) return
    let active = true
    const value = { ...snapshot, pendingImages: snapshot.pendingImages.map(image => image ? { ...image, url: null } : null) }
    void writeHqRichMenuDraft(scope, value).catch(() => { if (active) setFailedScope(scope) })
    return () => { active = false }
  }, [scope, readyScope, failed, snapshot.step, snapshot.maxStepIndex, snapshot.group, snapshot.pages, snapshot.activePageId,
    snapshot.selectedAreaId, snapshot.name, snapshot.chatBarText, snapshot.folderId, snapshot.size, snapshot.tabCount,
    snapshot.templateKey, snapshot.pendingImages, snapshot.tabNames, snapshot.audience, snapshot.hqTagName,
    snapshot.targetingPriority, snapshot.defaultOpen, snapshot.selectedIds.join('\0'), snapshot.uploadedKeys.join('\0'), snapshot.duplicateMode])
  return { ready: !scope || readyScope === scope, failed }
}
