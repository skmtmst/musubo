// @vitest-environment happy-dom
/*
 * 監査 WEB318/319：イベントの公開の状態。
 * - 318：状態の取得に失敗したら「読み込んでいます」のまま残さず、読み直しを出す
 * - 319：状態を変えたら、上の「申込の状況」の札も読み直す
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({ getEvent: vi.fn(), getBookingSummary: vi.fn(), listSlots: vi.fn(), setEventLifecycle: vi.fn() }))

vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useSearchParams: () => ({ get: (key: string) => (key === 'id' ? 'ev-1' : null) }),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1', loading: false }) }))
vi.mock('@/components/shell/page-chrome', async () => ({ ...(await import('@/test-utils/page-chrome-mock')).pageChromeMock() }))
vi.mock('@/v8/events/edit-form', () => ({ default: () => <div>フォーム</div> }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    eventsApi: {
      ...actual.eventsApi,
      getEvent: (...args: unknown[]) => net.getEvent(...args),
      getBookingSummary: (...args: unknown[]) => net.getBookingSummary(...args),
      listSlots: (...args: unknown[]) => net.listSlots(...args),
      setEventLifecycle: (...args: unknown[]) => net.setEventLifecycle(...args),
    },
  }
})

const { default: EditEventPage } = await import('./page')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-18T00:00:00.000Z'))
  document.documentElement.dataset.theme = 'v8'
  net.getEvent.mockReset()
  net.listSlots.mockReset()
  net.listSlots.mockResolvedValue({ items: [{ is_active: 1, starts_at: '2099-12-01T00:00:00Z' }] })
  net.getBookingSummary.mockReset()
  net.getBookingSummary.mockResolvedValue({ confirmed: 1, totalCapacity: 10, requested: 0, waitlist: 0, cancelled: 0 })
  net.setEventLifecycle.mockReset()
})
afterEach(() => { cleanup(); delete document.documentElement.dataset.theme; vi.useRealTimers() })

describe('公開の状態（WEB318/319）', () => {
  it('申込の一覧へ表示中のイベントIDを渡す', async () => {
    net.getEvent.mockResolvedValue({ id: 'ev-1', lifecycle_status: 'published', is_published: 1 })
    render(<EditEventPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'その他の操作' }))
    expect((await screen.findByText('申込の一覧を見る')).closest('a')?.getAttribute('href')).toBe('/events/bookings?id=ev-1')
  })
  it('下書きの状態と公開する操作は見出しに並び、数の帯には重ねない', async () => {
    net.getEvent.mockResolvedValue({ id: 'ev-1', name: '2026大忘年会', lifecycle_status: 'draft', is_published: 0 })
    render(<EditEventPage />)
    const publish = await screen.findByRole('button', { name: '公開する' })
    const heading = publish.closest('[data-template-region="heading"]')!
    expect(heading.textContent).toContain('2026大忘年会')
    expect(heading.textContent).toContain('下書き')
    expect(document.querySelector('[data-template-region="stats"]')?.textContent).not.toContain('下書き')
  })
  it('予約数が取得できない場合は未取得として示し、undefined を表示しない', async () => {
    net.getEvent.mockResolvedValue({ id: 'ev-1', lifecycle_status: 'draft', is_published: 0 })
    net.getBookingSummary.mockResolvedValue({ totalCapacity: null, requested: 0, waitlist: 0, cancelled: 0 })
    render(<EditEventPage />)
    await waitFor(() => expect(document.querySelector('[data-template-region="stats"]')?.textContent).toContain('— / —'))
    expect(document.querySelector('[data-template-region="stats"]')?.textContent).not.toContain('undefined')
  })

  it.each([['ended', '終了'], ['cancelled', '中止']])('%s の札には公開状態を変える操作を出さない', async (lifecycle_status, label) => {
    net.getEvent.mockResolvedValue({ id: 'ev-1', lifecycle_status, is_published: 1 })
    render(<EditEventPage />)
    const heading = document.querySelector('[data-template-region="heading"]')!
    await waitFor(() => expect(heading.textContent).toContain(label))
    expect(screen.queryByRole('button', { name: '一時停止する' })).toBeNull()
    expect(screen.queryByRole('button', { name: '公開状態の操作' })).toBeNull()
  })

  it('これからの枠があると公開中の札と一時停止の操作を表示する', async () => {
    net.getEvent.mockResolvedValue({ id: 'ev-1', lifecycle_status: 'published', is_published: 1 })
    render(<EditEventPage />)
    const pause = await screen.findByRole('button', { name: '一時停止する' })
    const heading = pause.closest('[data-template-region="heading"]')!
    await waitFor(() => expect(heading.textContent).toContain('公開中'))
    expect(screen.getByRole('button', { name: '公開状態の操作' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'その他の操作' })).toBeTruthy()
  })

  it('これからの枠がない公開中イベントは終了の札と終了操作を表示する', async () => {
    net.getEvent.mockResolvedValue({ id: 'ev-1', lifecycle_status: 'published', is_published: 1 })
    net.listSlots.mockResolvedValue({ items: [{ is_active: 1, starts_at: '2026-01-01T00:00:00Z' }] })
    render(<EditEventPage />)
    const finish = await screen.findByRole('button', { name: '終了する' })
    expect(finish.closest('[data-template-region="heading"]')?.textContent).toContain('終了')
    expect(finish.getAttribute('data-variant')).toBe('primary')
    expect(screen.queryByRole('button', { name: '一時停止する' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '公開状態の操作' }))
    expect(await screen.findByRole('menuitem', { name: '中止する' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'その他の操作' })).toBeTruthy()
  })

  it('状態が読めなかったら、読み直しを出す', async () => {
    net.getEvent.mockRejectedValue(new Error('down'))
    render(<EditEventPage />)
    await waitFor(() => expect(screen.getByText('公開の状態を読み込めませんでした。')).toBeTruthy())
    expect(screen.queryByText('状態を読み込んでいます…')).toBeNull()
  })

  it('一時停止したら、申込の状況の札も一時停止になる', async () => {
    net.getEvent.mockResolvedValue({ id: 'ev-1', lifecycle_status: 'published', is_published: 1 })
    net.setEventLifecycle.mockResolvedValue({ lifecycle_status: 'paused' })
    render(<EditEventPage />)
    const pause = await screen.findByRole('button', { name: '一時停止する' })
    expect(pause.closest('[data-template-region="heading"]')).toBeTruthy()
    net.getEvent.mockResolvedValue({ id: 'ev-1', lifecycle_status: 'paused', is_published: 1 })
    await act(async () => { pause.click() })
    const reason = document.body.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => { fireEvent.change(reason, { target: { value: '台風' } }) })
    const confirm = screen.getAllByRole('button', { name: '一時停止する' }).at(-1)!
    await act(async () => { confirm.click() })
    await waitFor(() => expect(document.querySelector('[data-template-region="heading"]')?.textContent).toContain('停止中'))
    expect(net.setEventLifecycle).toHaveBeenCalledWith('acc-1', 'ev-1', expect.objectContaining({ to: 'paused', reason: '台風' }))
    expect(net.getEvent).toHaveBeenCalledTimes(2)
  })

  it('理由なしの中止を止め、二度押しと失敗後の再送でも同じ操作の鍵を使う', async () => {
    net.getEvent.mockResolvedValue({ id: 'ev-1', lifecycle_status: 'published', is_published: 1 })
    let fail!: (error: unknown) => void
    net.setEventLifecycle.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject })).mockResolvedValue({ lifecycle_status: 'cancelled' })
    render(<EditEventPage />)
    fireEvent.click(await screen.findByRole('button', { name: '公開状態の操作' }))
    const cancel = await screen.findByRole('menuitem', { name: '中止する' })
    await act(async () => { cancel.click() })
    const dialog = screen.getByRole('alertdialog')
    expect(dialog.textContent).toContain('LINEアカウント')
    expect(dialog.textContent).toContain('環境')
    let confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '中止する')!
    expect(confirm.disabled).toBe(true)
    expect(net.setEventLifecycle).not.toHaveBeenCalled()
    await act(async () => { fireEvent.change(dialog.querySelector('textarea')!, { target: { value: '荒天のため中止' } }) })
    confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '中止する')!
    await act(async () => { confirm.click(); confirm.click() })
    expect(net.setEventLifecycle).toHaveBeenCalledTimes(1)
    const key = net.setEventLifecycle.mock.calls[0][2].idempotency_key
    await act(async () => { fail(new Error('offline')) })
    await waitFor(() => expect(dialog.textContent).toContain('変えられませんでした'))
    expect(dialog.querySelector('textarea')?.value).toBe('荒天のため中止')
    confirm = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '中止する')!
    await act(async () => { confirm.click() })
    expect(net.setEventLifecycle).toHaveBeenLastCalledWith('acc-1', 'ev-1', { to: 'cancelled', reason: '荒天のため中止', idempotency_key: key })
  })
})
