// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const imageUrlMock = vi.hoisted(() => vi.fn((key: string) => `/api/images/${key}?accountId=acc-1`))
vi.mock('@/lib/api', () => ({
  api: {
    media: { contentUrl: (id: string, acc: string) => `/api/media/${id}?accountId=${acc}` },
    richMenuGroups: { imageUrl: imageUrlMock },
  },
}))

import { getSlotImage, renderTabSlot } from './create-image-slots'
import type { Group, Page } from './create-types'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('リッチメニュー画像スロットのURL付与と未保存タブ・処理中ガード', () => {
  it('既存クエリ付き画像URLにバージョンを正しく連結し、未保存タブでは登録メディア選択を出さない', () => {
    const group = { id: 'g-1', accountId: 'acc-1', size: 'large' } as Group
    const pages = [
      { id: 'page-1', name: 'メイン', imageR2Key: 'menu-1.png', areas: [] },
      { id: 'tmp-2', name: '追加タブ', imageR2Key: null, areas: [] },
    ] as unknown as Page[]

    const slot = getSlotImage(
      { accountId: 'acc-1', group, host: undefined, imageVersion: 3, pages, pendingImages: [] },
      0,
    )
    expect(slot?.src).toBe('/api/images/menu-1.png?accountId=acc-1&v=3')

    const setImagePickTarget = vi.fn()
    const setMediaPickerOpen = vi.fn()
    const view = render(
      <div>
        {renderTabSlot(
          {
            accountId: 'acc-1',
            busy: false,
            clearPendingImage: vi.fn(),
            group,
            handlePickedFile: vi.fn(),
            host: undefined,
            pages,
            setImagePickTarget,
            setMediaPickerOpen,
            size: 'large',
            slotImage: () => null,
            tabNameAt: (i) => `タブ${i + 1}`,
          },
          1,
        )}
      </div>,
    )

    expect(screen.getByText('下書きを保存すると、このタブの画像を入れられます。')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '登録メディアから選択する' })).toBeNull()

    // 保存済みタブ（busy=false）なら登録メディア選択が出る
    view.rerender(
      <div>
        {renderTabSlot(
          {
            accountId: 'acc-1',
            busy: false,
            clearPendingImage: vi.fn(),
            group,
            handlePickedFile: vi.fn(),
            host: undefined,
            pages,
            setImagePickTarget,
            setMediaPickerOpen,
            size: 'large',
            slotImage: () => null,
            tabNameAt: (i) => `タブ${i + 1}`,
          },
          0,
        )}
      </div>,
    )
    expect(screen.getByRole('button', { name: '登録メディアから選択する' })).toBeTruthy()
  })
})
