// @vitest-environment happy-dom
/*
 * V8 投稿（src/v8/nen-posts）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * V8 のテーマで表示し、本物の api・fetchApi を通す（差し替えるのは通信とアカウントだけ）。
 * - 審査待ちの札：札の名前に件数が1つの文字で付く・数の帯・写真の「見送る」で窓が開く
 * - 閲覧のみ（staff）：閲覧のみの帯を出し、押せない操作（見送る・採用する・選ぶ・まとめて）を置かない
 * - 採用の札：同意ありは「公式サイトに出す」、通知の失敗は「LINE通知を再送」
 * - 版の履歴：版ごとの行と予約中の版。閲覧のみには「新しい版を作る」を置かない
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const fixture = vi.hoisted(() => ({ role: 'owner' as string, readOnly: false, roleBundle: undefined as string | undefined }))

vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => children }))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/nen-members',
  useSearchParams: () => new URLSearchParams(''),
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: 'account-a', accounts: [{ id: 'account-a', name: '本店' }], loading: false }),
}))

import PhotoReviewV8 from './review'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const thisMonth = new Date().toISOString()
function photo(id: string, petName: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id, pet_name: petName, pet_call_name: `${petName}ちゃん`, pet_gender: 'female',
    owner_name: '見本 169', customer_id: '10234', caption: '散歩のあと',
    status, created_at: '2026-09-30T01:00:00.000Z', review_version: 1, latest_risk_flag: 'safe',
    publication_consent_at: '2026-09-01T00:00:00.000Z', publication_withdrawn_at: null,
    review_notification_status: 'sent',
    ...(status === 'pending' ? {} : { reviewed_at: thisMonth }),
    ...extra,
  }
}
const PHOTOS = [
  photo('ph-1', 'こむぎ', 'pending'),
  photo('ph-2', 'そら', 'pending'),
  photo('ph-3', 'もも', 'pending'),
  photo('ph-4', 'きなこ', 'adopted', { awarded_points: 100, point_sync_status: 'synced' }),
  photo('ph-5', 'レオ', 'adopted', { awarded_points: 100, point_sync_status: 'synced', publication_consent_at: null, review_notification_status: 'failed' }),
  photo('ph-6', 'むぎ', 'rejected', { review_reason_code: 'quality' }),
]
const VERSIONS = [
  { versionNumber: 4, policyKey: 'v4', points: 120, publicationPoints: 200, summary: '', effectiveFrom: '2026-10-15T00:00:00+09:00', createdBy: '見本 18', createdAt: '2026-09-25T20:40:00+09:00', status: 'reserved' },
  { versionNumber: 3, policyKey: 'v3', points: 100, publicationPoints: 200, summary: '', effectiveFrom: null, createdBy: '見本 18', createdAt: '2026-09-20T10:00:00+09:00', status: 'in_use' },
  { versionNumber: 2, policyKey: 'v2', points: 50, publicationPoints: 150, summary: '', effectiveFrom: null, createdBy: '見本 30', createdAt: '2026-08-01T09:30:00+09:00', status: 'past' },
]

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  fixture.role = 'owner'
  fixture.readOnly = false
  fixture.roleBundle = undefined
  document.documentElement.dataset.theme = 'v8'
  window.history.replaceState(null, '', '/nen-members')
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://worker.test')
    if (url.pathname === '/api/staff/me') return json({ success: true, data: { id: 'me', name: 'K', role: fixture.role, readOnly: fixture.readOnly, roleBundle: fixture.roleBundle, email: null } })
    if (url.pathname === '/api/nen-members/photos') return json({ success: true, data: PHOTOS })
    if (url.pathname === '/api/nen-members/photos/review-metrics') return json({ success: true, data: { pendingCount: 3, reviewedCount: 3, averageReviewMinutes: null, oldestPendingAt: null, attentionCount: 0 } })
    if (url.pathname === '/api/nen-members/photos/publications') return json({ success: true, data: { summary: { publishedCount: 18 }, items: [], pendingWithdrawals: [], withdrawnItems: [] } })
    if (url.pathname === '/api/nen-members/photo-reward-policy/versions') return json({ success: true, data: VERSIONS })
    return json({ success: true, data: null })
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

async function render() {
  await act(async () => { root.render(<PhotoReviewV8 accountId="account-a" />) })
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}
const buttons = (label: string) => [...document.querySelectorAll('button')].filter((button) => (button.getAttribute('aria-label') ?? button.textContent ?? '').includes(label) || (button.textContent ?? '').includes(label))
const tabs = () => [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim())
async function click(element: Element | undefined) {
  if (!element) throw new Error('押す相手が見つかりません')
  await act(async () => { (element as HTMLElement).click() })
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

describe('V8 投稿（審査）', () => {
  it('審査が空でも掲載済み写真の場所を案内する', async () => {
    const original = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://worker.test')
      if (url.pathname === '/api/nen-members/photos') return json({ success: true, data: [] })
      if (url.pathname === '/api/nen-members/photos/review-metrics') return json({ success: true, data: { pendingCount: 0, reviewedCount: 0, averageReviewMinutes: null, oldestPendingAt: null, attentionCount: 0 } })
      if (url.pathname === '/api/nen-members/photos/publications') return json({ success: true, data: { summary: { publishedCount: 2 }, items: [], pendingWithdrawals: [], withdrawnItems: [] } })
      return original(input, init)
    })
    await render()
    expect(host.textContent).toContain('この状態の写真はありません')
    expect(host.textContent).toContain('掲載した写真は「公式サイト掲載」タブで確認できます')
  })

  it('掲載のURLでは掲載タブと本文をそろえ、審査のカードを出さない', async () => {
    window.history.replaceState(null, '', '/nen-members?tab=publications')
    await render()
    const publications = [...host.querySelectorAll('[role="tab"]')].find(tab => tab.textContent === '公式サイト掲載')
    expect(publications?.getAttribute('aria-selected')).toBe('true')
    expect(host.textContent).toContain('公式サイト掲載中の写真はありません')
    expect(host.querySelector('[data-design-node="photo-cards-v8"]')).toBeNull()
    expect(buttons('写真を見送る')).toHaveLength(0)
    expect(window.location.search).toBe('?tab=publications')
  })
  it('次のページを含む全件選択でも審査対象の写真と版を保持する', async () => {
    const rows = Array.from({ length: 201 }, (_, index) => photo(`page-${index}`, `写真${index}`, 'pending'))
    const originalFetch = globalThis.fetch
    const offsets: string[] = []
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://worker.test')
      if (url.pathname === '/api/nen-members/photos') {
        const offset = Number(url.searchParams.get('offset') ?? '0')
        offsets.push(String(offset))
        return json({ success: true, data: rows.slice(offset, offset + 200) })
      }
      return originalFetch(input, init)
    })
    await render()
    const checkbox = host.querySelector('input[type="checkbox"]')!
    await click(checkbox)
    expect(buttons('条件に合う201枚すべてを選ぶ')).toHaveLength(1)
    await click(buttons('条件に合う201枚すべてを選ぶ')[0])
    expect(host.textContent).toContain('201枚を選択中')
    expect(offsets).toContain('200')
    await click(buttons('まとめて採用')[0])
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('201枚をまとめて採用')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('LINEアカウント')
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('環境')
  })

  it('V8 のテーマで、札の名前と件数を1つの文字で出し、数の帯と右の決まりを並べる', async () => {
    await render()
    expect(document.documentElement.dataset.theme).toBe('v8')
    expect(tabs()).toEqual(['審査待ち 3', '採用 2', '見送り 1', '公式サイト掲載'])
    const band = host.querySelector('[data-kpi-strip]')
    expect(band?.textContent).toContain('今月 採用')
    expect(band?.textContent).toContain('1 枚ごとに 100 マイル')
    expect(band?.textContent).toContain('理由：暗くて見えにくいです')
    expect(host.textContent).toContain('さらに 200 マイル')
    expect(host.querySelectorAll('[data-design-node="photo-cards-v8"] > li')).toHaveLength(3)
  })

  it('写真の「見送る」で見送る窓（ujcar）が開き、理由をえらぶと届く文章が変わる', async () => {
    await render()
    await click(buttons('そらちゃんの写真を見送る')[0])
    const dialog = document.querySelector('[data-design-node="ujcar"]')
    expect(dialog?.textContent).toContain('この写真を見送りますか？')
    expect(dialog?.textContent).toContain('LINEアカウント')
    expect(dialog?.textContent).toContain('環境')
    expect(dialog?.textContent).toContain('写真が暗い・ぼやけている')
    await click([...document.querySelectorAll('input[type="radio"]')].find((radio) => radio.parentElement?.textContent?.includes('ほかの人の顔')))
    expect(document.querySelector('[data-design-node="ujcar"]')?.textContent).toContain('人の顔や個人情報が写っている')
  })

  it('まとめて見送る確認には送信元と環境を出す', async () => {
    await render()
    await click(host.querySelector('input[type="checkbox"]') ?? undefined)
    await click(buttons('まとめて見送り')[0])
    const dialog = document.querySelector('[role="alertdialog"]')
    expect(dialog?.textContent).toContain('LINEアカウント')
    expect(dialog?.textContent).toContain('環境')
  })

  it('そのほかの理由が空なら送らず、補足の欄だけで知らせる', async () => {
    await render()
    await click(buttons('そらちゃんの写真を見送る')[0])
    await click([...document.querySelectorAll('input[type="radio"]')].find((radio) => radio.parentElement?.textContent?.includes('自分で書く')))
    const dialog = document.querySelector('[data-design-node="ujcar"]')!
    const confirm = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.trim() === '見送る')!
    await click(confirm)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)) })
    const note = document.getElementById('photo-reject-note')!
    expect(note.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(note)
    expect(dialog.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(dialog.textContent).toContain('そのほかの理由を入力してください')
  })

  it('WEB225：見送りの保存に失敗したら、理由を開いている窓の中に出す', async () => {
    const base = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://worker.test')
      if ((init?.method ?? 'GET') !== 'GET' && url.pathname.includes('/photos/')) {
        return new Response(JSON.stringify({ success: false, error: 'down' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      }
      return base(input, init)
    })
    await render()
    await click(buttons('そらちゃんの写真を見送る')[0])
    const dialog = () => document.querySelector('[data-design-node="ujcar"]')
    const confirm = [...dialog()!.querySelectorAll('button')].find((button) => button.textContent?.trim() === '見送る')
    await click(confirm)
    expect(dialog()).toBeTruthy()
    expect(dialog()!.textContent).toContain('審査結果を保存できませんでした')
  })

  it.each([
    { role: 'staff', readOnly: false, roleBundle: undefined },
    { role: 'viewer', readOnly: false, roleBundle: undefined },
    { role: 'admin', readOnly: true, roleBundle: undefined },
    { role: 'owner', readOnly: false, roleBundle: 'view_only' },
  ])('閲覧のみには帯を出し、押せない操作を置かない: %j', async (identity) => {
    Object.assign(fixture, identity)
    await render()
    expect(host.textContent).toContain('閲覧のみで見ています')
    for (const label of ['見送る', '採用する', 'まとめて', '公式サイトに出す', 'LINE通知を再送']) {
      expect(buttons(label), label).toHaveLength(0)
    }
    expect(host.querySelectorAll('input[type="checkbox"]')).toHaveLength(0)
    expect([...host.querySelectorAll('button')].filter((button) => button.disabled).map((button) => button.textContent)).toEqual([])
    // 見るだけの操作（版の履歴・札）は残す。
    expect(buttons('版の履歴を見る')).toHaveLength(1)
    await click([...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.startsWith('採用')))
    expect(host.textContent).toContain('きなこちゃん')
    expect(buttons('公式サイトに出す')).toHaveLength(0)
    expect([...host.querySelectorAll('button')].filter((button) => button.disabled).map((button) => button.textContent)).toEqual([])
  })

  it('採用の札：同意ありは「公式サイトに出す」、通知に失敗した写真は「LINE通知を再送」', async () => {
    await render()
    await click([...document.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent?.startsWith('採用')))
    const cards = [...host.querySelectorAll('[data-design-node="photo-cards-v8"] article')]
    expect(cards).toHaveLength(2)
    expect(cards[0].textContent).toContain('公開の同意あり')
    expect(cards[0].textContent).toContain('公式サイトに出す')
    expect(cards[1].textContent).toContain('公開しない')
    expect(cards[1].textContent).toContain('LINE通知を再送')
    expect(host.textContent).toContain('写真を採用しても自動公開しません')
  })

  it('掲載の確認に対象アカウントと環境を示す', async () => {
    const originalFetch = globalThis.fetch
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://worker.test')
      if (url.pathname === '/api/nen-members/photos/ph-4') return json({ success: true, data: { publication: { version: 2 } } })
      return originalFetch(input, init)
    })
    await render()
    await click([...document.querySelectorAll('[role="tab"]')].find(tab => tab.textContent?.startsWith('採用')))
    await click(buttons('公式サイトに出す')[0])
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('LINEアカウント')
    expect(dialog.textContent).toContain('環境')
  })

  it('版の履歴（N1br7）：版の行・予約中の版。閲覧のみには新しい版の入力を置かない', async () => {
    await render()
    await click(buttons('版の履歴を見る')[0])
    const dialog = () => document.querySelector('[data-design-node="N1br7"]')
    expect(dialog()?.textContent).toContain('第3版')
    expect(dialog()?.textContent).toContain('採用 100・公式サイト掲載 さらに 200')
    expect(dialog()?.textContent).toContain('いま使っている版')
    expect(dialog()?.textContent).toContain('10/15 00:00 から')
    expect(dialog()?.textContent).toContain('新しい版を作る')
    expect(document.querySelector('[data-drawer]')).toBeNull()
    await click([...document.querySelectorAll('button')].find(button => button.textContent?.trim() === '新しい版を作る'))
    expect(document.querySelector('[data-shared-part="drawer"]')?.textContent ?? document.body.textContent).toContain('採用したら（マイル）')

    act(() => root.unmount())
    root = createRoot(host)
    fixture.role = 'staff'
    await render()
    await click(buttons('版の履歴を見る')[0])
    expect(dialog()?.textContent).toContain('予約中の版')
    expect(dialog()?.textContent).not.toContain('新しい版を作る')
  })
})


it('掲載順の端の操作は理由を示し、並びを変えても取消で保存しない', async () => {
  const items = [
    { id: 'publication-a', version: 3, pet_name: 'こむぎ', hide_owner_name: 1, placements: [], view_count_30_days: null },
    { id: 'publication-b', version: 5, pet_name: 'そら', hide_owner_name: 1, placements: [], view_count_30_days: null },
  ]
  const originalFetch = globalThis.fetch
  const writes: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://worker.test')
    if (init?.method && init.method !== 'GET') writes.push(url.pathname)
    if (url.pathname === '/api/nen-members/photos/publications') return json({ success: true, data: { summary: { publishedCount: 2 }, items, pendingWithdrawals: [], withdrawnItems: [] } })
    if (url.pathname === '/api/nen-members/photos/publications/order') return json({ success: true, data: { items } })
    return originalFetch(input, init)
  })
  await render()
  await click(buttons('公式サイト掲載')[0])
  await click(buttons('並び順を変える')[0])
  const dialog = document.querySelector('[role="dialog"]')!
  const orderButtons = () => [...dialog.querySelectorAll<HTMLButtonElement>('button')]
  const up = orderButtons().find(button => button.getAttribute('aria-label') === 'こむぎを上へ')!
  const down = orderButtons().find(button => button.getAttribute('aria-label') === 'そらを下へ')!
  expect(up.disabled).toBe(true)
  expect(up.title).toBe('これより上には移動できません')
  expect(down.disabled).toBe(true)
  expect(down.title).toBe('これより下には移動できません')
  await click(orderButtons().find(button => button.getAttribute('aria-label') === 'こむぎを下へ'))
  expect(dialog.querySelector('li')?.textContent).toContain('そら')
  await click(orderButtons().find(button => button.textContent === 'キャンセル'))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(writes).toEqual([])
})


it('掲載先の保存失敗は編集中の窓だけで伝え、選択を保持する', async () => {
  const item = { id: 'publication-a', version: 3, pet_name: 'こむぎ', hide_owner_name: 1, placements: [], view_count_30_days: null }
  const originalFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://worker.test')
    if (url.pathname === '/api/nen-members/photos/publications') return json({ success: true, data: { summary: { publishedCount: 1 }, items: [item], pendingWithdrawals: [], withdrawnItems: [] } })
    if (url.pathname.endsWith('/placements') && init?.method === 'PUT') return new Response(JSON.stringify({ success: false, error: { code: 'CONFLICT', message: '先に変更されました' } }), { status: 409, headers: { 'Content-Type': 'application/json' } })
    return originalFetch(input, init)
  })
  await render()
  await click(buttons('公式サイト掲載')[0])
  await click(buttons('その他操作')[0])
  await click(buttons('使う場所')[0])
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('LINEアカウント')
  expect(dialog.textContent).toContain('環境')
  const firstChoice = dialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  await click(firstChoice)
  expect(firstChoice.checked).toBe(true)
  await click([...dialog.querySelectorAll('button')].find(button => button.textContent === '保存する'))
  const alerts = [...document.querySelectorAll('[role="alert"]')].filter(element => element.textContent?.includes('使う場所を保存できませんでした'))
  expect(alerts).toHaveLength(1)
  expect(dialog.contains(alerts[0])).toBe(true)
  expect(firstChoice.checked).toBe(true)
})

it('掲載解除の確認に対象アカウントと環境を示す', async () => {
  const item = { id: 'publication-a', version: 3, pet_name: 'こむぎ', hide_owner_name: 1, placements: [], view_count_30_days: null }
  const originalFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://worker.test')
    if (url.pathname === '/api/nen-members/photos/publications') return json({ success: true, data: { summary: { publishedCount: 1 }, items: [item], pendingWithdrawals: [], withdrawnItems: [] } })
    return originalFetch(input, init)
  })
  await render()
  await click(buttons('公式サイト掲載')[0])
  await click(buttons('その他操作')[0])
  await click(buttons('掲載先から外す')[0])
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('LINEアカウント')
  expect(dialog.textContent).toContain('環境')
})

it('一括採用の窓を閉じた後は古い確定口から審査しない', async () => {
  const original = globalThis.fetch
  const writes: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') writes.push(String(input))
    return original(input, init)
  })
  await render()
  await click(host.querySelector('input[type="checkbox"]') ?? undefined)
  await click(buttons('まとめて採用')[0])
  const dialog = document.querySelector('[role="dialog"]')!
  const button = [...dialog.querySelectorAll('button')].find(el => el.textContent?.trim() === 'まとめて採用')!
  const key = Object.keys(button).find(k => k.startsWith('__reactProps$'))!
  const oldClick = (button as unknown as Record<string, { onClick: (event: unknown) => void }>)[key].onClick
  await click([...dialog.querySelectorAll('button')].find(el => el.textContent?.trim() === '審査へ戻る'))
  await act(async () => { await oldClick({defaultPrevented:false,preventDefault(){},stopPropagation(){},currentTarget:button,target:button}) })
  expect(writes).toEqual([])
})

it('一括見送りの窓を閉じた後は古い確定口から通知しない', async () => {
  const original = globalThis.fetch
  const writes: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') writes.push(String(input))
    return original(input, init)
  })
  await render()
  await click(host.querySelector('input[type="checkbox"]') ?? undefined)
  await click(buttons('まとめて見送り')[0])
  const dialog = document.querySelector('[role="alertdialog"]')!
  const button = [...dialog.querySelectorAll('button')].find(el => el.textContent?.trim() === 'この理由でまとめて見送り')!
  const key = Object.keys(button).find(k => k.startsWith('__reactProps$'))!
  const oldClick = (button as unknown as Record<string, { onClick: (event: unknown) => void }>)[key].onClick
  await click([...dialog.querySelectorAll('button')].find(el => el.textContent?.trim() === '審査へ戻る'))
  await act(async () => { await oldClick({defaultPrevented:false,preventDefault(){},stopPropagation(){},currentTarget:button,target:button}) })
  expect(writes).toEqual([])
})

it('一括採用の確認はアカウントを往復した後に使えず、新しい確認は送れる', async () => {
  const original = globalThis.fetch
  const writes: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST' && String(input).includes('/decisions/bulk')) { writes.push(String(input)); return json({success:true,data:{updatedCount:3,notificationFailures:[]}}) }
    return original(input, init)
  })
  await render()
  await click(host.querySelector('input[type="checkbox"]') ?? undefined)
  await click(buttons('まとめて採用')[0])
  const button = [...document.querySelector('[role="dialog"]')!.querySelectorAll('button')].find(el => el.textContent?.trim() === 'まとめて採用')!
  const key = Object.keys(button).find(k => k.startsWith('__reactProps$'))!
  const oldClick = (button as unknown as Record<string, { onClick: (event: unknown) => void }>)[key].onClick
  await act(async () => { root.render(<PhotoReviewV8 accountId="account-b" />) })
  await act(async () => { root.render(<PhotoReviewV8 accountId="account-a" />) })
  await act(async () => { await oldClick({defaultPrevented:false,preventDefault(){},stopPropagation(){},currentTarget:button,target:button}) })
  expect(writes).toEqual([])
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  const selection = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!
  if (!selection.checked) await click(selection)
  await click(buttons('まとめて採用')[0])
  const current = [...document.querySelector('[role="dialog"]')!.querySelectorAll('button')].find(el => el.textContent?.trim() === 'まとめて採用')!
  await click(current)
  expect(writes).toHaveLength(1)
})

it.each(['公開', '掲載解除', '掲載先変更'] as const)('%sの窓を閉じた後は古い確定口を使えない', async kind => {
  const item = { id: 'publication-a', version: 3, pet_name: 'こむぎ', hide_owner_name: 1, placements: [], view_count_30_days: null }
  const original = globalThis.fetch
  const writes: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://worker.test')
    if (init?.method && init.method !== 'GET') writes.push(url.pathname)
    if (url.pathname === '/api/nen-members/photos/publications') return json({ success: true, data: { summary: { publishedCount: 1 }, items: [item], pendingWithdrawals: [], withdrawnItems: [] } })
    if (url.pathname === '/api/nen-members/photos/ph-4') return json({ success: true, data: { publication: { version: 2 } } })
    return original(input, init)
  })
  await render()
  if (kind === '公開') {
    await click([...document.querySelectorAll('[role="tab"]')].find(tab => tab.textContent?.startsWith('採用')))
    await click(buttons('公式サイトに出す')[0])
  } else {
    await click(buttons('公式サイト掲載')[0])
    await click(buttons('その他操作')[0])
    await click(buttons(kind === '掲載解除' ? '掲載先から外す' : '使う場所')[0])
  }
  const dialog = document.querySelector('[role="dialog"]')!
  const label = kind === '公開' ? '公式サイトに掲載する' : kind === '掲載解除' ? '掲載先から外す' : '保存する'
  const button = [...dialog.querySelectorAll('button')].find(el => el.textContent?.trim() === label)!
  const key = Object.keys(button).find(k => k.startsWith('__reactProps$'))!
  const oldClick = (button as unknown as Record<string, { onClick: (event: unknown) => void }>)[key].onClick
  await click([...dialog.querySelectorAll('button')].find(el => el.textContent?.trim() === 'キャンセル'))
  await act(async () => { await oldClick({defaultPrevented:false,preventDefault(){},stopPropagation(){},currentTarget:button,target:button}) })
  expect(writes).toEqual([])
  if (kind === '公開') await click(buttons('公式サイトに出す')[0])
  else {
    await click(buttons('その他操作')[0])
    await click(buttons(kind === '掲載解除' ? '掲載先から外す' : '使う場所')[0])
  }
  const fresh = document.querySelector('[role="dialog"]')!
  await click([...fresh.querySelectorAll('button')].find(el => el.textContent?.trim() === label))
  expect(writes).toHaveLength(1)
})

it('個別見送りの窓を閉じた後は古い確定口から通知しない', async () => {
  const original = globalThis.fetch
  const writes: string[] = []
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method && init.method !== 'GET') writes.push(String(input))
    return original(input, init)
  })
  await render()
  await click(buttons('そらちゃんの写真を見送る')[0])
  const dialog = document.querySelector('[role="alertdialog"]')!
  const button = [...dialog.querySelectorAll('button')].find(el => el.textContent?.trim() === '見送る')!
  const key = Object.keys(button).find(k => k.startsWith('__reactProps$'))!
  const oldClick = (button as unknown as Record<string, { onClick: (event: unknown) => void }>)[key].onClick
  await click([...dialog.querySelectorAll('button')].find(el => el.textContent?.trim() === 'キャンセル'))
  await act(async () => { await oldClick({defaultPrevented:false,preventDefault(){},stopPropagation(){},currentTarget:button,target:button}) })
  expect(writes).toEqual([])
})
