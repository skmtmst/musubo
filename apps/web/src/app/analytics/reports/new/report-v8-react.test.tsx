import { pickEntities } from '@/components/shared/entity-picker-test-helpers'
// @vitest-environment happy-dom
/*
 * 分析レポート作成の V8（板 ）と作成時の競合小窓。
 *
 * V8 の頭・帯・右欄と、保存・競合時の入力保護を確認する。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/link', () => ({
  default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a>,
}))

const fixture = vi.hoisted(() => ({
  editId: null as string | null,
  accountId: 'account-a',
  pushes: [] as string[],
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: (href: string) => { fixture.pushes.push(href) } }),
  useSearchParams: () => ({ get: (key: string) => (key === 'id' ? fixture.editId : null) }),
  usePathname: () => '/analytics/reports/new',
}))
vi.mock('@/contexts/account-context', () => ({
  useAccount: () => ({ selectedAccountId: fixture.accountId, loading: false }),
}))
vi.mock('@/components/shell/page-chrome', () => ({
  usePageTitle: () => undefined,
  usePageChrome: () => ({ title: null, fullWidth: false }),
}))

const SCHEDULE = {
  id: 'report-1', lineAccountId: 'account-a', name: '週次まとめ',
  sections: ['friends', 'reactions'], savedAnalysisIds: [],
  cadence: 'weekly', weekday: 1, monthDay: null,
  sendTime: '09:00', timeZone: 'Asia/Tokyo', periodDays: 7,
  recipients: [{ kind: 'staff', staffId: 'u-1', label: '担当1' }],
  channels: ['dashboard', 'email'], alertRules: [],
  status: 'active', isOneTime: false,
  nextRunAt: '2026-09-28T00:00:00.000Z', createdBy: 'u-1',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
}

const OPTIONS = {
  timeZone: 'Asia/Tokyo',
  savedAnalyses: [],
  recipients: [{ id: 'u-1', name: '担当1', role: 'owner', email: 'u1@example.com', lineLinked: true }],
}

const net = vi.hoisted(() => ({
  puts: [] as unknown[],
  putMode: 'ok' as 'ok' | 'conflict-then-ok' | 'deferred' | 'failure',
  deferred: [] as Array<(value: Response) => void>,
  gets: 0,
  getMode: 'normal' as 'normal' | 'deferred' | 'failure',
  getDeferred: [] as Array<(value: Response) => void>,
  latestVersion: '2026-09-01T00:00:00.000Z',
  latestName: null as string | null,
  role: 'owner' as 'owner' | 'admin' | 'staff' | 'viewer',
  readOnly: false, roleBundle: undefined as string | undefined,
  noStaff: false,
  posts: [] as Record<string, unknown>[],
  ranges: [] as string[],
  overviews: null as null | ((path: string) => Response | null),
}))

function installFetch() {
  vi.stubGlobal('fetch', async (input: unknown, init?: { method?: string }) => {
    const raw = typeof input === 'string' ? input : String(input)
    const url = new URL(raw.startsWith('http') ? raw : `https://worker.example.com${raw}`)
    if (url.pathname === '/api/staff/me') {
      return new Response(JSON.stringify({ success: true, data: { role: net.role, readOnly: net.readOnly, roleBundle: net.roleBundle } }), { status: 200 })
    }
    if (url.pathname.startsWith('/api/analytics/report-schedules/report-1') && (init?.method ?? 'GET') === 'PUT') {
      if (net.putMode === 'failure') {
        return new Response(JSON.stringify({ success: false, error: 'internal failure' }), { status: 500 })
      }
      if (net.putMode === 'conflict-then-ok') {
        net.putMode = 'ok'
        return new Response(
          JSON.stringify({ success: false, error: 'この定期レポートは別の画面で先に更新されました。最新の内容を読み込み直してください' }),
          { status: 409 },
        )
      }
      if (net.putMode === 'deferred') {
        return new Promise<Response>((resolve) => { net.deferred.push(resolve) })
      }
      net.puts.push(1)
      return new Response(JSON.stringify({ success: true, data: { ...SCHEDULE, updatedAt: '2026-09-03T00:00:00.000Z' } }), { status: 200 })
    }
    if (url.pathname.startsWith('/api/analytics/report-schedules') && init?.method === 'POST') {
      net.posts.push(JSON.parse((init as RequestInit).body as string))
      return new Promise<Response>(() => {})
    }
    if (url.pathname.startsWith('/api/analytics/report-schedules')) {
      // 初回の読み込みは保存済みの名前、取り直しはほかの人が変えた名前。
      net.gets += 1
      if (net.getMode === 'failure') return new Response(JSON.stringify({ success: false, error: '取得できませんでした' }), { status: 500 })
      if (net.getMode === 'deferred') return new Promise<Response>((resolve) => { net.getDeferred.push(resolve) })
      const name = net.latestName ?? (net.gets === 1 ? SCHEDULE.name : 'ほかの人が変えた名前')
      return new Response(JSON.stringify({
        success: true,
        data: { items: [{ ...SCHEDULE, name, updatedAt: net.latestVersion }], options: net.noStaff ? { ...OPTIONS, recipients: [] } : OPTIONS },
      }), { status: 200 })
    }
    // 見本の数：前の期間の本当の数（友だち12人増加・100件配信・成果3件）。
    if (url.pathname === '/api/analytics/friends' || url.pathname === '/api/analytics/reactions' || url.pathname === '/api/analytics/routes') {
      net.ranges.push(`${url.pathname}${url.search}`)
      const overridden = net.overviews?.(url.pathname)
      if (overridden) return overridden
      const ok = (value: number) => ({ value, state: 'available', reason: null })
      const na = { value: null, state: 'unavailable', reason: null }
      const envelope = (data: unknown) => ({ success: true, data: { lineAccountId: 'account-a', timeZone: 'Asia/Tokyo', period: { from: '2026-09-01', to: '2026-09-07' }, dataCutoffAt: '2026-09-07T00:00:00.000Z', data } })
      if (url.pathname === '/api/analytics/friends') {
        return new Response(JSON.stringify(envelope({
          state: 'available', stateReason: null,
          metrics: { added: ok(15), removed: ok(3), net: ok(12), currentFriends: ok(100), firstTime: ok(10), returning: ok(5) },
          days: [], campaigns: [], historyAvailableFrom: null,
        })), { status: 200 })
      }
      if (url.pathname === '/api/analytics/reactions') {
        return new Response(JSON.stringify(envelope({
          metrics: { sent: ok(120), delivered: ok(100), opened: ok(68), lineClicked: ok(10), trackedClicks: ok(5), unavailableCampaigns: ok(0) },
          campaigns: [], campaignsTruncation: { limit: 50, broadcast: false, scenario: false }, trackedClickHours: [], clickDefinition: '',
        })), { status: 200 })
      }
      return new Response(JSON.stringify(envelope({
        attributionModel: 'first_touch', attributionLabel: '', searchConsoleHref: '',
        routes: [{
          id: 'r1', refCode: null, name: 'リンク1', clicks: na, friendAdds: na, currentFriends: na, reactionPeople: na,
          conversions: { approved: ok(3), pending: ok(0), rejected: ok(0), revenue: na },
          adCost: na, costPerFriend: na, costPerConversion: na, profitAfterAdCost: na,
        }],
      })), { status: 200 })
    }
    return new Response(JSON.stringify({ success: false, error: '未設定' }), { status: 500 })
  })
}

import AnalyticsReportNewPage from './page'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'

let container: HTMLDivElement
let root: Root

async function mount() {
  clearToastsForTest()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(<><AnalyticsReportNewPage /><ToastHost /></>) })
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {})
  }
}

function buttonByText(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === text,
  )
  if (!found) throw new Error(`「${text}」のボタンが見つかりません`)
  return found as HTMLButtonElement
}

/* 比べる窓は document.body 直下の覆いに出る（container の外）。 */
function overlayButtonByText(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').trim() === text && !container.contains(b),
  )
  if (!found) throw new Error(`覆いの「${text}」のボタンが見つかりません`)
  return found as HTMLButtonElement
}

function overlayText(): string {
  return document.body.textContent ?? ''
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  net.role = 'owner'; net.readOnly = false; net.roleBundle = undefined
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.documentElement.dataset.theme = 'v8'
  fixture.editId = null
  fixture.accountId = 'account-a'
  fixture.pushes.length = 0
  net.puts.length = 0
  net.noStaff = false
  net.posts.length = 0
  net.putMode = 'ok'
  net.deferred.length = 0
  net.gets = 0
  net.getMode = 'normal'
  net.getDeferred.length = 0
  net.latestVersion = SCHEDULE.updatedAt
  net.latestName = null
  net.ranges.length = 0
  net.overviews = null
  installFetch()
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  delete document.documentElement.dataset.theme
  vi.unstubAllGlobals()
})

describe('V8 レポート作成（H5UoIu）', () => {
  it('保存済みの担当者が取得済み候補にいなくても、外さずに案内する', async () => {
    fixture.editId = 'report-1'
    net.noStaff = true
    await mount()
    await settle()
    expect(container.textContent).toContain('担当者は今は選べません')
    expect(container.textContent).toContain('このまま保存すると宛先から外れます')
    expect(net.puts).toHaveLength(0)
  })
  it('宛先が未選択なら理由を伝えて送信せず、選んだ後に同じ操作が使える', async () => {
    await mount()
    await settle()
    const send = buttonByText('今すぐ1回だけ送る')
    expect(send.disabled).toBe(true)
    expect(send.title).toBe('受け取る人を1人以上選んでください')
    await pickEntities('レポートを受け取る人', ['担当1'])
    expect(send.disabled).toBe(false)
    expect(send.title).toBe('')
  })
  it('板ID・題・必須・右欄の見本を出す', async () => {
    await mount()
    await settle()
    const framed = container.querySelector('[data-design-node="H5UoIu"]')
    expect(framed).toBeTruthy()
    expect(container.textContent).toContain('レポートを作る')
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-template-region=heading] button[aria-expanded]')!.click() })
    expect(container.textContent).toContain('見たい数をまとめて')
    // 配信先・頻度は必須
    expect(container.textContent).toContain('必須')
    // 右欄の見本（作り物の数値は入れない）
    expect(container.textContent).toContain('こう届きます')
    expect(container.textContent).toContain('レポートが見ているもの')
    expect(container.textContent).toContain('数は送る時刻の時点で集めます')
    expect(container.textContent).toContain('宛先がブロックしていると、LINE では届きません')
  })

  it('右欄の見本に前の期間の本当の数を出す（届く本文と同じ式）', async () => {
    await mount()
    await waitFor(() => expect(container.textContent).toContain('これは前の7日の数での見本です'))
    expect(container.textContent).toContain('12人増加（新規15・解除3）')
    expect(container.textContent).toContain('100件配信・開封68件')
    expect(container.textContent).toContain('3件')
    // 今日の途中は含めない（昨日までの期間で読む）。
    const friends = net.ranges.find((range) => range.startsWith('/api/analytics/friends?'))!
    const params = new URLSearchParams(friends.slice(friends.indexOf('?')))
    const { jstDate } = await import('@/lib/jst-datetime')
    expect(params.get('to')).not.toBe(jstDate(new Date()))
    expect(params.get('from')! < params.get('to')!).toBe(true)
  })

  it('成果は承認済み＋保留を足し、経路不明は除く。1つでも読めなければ出さない', async () => {
    const ok = (value: number) => ({ value, state: 'available', reason: null })
    const na = { value: null, state: 'unavailable', reason: null }
    const route = (name: string, approved: unknown, pending: unknown) => ({
      id: name, refCode: null, name, clicks: na, friendAdds: na, currentFriends: na, reactionPeople: na,
      conversions: { approved, pending, rejected: ok(0), revenue: na },
      adCost: na, costPerFriend: na, costPerConversion: na, profitAfterAdCost: na,
    })
    const envelope = (routes: unknown[]) => new Response(JSON.stringify({
      success: true,
      data: { lineAccountId: 'account-a', timeZone: 'Asia/Tokyo', period: { from: '2026-09-01', to: '2026-09-07' }, dataCutoffAt: '2026-09-07T00:00:00.000Z', data: { attributionModel: 'first_touch', attributionLabel: '', searchConsoleHref: '', routes } },
    }), { status: 200 })
    // 経路不明の99件は混ぜない（2+1=3件）。
    net.overviews = (path) => (path === '/api/analytics/routes'
      ? envelope([route('経路不明', ok(99), ok(0)), route('リンク1', ok(2), ok(1))])
      : null)
    await mount()
    await waitFor(() => expect(container.textContent).toContain('これは前の7日の数での見本です'))
    const row = [...container.querySelectorAll('.report-v8-previewRow')].find((p) => p.textContent?.startsWith('成果'))!
    expect(row.textContent).toContain('3件')
    expect(row.textContent).not.toContain('99')
    // 保留が読めない経路があると、足さずに「送信時に集計」のまま。
    net.overviews = (path) => (path === '/api/analytics/routes'
      ? envelope([route('リンク1', ok(2), na), route('リンク2', ok(1), ok(0))])
      : null)
    await act(async () => { root.unmount() })
    container.remove()
    await mount()
    await waitFor(() => expect(container.textContent).toContain('これは前の7日の数での見本です'))
    const row2 = [...container.querySelectorAll('.report-v8-previewRow')].find((p) => p.textContent?.startsWith('成果'))!
    expect(row2.textContent).toContain('送信時に集計')
  })

  it('配信数が一斉配信だけのときは添え書きを付けて出す', async () => {
    const ok = (value: number) => ({ value, state: 'available', reason: null })
    net.overviews = (path) => (path === '/api/analytics/reactions' ? new Response(JSON.stringify({
      success: true,
      data: {
        lineAccountId: 'account-a', timeZone: 'Asia/Tokyo', period: { from: '2026-09-01', to: '2026-09-07' }, dataCutoffAt: '2026-09-07T00:00:00.000Z',
        data: {
          metrics: { sent: ok(120), delivered: { value: 100, state: 'partial', reason: null }, opened: ok(68), lineClicked: ok(10), trackedClicks: ok(5), unavailableCampaigns: ok(0) },
          campaigns: [], campaignsTruncation: { limit: 50, broadcast: false, scenario: false }, trackedClickHours: [], clickDefinition: '',
        },
      },
    }), { status: 200 }) : null)
    await mount()
    await waitFor(() => expect(container.textContent).toContain('これは前の7日の数での見本です'))
    expect(container.textContent).toContain('100件配信・開封68件（一斉配信のみ）')
  })

  it.each([
    { role: 'staff' as const }, { role: 'viewer' as const }, { role: 'admin' as const, readOnly: true }, { role: 'owner' as const, roleBundle: 'view_only' },
  ])('閲覧のみ：作る・送るは灰色で押せず、宛先を足す・選ぶ・札の × は置かない: %j', async identity => {
    Object.assign(net, identity)
    try {
      await mount()
      await settle()
      const text = container.textContent ?? ''
      expect(text).toContain('運用担当は内容を確認できます')
      for (const label of ['つくって動かす', '今すぐ1回だけ送る']) {
        for (const item of [...container.querySelectorAll<HTMLElement>('button, a')].filter((el) => el.textContent?.trim() === label)) {
          expect(item.getAttribute('aria-disabled') === 'true' || item.hasAttribute('disabled'), label).toBe(true)
        }
      }
      for (const label of ['＋ 宛先を足す', '＋ 保存した分析を選ぶ']) {
        expect([...container.querySelectorAll('button, a')].some((item) => item.textContent?.trim() === label)).toBe(false)
      }
      expect(container.querySelector('.report-v8-chipRemove')).toBeNull()
      expect([...container.querySelectorAll('button, a')].some((item) => item.textContent?.trim() === 'キャンセル')).toBe(true)
    } finally {
      net.role = 'owner'
    }
  })

  it('名前が空のまま押すと欄の下に文が出る', async () => {
    await mount()
    await settle()
    const nameField = container.querySelector("input[placeholder=\"例：週次まとめ\"]") as HTMLInputElement | null
    if (!nameField) throw new Error('名前の入力が見つかりません')
    await act(async () => { fireEvent.change(nameField, { target: { value: '' } }) })
    // 宛先を選んで保存できる形にする
    await pickEntities('レポートを受け取る人', ['担当1'])
    await click(buttonByText('つくって動かす'))
    await settle()
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(nameField.getAttribute('aria-invalid')).toBe('true')
    expect(document.activeElement).toBe(nameField)
    expect(container.textContent).toContain('レポートの名前を入力してください')
  })

  it('知らせる条件の空欄は0として保存せず、その欄へ移る', async () => {
    fixture.editId = 'report-1'
    await mount()
    await settle()
    const toggle = [...container.querySelectorAll('input[type="checkbox"]')].find((item) => item.closest('label')?.textContent?.includes('大きな変化を知らせる')) as HTMLInputElement
    await act(async () => { fireEvent.click(toggle) })
    const condition = container.querySelector('input[aria-label="友だち減少の条件を使う"]') as HTMLInputElement
    await act(async () => { fireEvent.click(condition) })
    const threshold = container.querySelector('#report-alert-friend_adds-threshold') as HTMLInputElement
    await act(async () => { fireEvent.change(threshold, { target: { value: '' } }) })
    await click(buttonByText('変更を保存する'))
    await settle()
    expect(document.activeElement).toBe(threshold)
    expect(threshold.getAttribute('aria-invalid')).toBe('true')
    expect(container.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(net.puts).toHaveLength(0)
  })
})

describe('V8 作成時の競合小窓（G83vi）', () => {
  it('通常の保存成功で離脱確認を解除し、次の編集では再び入力を守る', async () => {
    fixture.editId = 'report-1'
    await mount()
    await settle()
    const nameField = container.querySelector("input[placeholder=\"例：週次まとめ\"]") as HTMLInputElement
    await act(async () => { fireEvent.change(nameField, { target: { value: '保存する名前' } }) })
    const beforeSave = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(beforeSave)
    expect(beforeSave.defaultPrevented).toBe(true)

    await click(buttonByText('変更を保存する'))
    await settle()
    expect(net.puts).toHaveLength(1)
    const afterSave = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(afterSave)
    expect(afterSave.defaultPrevented).toBe(false)
    expect(nameField.value).toBe('保存する名前')

    await act(async () => { fireEvent.change(nameField, { target: { value: '次の編集' } }) })
    const afterEdit = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(afterEdit)
    expect(afterEdit.defaultPrevented).toBe(true)
  })

  it('保存が失敗したら未保存の扱いと入力を残す', async () => {
    fixture.editId = 'report-1'
    net.putMode = 'failure'
    await mount()
    await settle()
    const nameField = container.querySelector("input[placeholder=\"例：週次まとめ\"]") as HTMLInputElement
    await act(async () => { fireEvent.change(nameField, { target: { value: '残す名前' } }) })
    await click(buttonByText('変更を保存する'))
    await settle()
    expect(container.textContent).toContain('保存できませんでした')
    expect(container.textContent).not.toContain('API error:')
    expect(container.textContent).not.toContain('internal failure')
    expect(nameField.value).toBe('残す名前')
    const afterFailure = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(afterFailure)
    expect(afterFailure.defaultPrevented).toBe(true)

    net.putMode = 'ok'
    await click(buttonByText('変更を保存する'))
    await settle()
    expect(net.puts).toHaveLength(1)
    expect(container.textContent).not.toContain('保存できませんでした')
    const afterRetry = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(afterRetry)
    expect(afterRetry.defaultPrevented).toBe(false)
  })

  it('比較後の保存が失敗しても窓と入力を残し、同じ内容で再試行できる', async () => {
    fixture.editId = 'report-1'
    net.putMode = 'conflict-then-ok'
    await mount()
    await settle()
    const nameField = container.querySelector("input[placeholder=\"例：週次まとめ\"]") as HTMLInputElement
    await act(async () => { fireEvent.change(nameField, { target: { value: '比較して残す名前' } }) })
    await click(buttonByText('変更を保存する'))
    await settle()
    await click(buttonByText('違いを比べる'))

    net.putMode = 'failure'
    await click(overlayButtonByText('この内容で保存する'))
    await settle()
    expect(overlayText()).toContain('保存できませんでした')
    expect(overlayText()).not.toContain('API error:')
    expect(overlayText()).not.toContain('internal failure')
    expect(nameField.value).toBe('比較して残す名前')
    expect(container.querySelector('[data-design-node="G83vi"]')).toBeTruthy()
    expect(overlayButtonByText('この内容で保存する').disabled).toBe(false)
    const afterFailure = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(afterFailure)
    expect(afterFailure.defaultPrevented).toBe(true)

    net.putMode = 'ok'
    await click(overlayButtonByText('この内容で保存する'))
    await settle()
    expect(net.puts).toHaveLength(1)
    expect(container.querySelector('[data-design-node="G83vi"]')).toBeNull()
    await waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull())
    expect(nameField.value).toBe('比較して残す名前')
    const afterRetry = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(afterRetry)
    expect(afterRetry.defaultPrevented).toBe(false)
  })

  it('409で帯が出て入力が残り、比べたうえで保存できる', async () => {
    fixture.editId = 'report-1'
    net.putMode = 'conflict-then-ok'
    await mount()
    await settle()
    expect(buttonByText('変更を保存する')).toBeTruthy()

    // 入力中の名前を変えてから保存する（取り直した最新と食い違う）。
    const nameField = container.querySelector("input[placeholder=\"例：週次まとめ\"]") as HTMLInputElement | null
    if (!nameField) throw new Error('名前の入力が見つかりません')
    await act(async () => { fireEvent.change(nameField, { target: { value: 'わたしの入力' } }) })

    await click(buttonByText('変更を保存する'))
    await settle()

    // 板が競合になり、帯が出る。入力は残る（最新の名前で上書きしない）。
    expect(container.querySelector('[data-design-node="G83vi"]')).toBeTruthy()
    expect(container.textContent).toMatch(/ほかの人が.*このレポートを.*保存しました/)
    expect(container.textContent).toContain('このまま保存すると、相手の変更が消えます。入力は残っています。')
    expect((container.querySelector("input[placeholder=\"例：週次まとめ\"]") as HTMLInputElement).value).toBe('わたしの入力')
    // 下の帯の主ボタンは比べる向きになる
    expect(buttonByText('比べてから保存')).toBeTruthy()

    // 比べる窓を開く。最新の文と入力の文が並ぶ。
    await click(buttonByText('違いを比べる'))
    await settle()
    expect(overlayText()).toContain('違いを比べる')
    expect(overlayText()).toContain('名前: ほかの人が変えた名前')
    expect(overlayText()).toContain('名前: わたしの入力')

    // 比べたうえで保存する。最新の版つきでもう一度送る。
    await click(overlayButtonByText('この内容で保存する'))
    await settle()
    expect(net.puts).toHaveLength(1)
    expect(container.querySelector('[data-design-node="G83vi"]')).toBeNull()
    expect(container.textContent).toContain('定期レポートを更新しました')
  })

  it('最新を読み込んで続けると最新の内容に戻る', async () => {
    fixture.editId = 'report-1'
    net.putMode = 'conflict-then-ok'
    await mount()
    await settle()
    await click(buttonByText('変更を保存する'))
    await settle()
    expect(container.querySelector('[data-design-node="G83vi"]')).toBeTruthy()

    await click(buttonByText('最新を読み込んで続ける'))
    await settle()
    expect(container.querySelector('[data-design-node="H5UoIu"]')).toBeTruthy()
    expect((container.querySelector("input[placeholder=\"例：週次まとめ\"]") as HTMLInputElement).value).toBe('ほかの人が変えた名前')
    expect(buttonByText('変更を保存する')).toBeTruthy()
  })

  it('比較を開いた後にさらに更新されていたら、未確認の内容を上書きしない', async () => {
    fixture.editId = 'report-1'
    net.putMode = 'conflict-then-ok'
    await mount()
    await settle()
    await click(buttonByText('変更を保存する'))
    await settle()
    await click(buttonByText('違いを比べる'))
    net.latestVersion = '2026-09-05T00:00:00.000Z'
    net.latestName = 'さらに新しい変更'
    await click(overlayButtonByText('この内容で保存する'))
    await settle()
    expect(net.puts).toHaveLength(0)
    expect(overlayText()).toContain('内容がさらに変更されました')
    expect(overlayText()).toContain('名前: さらに新しい変更')
    await click(overlayButtonByText('この内容で保存する'))
    await settle()
    expect(net.puts).toHaveLength(1)
  })

  it('最新の読み込みはその場で取り直し、失敗しても入力を消さない', async () => {
    fixture.editId = 'report-1'
    net.putMode = 'conflict-then-ok'
    await mount()
    await settle()
    const nameField = container.querySelector("input[placeholder=\"例：週次まとめ\"]") as HTMLInputElement
    await act(async () => { fireEvent.change(nameField, { target: { value: '残したい入力' } }) })
    await click(buttonByText('変更を保存する'))
    await settle()
    const reads = net.gets
    net.getMode = 'failure'
    await click(buttonByText('最新を読み込んで続ける'))
    await settle()
    expect(net.gets).toBe(reads + 1)
    expect(nameField.value).toBe('残したい入力')
    expect(container.textContent).toContain('最新の内容を読み込めませんでした。入力は残っています')
    net.getMode = 'normal'
    net.latestName = 'ボタンを押した時点の最新'
    net.latestVersion = '2026-09-06T00:00:00.000Z'
    await click(buttonByText('最新を読み込んで続ける'))
    await settle()
    expect(nameField.value).toBe('ボタンを押した時点の最新')
  })

  it('比較用の取得中にアカウントを往復しても、遅い結果で保存を始めない', async () => {
    fixture.editId = 'report-1'
    net.putMode = 'conflict-then-ok'
    await mount()
    await settle()
    await click(buttonByText('変更を保存する'))
    await settle()
    await click(buttonByText('違いを比べる'))
    net.getMode = 'deferred'
    await click(overlayButtonByText('この内容で保存する'))
    await settle()
    expect(net.getDeferred).toHaveLength(1)
    net.getMode = 'normal'
    for (const accountId of ['account-b', 'account-a']) {
      fixture.accountId = accountId
      await act(async () => { root.render(<><AnalyticsReportNewPage /><ToastHost /></>) })
      await settle()
    }
    const nameField = container.querySelector("input[placeholder=\"例：週次まとめ\"]") as HTMLInputElement
    await act(async () => { fireEvent.change(nameField, { target: { value: '新しい入力' } }) })
    await act(async () => { net.getDeferred.splice(0).forEach((resolve) => resolve(new Response(JSON.stringify({ success: true, data: { items: [SCHEDULE], options: OPTIONS } }), { status: 200 }))) })
    await settle()
    expect(net.puts).toHaveLength(0)
    expect(nameField.value).toBe('新しい入力')
    expect(container.textContent).not.toContain('定期レポートを更新しました')
  })

  it('保存中は押せない（二重押し防止）', async () => {
    fixture.editId = 'report-1'
    net.putMode = 'deferred'
    await mount()
    await settle()
    await click(buttonByText('変更を保存する'))
    await settle()
    // 応答が戻るまで保存ボタンは押せない。戻れば通る。
    expect(net.deferred).toHaveLength(1)
    expect(buttonByText('保存しています').disabled).toBe(true)
    await act(async () => {
      net.deferred.splice(0).forEach((resolve) => resolve(
        new Response(JSON.stringify({ success: true, data: { ...SCHEDULE, updatedAt: '2026-09-03T00:00:00.000Z' } }), { status: 200 }),
      ))
    })
    await settle()
    expect(container.textContent).toContain('定期レポートを更新しました')
  })
})

it('担当者候補0人でもメール宛先だけで作成でき、1回送信は確認してから1要求だけ送る', async () => {
  net.noStaff = true
  await mount()
  await settle()
  expect(container.textContent).toContain('だれに送りますか')
  await act(async () => { fireEvent.change(container.querySelector('input[placeholder="例：週次まとめ"]')!, { target: { value: 'メールだけの集計' } }) })
  await click(buttonByText('＋ 宛先を足す'))
  await click(buttonByText('メールだけの宛先を足す'))
  await act(async () => { fireEvent.change(container.querySelector('input[aria-label="宛先のメールアドレス 1行目"]')!, { target: { value: 'report@example.com' } }) })
  await click(buttonByText('通知方法：管理画面'))
  await act(async () => {
    fireEvent.click(container.querySelector('#report-channels')!)
    fireEvent.click([...container.querySelectorAll('input[type="checkbox"]')].find(el => el.closest('label')?.textContent?.includes('メールでも送る'))!)
  })
  await click(buttonByText('今すぐ1回だけ送る'))
  expect(net.posts).toHaveLength(0)
  const dialog = document.querySelector('[role="dialog"]')!
  expect(dialog.textContent).toContain('LINEアカウント')
  expect(dialog.textContent).toContain('環境')
  expect(dialog.textContent).toContain('report@example.com')
  expect(dialog.textContent).toContain('通知方法: メール')
  expect(dialog.textContent).not.toContain('送る間かく')
  const confirm = [...dialog.querySelectorAll('button')].find(el => el.textContent?.trim() === 'この宛先へ1回だけ送る')!
  await act(async () => { confirm.click(); confirm.click() })
  await settle()
  expect(net.posts).toHaveLength(1)
  expect(net.posts[0]).toMatchObject({ sendOnce: true, channels: ['email'], recipients: [{ kind: 'email', email: 'report@example.com' }] })
})

it('アカウントを往復した後の古い1回送信の確認では送らない', async () => {
  net.noStaff = true
  await mount(); await settle()
  await click(buttonByText('＋ 宛先を足す'))
  await click(buttonByText('メールだけの宛先を足す'))
  await act(async () => { fireEvent.change(container.querySelector('input[aria-label="宛先のメールアドレス 1行目"]')!, { target: { value: 'report@example.com' } }) })
  await click(buttonByText('通知方法：管理画面'))
  await act(async () => {
    fireEvent.click(container.querySelector('#report-channels')!)
    fireEvent.click([...container.querySelectorAll('input[type="checkbox"]')].find(el => el.closest('label')?.textContent?.includes('メールでも送る'))!)
  })
  await click(buttonByText('今すぐ1回だけ送る'))
  const dialog = document.querySelector('[role="dialog"]')!
  const button = [...dialog.querySelectorAll('button')].find(el => el.textContent?.trim() === 'この宛先へ1回だけ送る')!
  const key = Object.keys(button).find(item => item.startsWith('__reactProps$'))!
  const oldClick = (button as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
  for (const accountId of ['account-b', 'account-a']) {
    fixture.accountId = accountId
    await act(async () => { root.render(<><AnalyticsReportNewPage /><ToastHost /></>) })
    await settle()
  }
  await act(async () => { await oldClick({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button }) })
  expect(net.posts).toHaveLength(0)
})

it('定期レポート作成の同じイベント内の連打も同期して1要求に止める', async () => {
  await mount()
  await settle()
  await act(async () => { fireEvent.change(container.querySelector('input[placeholder="例：週次まとめ"]')!, { target: { value: '連打しても一つ' } }) })
  await pickEntities('レポートを受け取る人', ['担当1'])
  const create = buttonByText('つくって動かす')
  await act(async () => { create.click(); create.click() })
  await settle()
  expect(net.posts).toHaveLength(1)
  expect(net.posts[0]).toMatchObject({ sendOnce: false })
})
