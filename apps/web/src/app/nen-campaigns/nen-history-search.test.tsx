/*
 * #934 N-294: 配信履歴の検索がサーバー側へ渡ることを画面で固定する。
 *  1. 検索語を入れて確定すると onChangeDeliveryView へ q が渡る
 *  2. 絞り込みチップやページ送りでも検索語が消えない
 */
// @vitest-environment happy-dom
import { StrictMode, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
import type { NenDelivery, NenDeliveryList } from '../../lib/api'
import NenOverview from '@/v8/nen-campaigns/list'
import { type NenTab } from '@/v8/nen-campaigns/display'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const noop = () => {}
const detail = null

const delivery = (over: Partial<NenDelivery> = {}): NenDelivery => ({
  id: 'job-1',
  campaignKey: 'arrival_check',
  label: '到着確認',
  friendId: 'friend-1',
  friendName: '見本 141',
  lineAccountName: '然',
  scheduledAt: '2026-09-10 10:00:00',
  sentAt: '2026-09-10 10:00:01',
  status: 'sent',
  attempts: 1,
  unmetReason: null,
  unmetReasonCode: null,
  reaction: { value: null, state: 'unavailable', reason: '取得できません' },
  version: 1,
  updatedAt: '2026-09-10 10:00:01',
  ...over,
})

const listWith = (rows: NenDelivery[]): NenDeliveryList => ({
  range: { days: 30, from: '2026-08-12T00:00:00.000Z', to: '2026-09-11T00:00:00.000Z' },
  summary: {
    pending: 0, processing: 0, sent: rows.length, skipped: 0, failed: 0, cancelled: 0,
    retryRequired: 0, unmetReasons: { blocked: 0, unfollowed: 0, other: 0 }, skippedReasons: {},
  },
  deliveries: rows,
  pagination: { total: 25, limit: 20, cursor: '0', nextCursor: '20' },
})

function renderHistory(list: NenDeliveryList, onChangeDeliveryView: (status?: string, cursor?: string, q?: string) => void = noop) {
  act(() => {
    root.render(
      <NenOverview
        tab={'history' as NenTab}
        topAction={null}
        onTabChange={noop}
        settings={[]}
        columns={[]}
        columnsTotal={0}
        kpis={null}
        flowMetrics={null}
        columnMetrics={null}
        deliveryList={list}
        deliveryDetail={detail}
        friends={[]}
        testFriendId=""
        onTestFriendChange={noop}
        accountId={null}
        loading={false}
        notice={null}
        saving={null}
        testing={null}
        previewCampaignKey={null}
        onPreviewCampaign={noop}
        onToggleSetting={noop}
        onTestSend={noop}
        coupon={{ isEnabled: false, codePrefix: '', benefitLabel: '', discountAmount: 0, validityDays: 0, leapYearPolicy: 'feb28' }}
        couponOpen={false}
        onCouponOpenChange={noop}
        onCouponChange={noop}
        onSaveCoupon={noop}
        savingCoupon={false}
        selectedColumnId={null}
        onSelectColumn={noop}
        audienceCount={null}
        plan={{ when: 'now', scheduledAt: '' }}
        onPlanChange={noop}
        introDraft=""
        onIntroChange={noop}
        onSaveIntro={noop}
        savingColumnId={null}
        onDeliverColumn={noop}
        onDuplicateColumn={noop}
        onTestColumn={noop}
        onShowDelivery={noop}
        onRetryDelivery={noop}
        onChangeDeliveryView={onChangeDeliveryView}
      />,
    )
  })
}

beforeEach(() => {
  window.history.replaceState(null, '', '/nen-campaigns?tab=history')
  window.dispatchEvent(new PopStateEvent('popstate'))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

function typeSearch(value: string) {
  const field = container.querySelector('input[type="search"]')
  expect(field).not.toBeNull()
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(field, value)
    field!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function submitSearch() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 750)) })
}

describe('NEN配信履歴の検索(#934 N-294)', () => {
  it('検索語を確定すると q がサーバー側へ渡る', async () => {
    const onChangeView = vi.fn()
    renderHistory(listWith([delivery()]), onChangeView)
    typeSearch('珍名')
    await submitSearch()
    expect(onChangeView).toHaveBeenCalledWith(undefined, undefined, '珍名')
  })

  it('絞り込みチップを切り替えても確定済みの検索語が消えない', async () => {
    const onChangeView = vi.fn()
    renderHistory(listWith([delivery()]), onChangeView)
    typeSearch('珍名')
    await submitSearch()
    onChangeView.mockClear()
    const chip = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.startsWith('届きませんでした'))
    expect(chip).toBeDefined()
    act(() => { chip!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onChangeView).toHaveBeenCalledWith('failed', undefined, '珍名')
  })

  it('ページ送りでも確定済みの検索語が消えない', async () => {
    const onChangeView = vi.fn()
    renderHistory(listWith([delivery()]), onChangeView)
    typeSearch('珍名')
    await submitSearch()
    onChangeView.mockClear()
    const next = Array.from(container.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === '次のページ')
    expect(next).toBeDefined()
    act(() => { next!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onChangeView).toHaveBeenCalledWith(undefined, '20', '珍名')
  })

  /*
   * #635: 存在しない言葉で検索して0件になったとき、
   * 「送った履歴はまだありません」（そもそも無い）ではなく、
   * 「条件に合う履歴はありません」＋解除導線を出す。
   */
  it('存在しない言葉の検索で0件なら、条件に合う履歴はありませんと解除導線を出す', async () => {
    const onChangeView = vi.fn()
    renderHistory(listWith([delivery()]), onChangeView)
    typeSearch('存在しない言葉xyz')
    await submitSearch()
    expect(onChangeView).toHaveBeenCalledWith(undefined, undefined, '存在しない言葉xyz')

    // サーバが0件を返したあとの描画。
    renderHistory(listWith([]), onChangeView)
    expect(container.textContent).toContain('条件に合う履歴はありません')
    expect(container.textContent).toContain('検索語や絞り込みを変えてください。')
    expect(container.textContent).not.toContain('送った履歴はまだありません')
  })

  it('「検索と絞り込みを解除」で検索語を外して履歴を取り直す', async () => {
    const onChangeView = vi.fn()
    renderHistory(listWith([]), onChangeView)
    typeSearch('存在しない言葉xyz')
    await submitSearch()
    onChangeView.mockClear()

    renderHistory(listWith([]), onChangeView)
    const clear = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '検索と絞り込みを解除')
    expect(clear).toBeDefined()
    act(() => { clear!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    // q='' を明示してサーバの検索語も消す。
    expect(onChangeView).toHaveBeenCalledWith(undefined, undefined, '')
    renderHistory(listWith([]), onChangeView)
    expect(container.textContent).toContain('送った履歴はまだありません')
  })
})
