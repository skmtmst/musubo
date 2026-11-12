import { beforeEach as seedIdentity } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import { within } from '@testing-library/react'
import { ChangeConfirmScreen } from './profile-confirm'
import type { GoogleChange } from '@/lib/restaurant-google-api'

const mocks = vi.hoisted(() => ({ change: vi.fn(), sendChange: vi.fn(), cancelChange: vi.fn() }))
vi.mock('@/lib/restaurant-google-api', () => ({ restaurantGoogleApi: mocks }))
const change: GoogleChange = {
  id: 'proposal-1', kind: 'profile', source: 'profile_edit', summary: '店名の変更', target: { field: 'title' },
  before: '変更前の店', after: '変更後の店', inputText: null, reservationImpactCount: 0, status: 'draft',
  staffName: '担当', error: null, createdAt: '2026-10-11T00:00:00Z', sentAt: null, appliedAt: null, updatedAt: '2026-10-11T00:00:00Z',
}
const response = { change, store: { name: '対象店舗', timeZone: 'Asia/Tokyo' }, writeEnabled: true, canSend: true }
const go = vi.fn()
beforeEach(() => {
  vi.clearAllMocks()
  mocks.change.mockResolvedValue(response)
  mocks.sendChange.mockResolvedValue({ change: { ...change, status: 'accepted' }, alreadyApplied: false })
  mocks.cancelChange.mockResolvedValue({ change: { ...change, status: 'cancelled' } })
})
afterEach(cleanup)

async function open(ids = ['proposal-1']) {
  render(<ChangeConfirmScreen accountId="account-1" ids={ids} go={go} />)
  await screen.findByText('変更後の店')
}
function check() { fireEvent.click(screen.getByRole('checkbox', { name: '店舗・項目・内容を確認しました' })) }
describe('Google変更案を現在の確認画面から送信する', () => {
  it('変更前後を表示し、確認するまで送信せず、確認して送信すると反映確認中になる', async () => {
    await open()
    const target = within(await screen.findByRole('region', { name: '操作の対象' }))
    await target.findByText('対象LINE-1')
    expect(target.getByText('対象店舗')).toBeTruthy()
    await target.findByText('検証環境')
    expect(screen.getByText('変更前の店')).toBeTruthy()
    const button = screen.getByRole('button', { name: 'Googleに変更を送信する' })
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(button)
    expect(mocks.sendChange).not.toHaveBeenCalled()
    check()
    fireEvent.click(button)
    await screen.findByText(/Googleに変更を送信しました。反映を確認できるまで/)
    expect(mocks.sendChange).toHaveBeenCalledExactlyOnceWith('account-1', 'proposal-1')
    expect(screen.queryByRole('button', { name: 'Googleに変更を送信する' })).toBeNull()
  })
  it('同じ描画で連打しても送信要求は1回になる', async () => {
    let finish!: (result: unknown) => void
    mocks.sendChange.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    await open(); check()
    const button = screen.getByRole('button', { name: 'Googleに変更を送信する' })
    act(() => { button.click(); button.click(); button.click() })
    expect(mocks.sendChange).toHaveBeenCalledTimes(1)
    await act(async () => { finish({ change: { ...change, status: 'applied' }, alreadyApplied: true }) })
    expect(screen.getByText(/すでにGoogleに反映されていました/)).toBeTruthy()
  })
  for (const permission of [{ canSend: false }, { writeEnabled: false }]) {
    it(`送信権限・環境の制約を守る ${JSON.stringify(permission)}`, async () => {
      mocks.change.mockResolvedValue({ ...response, ...permission })
      await open(); check()
      const button = screen.queryByRole('button', { name: 'Googleに変更を送信する' })
      if (button) expect((button as HTMLButtonElement).disabled || button.getAttribute('aria-disabled') === 'true').toBe(true)
      expect(mocks.sendChange).not.toHaveBeenCalled()
    })
  }
  it('競合すると最新の値を示し、旧値で再送しない', async () => {
    mocks.sendChange.mockRejectedValue(new ApiError(409, '競合', 'conflict', { current: '別担当が変更した店', change: { ...change, status: 'conflict' } }))
    await open(); check()
    fireEvent.click(screen.getByRole('button', { name: 'Googleに変更を送信する' }))
    await screen.findByText(/別担当が変更した店/)
    expect(screen.getByRole('button', { name: 'Googleに変更を送信する' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: '最新の内容を確認する' }))
    expect(go).toHaveBeenCalledWith({ tab: 'profile' })
  })
  it('送信結果が不明なら状態を再取得し、確認を外して重複防止の案内を残す', async () => {
    mocks.change.mockResolvedValueOnce(response).mockResolvedValueOnce({ ...response, change: { ...change, status: 'pending_confirm' } })
    mocks.sendChange.mockRejectedValue(new ApiError(502, '送信の結果が不明です'))
    await open(); check()
    fireEvent.click(screen.getByRole('button', { name: 'Googleに変更を送信する' }))
    await screen.findByText(/重複を防ぐため/)
    expect(mocks.change).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', false)
    expect(screen.getByRole('button', { name: 'Googleに変更を送信する' })).toHaveProperty('disabled', true)
  })
  it('失敗後は変更内容を保ち、取消してプロフィールへ戻れる', async () => {
    mocks.change.mockResolvedValue({ ...response, change: { ...change, status: 'failed' } })
    mocks.cancelChange.mockRejectedValueOnce(new ApiError(500, '取消に失敗しました')).mockResolvedValueOnce({})
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    await screen.findByText('取り消せませんでした。')
    expect(screen.getByText('変更後の店')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    await waitFor(() => expect(go).toHaveBeenCalledWith({ tab: 'profile' }))
    expect(mocks.cancelChange).toHaveBeenCalledTimes(2)
  })
  // 決まり2: 確かめ方の説明は帯にせず、題の横の「？」へ入れる。
  it('再確認の説明は帯に出さず題の「？」に入れる', async () => {
    await open()
    expect(screen.queryByText(/最新情報を再確認します/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '変更の確かめ方の説明' }))
    expect(await screen.findByText(/最新情報を再確認します/)).toBeTruthy()
  })
  it('複数の変更は1件ずつ送り、次の変更では確認をやり直す', async () => {
    mocks.change.mockResolvedValueOnce(response).mockResolvedValueOnce({ ...response, change: { ...change, id: 'proposal-2', after: '次の変更' } })
    await open(['proposal-1', 'proposal-2']); check()
    fireEvent.click(screen.getByRole('button', { name: 'Googleに変更を送信する' }))
    fireEvent.click(await screen.findByRole('button', { name: '次の変更へ' }))
    await screen.findByText('次の変更')
    expect(mocks.change).toHaveBeenLastCalledWith('account-1', 'proposal-2')
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', false)
    expect(screen.getByRole('button', { name: 'Googleに変更を送信する' })).toHaveProperty('disabled', true)
  })
})

seedIdentity(() => { verifiedStaffRole('owner') })

vi.mock('@/lib/admin-version-cache', () => ({ loadAdminVersionDetail: async () => ({ version: '2.7.0', deploy_env: 'staging' }) }))
vi.mock('@/lib/line-accounts-cache', () => ({ loadLineAccounts: async () => ({ success: true, data: [{ id: 'a', name: '対象LINE-A' }, { id: 'b', name: '対象LINE-B' }, { id: 'account-1', name: '対象LINE-1' }, { id: 'account-2', name: '対象LINE-2' }] }) }))

it.each([{ canSend: false }, { writeEnabled: false }])('再確認できないときは押せない送信操作を案内しない %o', async restriction => {
  mocks.change.mockResolvedValue({ ...response, ...restriction, change: { ...change, status: 'pending_confirm' } })
  await open()
  expect(screen.getByText(/前回の送信結果を確認できていません/).textContent).toContain('Google側の状態を確認してください。')
  expect(screen.getByText(/前回の送信結果を確認できていません/).textContent).not.toContain('を押すと')
  expect(mocks.sendChange).not.toHaveBeenCalled()
})

it.each([{ canSend: false }, { writeEnabled: false }])('送信できないときの失敗案内は再送可能と断定しない %o', async restriction => {
  mocks.change.mockResolvedValue({ ...response, ...restriction, change: { ...change, status: 'failed', error: '接続エラー' } })
  await open()
  const notice = screen.getByText(/前回の送信は失敗しました/)
  expect(notice.textContent).toContain('接続エラー')
  expect(notice.textContent).toContain('Google側の状態を確認してください')
  expect(notice.textContent).not.toContain('もう一度送信できます')
  expect(mocks.sendChange).not.toHaveBeenCalled()
})
