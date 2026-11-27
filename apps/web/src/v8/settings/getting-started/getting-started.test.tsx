// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ stepState: 'done' as 'done' | 'todo' | 'forbidden', style: 'standard' as import('@line-crm/shared').AccountStyle, progressStyle: null as import('@line-crm/shared').AccountStyle | null, role: 'owner' as string | null, allowed: true, progressStatus: 'ready' as 'ready' | 'loading' | 'idle', revalidating: false, revalidationError: null as unknown, progressRevalidationError: null as unknown, reload: vi.fn(), progressReload: vi.fn(), account: 'a' as string | null, runEnabled: vi.fn() }))
vi.mock('@/hooks/use-account-style', async original => ({ ...await original<typeof import('@/hooks/use-account-style')>(), useAccountStyle: () => ({ status: 'ready', data: { style: state.style }, error: null, stale: false, reload: vi.fn() }) }))
vi.mock('@/v8/onboarding/public/style-setup-progress/index', () => ({ useStyleSetupProgress: () => ({ status: state.progressStatus, revalidating: state.revalidating, revalidationError: state.progressRevalidationError, progress: state.progressStatus === 'idle' ? undefined : { style: state.progressStyle ?? state.style, steps: { attributes: { complete: false }, friendAdd: { complete: true }, scenario: { complete: null, reason: '受付の設定を確認できていません' } } }, reload: state.progressReload }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: state.account, loading: false }) }))
vi.mock('@/lib/staff-role', async (original) => ({
  ...await original<typeof import('@/lib/staff-role')>(),
  useStaffRole: () => state.role,
  useStaffIdentity: () => ({ id: 'u07-test', role: state.role, readOnly: state.role === 'viewer' }),
}))
vi.mock('@/components/layout/settings-inner-nav', () => ({ default: () => null }))
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/v8/onboarding/use-first-run', async () => {
  const { buildStepsFromApi } = await import('./steps')
  return { useFirstRun: (_account: string | null, enabled: boolean) => (state.runEnabled(enabled), { status: 'ready', revalidating: state.revalidating, revalidationError: state.revalidationError, error: null, reload: state.reload, steps: buildStepsFromApi(['accounts', 'featureSet', 'attributes', 'friendAdd', 'scenario', 'firstMessage'].map((key) => ({ key, state: state.stepState, href: state.allowed ? '/' : null, reason: null }))) }) }
})
import GettingStarted from './getting-started'
beforeEach(() => { state.reload.mockClear(); state.progressReload.mockClear(); state.role = 'owner'; state.allowed = true; state.style = 'standard'; state.progressStyle = null; state.stepState = 'done'; state.progressStatus = 'ready'; state.revalidating = false; state.revalidationError = null; state.progressRevalidationError = null; state.account = 'a'; state.runEnabled.mockClear() })
afterEach(cleanup)

it('送信せずに2つの確認経路へ案内し、受信後の読み直しを置く', () => {
  render(<GettingStarted />)
  expect(screen.getByRole('link', { name: '友だち追加のQRを開く' }).getAttribute('href')).toBe('/?qr=base')
  expect(screen.getByRole('link', { name: 'シナリオを選んでテスト送信する' }).getAttribute('href')).toBe('/scenarios')
  const card = screen.getByRole('region', { name: '最初の1通の確認方法' })
  const reload = within(card).getByRole('button', { name: '受信後に状態を読み直す' })
  expect(reload.textContent).toBe('読み直す')
  expect(reload.closest('[data-design-node="t0jk8p"]')?.contains(within(card).getByRole('heading', { name: '最初の1通の確認方法' }))).toBe(true)
  expect(card.querySelectorAll('p')).toHaveLength(1)
  expect(within(card).queryByText(/送らずに判定するテスト/)).toBeNull()
  fireEvent.click(within(card).getByRole('button', { name: '最初の1通の判定と確認方法' }))
  expect(within(card).getByRole('note').textContent).toContain('送らずに判定するテストと受信箱の手動返信は完了に数えません')
  expect(state.reload).not.toHaveBeenCalled()
  fireEvent.click(reload)
  expect(state.reload).toHaveBeenCalledTimes(1)
})
it('閲覧のみ・送信権限のない人にも入口を灰色のボタンで残し、移動させない', () => {
  state.role = 'viewer'
  const { unmount } = render(<GettingStarted />)
  for (const label of ['友だち追加のQRを開く', 'シナリオを選んでテスト送信する']) {
    expect(screen.queryByRole('link', { name: label })).toBeNull()
    const button = screen.getByRole('button', { name: label })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(button.hasAttribute('href')).toBe(false)
    const reason = document.getElementById(button.getAttribute('aria-describedby')!)?.textContent
    expect(reason).toMatch(/閲覧|権限/)
    fireEvent.click(button)
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(state.reload).not.toHaveBeenCalled()
  }
  unmount()
  state.role = 'owner'; state.allowed = false
  render(<GettingStarted />)
  for (const label of ['友だち追加のQRを開く', 'シナリオを選んでテスト送信する']) {
    expect(screen.queryByRole('link', { name: label })).toBeNull()
    const button = screen.getByRole('button', { name: label })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('disabled')).toBe(false)
    expect(button.hasAttribute('href')).toBe(false)
    const reason = document.getElementById(button.getAttribute('aria-describedby')!)?.textContent
    expect(reason).toMatch(/閲覧|権限/)
    fireEvent.click(button)
    fireEvent.keyDown(button, { key: 'Enter' })
    expect(state.reload).not.toHaveBeenCalled()
  }
})
it('板の印を付け、順路は名前の付いた表で読める', () => {
  const { container } = render(<GettingStarted />)
  expect(container.querySelector('[data-design-node="xuJ7D"]')).not.toBeNull()
  expect(screen.getByRole('table', { name: 'はじめの設定の順路' })).toBeTruthy()
})


it.each([
  ['restaurant', '卓と席を登録する'], ['salon', 'メニューを登録する'], ['consult', '面談の枠を作る'], ['lesson', 'クラスを作る'], ['ec', 'ストアをつなぐ'],
] as const)('%sは旧配信が済みでも実設定の未完了と未確認を出す', (style, title) => {
  state.style = style
  render(<GettingStarted />)
  expect(screen.getByText(title).closest('[role="row"]')?.getAttribute('data-step-state')).toBe('todo')
  expect(screen.getAllByText(/受付の設定を確認できていません/).length).toBeGreaterThan(0)
})


it.each(['viewer', 'staff'])('%sの未完了の段は灰色の入口を残す', role => {
  state.role = role
  state.allowed = false
  state.stepState = 'forbidden'
  const { container } = render(<GettingStarted />)
  const rows = [...container.querySelectorAll('[data-step-state="forbidden"]')]
  expect(rows).toHaveLength(7)
  for (const row of rows) {
    const button = row.querySelector('button')!
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.hasAttribute('href')).toBe(false)
    expect(button.hasAttribute('disabled')).toBe(false)
    fireEvent.click(button)
  }
})


it('権限が未確認の間は段の操作を押せないボタンにし、リンク先を持たせない', () => {
  state.role = null
  state.stepState = 'todo'
  const { container } = render(<GettingStarted />)
  const rows = [...container.querySelectorAll('[data-step-state="todo"]')]
  expect(rows).toHaveLength(6)
  for (const row of rows) {
    expect(row.querySelector('a')).toBeNull()
    const button = row.querySelector('button')!
    expect(button.hasAttribute('disabled')).toBe(true)
    expect(button.hasAttribute('href')).toBe(false)
    fireEvent.click(button)
  }
  expect(screen.queryByRole('link', { name: 'シナリオを選んでテスト送信する' })).toBeNull()
})

it('店舗の完了判定を確認するまで暫定の済み数を表示しない', () => {
  state.style = 'restaurant'
  state.progressStatus = 'loading'
  const view = render(<GettingStarted />)
  expect(screen.queryByText(/\d+ \/ 8 済み/)).toBeNull()
  state.progressStatus = 'ready'
  view.rerender(<GettingStarted />)
  expect(screen.getByText(/\d+ \/ 8 済み/)).toBeTruthy()
})

it('一時停止したガイドを設定画面から再開する', async () => {
  const { GuideSharedProvider } = await import('@/v8/onboarding/public/guide-shared/index')
  const resume = vi.fn()
  const guide = { phase:'paused' as const, stepKey:null, procedureIndex:1, anchor:null, pausedAnchor:null, start:vi.fn(), pause:vi.fn(), resume, reset:vi.fn(), advanceProcedure:vi.fn() }
  render(<GuideSharedProvider value={{ guide, summary:null }}><GettingStarted /></GuideSharedProvider>)
  fireEvent.click(screen.getByRole('button', { name:'ガイドを再開' }))
  expect(resume).toHaveBeenCalledOnce()
})

it('アカウントがない場合は共通の未取得状態を使わず設定を読み込む', async () => {
  state.account = null
  const { GuideSharedProvider } = await import('@/v8/onboarding/public/guide-shared/index')
  const value = { guide: { phase: 'idle' }, summary: null, setup: { accountId: null, run: { status: 'loading' }, progress: { status: 'loading' }, setWatch: vi.fn() } }
  render(<GuideSharedProvider value={value as never}><GettingStarted /></GuideSharedProvider>)
  expect(state.runEnabled).toHaveBeenCalledWith(true)
  expect(screen.getByRole('table', { name: 'はじめの設定の順路' })).toBeTruthy()
})

it('最初の未完了だけに次の札と主ボタンを出す', () => {
  state.stepState = 'todo'
  render(<GettingStarted />)
  const table = screen.getByRole('table', { name: 'はじめの設定の順路' })
  const badge = within(table).getByText('次はここ')
  const row = badge.closest('[role="row"]')!
  expect(row.getAttribute('data-step-state')).toBe('todo')
  expect(within(table).getAllByText('次はここ')).toHaveLength(1)
  expect(row.querySelector('[data-variant="primary"]')).not.toBeNull()
  expect(table.querySelectorAll('[data-variant="primary"]')).toHaveLength(1)
})

it('権限がない最初の段は緑の操作可能なボタンにしない', () => {
  state.role = 'viewer'
  state.allowed = false
  state.stepState = 'forbidden'
  render(<GettingStarted />)
  const table = screen.getByRole('table', { name: 'はじめの設定の順路' })
  expect(within(table).queryByText('次はここ')).toBeNull()
  expect(table.querySelector('[data-variant="primary"]')).toBeNull()
})

it('状態を確認できない最初の段も開けるなら次に案内する', () => {
  render(<GettingStarted />)
  const row = screen.getByText('次はここ').closest('[role="row"]')!
  expect(row.getAttribute('data-step-state')).toBe('unknown')
  expect(row.textContent).toContain('営業時間を決める')
  expect(row.querySelector('[data-variant="primary"]')).not.toBeNull()
})

it.each(['viewer', null])('権限が %s のときは次の操作を勧めない', role => {
  state.role = role
  state.stepState = 'todo'
  render(<GettingStarted />)
  expect(screen.queryByText('次はここ')).toBeNull()
})

it('進み具合を読み込み中は次の段を推測しない', () => {
  state.style = 'restaurant'
  state.progressStatus = 'loading'
  render(<GettingStarted />)
  expect(screen.queryByText('次はここ')).toBeNull()
})

it('停止中の段と手順を再開ボタンのそばに示す', async () => {
  state.style = 'restaurant'
  const { GuideSharedProvider } = await import('@/v8/onboarding/public/guide-shared/index')
  const resume = vi.fn()
  const guide = { phase:'paused' as const, stepKey:'attributes', procedureIndex:2, anchor:null, pausedAnchor:null, start:vi.fn(), pause:vi.fn(), resume, reset:vi.fn(), advanceProcedure:vi.fn() }
  render(<GuideSharedProvider value={{ guide, summary:null }}><GettingStarted /></GuideSharedProvider>)
  const notice = screen.getByText('③ 卓と席を登録する・手順 2/3で停止中').closest('[data-design-part="notice"]')!
  expect(notice.getAttribute('data-action-layout')).toBe('stack-on-narrow')
  fireEvent.click(screen.getByRole('button', { name:'ガイドを再開' }))
  expect(resume).toHaveBeenCalledOnce()
})

it('業種進捗がidleまたは別業種の間は暫定の済み数や次の札を出さない', () => {
  state.style = 'restaurant'
  state.progressStatus = 'idle'
  const view = render(<GettingStarted />)
  expect(screen.queryByText(/\d+ \/ 8 済み/)).toBeNull()
  expect(screen.queryByText('次はここ')).toBeNull()

  state.progressStatus = 'ready'
  state.progressStyle = 'salon'
  view.rerender(<GettingStarted />)
  expect(screen.queryByText(/\d+ \/ 8 済み/)).toBeNull()

  state.progressStyle = 'restaurant'
  view.rerender(<GettingStarted />)
  expect(screen.getByText(/\d+ \/ 8 済み/)).toBeTruthy()
})

it('保存後の再確認中は札の数を保ったまま、はじめの設定の一覧だけ古い済みを隠す', async () => {
  const { GuideSharedProvider } = await import('@/v8/onboarding/public/guide-shared/index')
  const { SetupChip } = await import('@/components/shell/setup-chip')
  state.revalidating = true
  const guide = { phase:'idle' as const, stepKey:null, procedureIndex:1, anchor:null, pausedAnchor:null, start:vi.fn(), pause:vi.fn(), resume:vi.fn(), reset:vi.fn(), advanceProcedure:vi.fn() }
  const view = render(
    <GuideSharedProvider value={{ guide, dismissed: false, summary: { steps: [], done: 3, total: 6 } }}>
      <SetupChip />
      <GettingStarted />
    </GuideSharedProvider>,
  )
  expect(screen.getByRole('link', { name: '開店準備 3/6。はじめの設定を開く' })).toBeTruthy()
  expect(screen.queryByRole('table', { name: 'はじめの設定の順路' })).toBeNull()

  state.revalidating = false
  view.rerender(
    <GuideSharedProvider value={{ guide, dismissed: false, summary: { steps: [], done: 4, total: 6 } }}>
      <SetupChip />
      <GettingStarted />
    </GuideSharedProvider>,
  )
  expect(screen.getByRole('link', { name: '開店準備 4/6。はじめの設定を開く' })).toBeTruthy()
  expect(screen.getByRole('table', { name: 'はじめの設定の順路' })).toBeTruthy()
})

it('保存後の読み直しが失敗したとき、上の帯の札は直前の数を保ち、一覧は古い済みを戻さずエラーと再試行を出す', async () => {
  const { GuideSharedProvider } = await import('@/v8/onboarding/public/guide-shared/index')
  const { SetupChip } = await import('@/components/shell/setup-chip')
  state.revalidationError = new Error('通信できませんでした')
  const guide = { phase:'idle' as const, stepKey:null, procedureIndex:1, anchor:null, pausedAnchor:null, start:vi.fn(), pause:vi.fn(), resume:vi.fn(), reset:vi.fn(), advanceProcedure:vi.fn() }
  const view = render(
    <GuideSharedProvider value={{ guide, dismissed: false, summary: { steps: [], done: 3, total: 6 } }}>
      <SetupChip />
      <GettingStarted />
    </GuideSharedProvider>,
  )
  /* 上の帯の札は直前の数を維持する */
  expect(screen.getByRole('link', { name: '開店準備 3/6。はじめの設定を開く' })).toBeTruthy()
  /* 一覧は古い「済み」の表を出さず、エラーと［もう一度読み込む］を出す */
  expect(screen.queryByRole('table', { name: 'はじめの設定の順路' })).toBeNull()
  expect(screen.queryByText(/\d+ \/ \d+ 済み/)).toBeNull()
  const retry = screen.getByRole('button', { name: 'もう一度読み込む', exact: true })
  fireEvent.click(retry)
  expect(state.reload).toHaveBeenCalledTimes(1)
  expect(state.progressReload).toHaveBeenCalledTimes(1)

  /* 再試行が成功したら最新の一覧を表示する */
  state.revalidationError = null
  view.rerender(
    <GuideSharedProvider value={{ guide, dismissed: false, summary: { steps: [], done: 2, total: 6 } }}>
      <SetupChip />
      <GettingStarted />
    </GuideSharedProvider>,
  )
  expect(screen.getByRole('link', { name: '開店準備 2/6。はじめの設定を開く' })).toBeTruthy()
  expect(screen.getByRole('table', { name: 'はじめの設定の順路' })).toBeTruthy()
})

it('停止していた段が完了済みなら再開先の未完了段を示し、全完了や別アカウントでは帯を出さない', async () => {
  state.style = 'restaurant'
  const { GuideSharedProvider } = await import('@/v8/onboarding/public/guide-shared/index')
  const baseGuide = { phase:'paused' as const, stepKey:'friendAdd', procedureIndex:2, anchor:{ key:'attributes', label:'卓と席を登録する', href:'/restaurant-test/tables' }, pausedAnchor:{ key:'attributes', label:'卓と席を登録する', href:'/restaurant-test/tables' }, start:vi.fn(), pause:vi.fn(), resume:vi.fn(), reset:vi.fn(), advanceProcedure:vi.fn() }
  const summary = { steps: [{ key:'friendAdd', label:'コースとメニューを登録する', href:'/restaurant-test/menu', done:true }, { key:'attributes', label:'卓と席を登録する', href:'/restaurant-test/tables', done:false }], done:1, total:8 }
  const view = render(<GuideSharedProvider value={{ guide: baseGuide, summary }}><GettingStarted /></GuideSharedProvider>)
  expect(screen.queryByText(/コースとメニューを登録する.*停止中/)).toBeNull()
  expect(screen.getByText('③ 卓と席を登録するから再開できます')).toBeTruthy()

  view.rerender(<GuideSharedProvider value={{ guide: { ...baseGuide, anchor: null, pausedAnchor: null }, summary: { ...summary, done: 8 } }}><GettingStarted /></GuideSharedProvider>)
  expect(screen.queryByRole('button', { name: 'ガイドを再開' })).toBeNull()

  view.rerender(<GuideSharedProvider value={{ guide: baseGuide, summary, setup: { accountId: 'other', run: {} as never, progress: {} as never, setWatch: vi.fn() } }}><GettingStarted /></GuideSharedProvider>)
  expect(screen.queryByRole('button', { name: 'ガイドを再開' })).toBeNull()
})

it('担当者（staff）には管理者専用の［レシピから作る］を灰色＋理由で止め、管理者以上は開ける', () => {
  state.role = 'staff'
  state.stepState = 'todo'
  const { unmount } = render(<GettingStarted />)
  expect(screen.queryByRole('link', { name: 'レシピから作る' })).toBeNull()
  const button = screen.getByRole('button', { name: 'レシピから作る' })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(button.hasAttribute('disabled')).toBe(false)
  expect(button.hasAttribute('href')).toBe(false)
  expect(button.getAttribute('data-variant')).not.toBe('primary')
  const reason = document.getElementById(button.getAttribute('aria-describedby')!)?.textContent
  expect(reason).toBe('この操作はオーナーか管理者だけができます。')
  expect(button.closest('[role="row"]')?.textContent).not.toContain('次はここ')
  unmount()

  state.role = 'admin'
  render(<GettingStarted />)
  expect(screen.getByRole('link', { name: 'レシピから作る' }).getAttribute('href')).toBe('/recipes')
})
