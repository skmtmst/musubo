import type { HqRichMenuSeed } from '@/lib/hq-rich-menu-create'
import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'
import type { Group, Page } from './create-types'

export const MISSING_DEFAULT_PAGE_ERROR = '最初に出す面を選び直してください'

/** 統括の保存用の形を作れなかったときに出す文。理由が無ければ最初に出す面の選び直しを案内する。 */
export function hqSeedFailureMessage(caught: unknown): string {
  return caught instanceof Error && caught.message ? caught.message : MISSING_DEFAULT_PAGE_ERROR
}

export function resolveHqDefaultPageId(group: Group | null, pages: Page[]): string | null {
  if (pages.length === 0) return null
  if (!group) return pages[0]?.id ?? null
  return group.defaultPageId && pages.some((page) => page.id === group.defaultPageId)
    ? group.defaultPageId
    : null
}

export function makeHqMenuSeed({ host, name, chatBarText, folderId, size, group, audience, hqTagName, defaultOpen, targetingPriority, pages }: {
  host?: RichMenuCreateHost; name: string; chatBarText: string; folderId: string; size: 'large' | 'compact'; group: Group | null
  audience: 'all' | 'targeted' | 'none' | 'tag'; hqTagName: string; defaultOpen: boolean; targetingPriority: number; pages: Page[]
}): HqRichMenuSeed {
  const defaultPageId = resolveHqDefaultPageId(group, pages)
  if (!defaultPageId) throw new Error(MISSING_DEFAULT_PAGE_ERROR)
  const safeSize = group?.size === 'large' || group?.size === 'compact' ? group.size : size
  return { id: host?.initial?.id, name: name.trim(), chatBarText: chatBarText.trim(), folderId: folderId.trim() || null,
    size: safeSize, displayAudience: audience === 'all' ? 'all' : audience === 'tag' ? 'tag' : 'store',
    displayTagName: audience === 'tag' ? hqTagName.trim() : '', defaultOpen, displayOrder: targetingPriority,
    defaultPageId, pages: pages.map(page => ({ id:page.id, name:page.name, imageR2Key:page.imageR2Key, areas:page.areas })) }
}
