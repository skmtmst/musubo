// @vitest-environment happy-dom
/*
 * N-070: テスト送信先の設定欄が、読み込み失敗を「未設定」と混ぜずに出し、
 * 同じ画面からやり直せること。アカウントを切り替えたあとに遅れて届いた
 * 前アカウントの応答で上書きしないことも固定する。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  getTestRecipients: vi.fn(),
  getTestRecipientLoginUsers: vi.fn(),
  updateTestRecipients: vi.fn(),
  friendsList: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    accountSettings: {
      getTestRecipients: apiMocks.getTestRecipients,
      getTestRecipientLoginUsers: apiMocks.getTestRecipientLoginUsers,
      updateTestRecipients: apiMocks.updateTestRecipients,
    },
    friends: { list: apiMocks.friendsList },
  },
}))

import TestRecipientsSetting from './test-recipients-setting'

const ok = <T,>(data: T) => Promise.resolve({ success: true as const, data })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

async function flush() {
  await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  apiMocks.getTestRecipients.mockReset()
  apiMocks.getTestRecipientLoginUsers.mockReset()
  apiMocks.updateTestRecipients.mockReset()
  apiMocks.friendsList.mockReset()
})
afterEach(cleanup)

describe('テスト送信先の設定欄 (N-070)', () => {
  it('設定済みの送信先を表示する', async () => {
    apiMocks.getTestRecipients.mockReturnValue(ok([{ id: 'f1', displayName: '見本 167', pictureUrl: null }]))
    apiMocks.getTestRecipientLoginUsers.mockReturnValue(ok([]))
    render(<TestRecipientsSetting accountId="acc-a" />)
    await flush()
    expect(screen.getByText('見本 167')).toBeTruthy()
    expect(apiMocks.getTestRecipients).toHaveBeenCalledWith('acc-a')
  })

  it('読み込み失敗は未設定と混ぜず、再読み込みでやり直せる', async () => {
    apiMocks.getTestRecipients.mockReturnValue(Promise.resolve({ success: false, error: 'server error' }))
    apiMocks.getTestRecipientLoginUsers.mockReturnValue(ok([]))
    render(<TestRecipientsSetting accountId="acc-a" />)
    await flush()
    expect(screen.getByText(/読み込めませんでした/)).toBeTruthy()
    // 失敗を空一覧で取り繕わない（検索欄を出さない）。
    expect(screen.queryByPlaceholderText('友だちを検索して追加…')).toBeNull()

    apiMocks.getTestRecipients.mockReturnValue(ok([{ id: 'f1', displayName: '見本 167', pictureUrl: null }]))
    fireEvent.click(screen.getByRole('button', { name: '再読み込み' }))
    await flush()
    expect(screen.getByText('見本 167')).toBeTruthy()
  })

  it('アカウント切替後に届いた前アカウントの応答で上書きしない', async () => {
    const slowA = deferred<{ success: true; data: Array<{ id: string; displayName: string; pictureUrl: null }> }>()
    const usersA = deferred<{ success: true; data: unknown[] }>()
    apiMocks.getTestRecipients.mockImplementation((accountId: string) =>
      accountId === 'acc-a' ? slowA.promise : ok([{ id: 'f9', displayName: '別アカウントの人', pictureUrl: null }]),
    )
    apiMocks.getTestRecipientLoginUsers.mockImplementation((accountId: string) =>
      accountId === 'acc-a' ? usersA.promise : ok([]),
    )

    const { rerender } = render(<TestRecipientsSetting accountId="acc-a" />)
    // acc-a の応答が来る前に acc-b へ切り替える。
    rerender(<TestRecipientsSetting accountId="acc-b" />)
    await flush()
    expect(screen.getByText('別アカウントの人')).toBeTruthy()

    // 遅れて届いた acc-a の応答は捨てる。
    await act(async () => {
      slowA.resolve({ success: true, data: [{ id: 'f1', displayName: '古い送信先', pictureUrl: null }] })
      usersA.resolve({ success: true, data: [] })
      await Promise.resolve()
    })
    expect(screen.queryByText('古い送信先')).toBeNull()
    expect(screen.getByText('別アカウントの人')).toBeTruthy()
  })

  it('保存済みの人はログインユーザー候補から外し、候補を押すと同じアカウントの送信先へ足して保存する', async () => {
    apiMocks.getTestRecipients.mockReturnValue(ok([{ id: 'f1', displayName: '見本 167', pictureUrl: null }]))
    apiMocks.getTestRecipientLoginUsers.mockReturnValue(ok([
      { id: 'f1', displayName: '見本 167', pictureUrl: null, staffName: '見本 167', sameAccount: true },
      { id: 'f2', displayName: '候補 花子', pictureUrl: null, staffName: '候補 花子', sameAccount: true },
    ]))
    apiMocks.updateTestRecipients.mockReturnValue(ok(null))
    render(<TestRecipientsSetting accountId="acc-a" />)
    await flush()
    expect(apiMocks.getTestRecipientLoginUsers).toHaveBeenCalledWith('acc-a')
    expect(screen.getByText('ログインユーザーから追加')).toBeTruthy()
    expect(screen.queryByTitle('見本 167をテスト送信先に追加')).toBeNull()
    fireEvent.click(screen.getByTitle('候補 花子をテスト送信先に追加'))
    await flush()
    expect(apiMocks.updateTestRecipients).toHaveBeenCalledWith('acc-a', ['f1', 'f2'])
    expect(screen.queryByTitle('候補 花子をテスト送信先に追加')).toBeNull()
  })

  it('保存に失敗したら失敗を出し、サーバの真値へ戻す', async () => {
    apiMocks.getTestRecipients.mockReturnValue(ok([]))
    apiMocks.getTestRecipientLoginUsers.mockReturnValue(ok([
      { id: 'f2', displayName: '候補 花子', pictureUrl: null, staffName: '候補 花子', sameAccount: true },
    ]))
    apiMocks.updateTestRecipients.mockReturnValue(Promise.resolve({ success: false, error: 'forbidden' }))
    render(<TestRecipientsSetting accountId="acc-a" />)
    await flush()

    // ログインユーザー候補からの追加で保存を試みる。
    fireEvent.click(screen.getByRole('button', { name: /候補 花子/ }))
    await flush()
    expect(screen.getByText('テスト送信先を保存できませんでした。時間をおいて、もう一度お試しください。')).toBeTruthy()
    // 保存失敗後は真値（空）へ戻り、追加した人が送信先として残らない。
    expect(screen.queryByTitle('候補 花子を削除する')).toBeNull()
  })
})
