// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DashboardColumns, DashboardRow } from '@/components/templates/dashboard-page'
import DashboardEditor from './dashboard-editor'
import {
  defaultDashboardPreferences,
  normalizeDashboardPreferences,
  V8_DASHBOARD_DEFAULT_VISIBILITY,
} from '@/components/dashboard/dashboard-preference-defaults'
import { partialFailureLabels, partialFailuresWithoutCard } from '@/components/dashboard/partial-failure-labels'
import { ConnectionStatus, SupportStatus, webhookState } from './sections'

/*
 * ★V8 ダッシュボード（d8X09・）：右の列は上の数の帯の1マス分。
 * 縦の線を帯の線と一直線にするため、段は帯と同じ等分の格子に載る。
 * 実際の座標（1440〜1152・左メニュー開閉で ±0px）は撮影で確かめた。ここは仕組みを見張る。
 */
afterEach(() => { cleanup(); delete document.documentElement.dataset.theme })

const css = readFileSync(join(__dirname, '../../components/templates/page-templates.module.css'), 'utf8')

describe('右の列を帯の1マス分にする口', () => {
  it("asideSize='column' は段に印と帯のマスの数を渡す", () => {
    const { container } = render(<DashboardRow asideSize="column" asideColumns={3} aside={<p>右</p>}>左</DashboardRow>)
    const row = container.firstElementChild as HTMLElement
    expect(row.dataset.asideSize).toBe('column')
    expect(row.style.getPropertyValue('--tpl-dash-cols')).toBe('3')
  })

  it('右の列が無い段には印を付けない（左が全幅のまま）', () => {
    const { container } = render(<DashboardRow asideSize="column">左</DashboardRow>)
    expect((container.firstElementChild as HTMLElement).dataset.asideSize).toBeUndefined()
  })

  it('段は帯と同じ等分の格子。左は最後の1列の手前まで、右は最後の1列', () => {
    expect(css).toMatch(/\.dashboardRow\[data-aside-size='column'\] \{ display: grid; grid-template-columns: repeat\(var\(--tpl-dash-cols\), minmax\(0, 1fr\)\); \}/)
    expect(css).toMatch(/\[data-aside-size='column'\] > \.dashboardCell \{ grid-column: 1 \/ -2; \}/)
    expect(css).toMatch(/\[data-aside-size='column'\] > \.dashboardAside \{ grid-column: -2 \/ -1; width: auto; \}/)
    // 横並びの段も等分の格子（flex の配分だと線の太さ分ずれる）。高さは絵（ の下の4つ＝200）に合わせた下限だけ置く（中身が増えれば伸びる）。
    expect(css).toMatch(/\.dashboardColumns \{ min-height: 200px; display: grid; grid-auto-flow: column; grid-auto-columns: minmax\(0, 1fr\); \}/)
  })

  it('狭い板（1100 未満）でも 1マス分の右の列は隠さない', () => {
    const narrow = css.slice(css.indexOf('@container v8-page (max-width: 1099px)'))
    expect(narrow).toContain(".dashboardAside:not([data-aside-size='column']) { display: none; }")
  })

  it('横並びの段は子の数だけ並ぶ', () => {
    const { container } = render(<DashboardColumns>{[<p key="a">a</p>, <p key="b">b</p>]}</DashboardColumns>)
    expect(container.firstElementChild?.children).toHaveLength(2)
  })
})

describe('V8 の既定の表示', () => {
  it('友だちの状態は既定で表示し、保存済みの非表示は引き継ぐ', () => {
    const v8 = defaultDashboardPreferences(V8_DASHBOARD_DEFAULT_VISIBILITY)
    expect(v8.right.find((item) => item.id === 'friend-status')?.visible).toBe(true)
    // 保存済みで隠した人の選択は上書きしない
    const saved = normalizeDashboardPreferences({ right: [{ id: 'friend-status', visible: false }] }, V8_DASHBOARD_DEFAULT_VISIBILITY)
    expect(saved.right.find((item) => item.id === 'friend-status')?.visible).toBe(false)
    // 保存に無いカードは V8 の既定で補う
    const missing = normalizeDashboardPreferences({ right: [] }, V8_DASHBOARD_DEFAULT_VISIBILITY)
    expect(missing.right.find((item) => item.id === 'friend-status')?.visible).toBe(true)
  })
})

describe('読めなかった項目は日本語の名前', () => {
  it('内部の名前（quota など）を出さない', () => {
    expect(partialFailureLabels(['quota'])).toBe('送信枠')
    expect(partialFailureLabels(['quota', 'friends', 'quota'])).toBe('送信枠、友だちの状態')
    expect(partialFailureLabels(['unknown-x'])).toBe('その他')
  })

  it('部品の中で自分のエラーを出すカードが見えていれば、頭の帯には重ねない', () => {
    expect(partialFailuresWithoutCard(['quota'], new Set(['send-quota']))).toEqual([])
    expect(partialFailuresWithoutCard(['quota'], new Set())).toEqual(['quota'])
    expect(partialFailuresWithoutCard(['quota', 'broadcasts'], new Set(['send-quota']))).toEqual(['broadcasts'])
  })
})

describe('右の列：現在の対応状況と接続状態', () => {
  it('対応状況の4行は状態の札（色の点つき）で出す（未対応 赤・対応中 橙・保留 灰・対応済み 緑）', () => {
    const { container } = render(<SupportStatus inbox={{ unanswered: 5, inProgress: 0, onHold: 0, resolved: 38 } as never} autoOnInbound />)
    const dots = [...container.querySelectorAll('a [data-design-node="xRvDB"]')].map((badge) => (badge as HTMLElement).dataset.tone)
    expect(dots).toHaveLength(4)
    expect(dots[0]).toBe('danger')
    expect(dots[1]).toBe('warning')
    expect(dots[2]).toBe('neutral')
    expect(dots[3]).toBe('success')
  })

  it('Webhook の値は 正常／要確認（理由つき）／未確認。「確認中」で止まらない', () => {
    expect(webhookState({ connection: { status: 'ok', checkedAt: 'x' } } as never).label).toBe('正常')
    expect(webhookState({ webhook: { status: 'matched' } } as never).label).toBe('未確認')
    expect(webhookState({ connection: { status: 'unknown', checkedAt: null } } as never).label).toBe('未確認')
    expect(webhookState(null).label).toBe('未確認')
    expect(webhookState({ isActive: true, connection: { status: 'ok' }, webhook: { status: 'mismatched' } } as never).label).toBe('正常')
    expect(webhookState({ isActive: false, connection: { status: 'warn' } } as never).label).toBe('停止中')
    const warn = webhookState({ connection: { status: 'warn', checkedAt: 'x', issues: [{ kind: 'webhook_endpoint', result: 'unconfigured', expectedUrl: null, registeredUrl: null, webhookActive: null, httpStatus: null }] } } as never)
    expect(warn.label).toBe('要確認')
    expect(warn.reason?.text).toBe('LINE に Webhook の URL が登録されていません')
  })

  it('要確認・未確認は「確かめる」（権限のある人だけ）。押している間だけ「確認中」', async () => {
    const account = { id: 'a1', revision: 3, connection: { status: 'unknown', checkedAt: null } } as never
    let finish: () => void = () => {}
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = () => resolve(new Response(JSON.stringify({ success: true, data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })) }))
    vi.stubGlobal('fetch', fetchMock)
    const onChecked = vi.fn()
    const { rerender } = render(<ConnectionStatus account={account} canCheck={false} onChecked={onChecked} risk="normal" activeFriends={1} />)
    expect(screen.queryByRole('button', { name: 'LINE Webhook の接続を確かめる' })).toBeNull()
    expect(screen.getByText('未確認')).toBeTruthy()
    rerender(<ConnectionStatus account={account} canCheck onChecked={onChecked} risk="normal" activeFriends={1} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'LINE Webhook の接続を確かめる' })) })
    expect(screen.getByText('確認中')).toBeTruthy()
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('/api/line-accounts/a1/connection-checks')
    await act(async () => { finish() })
    expect(onChecked).toHaveBeenCalled()
    expect(screen.queryByText('確認中')).toBeNull()
    vi.unstubAllGlobals()
  })
})

describe('ダッシュボード編集の表示の切り替え', () => {
  const props = () => ({
    open: true,
    preferences: defaultDashboardPreferences(V8_DASHBOARD_DEFAULT_VISIBILITY),
    onCancel: vi.fn(),
    onApply: vi.fn(),
  })

  it('V8 はスイッチ（読み上げ「〇〇を表示」）。押すとオン・オフが変わる', async () => {
    document.documentElement.dataset.theme = 'v8'
    await act(async () => { render(<DashboardEditor {...props()} />) })
    const toggle = screen.getByRole('switch', { name: '写真審査を表示' })
    expect((toggle as HTMLElement).getAttribute('aria-checked') === 'true').toBe(true)
    fireEvent.click(toggle)
    expect((screen.getByRole('switch', { name: '写真審査を表示' }) as HTMLElement).getAttribute('aria-checked') === 'true').toBe(false)
  })

  it('V8 でも「今日やること」の切り替えは同じ動き（オフ→オンで4枠に戻る）', async () => {
    document.documentElement.dataset.theme = 'v8'
    await act(async () => { render(<DashboardEditor {...props()} />) })
    fireEvent.click(screen.getByRole('switch', { name: '写真審査を表示' }))
    fireEvent.click(screen.getByRole('switch', { name: '写真審査を表示' }))
    const on = ['対応が必要な受信', '写真審査', '今日の予約', '出荷予定件数']
      .map((label) => (screen.getByRole('switch', { name: `${label}を表示` }) as HTMLElement).getAttribute('aria-checked') === 'true')
    expect(on.filter(Boolean)).toHaveLength(4)
  })

  it('旧テーマ属性でも現役V8の編集を使う', async () => {
    document.documentElement.dataset.theme = 'v7'
    await act(async () => { render(<DashboardEditor {...props()} />) })
    expect(screen.getByRole('switch', { name: '写真審査を表示' })).toBeTruthy()
    expect(document.querySelector('input[aria-label="写真審査を非表示にする"]')).toBeNull()
  })
})

describe('狭い幅でも題を「…」で切らない（1280・1152）', () => {
  const dashCss = readFileSync(join(__dirname, 'dashboard.module.css'), 'utf8')
  const headerCss = readFileSync(join(__dirname, '../../components/shared/section-header.module.css'), 'utf8')

  it('ダッシュボードの段の題は行き先を次の行へ回せる（入るときは1行のまま）', async () => {
    const { default: Head } = await import('./head')
    const { container } = render(<Head title="現在の対応状況" href="/chats" linkLabel="受信箱へ" />)
    expect(container.querySelector('[data-wrap]')).not.toBeNull()
    expect(headerCss).toMatch(/\.root\[data-wrap\] \{\s*flex-wrap: wrap;/)
  })

  it('右の列の余白は型でそろえ、1152 の板では題の箱の高さを中身に合わせる', () => {
    expect(css).toMatch(/\.dashboardAsideSection \{[^}]*padding: var\(--polish-space-card\) var\(--polish-space-section\);/)
    expect(dashCss).not.toContain('.asideBlock')
    expect(dashCss).toMatch(/@container v8-page \(max-width: 959px\) \{\s*\.head \{ height: auto; min-height: var\(--tpl-db-head-h\); \}/)
  })



  it('送信枠の残数は0を保ち、グラフの日付は棒の真ん中', async () => {
    const { SendQuota } = await import('./sections')
    const metric = { value: { used: 3, limit: 200, remaining: 197 }, state: 'available' as const, reason: null, asOf: null, period: 'this-month' as const }
    const view = render(<SendQuota delivery={null} metric={metric} onRetry={() => {}} />)
    expect(screen.getByText('197')).toBeTruthy()
    view.rerender(<SendQuota delivery={null} metric={{ ...metric, value: { used: 200, limit: 200, remaining: 0 } }} onRetry={() => {}} />)
    expect(screen.getByText('0')).toBeTruthy()
    const chartCss = readFileSync(join(__dirname, '../../components/shared/bar-chart.module.css'), 'utf8')
    expect(chartCss).toMatch(/\.axisLabel \{[^}]*text-align: center;/)
  })
})

describe('概要が取れないとき・やり直しの言葉', () => {
  it('送信枠は骨組みのまま待たせず「読み込めませんでした」と「もう一度読み込む」', async () => {
    document.documentElement.dataset.theme = 'v8'
    const { SendQuota } = await import('./sections')
    const onRetry = vi.fn()
    render(<SendQuota overviewFailed delivery={null} metric={undefined} onRetry={onRetry} />)
    expect(screen.getByText(/データを読み込めませんでした/)).toBeTruthy()
    expect(screen.queryByLabelText('送信枠を読み込んでいます')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
