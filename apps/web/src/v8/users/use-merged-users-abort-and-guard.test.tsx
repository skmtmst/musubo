// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useMergedUsers } from './use-merged-users'

const mocks = vi.hoisted(() => ({
  usersList: vi.fn(),
  accountsList: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      usersGrouped: { ...actual.api.usersGrouped, list: mocks.usersList },
      lineAccounts: { ...actual.api.lineAccounts, list: mocks.accountsList },
    },
  }
})

const makeRow = (id: string) => ({
  id,
  displayName: `利用者${id}`,
  emails: [],
  phones: [],
  accounts: [{ accountName: '店舗A' }],
  identityKeyKind: 'uid',
  lastActivityAt: '2026-11-01T00:00:00Z',
})

function Harness() {
  const u = useMergedUsers()
  return (
    <div>
      <output data-testid="loading">{String(u.loading)}</output>
      <output data-testid="count">{u.rows.length}</output>
      <output data-testid="exporting">{String(u.exporting)}</output>
      <output data-testid="export-error">{u.exportError}</output>
      <button type="button" onClick={() => void u.exportCsv()}>CSV書き出し</button>
    </div>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.accountsList.mockResolvedValue({ success: true, data: [] })
  mocks.usersList.mockResolvedValue({ success: true, data: { rows: [makeRow('1')], total: 1 } })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useMergedUsers の中断・未処理エラー防止・二重書き出し防止', () => {
  it('アカウント候補の取得が失敗しても未処理の拒否を起こさず一覧表示を続ける', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      mocks.accountsList.mockRejectedValueOnce(new Error('accounts down'))
      render(<Harness />)
      await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(screen.getByTestId('count').textContent).toBe('1')
      expect(unhandled).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('CSV 書き出しの途中で画面を閉じたら次ページの取得とダウンロードを止める', async () => {
    let resolvePage1!: (value: unknown) => void
    let exportCalls = 0
    const createObjectURL = vi.fn(() => 'blob:mock')
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }))

    mocks.usersList.mockImplementation((input: { pageSize?: number }) => {
      if (input.pageSize === 200) {
        exportCalls += 1
        if (exportCalls === 1) return new Promise((resolve) => { resolvePage1 = resolve })
        return Promise.resolve({ success: true, data: { rows: [makeRow('2')], total: 2 } })
      }
      return Promise.resolve({ success: true, data: { rows: [makeRow('1')], total: 2 } })
    })

    const view = render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'))

    fireEvent.click(screen.getByRole('button', { name: 'CSV書き出し' }))
    await waitFor(() => expect(exportCalls).toBe(1))

    view.unmount()

    resolvePage1({ success: true, data: { rows: [makeRow('1')], total: 2 } })
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(exportCalls).toBe(1)
    expect(createObjectURL).not.toHaveBeenCalled()
  })
})
