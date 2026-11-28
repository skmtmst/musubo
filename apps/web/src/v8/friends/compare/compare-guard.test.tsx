// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IdentityCandidateWithProfiles } from '@/lib/api'
import type { StaffMember } from '@line-crm/shared'
import { forgetStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'

const fixture = vi.hoisted(() => ({
  detail: null as IdentityCandidateWithProfiles | null,
  deciding: false,
  decide: vi.fn(),
  reloadDetail: vi.fn(),
}))

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('id=cand-1') }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/components/identity/identity-review', () => ({
  useIdentityReview: () => ({
    state: 'ready',
    selectedId: 'cand-1',
    items: [],
    detail: fixture.detail,
    deciding: fixture.deciding,
    decide: fixture.decide,
    reloadDetail: fixture.reloadDetail,
  }),
}))

import Compare from './compare'

function makeDetail(overrides: Partial<IdentityCandidateWithProfiles> = {}): IdentityCandidateWithProfiles {
  const subject = (id: string, label: string, lineAccountName: string) => ({
    kind: 'friend' as const,
    id,
    label,
    detail: null,
    lineAccountId: id,
    lineAccountName,
    shopKey: null,
    attributes: [{ label: '電話番号', valuePreview: id === 'left' ? '090-0000-0001' : '090-0000-0002', verified: true }],
  })
  return {
    id: 'cand-1',
    kind: 'friend_duplicate',
    status: 'pending',
    version: 1,
    confidence: { score: 85, label: 'high' },
    left: subject('left', '見本A', '本店'),
    right: subject('right', '見本B', '支店'),
    evidence: [{ key: 'phone', label: '電話番号の一致', strength: 'strong', valuePreview: null }],
    impact: [{ key: 'orders', label: '注文履歴', value: 3, unit: '件', note: null }],
    history: [],
    detectedAt: '2026-11-20T00:00:00Z',
    reviewedAt: null,
    canDecide: true,
    canUndo: false,
    undoNote: '',
    profileCandidates: [
      {
        fieldKey: 'name',
        fieldLabel: '本名',
        options: [
          { candidateId: 'n1', sourceFriendId: 'left', sourceLabel: 'A', valuePreview: '山田 太郎', verified: true },
          { candidateId: 'n2', sourceFriendId: 'right', sourceLabel: 'B', valuePreview: '山田 太郎（旧）', verified: false },
        ],
      },
    ],
    tagCandidates: [],
    ...overrides,
  }
}

describe('CompareV8 ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fixture.deciding = false
    fixture.detail = makeDetail()
    rememberStaffIdentity({ id: 'owner', role: 'owner' } as StaffMember)
  })

  afterEach(() => {
    cleanup()
    forgetStaffIdentity()
  })

  it('影響の件数が不正な数値（NaN等）のときは NaN を出さず「確認できません」と表示する', () => {
    fixture.detail = makeDetail({
      impact: [
        { key: 'broken', label: '注文履歴', value: Number.NaN, unit: '件', note: null },
        { key: 'pending', label: '配信数', value: null, unit: '通', note: null },
      ],
    })
    render(<Compare />)

    expect(screen.getByText('確認できません')).toBeTruthy()
    expect(screen.queryByText(/NaN/)).toBeNull()
    expect(screen.getByText('—（つないだあとに出ます）')).toBeTruthy()
  })

  it('判定の送信中は判定ラジオ・確認チェック・理由入力が操作できない', () => {
    const { rerender } = render(<Compare />)
    fireEvent.click(screen.getByRole('button', { name: '同じ人として結び付ける' }))

    expect((screen.getByLabelText('判定の理由') as HTMLInputElement).disabled).toBe(false)

    fixture.deciding = true
    rerender(<Compare />)

    expect((screen.getByLabelText('判定の理由') as HTMLInputElement).disabled).toBe(true)
    for (const label of ['同じ人', '別の人', '保留']) {
      expect((screen.getByRole('radio', { name: label }) as HTMLInputElement).disabled).toBe(true)
    }
    for (const label of ['利用目的の範囲で結び付ける', '本人の同意（または正当な理由）がある', 'あとで戻せることを知っている']) {
      expect((screen.getByRole('checkbox', { name: label }) as HTMLInputElement).disabled).toBe(true)
    }
  })

  it('判定に必要な配列（profileCandidates・evidence・impact）が壊れているときは読み込み失敗と再読み込みを出し、判定APIを呼ばせない', () => {
    const cases: Array<Partial<IdentityCandidateWithProfiles>> = [
      { profileCandidates: null as unknown as IdentityCandidateWithProfiles['profileCandidates'] },
      { evidence: null as unknown as IdentityCandidateWithProfiles['evidence'] },
      { impact: null as unknown as IdentityCandidateWithProfiles['impact'] },
    ]
    for (const broken of cases) {
      fixture.reloadDetail.mockClear()
      fixture.decide.mockClear()
      fixture.detail = makeDetail(broken)
      render(<Compare />)

      expect(screen.getByText('候補の詳細を読み込めませんでした')).toBeTruthy()
      expect(screen.queryByRole('button', { name: '同じ人として結び付ける' })).toBeNull()
      expect(screen.queryByRole('button', { name: '別の人だった' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'あとで決める（保留）' })).toBeNull()

      fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
      expect(fixture.reloadDetail).toHaveBeenCalledTimes(1)
      expect(fixture.decide).not.toHaveBeenCalled()
      cleanup()
    }
  })

  it('表示専用の配列（history・tagCandidates）が欠けていても画面は落ちずに表示できる', () => {
    fixture.detail = makeDetail({
      history: null as unknown as IdentityCandidateWithProfiles['history'],
      tagCandidates: null as unknown as IdentityCandidateWithProfiles['tagCandidates'],
    })
    render(<Compare />)

    expect(screen.getByRole('heading', { name: '見本A ↔ 見本B' })).toBeTruthy()
  })
})
