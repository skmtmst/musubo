// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type ManualLink } from '@/lib/api'
import { useManualLinks } from './use-manual-links'

const mocks = vi.hoisted(() => ({
  loadStaffIdentity: vi.fn(),
  list: vi.fn(),
  check: vi.fn(),
  update: vi.fn(),
  notifySaved: vi.fn(),
  push: vi.fn(),
}))

vi.mock('@/lib/staff-role', () => ({
  loadStaffIdentity: mocks.loadStaffIdentity,
  useStaffIdentity: () => ({ id: 'ops-1', name: '運営太郎', role: 'owner', isPlatformAdmin: true }),
}))
vi.mock('@/lib/manual-link-access', () => ({
  canViewManualLinks: () => true,
}))
vi.mock('./manual-link-view', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./manual-link-view')>()
  return { ...actual, canEditTable: () => true }
})
vi.mock('@/components/shared/permission-lock', () => ({
  lockReason: () => null,
}))
vi.mock('@/components/shared/use-permission-lock-reason', () => ({
  usePermissionLockReason: () => null,
}))
vi.mock('@/components/shared/list-url-state', () => ({
  useListUrlValue: <T,>(_key: string, initial: T) => React.useState<T>(initial),
}))
vi.mock('@/components/shared/toast', () => ({
  notifySaved: mocks.notifySaved,
}))
vi.mock('@/lib/use-unsaved-guard', () => ({
  useUnsavedGuard: () => ({
    leaveTarget: null,
    confirmLeave: vi.fn(),
    cancelLeave: vi.fn(),
    guarded: (fn: () => void) => fn(),
  }),
}))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      manualLinks: {
        list: mocks.list,
        check: mocks.check,
        update: mocks.update,
      },
    },
  }
})

const sampleLink: ManualLink = {
  key: '2-1',
  keyKind: 'screen',
  name: '受信箱',
  url: 'https://help.example.com/inbox',
  status: 'ok',
  lastCheckedAt: '2026-11-26T19:00:00.000Z',
  lastHttpStatus: 200,
  lastError: null,
  version: 2,
}

function Harness() {
  const m = useManualLinks()
  return (
    <div>
      <output data-testid="status">{m.status}</output>
      <output data-testid="checking">{String(m.checking)}</output>
      <output data-testid="saving">{String(m.saving)}</output>
      <output data-testid="error">{m.actionError}</output>
      <button type="button" onClick={() => void m.checkAll()}>いま全部を確かめる</button>
      <button type="button" onClick={() => { m.startEdit('2-1'); m.setEditingUrl('https://help.example.com/inbox-v2') }}>編集開始</button>
      <button type="button" onClick={() => void m.saveEdit()}>決める</button>
    </div>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.loadStaffIdentity.mockResolvedValue({ success: true, data: { id: 'ops-1', role: 'owner', isPlatformAdmin: true } })
  mocks.list.mockResolvedValue({ success: true, data: { items: [sampleLink], total: 1 } })
})

afterEach(() => {
  cleanup()
})

describe('useManualLinks の競合再取得失敗・権限/混雑表示・二重実行防止', () => {
  it('409 競合後の一覧の読み込み失敗時に成功を表示しない', async () => {
    mocks.update.mockRejectedValueOnce(new ApiError(409, 'conflict'))
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'))

    fireEvent.click(screen.getByRole('button', { name: '編集開始' }))
    mocks.list.mockRejectedValueOnce(new ApiError(503, 'unavailable'))
    fireEvent.click(screen.getByRole('button', { name: '決める' }))

    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toContain('最新の内容を読み直せませんでした')
    })
    expect(screen.getByTestId('error').textContent).not.toContain('最新の内容を読み直したので')
  })

  it('いま全部を確かめるを連続クリックしても二重実行せず、403 では権限不足を案内する', async () => {
    let rejectCheck!: (err: unknown) => void
    mocks.check.mockImplementationOnce(() => new Promise((_, reject) => { rejectCheck = reject }))
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'))

    const checkBtn = screen.getByRole('button', { name: 'いま全部を確かめる' })
    fireEvent.click(checkBtn)
    fireEvent.click(checkBtn)

    expect(mocks.check).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByTestId('checking').textContent).toBe('true'))

    rejectCheck(new ApiError(403, 'forbidden'))
    await waitFor(() => expect(screen.getByTestId('checking').textContent).toBe('false'))
    expect(screen.getByTestId('error').textContent).toContain('権限がありません')
  })

  it('保存の連続クリックで update を二重送信しない', async () => {
    let resolveUpdate!: (value: unknown) => void
    mocks.update.mockImplementationOnce(() => new Promise((resolve) => { resolveUpdate = resolve }))
    render(<Harness />)
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('ready'))

    fireEvent.click(screen.getByRole('button', { name: '編集開始' }))
    const saveBtn = screen.getByRole('button', { name: '決める' })
    fireEvent.click(saveBtn)
    fireEvent.click(saveBtn)

    expect(mocks.update).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByTestId('saving').textContent).toBe('true'))

    resolveUpdate({ success: true, data: { ...sampleLink, url: 'https://help.example.com/inbox-v2', version: 3 } })
    await waitFor(() => expect(screen.getByTestId('saving').textContent).toBe('false'))
  })
})
