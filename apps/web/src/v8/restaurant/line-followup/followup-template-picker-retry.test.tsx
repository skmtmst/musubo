// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ messages: vi.fn(), assets: vi.fn(), get: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: {
    templates: { listPage: calls.messages, get: calls.get },
    broadcastMessageAssets: { list: calls.assets },
  },
}))

import { FollowupTemplatePicker } from './followup-template-picker'

const templateA = {
  id: 'tpl-a',
  name: 'ご予約ありがとうございます',
  accountId: 'account-a',
  category: '',
  messageType: 'text',
  messageContent: 'ご来店をお待ちしています',
  publishedVersion: 1,
  publishedAt: '2026-10-31T00:00:00Z',
}

beforeEach(() => {
  calls.messages.mockResolvedValue({ success: true, data: { items: [templateA], total: 1 } })
  calls.assets.mockResolvedValue({ success: true, data: [] })
  calls.get.mockResolvedValue({ success: true, data: templateA })
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('FollowupTemplatePicker の失敗時再読み込みと再選択', () => {
  it('一覧の読み込みに失敗しても窓を閉じずにその場でもう一度読み込める', async () => {
    calls.messages
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ success: true, data: { items: [templateA], total: 1 } })

    const onPick = vi.fn()
    render(<FollowupTemplatePicker accountId="account-a" storeName="試験店" onCancel={() => {}} onPick={onPick} />)

    await screen.findByText(/テンプレートを読み込めませんでした/)
    const retry = screen.getByRole('button', { name: 'もう一度読み込む' })
    fireEvent.click(retry)

    const option = await screen.findByRole('radio', { name: templateA.name })
    fireEvent.click(option)
    fireEvent.click(screen.getByRole('button', { name: '選択する' }))
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1))
    expect(calls.messages).toHaveBeenCalledTimes(2)
  })

  it('選んだテンプレートの取得に失敗しても一覧を消さず、そのまま選び直せる', async () => {
    calls.get
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ success: true, data: templateA })

    const onPick = vi.fn()
    render(<FollowupTemplatePicker accountId="account-a" storeName="試験店" onCancel={() => {}} onPick={onPick} />)

    const option = await screen.findByRole('radio', { name: templateA.name })
    fireEvent.click(option)
    const confirm = screen.getByRole('button', { name: '選択する' }) as HTMLButtonElement
    fireEvent.click(confirm)

    await screen.findByText('このテンプレートを読み込めませんでした。もう一度選んでください')
    expect(screen.getByRole('radio', { name: templateA.name })).toBeTruthy()
    expect(confirm.disabled).toBe(false)

    fireEvent.click(confirm)
    await waitFor(() => expect(onPick).toHaveBeenCalledTimes(1))
    expect(calls.get).toHaveBeenCalledTimes(2)
  })
})
