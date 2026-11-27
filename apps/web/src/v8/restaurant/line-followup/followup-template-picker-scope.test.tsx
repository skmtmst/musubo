// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({
  messages: vi.fn(),
  assets: vi.fn(),
  get: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: {
    templates: { listPage: calls.messages, get: calls.get },
    broadcastMessageAssets: { list: calls.assets },
  },
}))

import { FollowupTemplatePicker } from './followup-template-picker'

const assetA = {
  id: 'asset-a',
  name: 'アカウントAのクーポン',
  kind: 'coupon',
  lineAccountId: 'account-a',
  payload: { couponId: 'cp-a', title: '100円引き' },
}

const templateA = {
  id: 'tpl-a',
  name: 'アカウントAの案内',
  accountId: 'account-a',
  category: '',
  messageType: 'text',
  messageContent: 'アカウントAの本文',
  publishedVersion: 1,
  publishedAt: '2026-10-31T00:00:00Z',
}

const templateB = {
  id: 'tpl-b',
  name: 'アカウントBの案内',
  accountId: 'account-b',
  category: '',
  messageType: 'text',
  messageContent: 'アカウントBの本文',
  publishedVersion: 1,
  publishedAt: '2026-10-31T00:00:00Z',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('FollowupTemplatePicker のアカウント切替・選択競合の防止', () => {
  it('アカウントを切り替えた直後に前アカウントの候補を残さず、選択できない', async () => {
    calls.messages
      .mockResolvedValueOnce({ success: true, data: { items: [templateA], total: 1 } })
      .mockResolvedValueOnce({ success: true, data: { items: [templateB], total: 1 } })
    calls.assets
      .mockResolvedValueOnce({ success: true, data: [assetA] })
      .mockResolvedValueOnce({ success: true, data: [] })

    const onPick = vi.fn()
    const view = render(
      <FollowupTemplatePicker accountId="account-a" storeName="渋谷本店" onCancel={() => {}} onPick={onPick} />,
    )

    expect(await screen.findByRole('radio', { name: assetA.name })).not.toBeNull()

    view.rerender(
      <FollowupTemplatePicker accountId="account-b" storeName="新宿店" onCancel={() => {}} onPick={onPick} />,
    )

    expect(screen.queryByRole('radio', { name: assetA.name })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('読み込んでいます')
    expect(await screen.findByRole('radio', { name: templateB.name })).not.toBeNull()
    expect(onPick).not.toHaveBeenCalled()
  })

  it('テンプレート詳細取得中にアカウントを切り替えても、古い取得の失敗で新アカウントにエラーを出さない', async () => {
    const getA = deferred<{ success: boolean; data?: typeof templateA }>()
    calls.messages
      .mockResolvedValueOnce({ success: true, data: { items: [templateA], total: 1 } })
      .mockResolvedValueOnce({ success: true, data: { items: [templateB], total: 1 } })
    calls.assets.mockResolvedValue({ success: true, data: [] })
    calls.get.mockReturnValueOnce(getA.promise)

    const onPick = vi.fn()
    const view = render(
      <FollowupTemplatePicker accountId="account-a" storeName="渋谷本店" onCancel={() => {}} onPick={onPick} />,
    )

    const optionA = await screen.findByRole('radio', { name: templateA.name })
    fireEvent.click(optionA)
    fireEvent.click(screen.getByRole('button', { name: '選ぶ' }))
    await waitFor(() => expect(calls.get).toHaveBeenCalledWith(templateA.id))

    view.rerender(
      <FollowupTemplatePicker accountId="account-b" storeName="新宿店" onCancel={() => {}} onPick={onPick} />,
    )
    expect(await screen.findByRole('radio', { name: templateB.name })).not.toBeNull()

    await act(async () => {
      getA.reject(new Error('stale failure'))
      try {
        await getA.promise
      } catch {
        // expected rejection
      }
    })

    expect(screen.queryByText('このテンプレートを読み込めませんでした。もう一度選んでください')).toBeNull()
    expect(onPick).not.toHaveBeenCalled()
  })
})
