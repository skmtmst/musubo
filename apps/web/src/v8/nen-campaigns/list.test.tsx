// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
/*
 * V8 NEN配信の一覧（src/v8/nen-campaigns/list.tsx）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * V8 のテーマで出す・自動配信は止めている配信も同じ表に並ぶ・絞り込み札・行の「…」・
 * 閲覧のみの人には変える操作を置かない・クーポンの引き出し・送った履歴の取得不可。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NenCampaignSetting, NenColumn, NenDeliveryList, NenFlowMetrics } from '@/lib/api'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const role = vi.hoisted(() => ({ value: 'owner' as string | null }))

// 行の「…」の移動は router.push（画面を丸ごと読み直さない）。
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }))

vi.mock('@/lib/staff-role', async (importOriginal: () => Promise<typeof import('@/lib/staff-role')>) => {
  const actual = await importOriginal()
  return { ...actual, useStaffRole: () => role.value }
})

import NenCampaignsList, { type NenCampaignsListProps } from './list'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const setting = (campaignKey: string, label: string, category: NenCampaignSetting['category'], isEnabled: boolean): NenCampaignSetting => ({
  campaignKey, label, category, triggerEvent: 'ec.order.arrived', delayDays: 3, deliveryTime: '10:00', isEnabled,
  title: label, bodyText: `${label}の本文`, buttonLabel: null, buttonUrl: null, imageUrl: null,
  dedupWindowDays: 30, excludeFormRespondents: false, afterActions: [], formIssue: null, updatedAt: '2026-08-25T10:00:00+09:00',
} as unknown as NenCampaignSetting)

const SETTINGS = [
  setting('order_thanks', '注文ありがとうございます', 'transactional', true),
  setting('review_request', '口コミのお願い', 'follow_up', true),
  setting('care_check', '困っていませんか', 'follow_up', false),
  setting('birthday_coupon', 'お誕生日クーポン', 'birthday', true),
  setting('column', 'NENコラム', 'column', true),
]

const COLUMNS = [
  { id: 'c-1', title: '秋の食事、量はどれくらい？', category: '季節のこと', excerpt: '', introText: '', articleUrl: 'https://example.com/a', imageUrl: null, publishedAt: null, deliveryStatus: 'scheduled', deliveryAt: '2026-10-10T10:00:00+09:00', targetMode: 'all', targetTagId: null, updatedAt: '2026-08-25T10:00:00+09:00' },
  { id: 'c-2', title: 'トイレの回数、気にしていますか', category: 'からだのこと', excerpt: '', introText: '', articleUrl: 'https://example.com/b', imageUrl: null, publishedAt: '2026-09-26T10:00:00+09:00', deliveryStatus: 'sent', deliveryAt: null, targetMode: 'all', targetTagId: null, updatedAt: '2026-08-25T10:00:00+09:00' },
] as unknown as NenColumn[]

const FLOWS = { flows: [
  { campaignKey: 'order_thanks', sent: 412 },
  { campaignKey: 'review_request', sent: 241 },
  { campaignKey: 'care_check', sent: 0 },
  { campaignKey: 'birthday_coupon', sent: 125 },
] } as unknown as NenFlowMetrics

const DELIVERIES = {
  summary: { pending: 1, processing: 0, sent: 5, skipped: 0, failed: 1, cancelled: 0 },
  deliveries: [
    { id: 'd-1', campaignKey: 'review_request', label: '口コミのお願い', friendName: '見本 19', lineAccountName: 'LINE 本店', scheduledAt: '2026-08-23T20:00:00+09:00', sentAt: '2026-08-23T20:00:04+09:00', status: 'sent', attempts: 1, unmetReason: null, unmetReasonCode: null, reaction: { value: null, state: 'unavailable', reason: '取れません' }, version: 1 },
  ],
  pagination: { total: 1, limit: 20, cursor: '0', nextCursor: null },
} as unknown as NenDeliveryList

function baseProps(overrides: Partial<NenCampaignsListProps> = {}): NenCampaignsListProps {
  return {
    tab: 'auto', onTabChange: vi.fn(), settings: SETTINGS, columns: COLUMNS, columnsTotal: 2,
    kpis: { monthLabel: '9月', sentThisMonth: 1820, sentLastMonth: 1580, openRate: 64, orders: 3, orderAmount: 1000, undelivered: 0, blocked: 0, unfollowed: 0 },
    flowMetrics: FLOWS, columnMetrics: null, deliveryList: DELIVERIES, deliveryDetail: null,
    friends: [{ id: 'f-1', displayName: 'Kenta' }], testFriendId: 'f-1', onTestFriendChange: vi.fn(), accountId: 'account-a',
    loading: false, tabError: '', onRetryTab: vi.fn(), kpisFailed: false, notice: null,
    saving: null, testing: null, previewCampaignKey: null, onPreviewCampaign: vi.fn(), onToggleSetting: vi.fn(), onTestSend: vi.fn(),
    coupon: { isEnabled: true, codePrefix: 'NENBDAY', benefitLabel: 'お誕生日月限定クーポン', discountAmount: 500, validityDays: 31, leapYearPolicy: 'feb28' },
    couponOpen: false, onCouponOpenChange: vi.fn(), onCouponChange: vi.fn(), onSaveCoupon: vi.fn(), savingCoupon: false,
    selectedColumnId: null, onSelectColumn: vi.fn(), audienceCount: null, plan: { when: 'now', scheduledAt: '2026-10-10T10:00' }, onPlanChange: vi.fn(),
    introDraft: '', onIntroChange: vi.fn(), onSaveIntro: vi.fn(), savingColumnId: null, onDeliverColumn: vi.fn(), onDuplicateColumn: vi.fn(),
    onPreviewColumn: vi.fn(async (column: NenColumn) => ({ column, campaign: SETTINGS.find(item => item.campaignKey === 'column')!, recipientCount: 1, confirmationToken: 'a'.repeat(64), messages: [{ type: 'text' as const, text: '紹介文' }, { type: 'flex' as const, altText: 'コラム', contents: { type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [] } } }] })),
    duplicatingColumnId: null, onTestColumn: vi.fn(), onShowDelivery: vi.fn(), onRetryDelivery: vi.fn(), onChangeDeliveryView: vi.fn(),
    ...overrides,
  }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  document.documentElement.dataset.theme = 'v8'
  role.value = verifiedStaffRole('owner')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  delete document.documentElement.dataset.theme
})

async function render(props: NenCampaignsListProps) {
  await act(async () => { root.render(<NenCampaignsList {...props} />) })
}

const rowNames = () => [...host.querySelectorAll('tbody tr')].map((row) => row.querySelector('td')?.textContent ?? '')
const button = (name: string) => [...document.querySelectorAll('button')].find((b) => (b.textContent ?? '').trim() === name || b.getAttribute('aria-label') === name)

it('旧一覧のヘッダー操作を残し、閲覧のみでは隠す', async () => {
  const action = vi.fn()
  const props = baseProps({ tab: 'columns', topAction: <button onClick={action}>ECのコラムを取り込む</button> })
  await render(props)
  // 画面の題（h1）は一覧の型が1つだけ持つ。本文の見出しを h1 で重ねない。
  expect(host.querySelectorAll('h1')).toHaveLength(1)
  await act(async () => { button('ECのコラムを取り込む')!.click() })
  expect(action).toHaveBeenCalledTimes(1)
  role.value = verifiedStaffRole('viewer')
  await render(props)
  expect(button('ECのコラムを取り込む')).toBeUndefined()
})

it('コラムの見本は書きかけの紹介文と記事を見せ、ペット名を共通の代わりの名前にする', async () => {
  const props = baseProps({ tab: 'columns', selectedColumnId: 'c-1', introDraft: '{{pet_name}}への書きかけ', columns: [{ ...COLUMNS[0], excerpt: '{{pet_name}}の食事', imageUrl: 'https://example.test/article.jpg' }] })
  await render(props)
  await act(async () => { button('「秋の食事、量はどれくらい？」の操作')!.click() })
  await act(async () => { button('LINEでの見え方')!.click() })
  const dialog = document.querySelector('[role="dialog"][aria-label="コラムのLINEでの見え方"]') ?? Array.from(document.querySelectorAll('[role="dialog"]')).find((node) => node.textContent?.includes('コラムのLINEでの見え方'))
  expect(dialog?.textContent).toContain('大切なご家族への書きかけ')
  expect(dialog?.textContent).toContain('大切なご家族の食事')
  expect(dialog?.querySelector('img')?.src).toBe('https://example.test/article.jpg')
  expect(props.onDeliverColumn).not.toHaveBeenCalled()
  expect(props.onTestColumn).not.toHaveBeenCalled()
})

it('今月の補足に先月・注文・届かなかった数を残し、未取得は0にしない', async () => {
  await render(baseProps({ kpis: { monthLabel: '10月', sentThisMonth: 8, sentLastMonth: 4, openRate: null, orders: 3, orderAmount: 900, undelivered: 2, blocked: 1, unfollowed: 0 } }))
  await act(async () => { button('今月送ったの説明')!.click() })
  expect(document.body.textContent).toContain('先月 4通')
  expect(document.body.textContent).toContain('配信からの注文 3件')
  expect(document.body.textContent).toContain('届かなかった 2通')
  expect(document.body.textContent).toContain('友だち解除 0・ブロック 1')
  await render(baseProps({ kpis: null, kpisFailed: true }))
  expect(document.body.textContent).toContain('届かなかった —通')
  expect(document.body.textContent).not.toContain('届かなかった 0通')
})

it('下書きの配信したい日時を日本時間で残し、予約済みと混ぜない', async () => {
  const props = baseProps({ tab: 'columns', columns: [{ ...COLUMNS[0], deliveryStatus: 'draft', deliveryAt: '2099-05-01T01:30:00.000Z' }] })
  await render(props)
  const row = host.querySelector('tbody')
  expect(row?.textContent).toContain('未配信・')
  expect(row?.textContent).toContain('10:30')
  expect(row?.textContent).toContain('に出したい')
  expect(row?.textContent).not.toContain('予約中')
  expect(props.onDeliverColumn).not.toHaveBeenCalled()
})

describe('V8 NEN配信の一覧', () => {
  it.each(['columns', 'history'] as const)('%sは1ページは件数だけを帯に出す', async (tab) => {
    await render(baseProps({ tab }))
    const pager = host.querySelector('[data-pagination]')!
    expect(pager.querySelector('[data-pagination-summary]')?.textContent).toBe(tab === 'columns' ? '2件中 1〜2件' : '1件中 1〜1件')
    expect(within(pager as HTMLElement).queryByRole('button', { name: '前のページ' })).toBeNull()
    expect(within(pager as HTMLElement).queryByRole('button', { name: '次のページ' })).toBeNull()
  })

  it('送信履歴の総数と実際に読めた範囲を分け、次ページのカーソルを渡す', async () => {
    const props = baseProps({ tab: 'history', deliveryList: { ...DELIVERIES, pagination: { ...DELIVERIES.pagination, total: 41 } } })
    await render(props)
    const pager = within(host).getByRole('navigation', { name: 'ページ送り' })
    expect(pager.querySelector('[data-pagination-summary]')?.textContent).toBe('41件中 1〜1件')
    await act(async () => fireEvent.click(within(pager).getByRole('button', { name: '次のページ' })))
    expect(props.onChangeDeliveryView).toHaveBeenCalledWith(undefined, '20', '')
  })

  it('V8 のテーマで、自動配信の表に止めている配信も今月多く送った順で並び、コラムは並ばない', async () => {
    await render(baseProps())
    expect(document.documentElement.dataset.theme).toBe('v8')
    expect(host.querySelector('[data-design-node="MuhWR"]')).not.toBeNull()
    expect(rowNames()).toEqual(['注文ありがとうございます', '口コミのお願い', 'お誕生日クーポン', '困っていませんか'])
    expect(host.textContent).toContain('自動配信 4')
    expect(host.textContent).toContain('停止中 1')
    expect(host.textContent).toContain('4件中 1〜4件')
  })

  it('札「止めている」で止めている配信だけになり、もう一度押すと戻る', async () => {
    await render(baseProps())
    const chip = button('止めている 1')
    expect(chip).toBeTruthy()
    await act(async () => { fireEvent.click(chip!) })
    expect(rowNames()).toEqual(['困っていませんか'])
    await act(async () => { fireEvent.click(button('すべて')!) })
    expect(rowNames()).toHaveLength(4)
  })

  it('行の「…」から止める・クーポンの決めごとを選べる', async () => {
    const props = baseProps()
    await render(props)
    await act(async () => { fireEvent.click(button('「お誕生日クーポン」の操作')!) })
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())
    expect(items).toEqual(expect.arrayContaining(['編集する', 'テスト送信', 'クーポンの決めごと', '止める', '送った履歴を見る']))
    const stop = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.trim() === '止める') as HTMLElement
    await act(async () => { fireEvent.click(stop) })
    expect(props.onToggleSetting).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog').textContent).toContain('この自動配信を送りません')
    await act(async () => { fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '止める', exact: true })) })
    expect(props.onToggleSetting).toHaveBeenCalledWith(expect.objectContaining({ campaignKey: 'birthday_coupon' }))
  })

  it('閲覧のみの人には帯を出し、変える操作（CSV 以外の作る・止める・テスト送信・コラムを書く）を置かない', async () => {
    role.value = verifiedStaffRole('staff')
    await render(baseProps())
    expect(host.textContent).toContain('閲覧のみで見ています')
    await act(async () => { fireEvent.click(button('「注文ありがとうございます」の操作')!) })
    const items = [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent?.trim())
    expect(items).not.toContain('止める')
    expect(items).not.toContain('テスト送信')
    expect(items).not.toContain('編集する')
    // 閲覧のみには押せない更新を置かない。ページ送りの境界は残す。
    expect(host.querySelector('[data-pagination] button[aria-label="前のページ"]')).toBeNull()
    expect(host.querySelector('[data-pagination] button[aria-label="次のページ"]')).toBeNull()
    expect([...host.querySelectorAll('button[disabled]')].filter(b => !b.closest('[data-pagination]'))).toEqual([])
    await render(baseProps({ tab: 'columns' }))
    expect(host.textContent).not.toContain('コラムを書く')
    // クーポンの決めごとは値だけ見せる（入力欄・保存を置かない）。
    await render(baseProps({ couponOpen: true }))
    expect(document.body.textContent).toContain('お誕生日月限定クーポン')
    expect(button('設定を保存する')).toBeUndefined()
    expect(document.querySelector('[role="switch"]')).toBeNull()
    expect([...document.querySelectorAll('button[disabled]')].filter(b => !b.closest('[data-pagination]'))).toEqual([])
  })

  it('コラムのタブは公開日を「9/26」、予約中の下書きを「10/10 予定」と出す', async () => {
    await render(baseProps({ tab: 'columns' }))
    expect(host.querySelector('[data-design-node="Jxmqh"]')).not.toBeNull()
    expect(host.textContent).toContain('10/10 予定')
    expect(host.textContent).toContain('9/26')
    expect(host.textContent).toContain('予約中')
    expect(host.textContent).toContain('コラムを書く')
  })

  it('WEB231：コラムが読み込んだ分より多いときは「続きを読み込む」を出し、検索を勧めない', async () => {
    const onLoadMoreColumns = vi.fn(async () => undefined)
    await render(baseProps({ tab: 'columns', columnsTotal: 250, onLoadMoreColumns }))
    expect(host.textContent).not.toContain('探すときは検索を使ってください')
    await act(async () => { button('続きを読み込む')!.click() })
    expect(onLoadMoreColumns).toHaveBeenCalledTimes(1)
  })

  it('クーポンの決めごとの引き出しで、保存とキャンセルが呼べる', async () => {
    const props = baseProps({ couponOpen: true })
    await render(props)
    expect(document.body.textContent).toContain('誕生日クーポンの決めごと')
    expect(document.body.textContent).toContain('お誕生日月限定クーポン ¥500引き')
    await act(async () => { fireEvent.click(button('設定を保存する')!) })
    expect(props.onSaveCoupon).toHaveBeenCalled()
    await act(async () => { fireEvent.click(button('キャンセル')!) })
    expect(props.onCouponOpenChange).toHaveBeenCalledWith(false)
  })

  it('送った履歴は開封を「取得不可」と出し、札で状態を絞る', async () => {
    const props = baseProps({ tab: 'history' })
    await render(props)
    expect(host.querySelector('[data-design-node="Tj7n4"]')).not.toBeNull()
    expect(host.querySelector('tbody')?.textContent).toContain('取得不可')
    // コラムの記事を開いた割合を、取得できないLINE開封率として流用しない。
    expect(host.querySelectorAll('[data-kpi-number]')[2]?.textContent).toBe('—')
    await act(async () => { fireEvent.click(button('届きませんでした 1')!) })
    expect(props.onChangeDeliveryView).toHaveBeenCalledWith('failed', undefined, '')
  })
})

afterEach(() => { verifiedStaffRole(null) })

it('別アカウントの読み直し中は停止中の自動配信を動かせない', async () => {
 const props = baseProps({ currentAccountData: false })
 await render(props)
 await act(async () => { fireEvent.click(button('「困っていませんか」の操作')!) })
 const start = [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent?.trim().startsWith('動かす'))!
 await act(async () => { fireEvent.click(start) })
 expect(props.onToggleSetting).not.toHaveBeenCalled()
})
it.each([true, false])('別アカウントの読み直し中はコラム配信の状態を変えない（有効=%s）', async enabled => {
 const props = baseProps({ tab: 'columns', currentAccountData: false, settings: SETTINGS.map(item => item.campaignKey === 'column' ? { ...item, isEnabled: enabled } : item) })
 await render(props)
 await act(async () => { fireEvent.click(button('よく使う絞り込み')!) })
 const item = [...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent?.trim().startsWith(enabled ? 'コラム配信を止める' : 'コラム配信を動かす'))!
 await act(async () => { fireEvent.click(item) })
 expect(props.onToggleSetting).not.toHaveBeenCalled()
})
it('コラム配信の停止は対象の確認を通す', async () => {
 const props = baseProps({ tab: 'columns' })
 await render(props)
 await act(async () => { fireEvent.click(button('よく使う絞り込み')!) })
 const item = [...document.querySelectorAll('[role="menuitem"]')].find(node => node.textContent?.trim() === 'コラム配信を止める')!
 await act(async () => { fireEvent.click(item) })
 expect(props.onToggleSetting).not.toHaveBeenCalled()
 expect(screen.getByRole('alertdialog').textContent).toContain('LINEアカウント')
})

it('別アカウントの情報を読み直す間はコラム配信の確認を開けない', async () => {
 await render(baseProps({ tab: 'columns', selectedColumnId: 'c-1', currentAccountData: false }))
 expect(button('配信を予約する')?.disabled).toBe(true)
})

it.each(['column', 'stop'] as const)('%s の確認に操作するアカウントと環境を表示する', async kind => {
 const props = baseProps(kind === 'column' ? { tab: 'columns', selectedColumnId: 'c-1' } : {})
 await render(props)
 if (kind === 'column') await act(async () => { button('配信を予約する')!.click() })
 else {
  await act(async () => { button('「お誕生日クーポン」の操作')!.click() })
  await act(async () => { fireEvent.click([...document.querySelectorAll('[role="menuitem"]')].find(x => x.textContent?.trim() === '止める')!) })
 }
 const dialog = screen.getByRole(kind === 'column' ? 'dialog' : 'alertdialog')
 expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
 expect(within(dialog).getByText('環境')).toBeTruthy()
})
it.each(['column', 'stop'] as const)('%s の古い確定をアカウント切替後に送らない', async kind => {
 const props = baseProps(kind === 'column' ? { tab: 'columns', selectedColumnId: 'c-1' } : {})
 await render(props)
 if (kind === 'column') await act(async () => { button('配信を予約する')!.click() })
 else {
  await act(async () => { button('「お誕生日クーポン」の操作')!.click() })
  await act(async () => { fireEvent.click([...document.querySelectorAll('[role="menuitem"]')].find(x => x.textContent?.trim() === '止める')!) })
 }
 const dialog = screen.getByRole(kind === 'column' ? 'dialog' : 'alertdialog')
 const b = within(dialog).getByRole('button', { name: kind === 'column' ? '送る' : '止める' })
 const key = Object.keys(b).find(item => item.startsWith('__reactProps$'))!
 const oldConfirm = (b as unknown as Record<string,{onClick:(e:unknown)=>unknown}>)[key].onClick
 await render({ ...props, accountId:'account-b' })
 await render(props)
 await act(async () => { await oldConfirm({ defaultPrevented:false, preventDefault(){}, stopPropagation(){}, currentTarget:b, target:b }) })
 expect(props.onDeliverColumn).not.toHaveBeenCalled();expect(props.onToggleSetting).not.toHaveBeenCalled()
})
