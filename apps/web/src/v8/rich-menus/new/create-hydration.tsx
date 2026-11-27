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

const MAX_MENU_PAGES = 3

/** 保存済みのメニュー定義が編集画面で扱える形かを確かめる。壊れた値を既定値で置き換えない。 */
function isHydratableGroup(g: Group): boolean {
  if (!g || typeof g !== 'object') return false
  if (g.size !== 'large' && g.size !== 'compact') return false
  if (!Array.isArray(g.pages) || g.pages.length < 1 || g.pages.length > MAX_MENU_PAGES) return false
  return g.pages.every(
    (page) =>
      Boolean(page) &&
      typeof page === 'object' &&
      Array.isArray(page.areas) &&
      page.areas.every((area) => Boolean(area) && typeof area === 'object'),
  )
}

export function hydrateMenuDraft({ host, setActivePageId, setAudience, setBaselineSignature, setChatBarText, setDefaultOpen, setFolderId, setGroup, setName, setPages, setSelectedAreaId, setSize, setTabCount, setTargetingCondition, setTargetingPriority, setTemplateKey }: HydrateMenuDraftContext, g: Group) {
    if (!isHydratableGroup(g)) {
      throw new Error('このメニューは読み込めませんでした')
    }
    setGroup(g)
    setSize(g.size)
    setTabCount(Math.max(0, g.pages.length - 1))
    const matchedLayout = TEMPLATES.find((layout) => layout.size === g.size && layout.areas.length === g.pages[0]?.areas.length && layout.areas.every((bounds, i) => {
      const area = g.pages[0].areas[i]
      return area.boundsX === Math.round(bounds.x) && area.boundsY === Math.round(bounds.y) && area.boundsWidth === Math.round(bounds.w) && area.boundsHeight === Math.round(bounds.h)
    }))
    setTemplateKey(matchedLayout?.key ?? V8_LAYOUT_KEYS[g.size][0])
    setPages(g.pages)
    // 保存→読み直しで、いま見ているページを飛ばさない。消えたページだけ既定へ戻す。
    setActivePageId((prev) =>
      prev && g.pages.some((p) => p.id === prev)
        ? prev
        : g.pages.find((p) => p.id === g.defaultPageId)?.id ?? g.pages[0]?.id ?? null,
    )
    setSelectedAreaId((prev) =>
      prev && g.pages.some((p) => p.areas.some((a) => a.id === prev)) ? prev : (g.pages.find((p) => p.id === g.defaultPageId) ?? g.pages[0])?.areas[0]?.id ?? null,
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
        pages: g.pages.map((p, i) => ({
          id: p.id,
          name: p.name,
          orderIndex: i,
          areas: p.areas.map(projectAreaForDraft),
        })),
      }),
    )
  }
