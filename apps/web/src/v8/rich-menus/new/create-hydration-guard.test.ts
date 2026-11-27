import { describe, expect, it, vi } from 'vitest'
import { hydrateMenuDraft } from './create-hydration'
import { V8_LAYOUT_KEYS } from './create-options'
import type { Group } from './create-types'

function makeContext() {
  const setters = {
    setActivePageId: vi.fn(),
    setAudience: vi.fn(),
    setBaselineSignature: vi.fn(),
    setChatBarText: vi.fn(),
    setDefaultOpen: vi.fn(),
    setFolderId: vi.fn(),
    setGroup: vi.fn(),
    setName: vi.fn(),
    setPages: vi.fn(),
    setSelectedAreaId: vi.fn(),
    setSize: vi.fn(),
    setTabCount: vi.fn(),
    setTargetingCondition: vi.fn(),
    setTargetingPriority: vi.fn(),
    setTemplateKey: vi.fn(),
  }
  return { host: undefined, ...setters }
}

describe('rich-menus/new/create-hydration の不正サイズ・欠損ページガード', () => {
  it('未知のサイズや欠損したページ配列でも落ちずに安全な既定サイズ・テンプレートへ戻す', () => {
    const ctx = makeContext()
    const malformed = {
      id: 'g-1',
      name: 'テストメニュー',
      chatBarText: 'メニュー',
      size: 'unexpected' as unknown as Group['size'],
      folderId: null,
      defaultOpen: true,
      isDefaultForAll: true,
      targetingEnabled: false,
      targetingPriority: 10,
      targetingCondition: null,
      defaultPageId: null,
      pages: null as unknown as Group['pages'],
    } as Group

    expect(() => hydrateMenuDraft(ctx, malformed)).not.toThrow()
    expect(ctx.setSize).toHaveBeenCalledWith('large')
    expect(ctx.setTabCount).toHaveBeenCalledWith(0)
    expect(ctx.setPages).toHaveBeenCalledWith([])

    const ctxCustom = makeContext()
    const unknownSizeWithCustomArea = {
      ...malformed,
      pages: [
        {
          id: 'p1',
          name: '1',
          orderIndex: 0,
          imageR2Key: null,
          areas: [{ id: 'a1', boundsX: 1, boundsY: 2, boundsWidth: 3, boundsHeight: 4, actionType: 'message', actionData: {}, label: null }],
        },
      ],
    } as unknown as Group
    expect(() => hydrateMenuDraft(ctxCustom, unknownSizeWithCustomArea)).not.toThrow()
    expect(ctxCustom.setSize).toHaveBeenCalledWith('large')
    expect(ctxCustom.setTemplateKey).toHaveBeenCalledWith(V8_LAYOUT_KEYS.large[0])
  })

  it('ページ数が上限（3面＝タブ数2）を超える異常データでも tabCount を範囲内へ収める', () => {
    const ctx = makeContext()
    const oversize = {
      id: 'g-2',
      name: '多面メニュー',
      chatBarText: 'メニュー',
      size: 'compact' as const,
      folderId: null,
      defaultOpen: true,
      isDefaultForAll: true,
      targetingEnabled: false,
      targetingPriority: 10,
      targetingCondition: null,
      defaultPageId: 'p1',
      pages: [
        { id: 'p1', name: '1', orderIndex: 0, imageR2Key: null, areas: null as unknown as Group['pages'][number]['areas'] },
        { id: 'p2', name: '2', orderIndex: 1, imageR2Key: null, areas: [] },
        { id: 'p3', name: '3', orderIndex: 2, imageR2Key: null, areas: [] },
        { id: 'p4', name: '4', orderIndex: 3, imageR2Key: null, areas: [] },
      ],
    } as Group

    expect(() => hydrateMenuDraft(ctx, oversize)).not.toThrow()
    expect(ctx.setSize).toHaveBeenCalledWith('compact')
    expect(ctx.setTabCount).toHaveBeenCalledWith(2)
  })
})
