// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { MediaItem } from '@line-crm/shared'
const list = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api', () => ({ api: { media: { list, contentUrl: (id: string, account: string) => `/api/media/${id}/content?accountId=${account}` } } }))
import MediaPickerDialog from './media-picker-dialog'

const reason = '閲覧のみのためメディアを選び直せません。'
const item = { id: 'media', lineAccountId: 'account', filename: '動画.mp4', kind: 'video', url: 'https://media.example.test/video.mp4' } as MediaItem
const response = { success: true, data: { items: [item], total: 41 } }
const option = () => screen.getByRole('option', { name: /動画.mp4/ }) as HTMLButtonElement
const props = (): ComponentProps<typeof MediaPickerDialog> => ({ open: true, accountId: 'account', onClose: vi.fn(), onSelect: vi.fn() })
beforeEach(() => { list.mockReset().mockResolvedValue(response) })
afterEach(cleanup)

it('理由付きでも候補を残し、灰色・Tab可能・理由1つでclick/Enter/Spaceを拒む', async () => {
  const p = props()
  render(<MediaPickerDialog {...p} lockedReason={reason} />)
  await screen.findByRole('option')
  const button = option()
  expect(button.disabled).toBe(false)
  expect(button.tabIndex).toBe(0)
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(button.style.opacity).toBe('var(--polish-disabled-opacity)')
  expect(button.style.cursor).toBe('not-allowed')
  act(() => button.focus())
  await screen.findByRole('tooltip')
  expect(screen.getAllByRole('tooltip').map(t => t.textContent)).toEqual([reason])
  fireEvent.click(button)
  expect(fireEvent.keyDown(button, { key: 'Enter' })).toBe(false)
  expect(fireEvent.keyDown(button, { key: ' ' })).toBe(false)
  expect(p.onSelect).not.toHaveBeenCalled()
  expect(p.onClose).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeTruthy()
})

it('開いた窓は役割が変わっても候補と検索入力を残し、選択だけを拒む', async () => {
  const p = props(); const view = render(<MediaPickerDialog {...p} />)
  await screen.findByRole('option')
  fireEvent.change(screen.getByRole('textbox', { name: 'メディア名で検索' }), { target: { value: '入力途中' } })
  view.rerender(<MediaPickerDialog {...p} lockedReason={reason} />)
  expect((screen.getByRole('textbox', { name: 'メディア名で検索' }) as HTMLInputElement).value).toBe('入力途中')
  expect(list).toHaveBeenCalledTimes(1)
  fireEvent.click(option())
  expect(p.onSelect).not.toHaveBeenCalled()
  expect(p.onClose).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeTruthy()
})

it.each(['disabled', 'callback'] as const)('本人未確定の%sだけなら理由なしの普通のdisabled、復旧後は選べる', async which => {
  const p = props(); const denied = which === 'disabled' ? { disabled: true } : { canSelectNow: () => false }
  const view = render(<MediaPickerDialog {...p} {...denied} />)
  await screen.findByRole('option')
  expect(option().disabled).toBe(true)
  expect(option().hasAttribute('data-permission-locked')).toBe(false)
  expect(option().hasAttribute('aria-describedby')).toBe(false)
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.click(option())
  expect(p.onSelect).not.toHaveBeenCalled()
  view.rerender(<MediaPickerDialog {...p} />)
  fireEvent.click(option())
  expect(p.onSelect).toHaveBeenCalledExactlyOnceWith(item)
})

it('表示を描き直す前にleaseが失効した場合も、選ぶ直前で拒む', async () => {
  let allowed = true
  const p = props(); render(<MediaPickerDialog {...p} canSelectNow={() => allowed} />)
  await screen.findByRole('option')
  expect(option().disabled).toBe(false)
  allowed = false
  fireEvent.click(option())
  expect(p.onSelect).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog')).toBeTruthy()
})

it('拒否中も検索・ページ送りのGETと窓を閉じる操作は維持する', async () => {
  const p = props(); render(<MediaPickerDialog {...p} lockedReason={reason} />)
  await screen.findByRole('option')
  fireEvent.click(screen.getByRole('button', { name: '次のページ' }))
  await waitFor(() => expect(list).toHaveBeenLastCalledWith('account', expect.objectContaining({ offset: 20 })))
  await screen.findByRole('option')
  fireEvent.change(screen.getByRole('textbox', { name: 'メディア名で検索' }), { target: { value: '動画' } })
  fireEvent.click(screen.getByRole('button', { name: '検索', exact: true }))
  await waitFor(() => expect(list).toHaveBeenLastCalledWith('account', expect.objectContaining({ query: '動画', offset: 0 })))
  await screen.findByRole('option')
  expect(option().getAttribute('aria-disabled')).toBe('true')
  expect(p.onSelect).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
  expect(p.onClose).not.toHaveBeenCalled()
  fireEvent.click(await screen.findByRole('button', { name: '破棄する', exact: true }))
  await waitFor(() => expect(p.onClose).toHaveBeenCalledTimes(1))
})

it('読込待ちで拒否へ変わっても、返った候補を読めてGETを再送しない', async () => {
  let resolve!: (value: typeof response) => void
  list.mockReturnValue(new Promise<typeof response>(done => { resolve = done }))
  const p = props(); const view = render(<MediaPickerDialog {...p} />)
  view.rerender(<MediaPickerDialog {...p} lockedReason={reason} />)
  await act(async () => resolve(response))
  expect(option().getAttribute('aria-disabled')).toBe('true')
  expect(list).toHaveBeenCalledTimes(1)
  expect(p.onSelect).not.toHaveBeenCalled()
})

it('拒否中も失敗を権限不足に化けさせず、読み直して候補を表示できる', async () => {
  list.mockResolvedValueOnce({ success: false, error: '通信の失敗' })
  const p = props(); render(<MediaPickerDialog {...p} lockedReason={reason} />)
  await screen.findByText('メディアを読み込めませんでした')
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  await screen.findByRole('option')
  expect(list).toHaveBeenCalledTimes(2)
  expect(option().getAttribute('aria-disabled')).toBe('true')
  expect(p.onSelect).not.toHaveBeenCalled()
})

it('未指定の候補は同じDOMの形・Tab順・選択で、権限の印やstyleを足さない', async () => {
  const p = props(); render(<MediaPickerDialog {...p} />)
  await screen.findByRole('option')
  const button = option()
  expect(button.disabled).toBe(false); expect(button.tabIndex).toBe(0)
  expect(button.hasAttribute('style')).toBe(false)
  expect(button.hasAttribute('data-permission-locked')).toBe(false)
  expect(button.hasAttribute('aria-disabled')).toBe(false)
  expect(button.parentElement?.children.length).toBe(1)
  fireEvent.click(button)
  expect(p.onSelect).toHaveBeenCalledExactlyOnceWith(item)
})
