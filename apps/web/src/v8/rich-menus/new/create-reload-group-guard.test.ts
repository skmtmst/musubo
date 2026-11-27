import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  get: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      richMenuGroups: {
        ...actual.api.richMenuGroups,
        get: fixture.get,
      },
    },
  }
})

import { hydrateMenuDraft } from './create-hydration'
import { reloadMenuGroup } from './create-reload-group'
import type { Group } from './create-types'

function makeCompleteGroup(overrides: Record<string, unknown> = {}): Group {
  return {
    id: 'grp-1',
    accountId: 'acc-1',
    name: '通常メニュー',
    chatBarText: 'メニュー',
    size: 'large',
    defaultPageId: 'page-1',
    isDefaultForAll: true,
    status: 'draft',
    targetingCondition: null,
    targetingPriority: 0,
    targetingEnabled: false,
    folderId: null,
    displayOrder: 1,
    version: 1,
    publishingGeneration: 1,
    defaultOpen: true,
    pages: [
      {
        id: 'page-1',
        orderIndex: 0,
        name: 'トップ',
        aliasId: 'alias-top',
        lineRichmenuId: null,
        imageR2Key: null,
        imageContentType: null,
        areas: [
          {
            id: 'area-1',
            boundsX: 0,
            boundsY: 0,
            boundsWidth: 1250,
            boundsHeight: 843,
            actionType: 'uri',
            actionData: { uri: 'https://example.test/' },
            intent: 'url',
            label: '予約',
            tagIds: [],
            scoreChange: null,
            templateId: null,
            formId: null,
            trackedLinkId: null,
          },
        ],
      },
    ],
    ...overrides,
  } as unknown as Group
}

function makeHydrateContext() {
  const ctx = {
    host: undefined,
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
  return {
    ctx,
    hydrate: (g: Group) => hydrateMenuDraft(ctx, g),
  }
}

beforeEach(() => {
  vi.resetAllMocks()
})

describe('reloadMenuGroup 不正ID・欠損応答の実 hydrate フェイルクローズ', () => {
  it('空の groupId では API を呼ばずエラーにする', async () => {
    const { ctx, hydrate } = makeHydrateContext()
    await expect(reloadMenuGroup({ hydrate }, '   ')).rejects.toThrow('リッチメニューIDを確認できませんでした')
    expect(fixture.get).not.toHaveBeenCalled()
    expect(ctx.setGroup).not.toHaveBeenCalled()
  })

  it('id があっても pages・areas・size・必須項目が欠けたデータでは実 hydrate を呼ばずエラーにする', async () => {
    const { ctx, hydrate } = makeHydrateContext()

    fixture.get.mockResolvedValueOnce({ success: true, data: null })
    await expect(reloadMenuGroup({ hydrate }, 'grp-1')).rejects.toThrow('リッチメニューのデータを読み込めませんでした')

    // id と name だけあって pages が欠損（従来の id チェックだけでは通過して g.pages.length で落ちた）
    fixture.get.mockResolvedValueOnce({ success: true, data: { id: 'grp-1', name: '不完全メニュー' } })
    await expect(reloadMenuGroup({ hydrate }, 'grp-1')).rejects.toThrow('リッチメニューのデータを読み込めませんでした')

    // pages は配列だが中身の areas が欠損
    fixture.get.mockResolvedValueOnce({
      success: true,
      data: makeCompleteGroup({ pages: [{ id: 'page-1', name: 'トップ', areas: null }] }),
    })
    await expect(reloadMenuGroup({ hydrate }, 'grp-1')).rejects.toThrow('リッチメニューのデータを読み込めませんでした')

    // size が未知値（実 hydrate の V8_LAYOUT_KEYS[g.size][0] で落ちる）
    fixture.get.mockResolvedValueOnce({
      success: true,
      data: makeCompleteGroup({ size: 'unknown_size' }),
    })
    await expect(reloadMenuGroup({ hydrate }, 'grp-1')).rejects.toThrow('リッチメニューのデータを読み込めませんでした')

    // targetingPriority が NaN
    fixture.get.mockResolvedValueOnce({
      success: true,
      data: makeCompleteGroup({ targetingPriority: Number.NaN }),
    })
    await expect(reloadMenuGroup({ hydrate }, 'grp-1')).rejects.toThrow('リッチメニューのデータを読み込めませんでした')

    expect(ctx.setGroup).not.toHaveBeenCalled()
    expect(ctx.setPages).not.toHaveBeenCalled()
  })

  it('完全な形のグループ応答では実物の hydrateMenuDraft が完走して各状態へ反映される', async () => {
    const { ctx, hydrate } = makeHydrateContext()
    const group = makeCompleteGroup()
    fixture.get.mockResolvedValueOnce({ success: true, data: group })

    await reloadMenuGroup({ hydrate }, 'grp-1')

    expect(fixture.get).toHaveBeenCalledWith('grp-1')
    expect(ctx.setGroup).toHaveBeenCalledWith(group)
    expect(ctx.setSize).toHaveBeenCalledWith('large')
    expect(ctx.setName).toHaveBeenCalledWith('通常メニュー')
    expect(ctx.setPages).toHaveBeenCalledWith(group.pages)
    expect(ctx.setBaselineSignature).toHaveBeenCalledTimes(1)
  })
})
