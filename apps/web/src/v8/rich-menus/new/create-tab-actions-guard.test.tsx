// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { applyMenuTabCount, requestMenuTabCount } from './create-tab-actions'
import type { Group, Page } from './create-types'

function makePage(id: string, orderIndex: number): Page {
  return {
    id,
    orderIndex,
    name: `タブ ${orderIndex + 1}`,
    aliasId: '',
    lineRichmenuId: null,
    imageR2Key: null,
    imageContentType: null,
    areas: [],
  }
}

const dummyGroup = { id: 'grp-1' } as unknown as Group

describe('applyMenuTabCount と requestMenuTabCount の守り', () => {
  it('削除を止める理由があるときは tabCount も pages も変更せずズレを防ぐ', () => {
    const pages = [makePage('p1', 0), makePage('p2', 1), makePage('p3', 2)]
    const setTabCount = vi.fn()
    const setPages = vi.fn()
    const setPendingTabCount = vi.fn()
    const setActivePageId = vi.fn()
    const setSelectedAreaId = vi.fn()
    const setPendingImages = vi.fn()
    const setTabNames = vi.fn()

    applyMenuTabCount(
      {
        activePageId: 'p3',
        group: dummyGroup,
        host: undefined,
        pages,
        removePageBlockers: () => ['他のボタンから参照されています'],
        setActivePageId,
        setPages,
        setPendingImages,
        setPendingTabCount,
        setSelectedAreaId,
        setTabCount,
        setTabNames,
        templateKey: '6-grid',
      },
      1,
    )

    expect(setPendingTabCount).toHaveBeenCalledWith(null)
    expect(setTabCount).not.toHaveBeenCalled()
    expect(setPages).not.toHaveBeenCalled()
    expect(setActivePageId).not.toHaveBeenCalled()
  })

  it('負の数や小数など不正なタブ数が渡されても状態を壊さない', () => {
    const pages = [makePage('p1', 0), makePage('p2', 1)]
    const applyTabCount = vi.fn()
    const setTabCount = vi.fn()
    const setPages = vi.fn()
    const setPendingTabCount = vi.fn()

    requestMenuTabCount(
      {
        applyTabCount,
        group: dummyGroup,
        pageHasSettings: () => false,
        pages,
        pendingImages: [],
        removePageBlockers: () => [],
        setPendingTabCount,
        tabCount: 1,
      },
      -1,
    )
    expect(applyTabCount).not.toHaveBeenCalled()
    expect(setPendingTabCount).not.toHaveBeenCalled()

    applyMenuTabCount(
      {
        activePageId: 'p1',
        group: dummyGroup,
        host: undefined,
        pages,
        removePageBlockers: () => [],
        setActivePageId: vi.fn(),
        setPages,
        setPendingImages: vi.fn(),
        setPendingTabCount,
        setSelectedAreaId: vi.fn(),
        setTabCount,
        setTabNames: vi.fn(),
        templateKey: '6-grid',
      },
      -2,
    )
    expect(setTabCount).not.toHaveBeenCalled()
    expect(setPages).not.toHaveBeenCalled()
  })
})
