// @vitest-environment happy-dom
/*
 * #935: コラム一覧の打切り・過去の予約日時・確認文の実態一致を、
 * 本物の React で描画して確かめる。
 *
 * 見る筋書き:
 *   N-300: 口が200件で打ち切った分を「全部で◯本」と画面に出す。
 *   N-303: 「今すぐ」と「予約」で確認の見出しを分ける（実害は無いが文言がずれていた）。
 *   N-304: 過去の予約日時は画面で止め、送る操作を呼ばない。
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/staff-role', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/staff-role')>()), useStaffRole: () => 'owner' }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
import type { NenCampaignSetting, NenColumn, NenColumnDeliveryPreview } from '../../lib/api'
import NenOverview from '@/v8/nen-campaigns/list'
import { type ColumnDeliveryPlan, type NenTab } from '@/v8/nen-campaigns/display'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const noop = () => {}

const columnSetting = (): NenCampaignSetting => ({
  campaignKey: 'column',
  label: 'NENコラム',
  category: 'column',
  triggerEvent: null,
  delayDays: 0,
  deliveryTime: '10:00',
  isEnabled: true,
  title: 'コラム',
  bodyText: '本文',
  buttonLabel: 'コラムを読む',
  buttonUrl: null,
  imageUrl: null,
  dedupWindowDays: 0,
  excludeFormRespondents: false,
  afterActions: [],
  updatedAt: '2026-08-01T00:00:00Z',
})

const column = (id: string, over: Partial<NenColumn> = {}): NenColumn => ({
  id,
  externalId: null,
  slug: `slug-${id}`,
  title: `題名${id}`,
  category: '食事',
  excerpt: '概要',
  introText: `紹介文${id}`,
  articleUrl: 'https://example.com/a',
  imageUrl: null,
  publishedAt: '2026-08-01T00:00:00Z',
  deliveryStatus: 'draft',
  deliveryAt: null,
  lineAccountId: 'account-a',
  updatedAt: '2026-08-01T00:00:00Z',
  targetMode: 'all',
  targetTagId: null,
  completionEventName: null,
  completionTagId: null,
  sourceColumnId: null,
  ...over,
})

function renderColumns(input: {
  columns?: NenColumn[]
  columnsTotal?: number | null
  selectedColumnId?: string | null
  plan?: ColumnDeliveryPlan
  onDeliverColumn?: (column: NenColumn, scheduledAt?: string) => void
  onPreviewColumn?: (column: NenColumn) => Promise<NenColumnDeliveryPreview>
  onSelectColumn?: (id: string | null) => void
  introDraft?: string
}) {
  act(() => {
    root.render(
      <NenOverview
        tab={'columns' as NenTab}
        topAction={null}
        onTabChange={noop}
        settings={[columnSetting()]}
        columns={input.columns ?? []}
        columnsTotal={input.columnsTotal ?? null}
        kpis={null}
        flowMetrics={null}
        columnMetrics={null}
        deliveryList={null}
        deliveryDetail={null}
        friends={[]}
        testFriendId=""
        onTestFriendChange={noop}
        accountId="fixture-account"
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
        selectedColumnId={input.selectedColumnId ?? null}
        onSelectColumn={input.onSelectColumn ?? noop}
        audienceCount={12}
        plan={input.plan ?? { when: 'now', scheduledAt: '' }}
        onPlanChange={noop}
        introDraft={input.introDraft ?? '紹介文c1'}
        onIntroChange={noop}
        onSaveIntro={noop}
        savingColumnId={null}
        onPreviewColumn={input.onPreviewColumn ?? (async (col) => ({ recipientCount: 12, confirmationToken: 'a'.repeat(64), column: col, campaign: { updatedAt: '2026-08-01T00:00:00Z', buttonLabel: 'コラムを読む' }, messages: [{ type: 'text', text: '紹介文c1' }, { type: 'flex', altText: '題', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [] } } }] }))}
        onDeliverColumn={input.onDeliverColumn ?? noop}
        onDuplicateColumn={noop}
        onTestColumn={noop}
        onShowDelivery={noop}
        onRetryDelivery={noop}
        onChangeDeliveryView={noop}
      />,
    )
  })
}

const primaryButton = (label: string): HTMLButtonElement => {
  const found = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!found) throw new Error(`ボタン「${label}」が見つかりません`)
  return found as HTMLButtonElement
}

const click = (element: HTMLElement) => act(() => {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
})

beforeEach(() => {
  window.history.replaceState(null, '', '/nen-campaigns?tab=columns')
  window.dispatchEvent(new PopStateEvent('popstate'))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

describe('コラム一覧の打切りの可視化（#935 N-300）', () => {
  it('口の上限で打ち切られたとき、全体件数と「新しい◯本まで」を出す', () => {
    renderColumns({ columns: [column('c1'), column('c2')], columnsTotal: 250 })
    expect(container.textContent).toContain('コラムは250本ありますが、2本までしか読み込んでいません。')
    expect(container.textContent).toContain('検索・絞り込みは読み込んだ分の中で探します。')
    expect(container.textContent).toContain('コラム 250')
  })

  it('打ち切りが無ければ全体件数の注意を出さない', () => {
    renderColumns({ columns: [column('c1'), column('c2')], columnsTotal: 2 })
    expect(container.textContent).not.toContain('全部で')
    expect(container.textContent).toContain('2本')
  })
})

/* ConfirmDialog は document.body へ portal される。確認文は body 側で読む。 */
const bodyText = () => document.body.textContent ?? ''
const bodyButton = (label: string): HTMLButtonElement => {
  const found = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === label)
  if (!found) throw new Error(`ボタン「${label}」が見つかりません`)
  return found as HTMLButtonElement
}

describe('配信確認の文言と実態の一致（#935 N-303）', () => {
  it('前の予約結果が遅れても別の確認窓を閉じない', async () => {
    let finish!: (value: boolean) => void
    const pending = new Promise<boolean>((resolve) => { finish = resolve })
    const first=column('c1'),second=column('c2'),onDeliver=vi.fn(() => pending)
    renderColumns({columns:[first,second],selectedColumnId:'c1',onDeliverColumn:onDeliver})
    click(primaryButton('配信を予約する'));await act(async () => { await Promise.resolve() })
    click(bodyButton('送る'))
    renderColumns({columns:[first,second],selectedColumnId:'c2',introDraft:'紹介文c2',onDeliverColumn:onDeliver})
    click(primaryButton('配信を予約する'));await act(async () => { await Promise.resolve() })
    expect(bodyText()).toContain('「題名c2」を今すぐ配信しますか？')
    await act(async () => { finish(true); await pending })
    expect(bodyText()).toContain('「題名c2」を今すぐ配信しますか？')
  })
  it('確認前に配信設定の版が変わっていたら読み直しを求める', async () => {
    const preview = async (col: NenColumn) => ({ recipientCount: 3, confirmationToken: 'b'.repeat(64), column: col, campaign: { updatedAt: '2026-08-02T00:00:00Z', buttonLabel: 'コラムを読む' }, messages: [{ type: 'text', text: '紹介文c1' }, { type: 'flex', altText: '題', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [] } } }] })
    renderColumns({columns:[column('c1')],selectedColumnId:'c1',onPreviewColumn:preview})
    click(primaryButton('配信を予約する'))
    await act(async () => { await Promise.resolve() })
    expect(bodyText()).toContain('配信内容が変わりました')
    expect(bodyText()).not.toContain('今すぐ配信しますか？')
  })
  it('確認の読込み中に別のコラムを選べば古い確認は開かない', async () => {
    let finish!: (value: NenColumnDeliveryPreview) => void
    const preview = vi.fn(() => new Promise<NenColumnDeliveryPreview>((resolve) => { finish = resolve }))
    const first=column('c1'),second=column('c2')
    renderColumns({columns:[first,second],selectedColumnId:'c1',onPreviewColumn:preview})
    click(primaryButton('配信を予約する'))
    renderColumns({columns:[first,second],selectedColumnId:'c2',introDraft:'紹介文c2',onPreviewColumn:preview})
    await act(async () => { finish({recipientCount:3,confirmationToken:'b'.repeat(64),column:first,campaign:{updatedAt:'2026-08-01T00:00:00Z',buttonLabel:'コラムを読む'},messages:[{type:'text',text:'紹介文c1'},{type:'flex',altText:'題',contents:{type:'bubble',body:{type:'box',layout:'vertical',contents:[]}}}]}); await Promise.resolve() })
    expect(bodyText()).not.toContain('「題名c1」を今すぐ配信しますか？')
  })
  it('確認時の人数を表示し、二度押しても1回だけ予約する', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const onDeliver = vi.fn(async () => { await pending })
    renderColumns({ columns: [column('c1')], selectedColumnId: 'c1', onDeliverColumn: onDeliver,
      onPreviewColumn: async (col) => ({ recipientCount: 3, confirmationToken: 'b'.repeat(64), column: col, campaign: { updatedAt: '2026-08-01T00:00:00Z', buttonLabel: 'コラムを読む' }, messages: [{ type: 'text', text: '紹介文c1' }, { type: 'flex', altText: '題', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [] } } }] }) })
    click(primaryButton('配信を予約する'))
    await act(async () => { await Promise.resolve() })
    expect(bodyText()).toContain('3 人の友だちへ')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('紹介文c1')
    const send = bodyButton('送る')
    act(() => { send.click(); send.click() })
    expect(onDeliver).toHaveBeenCalledTimes(1)
    expect(onDeliver).toHaveBeenCalledWith(expect.objectContaining({id:'c1'}), undefined, {recipientCount:3,confirmationToken:'b'.repeat(64)})
    await act(async () => { finish(); await pending })
  })
  it('未保存の紹介文や更新された内容では確認へ進まない', async () => {
    const preview = vi.fn(async (col: NenColumn) => ({ recipientCount: 3, confirmationToken: 'b'.repeat(64), column: { ...col, title: '変更後' }, campaign: { updatedAt: '2026-08-01T00:00:00Z', buttonLabel: 'コラムを読む' }, messages: [{ type: 'text', text: '紹介文c1' }, { type: 'flex', altText: '題', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [] } } }] }))
    renderColumns({columns:[column('c1')],selectedColumnId:'c1',introDraft:'未保存',onPreviewColumn:preview})
    click(primaryButton('配信を予約する'))
    expect(bodyText()).toContain('紹介文を保存してから確認してください')
    expect(preview).not.toHaveBeenCalled()
    await act(async () => { await Promise.resolve() })
    renderColumns({columns:[column('c1')],selectedColumnId:'c1',onPreviewColumn:preview})
    click(primaryButton('配信を予約する'))
    await act(async () => { await Promise.resolve() })
    expect(bodyText()).toContain('配信内容が変わりました')
    expect(bodyText()).not.toContain('今すぐ配信しますか？')
  })
  it('「今すぐ」は「今すぐ配信しますか」と確認する', async () => {
    renderColumns({ columns: [column('c1')], selectedColumnId: 'c1', plan: { when: 'now', scheduledAt: '' } })
    click(primaryButton('配信を予約する'))
    await act(async () => { await Promise.resolve() })
    expect(bodyText()).toContain('「題名c1」を今すぐ配信しますか？')
    expect(bodyText()).not.toContain('配信予約しますか？')
  })

  it('「日時を予約」は「配信予約しますか」と確認し、確定で日本時間の予約日時を渡す', async () => {
    const onDeliver = vi.fn()
    renderColumns({
      columns: [column('c1')],
      selectedColumnId: 'c1',
      plan: { when: 'schedule', scheduledAt: '2099-05-01T10:30' },
      onDeliverColumn: onDeliver,
    })
    click(primaryButton('配信を予約する'))
    await act(async () => { await Promise.resolve() })
    expect(bodyText()).toContain('「題名c1」を配信予約しますか？')
    click(bodyButton('予約する'))
    expect(onDeliver).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), '2099-05-01T10:30:00+09:00', { recipientCount: 12, confirmationToken: 'a'.repeat(64) })
  })
})

describe('過去の予約日時を画面で止める（#935 N-304）', () => {
  it('過去の日時は「いまより先を選ぶ」と出し、予約ボタンを押せない', () => {
    const onDeliver = vi.fn()
    renderColumns({
      columns: [column('c1')],
      selectedColumnId: 'c1',
      plan: { when: 'schedule', scheduledAt: '2000-01-01T00:00' },
      onDeliverColumn: onDeliver,
    })
    expect(container.textContent).toContain('予約日時が過去になっています。いまより先の日時を選んでください。')
    const button = primaryButton('配信を予約する')
    expect(button.disabled).toBe(true)
    click(button)
    expect(onDeliver).not.toHaveBeenCalled()
  })

  it('日時が未入力なら「入れてください」のまま', () => {
    renderColumns({
      columns: [column('c1')],
      selectedColumnId: 'c1',
      plan: { when: 'schedule', scheduledAt: '' },
    })
    expect(primaryButton('配信を予約する').disabled).toBe(true)
    expect(container.textContent).not.toContain('いまより先の日時')
  })
})
