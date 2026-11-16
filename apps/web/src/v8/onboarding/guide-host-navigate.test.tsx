// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
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
      { key: 'hours', label: '営業時間を決める', href: '/settings/sns?tab=google', done: false },
    ],
    done: 0,
    total: 9,
  },
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: nav.push, replace: vi.fn() }), usePathname: () => nav.path, useSearchParams: () => new URLSearchParams() }))
vi.mock('@/contexts/account-context', () => ({ useOptionalAccount: () => ({ selectedAccountId: 'account-1' }) }))
vi.mock('@/hooks/use-account-style', () => ({ useAccountStyle: () => ({ data: { style: 'restaurant' } }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner' }))
vi.mock('@/v8/dashboard/first-steps', () => ({ useFirstSteps: () => ({ status: 'success', guide: state.guide, summary: state.summary }) }))
/* 重ね表示そのものは guide-overlay-react.test.tsx が見張る。ここは行き先だけ。 */
vi.mock('./guide-overlay', () => ({ GuideOverlay: () => null }))

import { guideEngineStorageKey } from './guide-engine'
import { GuideHost } from './guide-host'

beforeEach(() => {
  nav.push.mockClear()
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
    expect(nav.push).toHaveBeenCalledWith('/settings/sns?tab=google')
  })

  it('始めた直後は勝手に移らない（枠02/02b の行の「ガイドで開く」で入る）', () => {
    nav.path = '/dashboard'
    render(<GuideHost><p>中身</p></GuideHost>)
    expect(nav.push).not.toHaveBeenCalled()
  })

  it('すでにその画面にいる時は移らない', () => {
    const view = render(<GuideHost><p>中身</p></GuideHost>)
    nav.path = '/settings/sns'
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
})
