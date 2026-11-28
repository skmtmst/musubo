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

describe('壊れた候補の判定を止める', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    fixture.deciding = false
    rememberStaffIdentity({ id: 'owner', role: 'owner' } as StaffMember)
  })
  afterEach(() => { cleanup(); forgetStaffIdentity() })

  it.each(['evidence', 'impact', 'options'] as const)('%s に null が混じる場合は詳細の読み込み失敗とし、判定を止めて再取得できる', (broken) => {
    const detail = makeDetail()
    if (broken === 'evidence') detail.evidence = [null] as unknown as typeof detail.evidence
    if (broken === 'impact') detail.impact = [null] as unknown as typeof detail.impact
    if (broken === 'options') detail.profileCandidates[0].options = [null] as unknown as typeof detail.profileCandidates[0]['options']
    fixture.detail = detail
    render(<Compare />)
    expect(screen.getByText('候補の詳細を読み込めませんでした')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '同じ人として結び付ける' })).toBeNull()
    expect(screen.queryByRole('button', { name: '別の人だった' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'あとで決める（保留）' })).toBeNull()
    expect(fixture.decide).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
    expect(fixture.reloadDetail).toHaveBeenCalledTimes(1)
  })
})
