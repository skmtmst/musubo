// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultRestaurantReservationForm, RESTAURANT_FOLLOWUP_LABELS, type RestaurantFollowupTrigger } from '@line-crm/shared'

const fixture = vi.hoisted(() => ({ read: vi.fn(), saveRow: vi.fn(), initialize: vi.fn(), test: vi.fn(), start: vi.fn(), saveForm: vi.fn(), notUsing: vi.fn() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1' }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner' }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => '/restaurant-test/line-followup', useSearchParams: () => new URLSearchParams() }))
vi.mock('@/v8/restaurant/common-a/public/frame/index', () => ({ RestaurantFrame: ({ children }: { children: (ctx: unknown) => React.ReactNode }) => children({ store: { id: 'store-1', name: '試験店' } }) }))
vi.mock('@/lib/api/helpers/restaurant-followup-board', () => ({ followupBoardApi: fixture }))
import LineFollowupV8 from '@/v8/restaurant/line-followup/line-followup'

const triggers = Object.keys(RESTAURANT_FOLLOWUP_LABELS) as RestaurantFollowupTrigger[]
const timing = (trigger: RestaurantFollowupTrigger) => trigger === 'anniversary_before'
  ? { mode: 'time' as const, offsetDays: -7, sendAtTime: '10:00' }
  : { mode: 'countdown' as const, offsetMinutes: trigger === 'post_visit' ? 180 : trigger.startsWith('reservation_') && trigger !== 'reservation_created' ? -120 : 0 }
const content = (trigger: RestaurantFollowupTrigger) => ({ timing: timing(trigger), messageParts: [{ messageType: 'text', messageContent: 'ありがとうございました' }] })
let live: ReturnType<typeof snapshot>
function snapshot() {
  return {
    page: { rows: triggers.map(trigger => ({ trigger, enabled: true, version: 3, default_offset_minutes: 0 })), bindings: [], template: null, setup: { notUsing: false, version: 0 } },
    board: {
      testRecipient: { state: 'ready', recipientKind: 'self', recipient: { id: 'self', displayName: '本人' } },
      legacyContents: triggers.map(trigger => ({ trigger, content: content(trigger) })),
      engines: triggers.map(trigger => ({ trigger, engine: 'automation', targetId: `target-${trigger}`, targetVersion: 4, contentRevision: 'revision-4', enabled: true, effectiveSendingStatus: 'stopped', reason: 'テスト送信と承認を待っています', detailPath: `/automations/drafts?id=target-${trigger}`, editorContent: content(trigger) })),
    },
    form: { version: 0, definition: defaultRestaurantReservationForm() },
  }
}
beforeEach(() => {
  live = snapshot()
  fixture.read.mockImplementation(async () => structuredClone(live))
  fixture.saveRow.mockResolvedValue({})
  fixture.test.mockResolvedValue({ recipientName: '本人', recipientKind: 'self', contentHash: 'same-content', versionId: 'version-4' })
  fixture.start.mockImplementation(async () => { live.board.engines.find(row => row.trigger === 'post_visit')!.effectiveSendingStatus = 'active'; return {} })
})
afterEach(() => { cleanup(); vi.resetAllMocks() })
async function ready() { render(React.createElement(LineFollowupV8)); await screen.findByRole('article', { name: '予約の回答フォーム' }) }
const postVisit = () => screen.getByRole('article', { name: RESTAURANT_FOLLOWUP_LABELS.post_visit })
async function editPostVisit() { await ready(); fireEvent.click(within(postVisit()).getByRole('button', { name: '変更する' })); await screen.findByRole('dialog') }

describe('LINE来店フォローの接続後の契約', () => {
  it('8枚のカードと7つのスイッチを保ち、来店後は保存済みの時期と本文を描く', async () => {
    await ready()
    expect(screen.getAllByRole('article')).toHaveLength(8)
    expect(screen.getAllByRole('switch')).toHaveLength(7)
    expect(within(screen.getByRole('article', { name: '予約の回答フォーム' })).queryByRole('switch')).toBeNull()
    for (const name of Object.values(RESTAURANT_FOLLOWUP_LABELS)) expect(screen.getByRole('article', { name })).toBeTruthy()
    expect(within(postVisit()).getByText('退店から3時間後に送る')).toBeTruthy()
    fireEvent.click(within(postVisit()).getByRole('button', { name: '変更する' }))
    expect(screen.getByRole('textbox', { name: '本文' }).textContent).toBe('ありがとうございました')
    expect((screen.getByRole('spinbutton', { name: 'きっかけから待つ時間' }) as HTMLInputElement).value).toBe('3')
    expect(fixture.read).toHaveBeenCalledWith('account-1', 'store-1')
  })
  it('変えた行だけを現在の版で保存し、他の行や公開・送信へ進まない', async () => {
    await editPostVisit()
    const body = screen.getByRole('textbox', { name: '本文' })
    await act(async () => { body.textContent = 'またお待ちしています'; fireEvent.input(body) })
    fireEvent.click(screen.getByRole('button', { name: 'この内容でオンにする' }))
    expect(fixture.saveRow).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '保存して作る' }))
    await waitFor(() => expect(fixture.saveRow).toHaveBeenCalledTimes(1))
    expect(fixture.saveRow).toHaveBeenCalledWith('account-1', 'store-1', 'post_visit', expect.objectContaining({ expectedRowVersion: 3, expectedTargetVersion: 4, expectedContentRevision: 'revision-4', enabled: true, timing: { mode: 'countdown', offsetMinutes: 180 }, messageBubbles: [expect.objectContaining({ type: 'text', content: expect.objectContaining({ text: 'またお待ちしています' }) })] }))
    expect(fixture.initialize).not.toHaveBeenCalled(); expect(fixture.test).not.toHaveBeenCalled(); expect(fixture.start).not.toHaveBeenCalled()
  })
  it('同じ版のテスト成功後だけ開始し、停止は対象の行をオフにして版付きで保存する', async () => {
    await ready(); fireEvent.click(within(postVisit()).getByRole('button', { name: '試す・送り始める' }))
    expect(screen.queryByRole('button', { name: 'この内容で送り始める' })).toBeNull()
    expect(fixture.start).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '自分の LINE で試す' }))
    await screen.findByRole('button', { name: 'この内容で送り始める' })
    expect(fixture.test).toHaveBeenCalledWith('account-1', 'store-1', 'post_visit', 4)
    expect(fixture.start).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'この内容で送り始める' }))
    await waitFor(() => expect(fixture.start).toHaveBeenCalledWith('account-1', 'store-1', 'post_visit', 4, 'same-content'))
    expect(fixture.start.mock.invocationCallOrder[0]).toBeGreaterThan(fixture.test.mock.invocationCallOrder[0]!)
    fireEvent.click(screen.getByRole('button', { name: '閉じる', exact: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(within(postVisit()).getByRole('switch'))
    fireEvent.click(screen.getByRole('button', { name: '保存して作る' }))
    await waitFor(() => expect(fixture.saveRow).toHaveBeenCalledWith('account-1', 'store-1', 'post_visit', expect.objectContaining({ expectedRowVersion: 3, expectedTargetVersion: 4, enabled: false })))
  })
})
