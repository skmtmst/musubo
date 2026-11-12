// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { IdentityCandidateWithProfiles } from '@/lib/api'
const fixture = vi.hoisted(() => ({ detail: null as IdentityCandidateWithProfiles | null, decide: vi.fn() }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('id=one') }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/components/identity/identity-review', () => ({ useIdentityReview: () => ({
  state: 'ready', selectedId: 'one', items: [], detail: fixture.detail, deciding: false, decide: fixture.decide,
}) }))
import Compare from './compare'
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
import { expectPermissionLocked } from '@/test-utils/permission-locked-control'
beforeEach(() => rememberStaffIdentity({ id: 'owner', role: 'owner' } as StaffMember))
afterEach(() => { cleanup(); forgetStaffIdentity() })
it('一致項目の非表示でも元の全選択を判定へ渡し、名前と取得元で選べる', () => {
  const subject = (id: string, label: string, lineAccountName: string) => ({ kind: 'friend' as const, id, label, detail: null, lineAccountId: id, lineAccountName, shopKey: null, attributes: [{ label: '会員区分', valuePreview: '一般', verified: true }] })
  fixture.detail = {
    id: 'one', kind: 'friend_duplicate', status: 'pending', version: 1, confidence: { score: 80, label: 'high' },
    left: subject('left', '見本 171', '本店'), right: subject('right', '見本 161', '支店'),
    evidence: [], impact: [], history: [], detectedAt: '2026-10-26T00:00:00Z', reviewedAt: null, canDecide: true, canUndo: false, undoNote: '',
    profileCandidates: [
      { fieldKey: 'name', fieldLabel: '本名', options: ['見本 171', '見本 161'].map((valuePreview, i) => ({ candidateId: `n${i}`, sourceFriendId: i ? 'right' : 'left', sourceLabel: i ? 'B' : 'A', valuePreview, verified: true })) },
      { fieldKey: 'plan', fieldLabel: '会員区分', options: ['一般', '一般'].map((valuePreview, i) => ({ candidateId: `p${i}`, sourceFriendId: i ? 'right' : 'left', sourceLabel: i ? 'B' : 'A', valuePreview, verified: true })) },
    ], tagCandidates: [],
  }
  render(<Compare />)
  expect(screen.queryByLabelText('会員区分に使う値')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '本名に使う値' }))
  fireEvent.click(screen.getByRole('option', { name: '支店・見本 161：見本 161' }).querySelector('button')!)
  fireEvent.click(screen.getByRole('switch', { name: '違う項目だけ' }))
  expect(screen.getByLabelText('会員区分に使う値')).toBeTruthy()
  fireEvent.click(screen.getByRole('switch', { name: '違う項目だけ' }))
  fireEvent.click(screen.getByRole('button', { name: '同じ人として結び付ける' }))
  fireEvent.change(screen.getByLabelText('判定の理由'), { target: { value: '本人に確認しました' } })
  for (const name of ['利用目的の範囲で結び付ける', '本人の同意（または正当な理由）がある', 'あとで戻せることを知っている']) fireEvent.click(screen.getByRole('checkbox', { name }))
  fireEvent.click(screen.getByRole('button', { name: '判定する', exact: true }))
  expect(fixture.decide).toHaveBeenCalledWith({ decision: 'linked', reason: '本人に確認しました', profileSelections: [
    { fieldKey: 'name', sourceFriendId: 'right', updateMode: 'fixed' },
    { fieldKey: 'plan', sourceFriendId: 'left', updateMode: 'fixed' },
  ] })
})

it('閲覧のみは候補を比べられるが、3つの判定は灰色で起動しない', async () => {
  rememberStaffIdentity({ id: 'viewer', role: 'viewer' } as StaffMember)
  fixture.decide.mockClear()
  render(<Compare />)
  for (const name of ['別の人だった', 'あとで決める（保留）', '同じ人として結び付ける']) await expectPermissionLocked(screen.getByRole('button', { name }))
  expect(fixture.decide).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('判定の理由')).toBeNull()
})
