// @vitest-environment happy-dom
/*
 * #816 — 宛先のタブ（C-2）の描画。
 *
 * 空・読み込み中・失敗・正常の4つを固定する。
 */
import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'

const fixture = vi.hoisted(() => ({ recipients: vi.fn() }))

vi.mock('@/lib/api', () => ({ api: { broadcasts: { recipients: fixture.recipients } } }))

import BroadcastRecipients from './broadcast-recipients'
import type { BroadcastRecipientRow } from '@/lib/api'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const SUMMARY = {
  sent: 1, failedTemporary: 1, failedPermanent: 1, unknown: 0, inFlight: 0,
  pending: 0, total: 3, retryableCount: 1,
}

function row(displayName: string, group: BroadcastRecipientRow['group'], label: string) {
  return {
    friendId: `id-${displayName}`,
    displayName,
    lineAccountId: 'account-1',
    group,
    label,
    detail: '理由',
    retryable: group === 'failed_temporary',
    lineRequestId: null,
    errorCode: null,
    dispatchedAt: '2026-10-01T10:00:00+09:00',
    settledAt: '2026-10-01T10:00:00+09:00',
  }
}

describe('宛先のタブ', () => {
  it('読み込み中は1枚だけ出す', () => {
    fixture.recipients.mockImplementation(() => new Promise(() => undefined))
    render(<BroadcastRecipients broadcastId="b1" total={3} version={1} />)
    expect(screen.getByLabelText('宛先を読み込んでいます')).toBeTruthy()
  })

  it('失敗は読み直せる', async () => {
    fixture.recipients.mockRejectedValueOnce(new Error('down'))
    fixture.recipients.mockResolvedValueOnce({
      success: true,
      data: { rows: [], summary: SUMMARY, aggregateOnly: false, aggregateReason: null, legacySuccessCount: null },
    })
    render(<BroadcastRecipients broadcastId="b1" total={3} version={1} />)
    await waitFor(() => expect(screen.getByText('宛先を読み込めませんでした')).toBeTruthy())
    screen.getByRole('button', { name: 'もう一度読み込む' }).click()
    await waitFor(() => expect(screen.getByText('宛先の結果はまだありません')).toBeTruthy())
  })

  it('空は作り直しを促さない', async () => {
    fixture.recipients.mockResolvedValue({
      success: true,
      data: { rows: [], summary: SUMMARY, aggregateOnly: false, aggregateReason: null, legacySuccessCount: null },
    })
    render(<BroadcastRecipients broadcastId="b1" total={3} version={1} />)
    await waitFor(() => expect(screen.getByText('宛先の結果はまだありません')).toBeTruthy())
  })

  it('書き出しは宛先のタブの中に1つだけある', async () => {
    fixture.recipients.mockResolvedValue({
      success: true,
      data: {
        rows: [row('山田花子', 'delivered', '届いた')],
        summary: SUMMARY,
        aggregateOnly: false,
        aggregateReason: null,
        legacySuccessCount: null,
      },
    })
    render(<BroadcastRecipients broadcastId="b1" total={3} version={1} />)
    await waitFor(() => expect(screen.getByText('山田花子')).toBeTruthy())
    // 下の追従バーと二重にならない。タブの中の1つだけ。
    expect(screen.getAllByRole('button', { name: 'CSVに書き出す' })).toHaveLength(1)
  })

  it('宛先ごとに札と件数を出す', async () => {
    fixture.recipients.mockResolvedValue({
      success: true,
      data: {
        rows: [
          row('山田花子', 'delivered', '届いた'),
          row('佐々木健', 'failed_permanent', '失敗：届けられませんでした'),
          row('鈴木一郎', 'failed_temporary', '失敗：一時的（あとで再送できます）'),
        ],
        summary: SUMMARY,
        aggregateOnly: false,
        aggregateReason: null,
        legacySuccessCount: null,
      },
    })
    render(<BroadcastRecipients broadcastId="b1" total={3} version={1} />)
    await waitFor(() => expect(screen.getByText('山田花子')).toBeTruthy())
    expect(screen.getByText('LINEが受け付けました：1人')).toBeTruthy()
    expect(within(screen.getByText('山田花子').closest('li')!).getByText('LINEが受け付けました')).toBeTruthy()
    expect(screen.queryByText('届いた')).toBeNull()
    expect(screen.getByText('失敗 2')).toBeTruthy()
    expect(screen.getByText('送る前 0')).toBeTruthy()
    expect(screen.getByRole('button', { name: /1件を再送/ })).toBeTruthy()
  })

  it('再送できる未送信の宛先を共通の状態の札で表示する', async () => {
    fixture.recipients.mockResolvedValue({success:true,data:{rows:[row('山田花子','failed_temporary','未送信（再送できます）')],summary:SUMMARY,aggregateOnly:false,aggregateReason:null,legacySuccessCount:null}})
    render(<BroadcastRecipients broadcastId="b1" total={3} version={1} />)
    await waitFor(() => expect(screen.getByText('未送信（再送できます）')).toBeTruthy())
    expect(screen.getByText('未送信（再送できます）').closest('[data-design-node="xRvDB"]')?.getAttribute('data-tone')).toBe('warning')
  })

  it('宛先の結果は共通の状態の札で色を分け、時刻は time で桁をそろえる', async () => {
    fixture.recipients.mockResolvedValue({
      success: true,
      data: {
        rows: [row('山田花子', 'delivered', '届いた'), row('佐藤次郎', 'failed_permanent', '届けられなかった'), row('鈴木一郎', 'failed_temporary', '一時的な失敗')],
        summary: SUMMARY, aggregateOnly: false, aggregateReason: null, legacySuccessCount: null,
      },
    })
    render(<BroadcastRecipients broadcastId="b1" total={3} version={1} />)
    await waitFor(() => expect(screen.getByText('山田花子')).toBeTruthy())
    const tone = (name: string) => screen.getByText(name).closest('li')?.querySelector('[data-design-node="xRvDB"]')?.getAttribute('data-tone')
    expect(tone('山田花子')).toBe('success')
    expect(tone('佐藤次郎')).toBe('danger')
    expect(tone('鈴木一郎')).toBe('warning')
    expect(screen.getByText('山田花子').closest('li')?.querySelector('time')?.getAttribute('dateTime')).toBe('2026-10-01T10:00:00+09:00')
  })

  it('旧配信は集約だけと書く（行を作らない）', async () => {
    fixture.recipients.mockResolvedValue({
      success: true,
      data: { rows: [], summary: SUMMARY, aggregateOnly: true, aggregateReason: 'legacy', legacySuccessCount: 120 },
    })
    render(<BroadcastRecipients broadcastId="b1" total={150} version={1} />)
    await waitFor(() => expect(screen.getByText('宛先ごとの結果はありません')).toBeTruthy())
    expect(screen.getByText('この配信は集約だけの古い記録です（成功の記録 120人）。お客さまに届いたかは確認できません。')).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('受付が確定したgroupだけを受付表現にし、不明・失敗・送信中は元の結果を保つ', async () => {
    fixture.recipients.mockResolvedValue({
      success: true,
      data: {
        rows: [
          row('受付済み', 'delivered', '届いた'),
          row('未確認', 'unknown', '確認できていません'),
          row('待機中', 'inflight', '送信中'),
          row('一時失敗', 'failed_temporary', '一時的な失敗'),
          row('恒久失敗', 'failed_permanent', '届けられなかった'),
        ],
        summary: { ...SUMMARY, unknown: 1, inFlight: 1, total: 5 },
        aggregateOnly: false, aggregateReason: null, legacySuccessCount: null,
      },
    })
    render(<BroadcastRecipients broadcastId="b1" total={5} version={1} />)
    await waitFor(() => expect(screen.getByText('受付済み')).toBeTruthy())
    const result = (name: string, label: string) => within(screen.getByText(name).closest('li')!).getByText(label)
    expect(result('受付済み', 'LINEが受け付けました')).toBeTruthy()
    expect(result('未確認', '確認できていません')).toBeTruthy()
    expect(result('待機中', '送信中')).toBeTruthy()
    expect(result('一時失敗', '一時的な失敗')).toBeTruthy()
    expect(result('恒久失敗', '届けられなかった')).toBeTruthy()
  })

  it('受付件数0を保ち、旧集約の欠測は0人にせず、全員配信は宛先一覧を作らない', async () => {
    fixture.recipients.mockResolvedValue({
      success: true,
      data: { rows: [], summary: { ...SUMMARY, sent: 0 }, aggregateOnly: false, aggregateReason: null, legacySuccessCount: null },
    })
    const view = render(<BroadcastRecipients broadcastId="b1" total={3} version={1} />)
    await waitFor(() => expect(screen.getByText('LINEが受け付けました：0人')).toBeTruthy())
    fixture.recipients.mockResolvedValue({
      success: true,
      data: { rows: [], summary: SUMMARY, aggregateOnly: true, aggregateReason: 'legacy', legacySuccessCount: null },
    })
    view.rerender(<BroadcastRecipients broadcastId="b2" total={3} version={1} />)
    await waitFor(() => expect(screen.getByText('この配信は集約だけの古い記録です。お客さまに届いたかは確認できません。')).toBeTruthy())
    expect(screen.queryByText(/成功の記録/)).toBeNull()
    fixture.recipients.mockResolvedValue({
      success: true,
      data: { rows: [], summary: SUMMARY, aggregateOnly: true, aggregateReason: 'all', legacySuccessCount: null },
    })
    view.rerender(<BroadcastRecipients broadcastId="b3" total={3} version={1} />)
    await waitFor(() => expect(screen.getByText('全員への配信は宛先の一覧を持ちません。')).toBeTruthy())
    expect(screen.queryByRole('list')).toBeNull()
  })
})
