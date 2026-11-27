import { describe, expect, it } from 'vitest'
import type { Group, Page } from './create-types'
import { makeHqMenuSeed } from './hq-menu-seed'

const PAGE_A: Page = {
  id: 'page-a',
  orderIndex: 0,
  name: 'トップ',
  aliasId: 'alias-a',
  lineRichmenuId: null,
  imageR2Key: 'img-a',
  imageContentType: 'image/png',
  areas: [],
}

describe('rich-menus/new/hq-menu-seed の空白フォルダID・消えた既定ページガード', () => {
  it('空白だけの folderId は null にし、存在しない既定ページIDは先頭ページへ差し替える', () => {
    const group = {
      id: 'g1',
      size: 'large',
      defaultPageId: 'deleted-page',
    } as unknown as Group

    const seed = makeHqMenuSeed({
      name: '  本部メニュー  ',
      chatBarText: '  メニュー  ',
      folderId: '   ',
      size: 'large',
      group,
      audience: 'all',
      hqTagName: '',
      defaultOpen: true,
      targetingPriority: 1,
      pages: [PAGE_A],
    })

    expect(seed.folderId).toBeNull()
    expect(seed.defaultPageId).toBe('page-a')
    expect(seed.name).toBe('本部メニュー')
    expect(seed.chatBarText).toBe('メニュー')
  })

  it('存在する既定ページIDはそのまま維持する', () => {
    const pageB: Page = { ...PAGE_A, id: 'page-b', orderIndex: 1, name: 'タブ2' }
    const group = {
      id: 'g1',
      size: 'compact',
      defaultPageId: 'page-b',
    } as unknown as Group

    const seed = makeHqMenuSeed({
      name: '本部メニュー',
      chatBarText: 'メニュー',
      folderId: 'folder-1',
      size: 'large',
      group,
      audience: 'tag',
      hqTagName: ' VIP ',
      defaultOpen: false,
      targetingPriority: 2,
      pages: [PAGE_A, pageB],
    })

    expect(seed.folderId).toBe('folder-1')
    expect(seed.defaultPageId).toBe('page-b')
    expect(seed.size).toBe('compact')
    expect(seed.displayTagName).toBe('VIP')
  })
})
