// @vitest-environment happy-dom
/*
 * 監査 WEB051：版を戻すときに 409 になったら、知らせを残し、次は口が返した今の版で送る。
 */
import React from 'react'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({ list: vi.fn(), revert: vi.fn() }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, bookingApi: { ...actual.bookingApi, listMenuVersions: net.list, revertMenuVersion: net.revert } }
})

const { ApiError } = await import('@/lib/api')
const { default: MenuVersionHistory } = await import('./menu-version-history')

afterEach(() => { cleanup(); vi.clearAllMocks() })

const version = (n: number, status: 'in_use' | 'past') => ({ version_number: n, title: `第${n}版`, status, summary: '', author: null, at: '2026-10-01T00:00:00Z', lines: [] })

async function revertOnce() {
  await act(async () => { screen.getAllByRole('button', { name: 'この版に戻す' })[0].click() })
  const confirm = await screen.findByRole('button', { name: '新しい版を作る' })
  await act(async () => { confirm.click() })
}

describe('版を戻すときの競合（WEB051）', () => {
  it('確認中にメニューやアカウントが変わったら古い確認では戻さない', async () => {
    net.list.mockResolvedValue({ versions: [version(3, 'in_use'), version(1, 'past')] })
    const props = { menuId: 'm1', menuName: 'カット', currentVersion: 3, accountId: 'acc', canRevert: true, onReverted: () => undefined, onClose: () => undefined }
    const view = render(<MenuVersionHistory {...props} />)
    await screen.findByText('第1版')
    await act(async () => { screen.getByText('第1版').click() })
    await act(async () => { screen.getAllByRole('button', { name: 'この版に戻す' })[0].click() })
    const dialog = screen.getByRole('dialog', { name: '第1版に戻しますか？' })
    view.rerender(<MenuVersionHistory {...props} menuId="m2" accountId="acc2" />)
    const stillOpen = screen.queryByRole('dialog', { name: '第1版に戻しますか？' })
    if (stillOpen) await act(async () => { within(stillOpen).getByRole('button', { name: '新しい版を作る' }).click() })
    expect(net.revert).not.toHaveBeenCalled()
    expect(within(dialog).getByText('環境')).toBeTruthy()
  })
  it('409 の知らせは残り、次は口が返した今の版で送る', async () => {
    net.list.mockResolvedValueOnce({ versions: [version(3, 'in_use'), version(2, 'past'), version(1, 'past')] })
    net.list.mockResolvedValue({ versions: [version(3, 'in_use'), version(2, 'past'), version(1, 'past')] })
    net.revert
      .mockRejectedValueOnce(new ApiError(409, 'conflict', 'version_conflict', { currentVersion: 5 }))
      .mockResolvedValueOnce({ ok: true, version: 6 })
    render(<MenuVersionHistory menuId="m1" menuName="カット" currentVersion={3} accountId="acc" canRevert onReverted={() => undefined} onClose={() => undefined} />)
    await screen.findByText('第2版')
    await act(async () => { screen.getByText('第1版').click() })
    await revertOnce()
    const failed = await screen.findByRole('dialog', { name: '第1版に戻しますか？' })
    await waitFor(() => expect(within(failed).getByRole('alert').textContent).toMatch(/ほかの人が先に保存しました/))
    expect(net.revert.mock.calls[0][3]).toBe(3)
    // 読み直しのあとも知らせは残る。
    expect(within(failed).getByRole('alert').textContent).toMatch(/ほかの人が先に保存しました/)
    const retry = within(failed).getByRole('button', { name: 'もう一度' })
    expect(retry.hasAttribute('disabled')).toBe(true)
    await act(async () => { retry.click() })
    expect(net.revert).toHaveBeenCalledTimes(1)
    // 口は今の版を 5 と返した。読み直した一覧が古くても、5 で送る。
    net.list.mockResolvedValue({ versions: [version(5, 'in_use'), version(4, 'past'), version(3, 'past'), version(2, 'past'), version(1, 'past')] })
    await act(async () => { within(failed).getByRole('button', { name: 'キャンセル' }).click() })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '第1版に戻しますか？' })).toBeNull())
    await waitFor(() => expect(screen.getByRole('button', { name: 'この版に戻す' }).hasAttribute('disabled')).toBe(false))
    await revertOnce()
    await waitFor(() => expect(net.revert).toHaveBeenCalledTimes(2))
    expect(net.revert.mock.calls[1][3]).toBe(5)
  })
})
