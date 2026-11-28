// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AffiliateShell } from '@/v8/affiliates/frame'

const fx = vi.hoisted(() => ({ offers: vi.fn(), approvals: vi.fn() }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  const empty = vi.fn().mockResolvedValue({ success: true, data: [] })
  return { ...actual, api: { ...actual.api,
    affiliateOffers: { ...actual.api.affiliateOffers, list: fx.offers },
    folders: { ...actual.api.folders, list: empty }, lineAccounts: { ...actual.api.lineAccounts, list: empty },
    tags: { ...actual.api.tags, list: empty }, scenarios: { ...actual.api.scenarios, list: empty },
    affiliates: { ...actual.api.affiliates, allReport: empty },
  } }
})
vi.mock('@/v8/affiliates/display', async original => ({ ...(await original<typeof import('@/v8/affiliates/display')>()), listAllConversionApprovals: fx.approvals }))
import Offers from '@/v8/affiliates/offers'

const offer = { id: 'offer-1', name: '紹介キャンペーン', description: '初回購入', rewardAmount: 1200, rewardMiles: 20, mileageProgramId: 'p', lineAccountId: null, tagId: 'missing-tag', scenarioId: null, isActive: true, createdAt: '2026-09-01T00:00:00.000Z' }
const setCount = vi.fn()
function draw() { return render(<AffiliateShell.Provider value={{ tab: 'offers', readonly: false, narrow: false, accountId: 'account-a', counts: {}, setCount, focusAffiliateId: null }}><Offers /></AffiliateShell.Provider>) }
function card(title: string) {
  const label = [...document.querySelectorAll('[data-kpi-label]')].find(node => node.textContent?.trim() === title)
  expect(label).toBeTruthy()
  return label!.closest('[data-kpi-presentation]') as HTMLElement
}
beforeEach(() => {
  window.history.replaceState({}, '', '/affiliates')
  window.dispatchEvent(new PopStateEvent('popstate'))
  fx.offers.mockResolvedValue({ success: true, data: [offer] })
  fx.approvals.mockResolvedValue({ items: [], truncated: false })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('案件の読み込み中は件数を作らず、取得後に実際の数を出す', async () => {
  let finish!: (value: unknown) => void
  fx.offers.mockReturnValue(new Promise(resolve => { finish = resolve }))
  draw()
  expect(await screen.findByLabelText('案件を読み込んでいます')).toBeTruthy()
  for (const title of ['案件', '今月の成果', '平均報酬', 'マイルあり']) expect(card(title)).toBeTruthy()
  expect(card('案件').textContent).toContain('読み込んでいます')
  expect(card('案件').textContent).not.toContain('0件')
  await act(async () => finish({ success: true, data: [offer] }))
  expect(await screen.findByText('紹介キャンペーン')).toBeTruthy()
  expect(card('案件').textContent).toContain('1')
  expect(card('マイルあり').textContent).toContain('1')
})

it('案件取得の失敗と成功した0件を分け、読み直す', async () => {
  fx.offers.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ success: true, data: [] })
  draw()
  expect(await screen.findByText('案件を読み込めませんでした')).toBeTruthy()
  expect(screen.queryByText('まだ案件がありません')).toBeNull()
  expect(card('案件').textContent).toContain('読み込めませんでした')
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByText('まだ案件がありません')).toBeTruthy()
  expect(card('案件').textContent).toContain('0')
})

it('検索結果0件は条件解除を案内し、取得できない参照名は内部IDを見せない', async () => {
  draw()
  await screen.findByText('紹介キャンペーン')
  expect(screen.getByText(/名前を確認できません/)).toBeTruthy()
  expect(document.body.textContent).not.toContain('missing-tag')
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '存在しない案件' } })
  expect(await screen.findByText('条件に合うものがありません')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '条件を外す' }))
  expect(await screen.findByText('紹介キャンペーン')).toBeTruthy()
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
})

it('承認済みの実データだけで平均報酬を出し、行の成果も数える', async () => {
  const now = new Date().toISOString()
  fx.approvals.mockImplementation(async (status: string) => ({ items: status === 'approved' ? [
    { eventId: 'e1', offerId: 'offer-1', affiliateId: 'a1', approvalStatus: 'approved', rewardAmount: 1000, createdAt: now },
    { eventId: 'e2', offerId: 'offer-1', affiliateId: 'a2', approvalStatus: 'approved', rewardAmount: 3000, createdAt: now },
  ] : [{ eventId: 'e3', offerId: 'offer-1', affiliateId: 'a1', approvalStatus: 'pending', rewardAmount: 9000, createdAt: now }], truncated: false }))
  draw()
  await screen.findByText('紹介キャンペーン')
  await waitFor(() => expect(card('平均報酬').textContent).toContain('2,000'))
  expect(card('平均報酬').textContent).toContain('1件あたり')
  expect(screen.getByRole('row', { name: /紹介キャンペーン/ }).textContent).toContain('3件')
})

it('承認の読み込み失敗や件数の打ち切りは平均0円とせず理由を出す', async () => {
  fx.approvals.mockRejectedValue(new Error('offline'))
  const view = draw()
  await waitFor(() => expect(card('平均報酬').textContent).toContain('読み込めませんでした'))
  expect(card('平均報酬').textContent).not.toContain('0円')
  view.unmount()
  fx.approvals.mockResolvedValue({ items: [{ eventId: 'e1', offerId: 'offer-1', affiliateId: 'a1', approvalStatus: 'approved', rewardAmount: 2000, createdAt: new Date().toISOString() }], truncated: true })
  draw()
  await waitFor(() => expect(card('平均報酬').textContent).toContain('件数が多く、全部は数えられませんでした'))
  expect(card('平均報酬').textContent).not.toContain('0円')
  expect(card('平均報酬').textContent).not.toContain('2,000')
})

it('アカウントを替えて承認取得に失敗したら、前の平均報酬を残さない', async () => {
  fx.approvals.mockImplementation(async (_status: string, _offset: number, options: { accountId: string }) => {
    if (options.accountId === 'account-b') throw new Error('offline')
    return { items: [{ eventId: 'e1', offerId: 'offer-1', affiliateId: 'a1', approvalStatus: 'approved', rewardAmount: 2000, createdAt: new Date().toISOString() }], truncated: false }
  })
  const view = draw()
  await waitFor(() => expect(card('平均報酬').textContent).toContain('2,000'))
  view.rerender(<AffiliateShell.Provider value={{ tab: 'offers', readonly: false, narrow: false, accountId: 'account-b', counts: {}, setCount, focusAffiliateId: null }}><Offers /></AffiliateShell.Provider>)
  await waitFor(() => expect(card('平均報酬').textContent).toContain('読み込めませんでした'))
  expect(card('平均報酬').textContent).not.toContain('2,000')
})
