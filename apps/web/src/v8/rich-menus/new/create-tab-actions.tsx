'use client'

import { createAreaDrafts } from '@/components/rich-menus/action-drafts'
import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'
import { TEMPLATES } from '@/lib/rich-menu-templates'
import type { Dispatch,SetStateAction } from 'react'
import { type Group,type Page,type PendingImage } from './create-types'


type RequestMenuTabCountContext = {
  applyTabCount: (next: number) => void
  group: Group | null
  pageHasSettings: (page: Page) => boolean
  pages: Page[]
  pendingImages: (PendingImage | null)[]
  removePageBlockers: (removed: Page[], remaining: Page[]) => string[]
  setPendingTabCount: Dispatch<SetStateAction<number | null>>
  tabCount: number
}

export function requestMenuTabCount({ applyTabCount, group, pageHasSettings, pages, pendingImages, removePageBlockers, setPendingTabCount, tabCount }: RequestMenuTabCountContext, next: number) {
    if (!Number.isInteger(next) || next < 0) return
    if (!group) {
      if (next === tabCount) return
      if (pendingImages.slice(next + 1).some(Boolean)) {
        setPendingTabCount(next)
        return
      }
      applyTabCount(next)
      return
    }
    if (next + 1 === pages.length) return
    const removed = pages.slice(next + 1)
    if (removed.some(pageHasSettings) || removePageBlockers(removed, pages.slice(0, next + 1)).length > 0) {
      setPendingTabCount(next)
      return
    }
    applyTabCount(next)
  }

type ApplyMenuTabCountContext = {
  activePageId: string | null
  group: Group | null
  host: RichMenuCreateHost | undefined
  pages: Page[]
  removePageBlockers: (removed: Page[], remaining: Page[]) => string[]
  setActivePageId: Dispatch<SetStateAction<string | null>>
  setPages: Dispatch<SetStateAction<Page[]>>
  setPendingImages: Dispatch<SetStateAction<(PendingImage | null)[]>>
  setPendingTabCount: Dispatch<SetStateAction<number | null>>
  setSelectedAreaId: Dispatch<SetStateAction<string | null>>
  setTabCount: Dispatch<SetStateAction<number>>
  setTabNames: Dispatch<SetStateAction<string[]>>
  templateKey: string
}

export function applyMenuTabCount({ activePageId, group, host, pages, removePageBlockers, setActivePageId, setPages, setPendingImages, setPendingTabCount, setSelectedAreaId, setTabCount, setTabNames, templateKey }: ApplyMenuTabCountContext, next: number) {
    if (!Number.isInteger(next) || next < 0) return
    setPendingTabCount(null)
    if (!group) {
      setTabCount(next)
      setPendingImages((prev) => {
        prev.slice(next + 1).forEach((image) => { if (image?.url) URL.revokeObjectURL(image.url) })
        return prev.slice(0, next + 1)
      })
      setTabNames((prev) => prev.slice(0, next + 1))
      return
    }
    const count = next + 1
    if (pages.length > count) {
      const remaining = pages.slice(0, count)
      if (removePageBlockers(pages.slice(count), remaining).length > 0) return
      setTabCount(next)
      setPages(remaining)
      if (!remaining.some((p) => p.id === activePageId)) {
        setActivePageId(remaining[0]?.id ?? null)
        setSelectedAreaId(remaining[0]?.areas[0]?.id ?? null)
      }
      return
    }
    setTabCount(next)
    // 足すタブは①の面の分け方で始める（面と動きはタブごとに持つ）。保存すると作られる。
    const layout = TEMPLATES.find((t) => t.key === templateKey) ?? TEMPLATES[0]
    const added: Page[] = Array.from({ length: count - pages.length }, (_, offset) => {
      const index = pages.length + offset
      return {
        id: `tmp-${Math.random().toString(36).slice(2, 10)}`,
        orderIndex: index,
        name: host ? `タブ ${String.fromCharCode(65 + index)}` : `タブ ${String.fromCharCode(65 + index - 1)}`,
        aliasId: '',
        lineRichmenuId: null,
        imageR2Key: null,
        imageContentType: null,
        areas: createAreaDrafts(layout).map((area) => ({ ...area, id: crypto.randomUUID() })),
      }
    })
    setPages([...pages, ...added])
  }
