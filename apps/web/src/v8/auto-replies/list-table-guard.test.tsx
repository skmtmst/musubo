// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderAutoReplyList } from './list-table'
import type { AutoReply } from './list-model'

function makeRule(overrides: Partial<AutoReply> = {}): AutoReply {
  return {
    id: 'rule/1?x=1',
    name: '営業時間外ルール',
    keywords: ['営業時間'],
    matchType: 'contains',
    responseType: 'text',
    responseText: '営業時間外です',
    templateId: null,
    isActive: true,
    lifecycleStatus: 'active',
    priority: 1,
    folderId: null,
    scheduleEnabled: false,
    scheduleDays: [],
    scheduleStartTime: null,
    scheduleEndTime: null,
    tagId: null,
    scenarioId: null,
    actions: [],
    conflictAttentionCount: 0,
    stoppedAt: null,
    stoppedByStaffId: null,
    stoppedByStaffName: null,
    stopReason: null,
    createdAt: '2026-11-01T00:00:00Z',
    hits: { period: Number.NaN, total: -5 },
    ...overrides,
  } as AutoReply
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  const rule = makeRule()
  return {
    allOnPageSelected: false,
    canEdit: true,
    canRunList: vi.fn(() => false),
    reorderBusy: false,
    lockedReason: undefined,
    clearFilters: vi.fn(),
    clearSelection: vi.fn(),
    dragId: null,
    dropOn: vi.fn(),
    duplicateFeedback: {
      highlightedId: null,
      clear: vi.fn(),
      mark: vi.fn(),
      order: <T extends { id: string }>(rows: readonly T[]) => rows,
    },
    filterActive: false,
    folderDotOf: () => null,
    goEdit: vi.fn(),
    items: [rule],
    keyboardMove: vi.fn(),
    liveOrder: {
      shown: [rule],
      overId: null,
      enter: vi.fn(),
      dropTarget: (fallback: string) => fallback,
      reset: vi.fn(),
    },
    load: vi.fn(async () => {}),
    loadError: null,
    moveNotice: '',
    narrow: false,
    openMenuId: null,
    openMove: vi.fn(),
    panelId: rule.id,
    panelIndex: -1,
    panelRow: rule,
    requestDelete: vi.fn(),
    resumableIds: [],
    router: { push: vi.fn(), replace: vi.fn(), back: vi.fn(), forward: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() } as never,
    rowContextItems: () => [],
    rowMenuItems: () => [],
    runDuplicate: vi.fn(async () => {}),
    runToggle: vi.fn(),
    selectedAccountId: 'acc-1',
    selectedCount: 1,
    selectedIds: new Set([rule.id]),
    setConflictOnly: vi.fn(),
    setDragId: vi.fn(),
    setDuplicateError: vi.fn(),
    setOpenMenuId: vi.fn(),
    setPage: vi.fn(),
    setPanelId: vi.fn(),
    setPendingToggle: vi.fn(),
    setSelectedIds: vi.fn(),
    setToggleError: vi.fn(),
    setToggleReason: vi.fn(),
    sortedItems: [rule],
    sortKey: 'priority' as const,
    stoppableIds: [rule.id],
    tableHeadCells: <><th>名前</th></>,
    templateById: new Map(),
    templateListAvailable: true,
    toggleAllOnPage: vi.fn(),
    toggleFromPanel: vi.fn(),
    toggleOne: vi.fn(),
    visibleLoadState: 'ready' as const,
    ...overrides,
  }
}

describe('renderAutoReplyList ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('不正な応答回数（NaN・負数）を表示せず、詳細パネルの不正位置で次へを有効化しない。一括フォルダ移動も canRunList で止める', () => {
    const openMove = vi.fn()
    const setPanelId = vi.fn()
    const ctx = makeCtx({ openMove, setPanelId })

    render(<>{renderAutoReplyList(ctx as never)}</>)

    // NaN や -5 が一覧・詳細パネルのどこにも出ず、未取得表示（—回）になる
    expect(screen.queryByText(/NaN/)).toBeNull()
    expect(screen.queryByText(/-5/)).toBeNull()
    expect(screen.getAllByText(/—回/).length).toBeGreaterThanOrEqual(1)

    // 編集リンクは URL エンコードされる
    const editLink = screen.getByRole('link', { name: '営業時間外ルール' }) as HTMLAnchorElement
    expect(editLink.getAttribute('href')).toBe('/auto-replies/edit?id=rule%2F1%3Fx%3D1')

    // panelIndex === -1 で「次へ」が押せて先頭行へ飛ばない
    const nextBtn = screen.queryByRole('button', { name: /次へ|次の/ }) as HTMLButtonElement | null
    if (nextBtn) {
      expect(nextBtn.disabled).toBe(true)
      fireEvent.click(nextBtn)
      expect(setPanelId).not.toHaveBeenCalled()
    }

    // canRunList() === false のときは一括「フォルダへ移す」を押しても openMove が呼ばれない
    fireEvent.click(screen.getByRole('button', { name: 'フォルダへ移す' }))
    expect(openMove).not.toHaveBeenCalled()
  })
})
