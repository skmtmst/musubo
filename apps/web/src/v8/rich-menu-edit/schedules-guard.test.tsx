// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({ listSchedules: vi.fn(), cancelSchedule: vi.fn() }))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      richMenuGroups: {
        ...actual.api.richMenuGroups,
        listSchedules: fx.listSchedules,
        cancelSchedule: fx.cancelSchedule,
      },
    },
  }
})

import { ApiError } from '@/lib/api'
import RichMenuSchedules from './schedules'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const scheduleItem = (id: string, status = 'scheduled') => ({
  id,
  mode: 'scheduled' as const,
  startsAt: '2026-10-20T01:00:00Z',
  endsAt: null,
  restoreGroupId: null,
  restoreDefaultState: null,
  status,
  attemptCount: 0,
  nextRetryAt: null,
  lastErrorCode: null,
  createdAt: '2026-10-01T00:00:00Z',
})

beforeEach(() => {
  vi.clearAllMocks()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
})

describe('RichMenuSchedules 権限エラー表示と再オープン時の古い状態破棄', () => {
  it('403 のときは権限不足の案内だけを出し、無意味な再試行ボタンを出さない', async () => {
    fx.listSchedules.mockRejectedValueOnce(new ApiError(403, 'forbidden'))
    await act(async () => {
      root.render(<RichMenuSchedules groupId="g-403" canOperate restoreMenus={[]} />)
    })

    fireEvent.click(screen.getByRole('button', { name: '公開予約の一覧' }))
    const dialog = await screen.findByRole('dialog', { name: '公開予約の一覧' })

    expect(await within(dialog).findByText('公開予約の一覧を見る権限がありません。')).toBeTruthy()
    expect(within(dialog).queryByRole('button', { name: '再試行' })).toBeNull()
  })

  it('取消後に閉じて開き直したとき、前回の完了通知や古い一覧を引き継がない', async () => {
    fx.listSchedules
      .mockResolvedValueOnce({ success: true, data: [scheduleItem('s-1', 'scheduled')] })
      .mockResolvedValueOnce({ success: true, data: [scheduleItem('s-1', 'cancelled')] })
      .mockReturnValueOnce(new Promise(() => {}))
    fx.cancelSchedule.mockResolvedValueOnce({ success: true, data: { id: 's-1', status: 'cancelled' } })

    await act(async () => {
      root.render(<RichMenuSchedules groupId="g-1" canOperate restoreMenus={[]} />)
    })

    fireEvent.click(screen.getByRole('button', { name: '公開予約の一覧' }))
    const dialog1 = await screen.findByRole('dialog', { name: '公開予約の一覧' })
    fireEvent.click(await within(dialog1).findByRole('button', { name: '予約を取り消す' }))
    await within(dialog1).findByText('予約を取り消しました。')
    await within(dialog1).findByText('取消済み')

    // 閉じて開き直すと、古い通知・古い一覧を消して読み込み中から始める
    fireEvent.click(within(dialog1).getByRole('button', { name: '閉じる' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '公開予約の一覧' })).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: '公開予約の一覧' }))
    const dialog2 = await screen.findByRole('dialog', { name: '公開予約の一覧' })
    expect(within(dialog2).queryByText('予約を取り消しました。')).toBeNull()
    expect(within(dialog2).queryByText('取消済み')).toBeNull()
    expect(within(dialog2).getByText('読み込み中…')).toBeTruthy()
  })
})
