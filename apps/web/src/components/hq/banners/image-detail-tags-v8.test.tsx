// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AccountWithStats } from '@/contexts/account-context'
import type { BannerImage } from '@/lib/hq-banners'
import { BannerImageDetailV8 } from '@/v8/hq-banners/image-detail'
import { findPickerDialog } from '@/components/shared/entity-picker-test-helpers'
vi.mock('@/lib/api', () => ({ api: { lineAccounts: { list: async () => ({ success: true, data: [] }) }, lineAccountFolders: { list: async () => ({ success: true, data: { folders: [] } }) } } }))

afterEach(() => { cleanup(); delete document.documentElement.dataset.theme })
it('V8でタグから配布先を選び、渡し済みを新しい選択に数えない', async () => {
  document.documentElement.dataset.theme = 'v8'
  const accounts = [
    { id: 'a', name: '本店', tags: [{ id: 'area', name: '北エリア', color: null }] },
    { id: 'b', name: '支店', tags: [{ id: 'area', name: '北エリア', color: null }] },
    { id: 'c', name: '別店', tags: [] },
  ] as AccountWithStats[]
  const image = { id: 'img', projectId: 'p', isFavorite: false, generation: null, deliveredAccountIds: ['a'], createdAt: '2026-10-04', media: { filename: 'x.png', mimeType: 'image/png', sizeBytes: 1, url: 'https://example.test/x.png' } } as BannerImage
  const deliver = vi.fn(async () => true)
  render(<BannerImageDetailV8 image={image} presets={[]} accounts={accounts} canManage onClose={() => {}} onToggleFavorite={() => {}} onDeliver={deliver} onRemove={async () => true} />)
  fireEvent.click(screen.getByRole('button', { name: /^配るアカウント/ }))
  const dialog = await findPickerDialog('配るアカウントを選ぶ')
  fireEvent.change(within(dialog).getByPlaceholderText('名前で探す'), { target: { value: '北エリア' } })
  await waitFor(() => expect(within(dialog).queryByRole('checkbox', { name: '別店' })).toBeNull())
  const already = within(dialog).getByRole('checkbox', { name: '本店' }) as HTMLInputElement
  expect(already.disabled).toBe(true)
  expect(already.checked).toBe(false)
  fireEvent.click(within(dialog).getByRole('checkbox', { name: '支店' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '選択する（1件）' }))
  await waitFor(() => expect(screen.queryAllByRole('dialog').includes(dialog)).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '1アカウントへ配る' }))
  expect(deliver).toHaveBeenCalledWith(['b'])
})
