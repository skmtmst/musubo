// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FriendField } from '@line-crm/shared'
import FieldsTable from './fields-table'
import type { useFieldsTab } from './use-fields-tab'

afterEach(cleanup)

type FieldsTableProps = ReturnType<typeof useFieldsTab>

function makeField(overrides: Partial<FriendField> & { id: string; name: string }): FriendField {
  return {
    id: overrides.id,
    name: overrides.name,
    fieldKey: overrides.fieldKey ?? overrides.id,
    type: overrides.type ?? 'text',
    options: overrides.options ?? [],
    folderId: overrides.folderId ?? null,
    isInherited: overrides.isInherited ?? false,
    version: overrides.version ?? 1,
    usageCount: overrides.usageCount ?? 0,
    formUsageCount: overrides.formUsageCount ?? 0,
    displayOrder: overrides.displayOrder ?? 0,
    createdAt: overrides.createdAt ?? '2026-10-01T00:00:00Z',
    updatedAt: overrides.updatedAt ?? '2026-10-01T00:00:00Z',
    lineAccountId: overrides.lineAccountId ?? 'acc-1',
    isRequired: overrides.isRequired ?? false,
    placeholder: overrides.placeholder ?? null,
    helpText: overrides.helpText ?? null,
    isActive: overrides.isActive ?? true,
  } as FriendField
}

function makeProps(overrides: Partial<FieldsTableProps> = {}): FieldsTableProps {
  const fields = [
    makeField({ id: 'field-1', name: '誕生日', isInherited: false }),
    makeField({ id: 'field-2', name: '共通住所', isInherited: true }),
  ]
  return {
    accountId: 'acc-1',
    canEdit: true,
    narrow: false,
    host: undefined,
    explanation: false,
    items: fields,
    loaded: true,
    status: 'ready',
    error: '',
    actionError: '',
    setActionError: vi.fn(),
    retryOrder: null,
    setRetryOrder: vi.fn(),
    query: '',
    setQuery: vi.fn(),
    type: 'all',
    setType: vi.fn(),
    folderFilter: '',
    setFolderFilter: vi.fn(),
    pageSize: 20,
    setPageSize: vi.fn(),
    page: 1,
    setPage: vi.fn(),
    dragId: 'field-1',
    setDragId: vi.fn(),
    pendingDelete: null,
    setPendingDelete: vi.fn(),
    deleteError: '',
    deleteNeedsReview: false,
    leavingId: null,
    folders: [],
    folderDialog: null,
    setFolderDialog: vi.fn(),
    deletingFolder: null,
    setDeletingFolder: vi.fn(),
    folderBusy: false,
    folderError: '',
    openMenuId: null,
    setOpenMenuId: vi.fn(),
    setActiveFieldId: vi.fn(),
    openFieldDetail: vi.fn(),
    load: vi.fn(async () => {}),
    loadFolders: vi.fn(async () => {}),
    visible: fields,
    pages: 1,
    currentPage: 1,
    pageItems: fields,
    liveOrder: {
      shown: fields,
      enter: vi.fn(),
      dropTarget: vi.fn((id: string) => id),
    },
    bodyRef: { current: null },
    activeField: null,
    activeFieldIndex: -1,
    applyOrder: vi.fn(async () => {}),
    move: vi.fn(async () => {}),
    keyboardMove: vi.fn(async () => {}),
    remove: vi.fn(async () => true),
    removeFolder: vi.fn(async () => {}),
    rowMenuItems: vi.fn(() => []),
    fieldContextItems: vi.fn(() => []),
    kpis: [],
    folderRows: [],
    folderDotOf: vi.fn(() => null),
    filterActive: false,
    createButton: vi.fn(() => null),
    detailGuard: {} as FieldsTableProps['detailGuard'],
    ...overrides,
  }
}

describe('FieldsTable の並び替えガード', () => {
  it('閲覧のみでは行へのドラッグ進入やドロップで並び替えを実行しない', () => {
    const enter = vi.fn()
    const move = vi.fn(async () => {})
    const props = makeProps({
      canEdit: false,
      dragId: 'field-1',
      liveOrder: { shown: makeProps().items, enter, dropTarget: vi.fn((id: string) => id) },
      move,
    })

    const { container } = render(<FieldsTable {...props} />)
    const row = container.querySelector('tr[data-row-id="field-1"]') as HTMLElement
    expect(row).toBeTruthy()

    fireEvent.dragEnter(row)
    fireEvent.dragOver(row)
    fireEvent.drop(row)

    expect(enter).not.toHaveBeenCalled()
    expect(move).not.toHaveBeenCalled()
  })

  it('ドラッグ中でないときの dragEnter では仮の並び替えを動かさない', () => {
    const enter = vi.fn()
    const props = makeProps({
      canEdit: true,
      dragId: null,
      liveOrder: { shown: makeProps().items, enter, dropTarget: vi.fn((id: string) => id) },
    })

    const { container } = render(<FieldsTable {...props} />)
    const row = container.querySelector('tr[data-row-id="field-1"]') as HTMLElement

    fireEvent.dragEnter(row)

    expect(enter).not.toHaveBeenCalled()
  })

  it('共通項目へのドロップやドラッグ開始では並び替えを動かさない', () => {
    const setDragId = vi.fn()
    const move = vi.fn(async () => {})
    const props = makeProps({
      canEdit: true,
      dragId: 'field-1',
      setDragId,
      move,
    })

    const { container } = render(<FieldsTable {...props} />)
    const inheritedRow = container.querySelector('tr[data-row-id="field-2"]') as HTMLElement
    const inheritedGrip = inheritedRow.querySelector('[draggable="false"]') as HTMLElement
    expect(inheritedGrip).toBeTruthy()

    fireEvent.dragStart(inheritedGrip)
    fireEvent.drop(inheritedRow)

    expect(setDragId).not.toHaveBeenCalled()
    expect(move).not.toHaveBeenCalled()
  })

  it('編集権限がありドラッグ中なら通常行への進入とドロップで並び替えを実行する', () => {
    const enter = vi.fn()
    const dropTarget = vi.fn((id: string) => id)
    const move = vi.fn(async () => {})
    const fields = [
      makeField({ id: 'field-1', name: '誕生日', isInherited: false }),
      makeField({ id: 'field-3', name: '住まい', isInherited: false }),
    ]
    const props = makeProps({
      canEdit: true,
      dragId: 'field-1',
      items: fields,
      visible: fields,
      pageItems: fields,
      liveOrder: { shown: fields, enter, dropTarget },
      move,
    })

    const { container } = render(<FieldsTable {...props} />)
    const targetRow = container.querySelector('tr[data-row-id="field-3"]') as HTMLElement

    fireEvent.dragEnter(targetRow)
    fireEvent.drop(targetRow)

    expect(enter).toHaveBeenCalledWith('field-3')
    expect(dropTarget).toHaveBeenCalledWith('field-3')
    expect(move).toHaveBeenCalledWith('field-3')
  })
})
