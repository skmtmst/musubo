import { describe, expect, it } from 'vitest'
import type { Group, Page } from './create-types'
import { makeHqMenuSeed, MISSING_DEFAULT_PAGE_ERROR, resolveHqDefaultPageId } from './hq-menu-seed'

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

describe('rich-menus/new/hq-menu-seed の空白フォルダID・既定ページ未存在ガード', () => {
  it('既存メニューの defaultPageId が pages に無いときは先頭ページへ置き換えずエラーにする', () => {
    const group = {
      id: 'g1',
      size: 'large',
      defaultPageId: 'deleted-page',
    } as unknown as Group

    expect(resolveHqDefaultPageId(group, [PAGE_A])).toBeNull()
    expect(() => makeHqMenuSeed({
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
    })).toThrow(MISSING_DEFAULT_PAGE_ERROR)
  })

  it('空白だけの folderId は null にし、存在する既定ページIDと妥当な size は維持する', () => {
    const pageB: Page = { ...PAGE_A, id: 'page-b', orderIndex: 1, name: 'タブ2' }
    const group = {
      id: 'g1',
      size: 'compact',
      defaultPageId: 'page-b',
    } as unknown as Group

    const seed = makeHqMenuSeed({
      name: '  本部メニュー  ',
      chatBarText: '  メニュー  ',
      folderId: '   ',
      size: 'large',
      group,
      audience: 'tag',
      hqTagName: ' VIP ',
      defaultOpen: false,
      targetingPriority: 2,
      pages: [PAGE_A, pageB],
    })

    expect(seed.folderId).toBeNull()
    expect(seed.defaultPageId).toBe('page-b')
    expect(seed.size).toBe('compact')
    expect(seed.name).toBe('本部メニュー')
    expect(seed.chatBarText).toBe('メニュー')
    expect(seed.displayTagName).toBe('VIP')
  })

  it('未知の group.size は安全にフォーム側の size を使う', () => {
    const group = {
      id: 'g1',
      size: 'huge',
      defaultPageId: 'page-a',
    } as unknown as Group

    const seed = makeHqMenuSeed({
      name: '本部メニュー',
      chatBarText: 'メニュー',
      folderId: 'folder-1',
      size: 'compact',
      group,
      audience: 'all',
      hqTagName: '',
      defaultOpen: true,
      targetingPriority: 1,
      pages: [PAGE_A],
    })

    expect(seed.size).toBe('compact')
    expect(seed.folderId).toBe('folder-1')
  })
})
