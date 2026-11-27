// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RichMenuTemplate } from '@/lib/rich-menu-templates'
import type { Group } from './create-types'

vi.mock('@/components/shared/folder-select', () => ({
  default: () => <div data-testid="folder-select" />,
  folderById: (f: unknown) => f,
  folderCreator: () => undefined,
}))

vi.mock('@/components/shared/radio-card', () => ({
  RadioCardGroup: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  default: ({ value, onChange }: { value: string; onChange: () => void }) => (
    <button type="button" onClick={onChange}>{`サイズ変更:${value}`}</button>
  ),
}))

vi.mock('@/components/shared/segmented', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <div data-testid="tab-seg" data-value={value}>
      <button type="button" onClick={() => onChange('1')}>タブ数1</button>
      <button type="button" onClick={() => onChange('-1')}>タブ数不正</button>
    </div>
  ),
}))

vi.mock('@/components/shared/layout-picker', () => ({
  default: ({
    onChange,
    options,
  }: {
    onChange: (next: string) => void
    options: Array<{ value: string; areas: Array<{ label: string }> }>
  }) => (
    <div data-testid="layout-picker" data-last-label={options[0]?.areas.at(-1)?.label ?? ''}>
      <button type="button" onClick={() => onChange('compact-3')}>分け方変更</button>
    </div>
  ),
}))

import { renderShapeStep } from './create-shape-step'

afterEach(cleanup)

const dummyFields = {
  bind: () => ({}),
  error: () => undefined,
  invalid: () => false,
  requirement: () => undefined,
} as unknown as Parameters<typeof renderShapeStep>[0]['fields']

const bigLayout: RichMenuTemplate = {
  key: 'large-6',
  label: '6分割',
  size: 'large',
  areas: Array.from({ length: 27 }, () => ({ x: 0, y: 0, w: 100, h: 100 })),
} as unknown as RichMenuTemplate

describe('renderShapeStep の固定・処理中ガードと空ページ時のタブ値補正', () => {
  it('pages が空の group でもタブ数の選択値が -1 にならず 0 に丸まり、27面目は記号にならない', () => {
    render(
      <>
        {renderShapeStep({
          accountId: 'acc-1',
          busy: false,
          canOperate: true,
          chatBarText: 'メニュー',
          defaultTabName: (i) => `タブ${i + 1}`,
          fields: dummyFields,
          folderId: '',
          folders: [],
          group: { id: 'grp-1' } as unknown as Group,
          host: undefined,
          locked: false,
          name: 'メニュー',
          pages: [],
          renderSingleImage: () => <div />,
          renderTabImageSlot: () => <div />,
          requestTabCount: vi.fn(),
          setChatBarText: vi.fn(),
          setFolderId: vi.fn(),
          setFolders: vi.fn(),
          setName: vi.fn(),
          setSize: vi.fn(),
          setTabNames: vi.fn(),
          setTemplateKey: vi.fn(),
          shownLayouts: [bigLayout],
          size: 'large',
          tabCount: 0,
          tabNames: [],
          templateKey: 'large-6',
          updatePage: vi.fn(),
        })}
      </>,
    )

    expect(screen.getByTestId('tab-seg').getAttribute('data-value')).toBe('0')
    expect(screen.getByTestId('layout-picker').getAttribute('data-last-label')).toBe('27')
  })

  it('locked・busy のときはサイズ・分け方・タブ数の変更コールバックを止め、不正なタブ数も弾く', () => {
    const setSize = vi.fn()
    const setTemplateKey = vi.fn()
    const requestTabCount = vi.fn()

    const makeProps = (locked: boolean, busy: boolean) => ({
      accountId: 'acc-1',
      busy,
      canOperate: true,
      chatBarText: 'メニュー',
      defaultTabName: (i: number) => `タブ${i + 1}`,
      fields: dummyFields,
      folderId: '',
      folders: [],
      group: null,
      host: undefined,
      locked,
      name: 'メニュー',
      pages: [],
      renderSingleImage: () => <div />,
      renderTabImageSlot: () => <div />,
      requestTabCount,
      setChatBarText: vi.fn(),
      setFolderId: vi.fn(),
      setFolders: vi.fn(),
      setName: vi.fn(),
      setSize,
      setTabNames: vi.fn(),
      setTemplateKey,
      shownLayouts: [bigLayout],
      size: 'large' as const,
      tabCount: 0,
      tabNames: [],
      templateKey: 'large-6',
      updatePage: vi.fn(),
    })

    const { rerender } = render(<>{renderShapeStep(makeProps(true, true))}</>)
    fireEvent.click(screen.getByRole('button', { name: 'サイズ変更:compact' }))
    fireEvent.click(screen.getByRole('button', { name: '分け方変更' }))
    fireEvent.click(screen.getByRole('button', { name: 'タブ数1' }))

    expect(setSize).not.toHaveBeenCalled()
    expect(setTemplateKey).not.toHaveBeenCalled()
    expect(requestTabCount).not.toHaveBeenCalled()

    rerender(<>{renderShapeStep(makeProps(false, false))}</>)
    fireEvent.click(screen.getByRole('button', { name: 'タブ数不正' }))
    expect(requestTabCount).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'タブ数1' }))
    fireEvent.click(screen.getByRole('button', { name: '分け方変更' }))
    fireEvent.click(screen.getByRole('button', { name: 'サイズ変更:compact' }))

    expect(requestTabCount).toHaveBeenCalledWith(1)
    expect(setTemplateKey).toHaveBeenCalledWith('compact-3')
    expect(setSize).toHaveBeenCalledWith('compact')
  })
})
