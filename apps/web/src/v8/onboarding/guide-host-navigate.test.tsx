// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
  承認済み Pen /Users/masatosakamoto/Documents/musubo-course-media-upload-20261110.pen
  枠 14 (orKSi) 共通ルール「スキップ→次の手順へ」。
  差し戻し R1: 段をまたいだ時に、その段の画面へ実際に移らないと
  重ね表示の対象が無く、案内が消えて先へ進めない。
*/

const nav = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn(), resolveEntry: vi.fn(), path: '/restaurant-test/tables',
  query: '', entryReady: true, accountId: 'account-1', staffId: 'staff-1' }))
const state = vi.hoisted(() => ({
  guide: { phase: 'active' as string, stepKey: 'attributes' as string | null, procedureIndex: 1, anchor: null, pausedAnchor: null, start: vi.fn(), startAt: vi.fn(), pause: vi.fn(), resume: vi.fn(), reset: vi.fn(), advanceProcedure: vi.fn() },
  summary: {
    steps: [
      { key: 'accounts', label: 'LINEアカウント', href: '/accounts', done: false },
      { key: 'attributes', label: '卓と席を登録する', href: '/restaurant-test/tables', done: false },
      /* 実際の行き先と同じ（first-steps-styles.test.tsx が見張る値）。 */
      { key: 'hours', label: '営業時間を決める', href: '/restaurant-test/google?tab=hours', done: false },
      { key: 'richMenu', label: 'リッチメニューを選ぶ', href: '/?guide=richMenu', done: false },
    ],
    done: 1,
    total: 8,
  },
  dismissed: false as boolean | null,
  options: vi.fn(),
  refresh: vi.fn(),
  reload: vi.fn(),
  markStale: vi.fn(),
  invalidate: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push, replace: nav.replace }), usePathname: () => nav.path, useSearchParams: () => new URLSearchParams(nav.query) }))
vi.mock('@/contexts/account-context', () => ({ useOptionalAccount: () => ({ selectedAccountId: nav.accountId }) }))
vi.mock('@/hooks/use-account-style', () => ({ ACCOUNT_STYLE_UPDATED: 'musubo:account-style-updated', useAccountStyle: () => ({ status: 'ready', data: { style: 'restaurant', styleSelected: true, version: 1 } }) }))
vi.mock('@/lib/staff-role', () => ({ canManageRole: (role: string | null) => role === 'owner', useStaffRole: () => 'owner' }))
vi.mock('@/lib/staff-identity-state', () => ({ readStaffIdentity: () => ({ id: nav.staffId }) }))
vi.mock('@/lib/line-account-entry', () => ({ isLineAccountEntryReady: () => nav.entryReady, subscribeLineAccountEntry: () => () => {}, resolveLineAccountEntry: nav.resolveEntry }))
vi.mock('@/v8/dashboard/public/first-steps-model/index', () => ({
  useFirstSteps: (_account: string | null, _role: string | null, options: unknown) => (state.options(options), {
    status: 'ready',
    guide: state.guide,
    summary: state.summary,
    dismissed: state.dismissed,
    refresh: state.refresh,
    reload: state.reload,
    markStale: state.markStale,
    invalidate: state.invalidate,
  }),
}))
/* 重ね表示そのものは guide-overlay-react.test.tsx が見張る。ここは行き先と引き渡しだけ。 */
vi.mock('./guide-overlay', () => ({ GuideOverlay: ({ active, stepLabel }: { active: boolean; stepLabel: string | null }) => active ? <div data-testid="guide-overlay">{stepLabel}</div> : null }))

import { SetupChip } from '@/components/shell/setup-chip'
import { API_MUTATION_SUCCEEDED } from '@/lib/api/transport/mutation-events'
import { guideEngineStorageKey, writeGuideEngineState } from './guide-engine'
import { GuideHost } from './guide-host'
import { emitGuideSignal } from './guide-signal'

beforeEach(() => {
  nav.push.mockClear()
  state.refresh.mockClear()
  state.reload.mockClear()
  state.markStale.mockClear()
  state.invalidate.mockClear()
  state.options.mockClear()
  state.dismissed = false
  nav.replace.mockClear()
  nav.resolveEntry.mockReset().mockResolvedValue({ destination: 'dashboard' })
  state.guide.startAt.mockClear()
  state.guide.resume.mockClear()
  nav.path = '/restaurant-test/tables'
  nav.query = ''
  nav.entryReady = true
  nav.accountId = 'account-1'
  nav.staffId = 'staff-1'
  state.guide = { ...state.guide, phase: 'active', stepKey: 'attributes', procedureIndex: 1 }
  writeGuideEngineState(nav.accountId, { phase: 'active', stepKey: 'attributes', procedureIndex: 1 }, nav.staffId)
})
afterEach(() => { cleanup(); localStorage.clear() })

describe('案内の入れ物が段の画面へ移る', () => {
  it('段をまたいだら次の段の画面へ移る（最終手順のスキップ後に案内が消えない）', () => {
    const view = render(<GuideHost><p>中身</p></GuideHost>)
    expect(nav.push).not.toHaveBeenCalled()
    state.guide = { ...state.guide, stepKey: 'hours', procedureIndex: 1 }
    view.rerender(<GuideHost><p>中身</p></GuideHost>)
    expect(nav.push).toHaveBeenCalledTimes(1)
    expect(nav.push).toHaveBeenCalledWith('/restaurant-test/google?tab=hours')
  })

  it('接続済みの場合も営業時間の画面で進行する', () => {
    const view = render(<GuideHost><p>中身</p></GuideHost>)
    nav.path = '/restaurant-test/google'
    nav.query = 'tab=hours&mode=weekly&date=2026-11-24'
    state.guide = { ...state.guide, stepKey: 'hours', procedureIndex: 1 }
    view.rerender(<GuideHost><p>中身</p></GuideHost>)
    expect(nav.push).not.toHaveBeenCalled()
  })

  it('未接続で行の「開く」から入った時も、1/2の対象がある画面へ移る', () => {
    nav.path = '/dashboard'
    state.guide = { ...state.guide, stepKey: 'hours', procedureIndex: 1 }
    render(<GuideHost><p>中身</p></GuideHost>)
    expect(nav.push).toHaveBeenCalledWith('/restaurant-test/google?tab=hours')
  })

  it('1/2から2/2へ進むときは同じ営業時間の画面に留まる', () => {
    nav.path = '/restaurant-test/google'
    nav.query = 'tab=hours'
    state.guide = { ...state.guide, stepKey: 'hours', procedureIndex: 1 }
    const view = render(<GuideHost><p>中身</p></GuideHost>)
    state.guide = { ...state.guide, stepKey: 'hours', procedureIndex: 2 }
    view.rerender(<GuideHost><p>中身</p></GuideHost>)
    expect(nav.push).not.toHaveBeenCalled()
  })

  /*
    差し戻し R1c: ダッシュボードで始めると対象が無く、1.5秒で自動停止していた。
    枠14 共通ルール izsr5「『続きから』＝最初の未完了ステップの手順1へ」のとおり、
    始めた直後もその手順の画面まで連れていく。
  */
  it('ダッシュボードで始めた直後も、その手順の画面へ連れていく', () => {
    nav.path = '/dashboard'
    render(<GuideHost><p>中身</p></GuideHost>)
    expect(nav.push).toHaveBeenCalledWith('/restaurant-test/tables')
  })

  it('同じ居場所では繰り返し移らない', () => {
    nav.path = '/dashboard'
    const view = render(<GuideHost><p>中身</p></GuideHost>)
    view.rerender(<GuideHost><p>中身</p></GuideHost>)
    expect(nav.push).toHaveBeenCalledTimes(1)
  })

  it('すでにその画面にいる時は移らない', () => {
    const view = render(<GuideHost><p>中身</p></GuideHost>)
    nav.path = '/restaurant-test/google'
    nav.query = 'tab=hours'
    state.guide = { ...state.guide, stepKey: 'hours', procedureIndex: 1 }
    view.rerender(<GuideHost><p>中身</p></GuideHost>)
    expect(nav.push).not.toHaveBeenCalled()
  })

  it('Googleビジネスで別のタブを表示中なら営業時間タブを開く', () => {
    nav.path = '/restaurant-test/google'
    nav.query = 'tab=reviews'
    state.guide = { ...state.guide, stepKey: 'hours', procedureIndex: 2 }
    render(<GuideHost><p>中身</p></GuideHost>)
    expect(nav.push).toHaveBeenCalledWith('/restaurant-test/google?tab=hours')
  })

  it('共通の入口は同じ段の一時停止から再開し、手順を最初に戻さない', () => {
    nav.path = '/'
    nav.query = 'guide=richMenu'
    state.guide = { ...state.guide, phase: 'paused', stepKey: 'richMenu' }
    render(<GuideHost><p>中身</p></GuideHost>)
    expect(state.guide.resume).toHaveBeenCalledOnce()
    expect(state.guide.startAt).not.toHaveBeenCalled()
    expect(nav.replace).toHaveBeenCalledWith('/')
  })

  it('一時停止中は移らない', () => {
    const view = render(<GuideHost><p>中身</p></GuideHost>)
    state.guide = { ...state.guide, phase: 'paused', stepKey: 'hours', procedureIndex: 1 }
    view.rerender(<GuideHost><p>中身</p></GuideHost>)
    expect(nav.push).not.toHaveBeenCalled()
  })

  it('保存ごとに札とガイドを消さず裏で読み直し、接続確認の合図とも二重発火しない', async () => {
    nav.path = '/accounts'
    nav.entryReady = false
    state.guide = { ...state.guide, stepKey: 'accounts' }
    writeGuideEngineState(nav.accountId, { phase: 'active', stepKey: 'accounts', procedureIndex: 1 }, nav.staffId)
    render(<GuideHost><SetupChip /></GuideHost>)
    await waitFor(() => expect(nav.resolveEntry).toHaveBeenCalledExactlyOnceWith(nav.accountId))
    await act(async () => {})
    vi.useFakeTimers()
    try {
      expect(screen.getByRole('link', { name: '開店準備 1/8。はじめの設定を開く' })).toBeTruthy()
      expect(screen.getByTestId('guide-overlay').textContent).toBe('LINEアカウント')

      act(() => {
        window.dispatchEvent(new CustomEvent(API_MUTATION_SUCCEEDED, { detail: { accountId: 'account-1' } }))
      })
      expect(state.invalidate).not.toHaveBeenCalled()
      expect(state.reload).not.toHaveBeenCalled()
      expect(state.markStale).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('link', { name: '開店準備 1/8。はじめの設定を開く' })).toBeTruthy()
      expect(screen.getByTestId('guide-overlay').textContent).toBe('LINEアカウント')

      act(() => { vi.advanceTimersByTime(500) })
      expect(state.refresh).toHaveBeenCalledTimes(1)
      expect(state.reload).not.toHaveBeenCalled()

      act(() => {
        window.dispatchEvent(new CustomEvent(API_MUTATION_SUCCEEDED, { detail: { accountId: 'account-1' } }))
        emitGuideSignal('accounts.connection', 'account-1')
      })
      expect(state.refresh).toHaveBeenCalledTimes(2)
      act(() => { vi.advanceTimersByTime(600) })
      expect(state.refresh).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('登録状態の照合が済んでから案内する', () => {
    nav.path = '/'
    nav.entryReady = false
    const view = render(<GuideHost><p>中身</p></GuideHost>)
    expect(nav.push).not.toHaveBeenCalled()
    nav.entryReady = true
    view.rerender(<GuideHost><p>中身</p></GuideHost>)
    expect(nav.push).toHaveBeenCalledWith('/restaurant-test/tables')
  })

  it('設定画面では登録確認後に札の進捗を読み、ガイドを自動で開かない', async () => {
    nav.path = '/settings'
    nav.entryReady = false
    render(<GuideHost><SetupChip /></GuideHost>)
    await waitFor(() => expect(nav.resolveEntry).toHaveBeenCalledWith(nav.accountId))
    await waitFor(() => expect(state.options).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true })))
    expect(screen.getByRole('link', { name: '開店準備 1/8。はじめの設定を開く' })).toBeTruthy()
    expect(screen.queryByTestId('guide-overlay')).toBeNull()
    expect(nav.push).not.toHaveBeenCalled()
  })

  it('接続の案内中だけアカウント一覧で対象を確認し、同じアカウントの成功後は次の段へ移る', async () => {
    nav.path = '/accounts'
    nav.entryReady = false
    state.guide = { ...state.guide, stepKey: 'accounts' }
    writeGuideEngineState(nav.accountId, { phase: 'active', stepKey: 'accounts', procedureIndex: 1 }, nav.staffId)
    const view = render(<GuideHost><p>中身</p></GuideHost>)
    await waitFor(() => expect(nav.resolveEntry).toHaveBeenCalledExactlyOnceWith(nav.accountId))
    await act(async () => {})
    act(() => emitGuideSignal('accounts.connection', 'account-2'))
    expect(state.refresh).not.toHaveBeenCalled()
    act(() => emitGuideSignal('accounts.connection', nav.accountId))
    expect(state.refresh).toHaveBeenCalledOnce()
    state.guide = { ...state.guide, stepKey: 'richMenu' }
    act(() => writeGuideEngineState(nav.accountId, { phase: 'active', stepKey: 'richMenu', procedureIndex: 1 }, nav.staffId))
    view.rerender(<GuideHost><p>中身</p></GuideHost>)
    expect(nav.push).toHaveBeenCalledExactlyOnceWith('/')
    expect(nav.resolveEntry).toHaveBeenCalledOnce()
  })

  it('他の担当者の接続案内を使わず、登録未完了のアカウントを案内しない', async () => {
    nav.path = '/accounts'
    nav.entryReady = false
    state.guide = { ...state.guide, stepKey: 'accounts' }
    writeGuideEngineState(nav.accountId, { phase: 'active', stepKey: 'accounts', procedureIndex: 1 }, 'staff-2')
    const view = render(<GuideHost><p>中身</p></GuideHost>)
    expect(nav.resolveEntry).not.toHaveBeenCalled()
    nav.resolveEntry.mockResolvedValueOnce({ destination: 'registration', href: '/accounts/new?resume=account-1' })
    nav.staffId = 'staff-2'
    view.rerender(<GuideHost><p>中身</p></GuideHost>)
    await act(async () => {})
    expect(nav.resolveEntry).toHaveBeenCalledExactlyOnceWith(nav.accountId)
    act(() => emitGuideSignal('accounts.connection', nav.accountId))
    expect(state.refresh).not.toHaveBeenCalled()
    expect(nav.push).not.toHaveBeenCalled()
    expect(nav.replace).not.toHaveBeenCalled()
  })

  it('対象を切り替えたら古いアカウントの確認結果で案内しない', async () => {
    nav.path = '/accounts'
    nav.entryReady = false
    state.guide = { ...state.guide, stepKey: 'accounts' }
    writeGuideEngineState(nav.accountId, { phase: 'active', stepKey: 'accounts', procedureIndex: 1 }, nav.staffId)
    let resolveOld: (value: { destination: 'dashboard' }) => void = () => {}
    nav.resolveEntry.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
    const view = render(<GuideHost><p>中身</p></GuideHost>)
    expect(nav.resolveEntry).toHaveBeenCalledExactlyOnceWith('account-1')
    nav.accountId = 'account-2'
    view.rerender(<GuideHost><p>中身</p></GuideHost>)
    await act(async () => { resolveOld({ destination: 'dashboard' }) })
    act(() => emitGuideSignal('accounts.connection', nav.accountId))
    expect(state.refresh).not.toHaveBeenCalled()
    expect(nav.resolveEntry).toHaveBeenCalledOnce()
    expect(nav.push).not.toHaveBeenCalled()
  })
})


it.each(['close', 'escape', 'later'])('リッチメニューの%sは同じ手順を一時停止する', (method) => {
  nav.path = '/'
  state.guide = { ...state.guide, phase: 'active', stepKey: 'richMenu', pause: vi.fn(), advanceProcedure: vi.fn() }
  render(<GuideHost><p>中身</p></GuideHost>)
  const dialog = screen.getByRole('dialog', { name: /リッチメニューを選ぶ/ })
  if (method === 'close') fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
  else if (method === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
  else fireEvent.click(screen.getByRole('button', { name: 'あとで' }))
  expect(dialog).toBeTruthy()
  expect(state.guide.pause).toHaveBeenCalledOnce()
  expect(state.guide.advanceProcedure).not.toHaveBeenCalled()
})
