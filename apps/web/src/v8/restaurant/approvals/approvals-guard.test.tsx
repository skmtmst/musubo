// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'

const fixture = vi.hoisted(() => ({ snapshot: vi.fn(), decideApproval: vi.fn(), role: 'owner' as string | null }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-1', accounts: [] }) }))
vi.mock('@/lib/restaurant-test-api', () => ({ restaurantTestApi: { snapshot: fixture.snapshot, decideApproval: fixture.decideApproval } }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => fixture.role, canManageRole: (role: string | null) => role === 'owner' || role === 'admin' }))
import ApprovalsV8 from './approvals'

const snapshotData = {
  organization: { id: 'org', name: '試験組織' },
  stores: [{ id: 'store', name: '試験店', code: 'S', status: 'active', line_account_id: 'account-1', capacity: 10 }],
  approvals: [
    {
      id: 'apr-1',
      store_id: 'store',
      kind: 'gbp_post',
      title: '春の投稿',
      status: 'pending',
      requested_by: '申請者A',
      review_comment: null,
      created_at: '2026-09-29T09:40:00Z',
      payload_json: JSON.stringify({ postId: 'post-proto' }),
    },
    {
      id: 'apr-2',
      store_id: 'store',
      kind: 'line_message',
      title: 'お礼配信',
      status: 'pending',
      requested_by: '申請者B',
      review_comment: null,
      created_at: '2026-09-29T10:00:00Z',
      payload_json: JSON.stringify({ title: 'お礼', body: 'ご利用ありがとうございます' }),
    },
  ],
  memberships: [],
  reservations: [],
  tables: [],
  inventory: [],
  menuItems: [],
  connectors: [],
  reviews: [],
  posts: [{ id: 'post-proto', post_type: 'toString', title: '投稿見出し', body: '投稿本文' }],
  lineFlows: [],
}

beforeEach(() => {
  fixture.role = verifiedStaffRole('owner')
  fixture.snapshot.mockResolvedValue({ data: snapshotData })
  fixture.decideApproval.mockResolvedValue({ data: { menuChangeStatus: 'applied' } })
})

afterEach(() => {
  cleanup()
  verifiedStaffRole(null)
  vi.resetAllMocks()
})

describe('ApprovalsV8 差し戻し小窓と種別表示の守り', () => {
  it('別の申請の差し戻し小窓を開くと前回の入力理由が残らない', async () => {
    render(<ApprovalsV8 />)
    const buttons = await screen.findAllByRole('button', { name: '差戻し' })
    expect(buttons).toHaveLength(2)

    // 1件目の差し戻し小窓で理由を入力し、キャンセルで閉じる
    fireEvent.click(buttons[0])
    const firstInput = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(firstInput, { target: { value: '1件目の差し戻し理由' } })
    expect(firstInput.value).toBe('1件目の差し戻し理由')
    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))

    // 2件目の差し戻し小窓を開いた時は入力欄が空で送信できない
    fireEvent.click(buttons[1])
    const secondInput = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(secondInput.value).toBe('')
    expect((screen.getByRole('button', { name: '差し戻す' }) as HTMLButtonElement).disabled).toBe(true)

    // 2件目を送信後、再度1件目を開いても2件目の理由が残らない
    fireEvent.change(secondInput, { target: { value: '2件目の差し戻し理由' } })
    fireEvent.click(screen.getByRole('button', { name: '差し戻す' }))
    await waitFor(() => expect(fixture.decideApproval).toHaveBeenCalledWith('account-1', 'apr-2', 'return', '2件目の差し戻し理由'))

    const nextButtons = await screen.findAllByRole('button', { name: '差戻し' })
    fireEvent.click(nextButtons[0])
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
  })

  it('Google投稿の post_type がプロトタイプ名でもクラッシュせず未確認として表示する', async () => {
    render(<ApprovalsV8 />)
    expect(await screen.findByText('春の投稿')).toBeTruthy()
    expect(screen.getByText('種別：種別を確認できません')).toBeTruthy()
    expect(screen.getByText('投稿見出し')).toBeTruthy()
  })
})
