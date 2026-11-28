// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  account: null as string | null,
  list: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    broadcastMessageAssets: {
      list: (...args: unknown[]) => fixture.list(...args),
    },
  },
}))

vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.account }),
}))

vi.mock('./frame', () => ({
  TemplateEditFrame: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

import StoredAssetEditor from './stored-asset-editor'

beforeEach(() => {
  fixture.account = null
  fixture.list.mockReset()
})

afterEach(cleanup)

describe('StoredAssetEditor の未選択・失敗・未検出の出し分け', () => {
  it('アカウント未選択のときはエラーや押しても動かないボタンを出さず、選択案内だけを出す', () => {
    fixture.account = null
    render(<StoredAssetEditor id="c1">{asset => <p>{asset.name}</p>}</StoredAssetEditor>)

    expect(screen.getByText('LINEアカウントを選んでください')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /再読み込み|もう一度/ })).toBeNull()
    expect(fixture.list).not.toHaveBeenCalled()
  })

  it('読み込み失敗のときはエラー表示と再読込ボタンを出す', async () => {
    fixture.account = 'acc-a'
    fixture.list.mockResolvedValueOnce({ success: false, error: 'server error' })

    render(<StoredAssetEditor id="c1">{asset => <p>{asset.name}</p>}</StoredAssetEditor>)

    expect(await screen.findByText('クーポンを読み込めませんでした')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'もう一度読み込む' })).toBeTruthy()
    expect(screen.queryByText('このクーポンは見つかりません')).toBeNull()
  })

  it('一覧取得は成功したが対象が見つからないときは、読み込み失敗ではなく未検出の案内を出す', async () => {
    fixture.account = 'acc-a'
    fixture.list.mockResolvedValueOnce({
      success: true,
      data: [{ id: 'other-id', name: '別の券', lineAccountId: 'acc-a' }],
    })

    render(<StoredAssetEditor id="c1">{asset => <p>{asset.name}</p>}</StoredAssetEditor>)

    expect(await screen.findByText('このクーポンは見つかりません')).toBeTruthy()
    expect(screen.queryByText('クーポンを読み込めませんでした')).toBeNull()
  })
})
