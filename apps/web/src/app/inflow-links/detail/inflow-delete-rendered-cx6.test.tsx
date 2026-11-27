// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fx = vi.hoisted(() => ({ update: vi.fn(), replace: vi.fn(), fetch: vi.fn() }))
const route = { id: 'route-1', refCode: 'shop-qr', genre: '店頭', name: '店頭QR', tagId: null, scenarioId: null, redirectUrl: null, poolId: null, introTemplateId: null, runAccountFriendAddScenarios: true, isActive: true, createdAt: '2026-09-01T09:00:00.000+09:00', updatedAt: '2026-09-01T09:00:00.000+09:00' }
const other = { ...route, id: 'route-2', name: '別の経路', refCode: 'other-qr' }
vi.mock('next/navigation', async () => ({ ...(await import('@/test-utils/navigation-mock')).navigationMock(), useRouter: () => ({ replace: fx.replace }), useSearchParams: () => new URLSearchParams('id=route-1') }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [], selectedAccountId: 'account-a' }) }))
vi.mock('@/lib/pools-availability', () => ({ isPoolsFeatureAvailable: vi.fn().mockResolvedValue(false) }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  const empty = vi.fn().mockResolvedValue({ success: true, data: [] })
  return { ...actual, fetchApi: fx.fetch, api: { ...actual.api,
    entryRoutes: { ...actual.api.entryRoutes, list: vi.fn(async () => ({ success: true, data: [route, other] })), get: vi.fn(async () => ({ success: true, data: route })), funnel: vi.fn().mockResolvedValue({ success: true, data: { click_count: 0, friend_add_count: 0, form_submission_count: 0, cv_count: 0 } }), update: fx.update },
    tags: { ...actual.api.tags, list: empty }, scenarios: { ...actual.api.scenarios, list: empty }, templates: { ...actual.api.templates, list: empty },
    staff: { ...actual.api.staff, me: vi.fn().mockResolvedValue({ success: true, data: { role: 'owner' } }) },
  } }
})
import Page from './page'

beforeEach(() => {
  fx.update.mockResolvedValue({ success: true, data: { ...route, isActive: false } })
  fx.fetch.mockImplementation(async (path: string) => path.startsWith('/api/analytics/ref/') ? { success: true, data: { friends: [] } } : { success: true })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

async function open() {
  render(<Page />)
  fireEvent.click(await screen.findByRole('button', { name: '止める' }))
  return screen.findByRole('alertdialog')
}

async function selectTarget(dialog: HTMLElement) {
  fireEvent.click(within(dialog).getByRole('button', { name: '転送先のリンク' }))
  const picker = await screen.findByRole('dialog', { name: '転送先のリンクを選ぶ' })
  fireEvent.click(within(picker).getByRole('radio', { name: '別の経路（other-qr）' }))
  fireEvent.click(within(picker).getByRole('button', { name: '選択する' }))
}

it('実際の確認窓に名前と3つの選択肢、残る記録を示す', async () => {
  const dialog = await open()
  expect(dialog.textContent).toContain('「店頭QR」を削除しますか？')
  expect(dialog.closest('[data-design-node="UIaM7"]')).toBeTruthy()
  expect(within(dialog).getByRole('radio', { name: /新しい人を受けるのをやめる（おすすめ）/ })).toBeTruthy()
  expect(within(dialog).getByRole('radio', { name: /別の流入リンクへ送るようにする/ })).toBeTruthy()
  expect(within(dialog).getByRole('radio', { name: /このまま削除する/ })).toBeTruthy()
  expect(dialog.textContent).toContain('付いたタグ・進んでいるシナリオは消えません')
  expect(fx.update).not.toHaveBeenCalled()
})

it('受付停止の失敗は窓に出し、選択を変えると前の失敗を消す', async () => {
  fx.update.mockResolvedValueOnce({ success: false, error: 'internal error' })
  const dialog = await open()
  fireEvent.click(within(dialog).getByRole('button', { name: '受けるのをやめる' }))
  expect(await within(dialog).findByText('選んだ処理を完了できませんでした。状態を読み直してから、もう一度お試しください。')).toBeTruthy()
  expect(dialog.textContent).not.toContain('internal error')
  expect(screen.getByRole('alertdialog')).toBe(dialog)
  expect(fx.replace).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('radio', { name: /別の流入リンクへ送るようにする/ }))
  expect(within(dialog).queryByText(/選んだ処理を完了できませんでした/)).toBeNull()
})

it('転送先は自動選択せず、利用者が選ぶまでは送らない', async () => {
  const dialog = await open()
  fireEvent.click(within(dialog).getByRole('radio', { name: /別の流入リンクへ送るようにする/ }))
  const choice = within(dialog).getByRole('button', { name: '転送先のリンク' })
  expect(choice.id).toContain('inflow-redirect-target')
  expect(within(dialog).getByText('選んでください')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '別のリンクへ送る' }))
  expect(await within(dialog).findByText('転送先のリンクを選んでください')).toBeTruthy()
  expect(fx.update).not.toHaveBeenCalled()
  await selectTarget(dialog)
  fireEvent.click(within(dialog).getByRole('button', { name: '別のリンクへ送る' }))
  await waitFor(() => expect(fx.update).toHaveBeenCalledWith('route-1', expect.objectContaining({ redirectUrl: expect.stringContaining('/r/other-qr') })))
})

it('転送先を選んだ後の失敗も窓に残し、成功したように移動しない', async () => {
  fx.update.mockResolvedValueOnce({ success: false, error: 'internal error' })
  const dialog = await open()
  fireEvent.click(within(dialog).getByRole('radio', { name: /別の流入リンクへ送るようにする/ }))
  await selectTarget(dialog)
  fireEvent.click(within(dialog).getByRole('button', { name: '別のリンクへ送る' }))
  expect(await within(dialog).findByText(/選んだ処理を完了できませんでした/)).toBeTruthy()
  expect(screen.getByRole('alertdialog')).toBe(dialog)
  expect(fx.replace).not.toHaveBeenCalled()
})

it('処理中は二重送信できず、窓を閉じられない', async () => {
  let finish!: (value: unknown) => void
  fx.update.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const dialog = await open()
  const submit = within(dialog).getByRole('button', { name: '受けるのをやめる' }) as HTMLButtonElement
  fireEvent.click(submit)
  fireEvent.click(submit)
  expect(fx.update).toHaveBeenCalledTimes(1)
  expect(submit.disabled).toBe(true)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.getByRole('alertdialog')).toBe(dialog)
  await act(async () => finish({ success: true, data: { ...route, isActive: false } }))
  await waitFor(() => expect(fx.replace).toHaveBeenCalledWith('/inflow-links'))
})
