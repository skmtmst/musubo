// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/*
  承認済み Pen /Users/masatosakamoto/Documents/musubo-course-media-upload-20261110.pen
  枠 14 (orKSi) 共通ルール「スキップ→次の手順へ」。
  差し戻し R1: 段をまたいだ時に、その段の画面へ実際に移らないと
  重ね表示の対象が無く、案内が消えて先へ進めない。
*/

const nav = vi.hoisted(() => ({ push: vi.fn(), path: '/restaurant-test/tables' }))
const state = vi.hoisted(() => ({
  guide: { phase: 'active' as string, stepKey: 'attributes' as string | null, procedureIndex: 1, anchor: null, pausedAnchor: null, start: vi.fn(), pause: vi.fn(), resume: vi.fn(), reset: vi.fn(), advanceProcedure: vi.fn() },
  summary: {
    steps: [
      { key: 'attributes', label: '卓と席を登録する', href: '/restaurant-test/tables', done: false },
      /* 実際の行き先と同じ（first-steps-styles.test.tsx が見張る値）。 */
      { key: 'hours', label: '営業時間を決める', href: '/restaurant-test/google?tab=hours', done: false },
    ],
    done: 1,
    total: 8,
  },
  dismissed: false as boolean | null,
  refresh: vi.fn(),
  reload: vi.fn(),
  markStale: vi.fn(),
  invalidate: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push, replace: vi.fn() }), usePathname: () => nav.path, useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useOptionalAccount: () => ({ selectedAccountId: 'account-1' }) }))
vi.mock('@/hooks/use-account-style', () => ({ ACCOUNT_STYLE_UPDATED: 'musubo:account-style-updated', useAccountStyle: () => ({ status: 'ready', data: { style: 'restaurant' } }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner' }))
vi.mock('@/v8/dashboard/public/first-steps-model/index', () => ({
  useFirstSteps: () => ({
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
import { guideEngineStorageKey } from './guide-engine'
import { GuideHost } from './guide-host'
import { emitGuideSignal } from './guide-signal'

beforeEach(() => {
  nav.push.mockClear()
  state.refresh.mockClear()
  state.reload.mockClear()
  state.markStale.mockClear()
  state.invalidate.mockClear()
  state.dismissed = false
  nav.path = '/restaurant-test/tables'
  state.guide = { ...state.guide, phase: 'active', stepKey: 'attributes', procedureIndex: 1 }
  localStorage.setItem(guideEngineStorageKey('account-1'), JSON.stringify({ phase: 'active', stepKey: 'attributes', procedureIndex: 1 }))
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
    state.guide = { ...state.guide, stepKey: 'hours', procedureIndex: 1 }
    view.rerender(<GuideHost><p>中身</p></GuideHost>)
    expect(nav.push).not.toHaveBeenCalled()
  })

  it('一時停止中は移らない', () => {
    const view = render(<GuideHost><p>中身</p></GuideHost>)
    state.guide = { ...state.guide, phase: 'paused', stepKey: 'hours', procedureIndex: 1 }
    view.rerender(<GuideHost><p>中身</p></GuideHost>)
    expect(nav.push).not.toHaveBeenCalled()
  })

  it('保存ごとに札とガイドを消さず裏で読み直し、接続確認の合図とも二重発火しない', () => {
    vi.useFakeTimers()
    try {
      render(<GuideHost><SetupChip /></GuideHost>)
      expect(screen.getByRole('link', { name: '開店準備 1/8。はじめの設定を開く' })).toBeTruthy()
      expect(screen.getByTestId('guide-overlay').textContent).toBe('卓と席を登録する')

      act(() => {
        window.dispatchEvent(new CustomEvent(API_MUTATION_SUCCEEDED, { detail: { accountId: 'account-1' } }))
      })
      expect(state.invalidate).not.toHaveBeenCalled()
      expect(state.reload).not.toHaveBeenCalled()
      expect(state.markStale).toHaveBeenCalledTimes(1)
      expect(screen.getByRole('link', { name: '開店準備 1/8。はじめの設定を開く' })).toBeTruthy()
      expect(screen.getByTestId('guide-overlay').textContent).toBe('卓と席を登録する')

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
})
