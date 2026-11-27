// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({
  eventId: 'ev-1',
  accountId: 'acc-1',
  runApply: vi.fn(),
  preview: {
    blocked: false,
    total_confirmed: Number.NaN,
    total_waiting: -1,
    impacts: [],
  } as {
    blocked: boolean
    total_confirmed: number
    total_waiting: number
    impacts: Array<{ slot_id: string; confirmed_seats: number; waiting_seats: number; errors: string[]; notices: string[] }>
  },
  edits: {
    'slot-1': { startsAt: '2026-12-01T14:00', endsAt: '2026-12-01T13:00', capacity: '10', isActive: true },
    'slot-2': { startsAt: '2026-12-02T10:00', endsAt: '2026-12-02T12:00', capacity: '10', isActive: true },
  } as Record<string, { startsAt: string; endsAt: string; capacity: string; isActive: boolean }>,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/events/change-review',
  useSearchParams: () => new URLSearchParams(`id=${fx.eventId}`),
}))

vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => undefined,
  usePageCrumbs: () => undefined,
}))

vi.mock('@/components/shared/list-navigation', () => ({
  useListNavigationRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  default: ({ children, href, ...rest }: { children: React.ReactNode; href: string }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}))

vi.mock('./change-review-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./change-review-model')>()
  return {
    ...actual,
    useChangeReview: () => ({
      selectedAccountId: fx.accountId,
      status: 'ready' as const,
      event: { id: fx.eventId, name: '秋のセミナー' },
      slotList: [
        { id: 'slot-1', starts_at: '2026-12-01T01:00:00Z', ends_at: '2026-12-01T03:00:00Z', capacity: 10, active_count: 2, is_active: 1 },
        { id: 'slot-2', starts_at: '2026-12-02T01:00:00Z', ends_at: '2026-12-02T03:00:00Z', capacity: 10, active_count: 1, is_active: 1 },
      ],
      edits: fx.edits,
      setEdits: vi.fn(),
      venueName: '東京会場',
      setVenueName: vi.fn(),
      venueUrl: '',
      setVenueUrl: vi.fn(),
      preview: fx.preview,
      previewBusy: false,
      previewError: '',
      reason: '会場都合',
      setReason: vi.fn(),
      applyBusy: false,
      applyError: null,
      applied: null,
      isPublished: true,
      refresh: vi.fn(),
      touchEdits: vi.fn(),
      runApply: fx.runApply,
    }),
  }
})

import EventChangeReviewV8 from './change-review'

beforeEach(() => {
  vi.resetAllMocks()
  fx.eventId = 'ev-1'
  fx.accountId = 'acc-1'
  fx.preview = {
    blocked: false,
    total_confirmed: Number.NaN,
    total_waiting: -1,
    impacts: [],
  }
  fx.edits = {
    'slot-1': { startsAt: '2026-12-01T14:00', endsAt: '2026-12-01T13:00', capacity: '10', isActive: true },
    'slot-2': { startsAt: '2026-12-02T10:00', endsAt: '2026-12-02T12:00', capacity: '10', isActive: true },
  }
})

afterEach(() => {
  cleanup()
})

describe('EventChangeReviewV8 他スロット不正入力・NaN人数・イベント切替時の確認ダイアログ防御', () => {
  it('別の開催回に不正な終了日時が残っている場合、正常な開催回へ切り替えても「変えてお知らせする」を押せない', () => {
    render(<EventChangeReviewV8 />)
    const radios = within(screen.getByRole('radiogroup', { name: '変える回' })).getAllByRole('radio')
    expect(radios).toHaveLength(2)

    // 正常な slot-2 に切り替える
    fireEvent.click(radios[1])
    const submitBtn = screen.getByRole('button', { name: '変えてお知らせする' }) as HTMLButtonElement
    expect(submitBtn.disabled).toBe(true)
  })

  it('preview の人数が NaN・負数のときは「0 人」と偽装せず確認不能表示にし、イベント切替で確認ダイアログを閉じる', () => {
    fx.edits = {
      'slot-1': { startsAt: '2026-12-01T10:00', endsAt: '2026-12-01T12:00', capacity: '10', isActive: true },
      'slot-2': { startsAt: '2026-12-02T10:00', endsAt: '2026-12-02T12:00', capacity: '10', isActive: true },
    }
    const view = render(<EventChangeReviewV8 />)
    expect(screen.getByText(/確定した申込 — 人/)).toBeTruthy()
    expect(screen.queryByText(/NaN/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '変えてお知らせする' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getAllByText('人数を確認できません').length).toBe(2)
    expect(screen.queryByText('変えて 0 人にお知らせする')).toBeNull()

    // イベントを切り替えると前のイベントの確認ダイアログが閉じる
    fx.eventId = 'ev-2'
    view.rerender(<EventChangeReviewV8 />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
