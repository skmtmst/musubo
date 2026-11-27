'use client'

import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'
import { TEMPLATES } from '@/lib/rich-menu-templates'
import {
pruneCondition,
type SegmentCondition
} from '@/lib/segment-condition'
import type { Dispatch,SetStateAction } from 'react'
import { parseStoredCondition,projectAreaForDraft } from './create-draft'
import { V8_LAYOUT_KEYS } from './create-options'
import { type Group,type Page } from './create-types'

type HydrateMenuDraftContext = {
  host: RichMenuCreateHost | undefined
  setActivePageId: Dispatch<SetStateAction<string | null>>
  setAudience: Dispatch<SetStateAction<"all" | "tag" | "none" | "targeted">>
  setBaselineSignature: Dispatch<SetStateAction<string | null>>
  setChatBarText: Dispatch<SetStateAction<string>>
  setDefaultOpen: Dispatch<SetStateAction<boolean>>
  setFolderId: Dispatch<SetStateAction<string>>
  setGroup: Dispatch<SetStateAction<Group | null>>
  setName: Dispatch<SetStateAction<string>>
  setPages: Dispatch<SetStateAction<Page[]>>
  setSelectedAreaId: Dispatch<SetStateAction<string | null>>
  setSize: Dispatch<SetStateAction<"large" | "compact">>
  setTabCount: Dispatch<SetStateAction<number>>
  setTargetingCondition: Dispatch<SetStateAction<SegmentCondition | null>>
  setTargetingPriority: Dispatch<SetStateAction<number>>
  setTemplateKey: Dispatch<SetStateAction<string>>
}

export function hydrateMenuDraft({ host, setActivePageId, setAudience, setBaselineSignature, setChatBarText, setDefaultOpen, setFolderId, setGroup, setName, setPages, setSelectedAreaId, setSize, setTabCount, setTargetingCondition, setTargetingPriority, setTemplateKey }: HydrateMenuDraftContext, g: Group) {
    const safeSize: 'large' | 'compact' = g.size === 'compact' ? 'compact' : 'large'
    const safePages = Array.isArray(g.pages)
      ? g.pages.map((p) => ({ ...p, areas: Array.isArray(p.areas) ? p.areas : [] }))
      : []
    const firstAreas = safePages[0]?.areas ?? []
    setGroup(g)
    setSize(safeSize)
    setTabCount(Math.min(2, Math.max(0, safePages.length - 1)))
    const matchedLayout = TEMPLATES.find((layout) => layout.size === safeSize && layout.areas.length === firstAreas.length && layout.areas.every((bounds, i) => {
      const area = firstAreas[i]
      return Boolean(area) && area.boundsX === Math.round(bounds.x) && area.boundsY === Math.round(bounds.y) && area.boundsWidth === Math.round(bounds.w) && area.boundsHeight === Math.round(bounds.h)
    }))
    setTemplateKey(matchedLayout?.key ?? V8_LAYOUT_KEYS[safeSize][0])
    setPages(safePages)
    // 保存→読み直しで、いま見ているページを飛ばさない。消えたページだけ既定へ戻す。
    setActivePageId((prev) =>
      prev && safePages.some((p) => p.id === prev)
        ? prev
        : safePages.find((p) => p.id === g.defaultPageId)?.id ?? safePages[0]?.id ?? null,
    )
    setSelectedAreaId((prev) =>
      prev && safePages.some((p) => p.areas.some((a) => a.id === prev)) ? prev : (safePages.find((p) => p.id === g.defaultPageId) ?? safePages[0])?.areas[0]?.id ?? null,
    )
    setName(g.name)
    setChatBarText(g.chatBarText)
    setFolderId(g.folderId ?? '')
    setDefaultOpen(g.defaultOpen)
    setAudience(g.targetingEnabled ? 'targeted' : g.isDefaultForAll ? 'all' : host ? (host.initial?.displayAudience === 'tag' ? 'tag' : 'targeted') : 'none')
    setTargetingCondition(parseStoredCondition(g.targetingCondition))
    setTargetingPriority(g.targetingPriority)
    /*
     * 基準署名は draftSignature と同じ投影で組み立てる（audience の写像・
     * 条件の prune が違うと、保存直後なのに未保存と出る）。
     */
    const hydratedAudience = g.targetingEnabled ? 'targeted' : g.isDefaultForAll ? 'all' : host ? (host.initial?.displayAudience === 'tag' ? 'tag' : 'targeted') : 'none'
    const hydratedCondition = parseStoredCondition(g.targetingCondition)
    setBaselineSignature(
      JSON.stringify({
        name: g.name,
        chatBarText: g.chatBarText,
        isDefaultForAll: hydratedAudience === 'all',
        targetingEnabled: hydratedAudience === 'targeted',
        targetingPriority: g.targetingPriority,
        targetingCondition:
          hydratedAudience === 'targeted' && hydratedCondition
            ? JSON.stringify(pruneCondition(hydratedCondition))
            : null,
        folderId: g.folderId,
        defaultOpen: g.defaultOpen,
        hqTag: hydratedAudience === 'tag' ? (host?.initial?.displayTagName ?? '').trim() : null,
        pages: safePages.map((p, i) => ({
          id: p.id,
          name: p.name,
          orderIndex: i,
          areas: p.areas.map(projectAreaForDraft),
        })),
      }),
    )
  }
