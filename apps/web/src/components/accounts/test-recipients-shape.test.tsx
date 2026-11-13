// @vitest-environment happy-dom
/*
 * 全ルート監査 A1（2026-09-25）: `/accounts/detail` が
 * `s.filter is not a function` で落ちていた。原因は候補一覧の口が
 * 配列でない形（`{items,…}`）で返っていたこと。画面側は配列でない
 * 応答を読み込み失敗として出し、落とさない。
 */
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
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
const flush = () => act(async () => { await Promise.resolve() })

beforeEach(() => {
  apiMocks.getTestRecipients.mockReset()
  apiMocks.getTestRecipientLoginUsers.mockReset()
  apiMocks.updateTestRecipients.mockReset()
  apiMocks.friendsList.mockReset()
})
afterEach(cleanup)

describe('テスト送信先の形違い応答', () => {
  it('候補が配列でなくても落ちず読み込み失敗を出す', async () => {
    apiMocks.getTestRecipients.mockReturnValue(ok([{ id: 'f1', displayName: '見本 167', pictureUrl: null }]))
    // 旧偽APIの形（配列でない）。本物は配列を返す。
    apiMocks.getTestRecipientLoginUsers.mockReturnValue(ok({ items: [], total: 0, page: 1, limit: 20 }))
    render(<TestRecipientsSetting accountId="acc-a" />)
    await flush()
    expect(await screen.findByText('テスト送信先を読み込めませんでした。通信状態を確認してください。')).toBeTruthy()
  })

  it('送信先が配列でなくても落ちず読み込み失敗を出す', async () => {
    apiMocks.getTestRecipients.mockReturnValue(ok({ items: [], total: 0 }))
    apiMocks.getTestRecipientLoginUsers.mockReturnValue(ok([]))
    render(<TestRecipientsSetting accountId="acc-a" />)
    await flush()
    expect(await screen.findByText('テスト送信先を読み込めませんでした。通信状態を確認してください。')).toBeTruthy()
  })
})
