import type { HqRichMenuSeed } from '@/lib/hq-rich-menu-create'
import type { RichMenuCreateHost } from '@/lib/rich-menu-create-host'
import type { Group, Page } from './create-types'

export function makeHqMenuSeed({ host, name, chatBarText, folderId, size, group, audience, hqTagName, defaultOpen, targetingPriority, pages }: {
  host?: RichMenuCreateHost; name: string; chatBarText: string; folderId: string; size: 'large' | 'compact'; group: Group | null
  audience: 'all' | 'targeted' | 'none' | 'tag'; hqTagName: string; defaultOpen: boolean; targetingPriority: number; pages: Page[]
}): HqRichMenuSeed {
  const existingDefault = group?.defaultPageId && pages.some((page) => page.id === group.defaultPageId)
    ? group.defaultPageId
    : null
  const safeSize = group?.size === 'large' || group?.size === 'compact' ? group.size : size
  return { id: host?.initial?.id, name: name.trim(), chatBarText: chatBarText.trim(), folderId: folderId.trim() || null,
    size: safeSize, displayAudience: audience === 'all' ? 'all' : audience === 'tag' ? 'tag' : 'store',
    displayTagName: audience === 'tag' ? hqTagName.trim() : '', defaultOpen, displayOrder: targetingPriority,
    defaultPageId: existingDefault ?? pages[0]?.id ?? '', pages: pages.map(page => ({ id:page.id, name:page.name, imageR2Key:page.imageR2Key, areas:page.areas })) }
}
