// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MediaItem } from '@line-crm/shared'
import { MediaCardV8, type MediaCardV8Props } from './list-media-card'

function makeItem(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'm-1',
    filename: 'menu.png',
    kind: 'image',
    mimeType: 'image/png',
    sizeBytes: 1024,
    width: 800,
    height: 600,
    folderId: null,
    usageCount: 0,
    archivedAt: null,
    archiveReason: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    ...overrides,
  } as unknown as MediaItem
}

function makeProps(overrides: Partial<MediaCardV8Props> = {}): MediaCardV8Props {
  return {
    item: makeItem(),
    view: 'grid',
    displaySrc: 'https://example.test/menu.png',
    kindLabel: '画像',
    folder: null,
    canManageMedia: true,
    managementPermissionReason: '',
    selected: false,
    downloading: false,
    menuOpen: false,
    renaming: { id: 'm-1', value: 'new-name.png' },
    renamingBusy: false,
    renameConflict: false,
    renameError: '',
    onToggleSelect: vi.fn(),
    onPreview: vi.fn(),
    onToggleMenu: vi.fn(),
    onCloseMenu: vi.fn(),
    onDownload: vi.fn(),
    onRenameStart: vi.fn(),
    onRenameCancel: vi.fn(),
    onRenameChange: vi.fn(),
    onRenameConfirm: vi.fn(),
    onRenameReload: vi.fn(),
    onMoveStart: vi.fn(),
    onArchiveStart: vi.fn(),
    onDeleteStart: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('MediaCardV8 リネーム保存中/競合中キー操作と不正usageCount防御', () => {
  it('リネーム保存中や競合中は Enter で確定・Escape でキャンセルを発火させない', () => {
    const onRenameConfirm = vi.fn()
    const onRenameCancel = vi.fn()

    const view = render(
      <MediaCardV8 {...makeProps({ renamingBusy: true, onRenameConfirm, onRenameCancel })} />,
    )
    const input = screen.getByLabelText('ファイル名')
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onRenameConfirm).not.toHaveBeenCalled()
    expect(onRenameCancel).not.toHaveBeenCalled()

    view.rerender(
      <MediaCardV8 {...makeProps({ renamingBusy: false, renameConflict: true, onRenameConfirm, onRenameCancel })} />,
    )
    fireEvent.keyDown(screen.getByLabelText('ファイル名'), { key: 'Enter' })
    expect(onRenameConfirm).not.toHaveBeenCalled()

    view.rerender(
      <MediaCardV8 {...makeProps({ renamingBusy: false, renameConflict: false, onRenameConfirm, onRenameCancel })} />,
    )
    fireEvent.keyDown(screen.getByLabelText('ファイル名'), { key: 'Enter' })
    expect(onRenameConfirm).toHaveBeenCalledTimes(1)
  })

  it('usageCount が負数や NaN のとき選択欄の理由ツールチップを欠落させない', () => {
    const { container } = render(
      <MediaCardV8
        {...makeProps({
          renaming: null,
          item: makeItem({ usageCount: -1 }),
        })}
      />,
    )
    const corner = container.querySelector('[data-media-select-corner]')
    expect(corner?.getAttribute('title')).toBe('使用先を確認できないため選べません')
  })
})
