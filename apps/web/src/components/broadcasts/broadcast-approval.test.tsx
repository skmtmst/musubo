// @vitest-environment happy-dom
/*
 * 二者承認の見た目の試験（m12a / 設計 A）。
 *
 * 主な状態を確かめる。空（出すものなし）・読み込み中・失敗・正常。
 * 承認する人にだけ操作を出すことと、自分の依頼には出さないことも見る。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

/*
 * 承認する人の欄は共通 Select（listbox）。ここで見たいのは選んだ後の
 * 承認の判断なので、素の <select> に置き換える。
 */
vi.mock('@/components/shared/select', () => ({
  default: ({ 'aria-label': label, id, value, onChange, options }: {
    'aria-label'?: string
    id?: string
    value: string
    onChange: (value: string) => void
    options: Array<{ value: string; label: string }>
  }) => React.createElement(
    'select',
    { 'aria-label': label, id, value, onChange: (e: { target: { value: string } }) => onChange(e.target.value) },
    options.map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label)),
  ),
}))
import {
  ApprovalBadge,
  ApprovalRequestFields,
  ApprovalStatusSection,
  ApproverSection,
  SingleOperatorFields,
  formatApprovalDateTime,
} from './broadcast-approval'
import type { BroadcastApprovalState } from '@/lib/api'

function render(node: React.ReactElement): { root: Root; host: HTMLElement } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(node)
  })
  return { root, host }
}

function cleanup(rendered: { root: Root; host: HTMLElement }) {
  act(() => {
    rendered.root.unmount()
  })
  rendered.host.remove()
}

function pendingState(overrides: Partial<BroadcastApprovalState['viewer']> = {}): BroadcastApprovalState {
  return {
    approval: {
      status: 'pending',
      requestedByStaffId: 'staff-send',
      requestedAt: '2026-09-25T10:00:00+09:00',
      approverStaffId: 'staff-approve',
      note: '秋の案内です',
      decidedByStaffId: null,
      decidedAt: null,
      rejectReason: null,
      confirmedCount: null,
    },
    gate: {
      required: true,
      recipientCount: 1248,
      threshold: 1000,
      singleOperator: false,
      operatorCount: 2,
    },
    viewer: {
      isApprover: false,
      canApprove: false,
      isRequester: true,
      ...overrides,
    },
  }
}

describe('二者承認の見た目', () => {
  it('一覧の札は承認待ち・期限切れだけ出す（空は出さない）', () => {
    const pending = render(<ApprovalBadge status="pending" />)
    expect(pending.host.textContent).toContain('承認待ち')
    cleanup(pending)

    const expired = render(<ApprovalBadge status="expired" />)
    expect(expired.host.textContent).toContain('期限切れ')
    cleanup(expired)

    for (const status of ['none', 'approved', 'rejected', 'cancelled', undefined] as const) {
      const empty = render(<ApprovalBadge status={status} />)
      expect(empty.host.textContent).toBe('')
      cleanup(empty)
    }
  })

  it('A-1 承認する人の選択・ひとこと・人数が出る', () => {
    const rendered = render(
      <ApprovalRequestFields
        recipientCount={1248}
        threshold={1000}
        candidates={[{ id: 'a1', name: '見本 121', role: 'admin', canApprove: true }]}
        candidatesState="ready"
        approverId=""
        onApproverChange={() => undefined}
        note=""
        onNoteChange={() => undefined}
      />,
    )
    expect(rendered.host.textContent).toContain('承認をお願いする人')
    expect(rendered.host.textContent).toContain('見本 121')
    expect(rendered.host.textContent).toContain('1,248人')
    cleanup(rendered)
  })

  it('A-1 候補の読み込み中・失敗を分けて出す', () => {
    const loading = render(
      <ApprovalRequestFields
        recipientCount={1248}
        threshold={1000}
        candidates={[]}
        candidatesState="loading"
        approverId=""
        onApproverChange={() => undefined}
        note=""
        onNoteChange={() => undefined}
      />,
    )
    expect(loading.host.textContent).toContain('読み込んでいます')
    cleanup(loading)

    const failed = render(
      <ApprovalRequestFields
        recipientCount={1248}
        threshold={1000}
        candidates={[]}
        candidatesState="error"
        approverId=""
        onApproverChange={() => undefined}
        note=""
        onNoteChange={() => undefined}
      />,
    )
    expect(failed.host.textContent).toContain('読み込めませんでした')
    cleanup(failed)
  })

  it('A-2 承認待ちの帯に承認する人の名前と依頼の補足が出る', () => {
    const state = pendingState()
    const rendered = render(
      <ApprovalStatusSection
        approval={state.approval}
        scheduledLabel="10月1日（水）10:00"
        approverName="見本 121"
        requesterName="見本 145"
        viewer={state.viewer}
        onCancel={() => undefined}
        onRemind={() => undefined}
        busy={false}
        message={null}
      />,
    )
    expect(rendered.host.textContent).toContain('見本 121さんの承認を待っています')
    expect(rendered.host.textContent).toContain('依頼：見本 145')
    cleanup(rendered)
  })

  it('A-2 取り消し・もう一度知らせるは頼んだ人にだけ出す', () => {
    const requesterState = pendingState({ isApprover: false, canApprove: false, isRequester: true })
    const requester = render(
      <ApprovalStatusSection
        approval={requesterState.approval}
        scheduledLabel="10月1日（水）10:00"
        approverName="見本 121"
        requesterName="見本 145"
        viewer={requesterState.viewer}
        onCancel={() => undefined}
        onRemind={() => undefined}
        busy={false}
        message={null}
      />,
    )
    expect(requester.host.textContent).toContain('依頼を取り消す')
    expect(requester.host.textContent).toContain('もう一度知らせる')
    cleanup(requester)

    // 承認する人には取り消し・知らせ直しを出さない（両方にはならない）。
    const approverState = pendingState({ isApprover: true, canApprove: true, isRequester: false })
    const approver = render(
      <ApprovalStatusSection
        approval={approverState.approval}
        scheduledLabel="10月1日（水）10:00"
        approverName="見本 121"
        requesterName="見本 145"
        viewer={approverState.viewer}
        onCancel={() => undefined}
        onRemind={() => undefined}
        busy={false}
        message={null}
      />,
    )
    expect(approver.host.textContent).not.toContain('依頼を取り消す')
    expect(approver.host.textContent).not.toContain('もう一度知らせる')
    cleanup(approver)
  })

  it('A-2 差し戻し・期限切れの理由が出る', () => {
    const rejected: BroadcastApprovalState = {
      ...pendingState(),
      approval: { ...pendingState().approval, status: 'rejected', rejectReason: '金額が古い' },
    }
    const rejectedView = render(
      <ApprovalStatusSection
        approval={rejected.approval}
        scheduledLabel={null}
        onCancel={() => undefined}
        onRemind={() => undefined}
        busy={false}
        message={null}
      />,
    )
    expect(rejectedView.host.textContent).toContain('金額が古い')
    cleanup(rejectedView)

    const expired: BroadcastApprovalState = {
      ...pendingState(),
      approval: { ...pendingState().approval, status: 'expired' },
    }
    const expiredView = render(
      <ApprovalStatusSection
        approval={expired.approval}
        scheduledLabel={null}
        onCancel={() => undefined}
        onRemind={() => undefined}
        busy={false}
        message={null}
      />,
    )
    expect(expiredView.host.textContent).toContain('期限切れ')
    cleanup(expiredView)
  })

  it('A-3 承認する人にだけ操作が出る（頼んだ人には出さない）', () => {
    const approverState = pendingState({ isApprover: true, canApprove: true, isRequester: false })
    const approver = render(
      <ApproverSection
        approval={approverState.approval}
        viewer={approverState.viewer}
        requesterName="見本 145"
        recipientCount={1248}
        scheduledLabel="10月1日（水）10:00"
        messageSummary="3通"
        messageHref="#broadcast-content"
        onApprove={() => undefined}
        onReject={() => undefined}
        busy={false}
        message={null}
      />,
    )
    expect(approver.host.textContent).toContain('あなたの確認待ち')
    expect(approver.host.textContent).toContain('承認して送る')
    expect(approver.host.textContent).toContain('差し戻す')
    // 要約（送る相手・送る日時・メッセージの数）が出る。
    expect(approver.host.textContent).toContain('1,248人')
    expect(approver.host.textContent).toContain('10月1日（水）10:00')
    expect(approver.host.textContent).toContain('3通')
    cleanup(approver)

    // 頼んだ人には操作を出さない。
    const requesterState = pendingState()
    const requester = render(
      <ApproverSection
        approval={requesterState.approval}
        viewer={requesterState.viewer}
        requesterName="見本 145"
        recipientCount={1248}
        scheduledLabel="10月1日（水）10:00"
        messageSummary="3通"
        messageHref="#broadcast-content"
        onApprove={() => undefined}
        onReject={() => undefined}
        busy={false}
        message={null}
      />,
    )
    expect(requester.host.textContent).toBe('')
    cleanup(requester)
  })

  it('承認まわりの日時は今年なら年を省く', () => {
    expect(formatApprovalDateTime('2026-09-25T20:10:00+09:00')).toBe('9月25日 20:10')
    expect(formatApprovalDateTime(null)).toBe('—')
    expect(formatApprovalDateTime('壊れた値')).toBe('—')
  })

  it('補足は「？」に入り、本文に重ねて書かない', () => {
    const fields = render(
      <ApprovalRequestFields
        recipientCount={1248}
        threshold={1000}
        candidates={[]}
        candidatesState="ready"
        approverId=""
        onApproverChange={() => undefined}
        note=""
        onNoteChange={() => undefined}
      />,
    )
    expect(fields.host.querySelector('button[aria-label="承認をお願いする人の説明"]')).not.toBeNull()
    expect(fields.host.textContent).not.toContain('自分は選べない')
    // ？を label の中に入れると、ラベルがボタンを指して入力欄との
    // 結びつき（htmlFor・読み上げ）が壊れる。外に置く。
    const approverLabel = fields.host.querySelector('label[for="approval-approver"]')
    expect(approverLabel?.querySelector('button')).toBeNull()
    expect(
      approverLabel?.parentElement?.querySelector('button[aria-label="承認をお願いする人の説明"]'),
    ).not.toBeNull()
    cleanup(fields)

    const count = render(
      <SingleOperatorFields recipientCount={1248} value="" onChange={() => undefined} />,
    )
    expect(count.host.querySelector('button[aria-label="人数の説明"]')).not.toBeNull()
    cleanup(count)

    const approverState = pendingState({ isApprover: true, canApprove: true, isRequester: false })
    const approver = render(
      <ApproverSection
        approval={approverState.approval}
        viewer={approverState.viewer}
        requesterName={null}
        recipientCount={1248}
        scheduledLabel={null}
        messageSummary={null}
        messageHref="#broadcast-content"
        onApprove={() => undefined}
        onReject={() => undefined}
        busy={false}
        message={null}
      />,
    )
    expect(approver.host.querySelector('button[aria-label="承認の依頼の説明"]')).not.toBeNull()
    expect(approver.host.textContent).not.toContain('自分が頼んだ配信は承認できない')
    cleanup(approver)
  })

  it('A-4 人数の一致・不一致が分かる', () => {
    const matched = render(
      <SingleOperatorFields recipientCount={1248} value="1248" onChange={() => undefined} />,
    )
    expect(matched.host.textContent).toContain('人数が合いました')
    cleanup(matched)

    const mismatched = render(
      <SingleOperatorFields recipientCount={1248} value="1247" onChange={() => undefined} />,
    )
    expect(mismatched.host.textContent).toContain('人数が合いません')
    cleanup(mismatched)
  })
})

// 選ぶ物の欄も、保存/API境界の試験では以前のSelectと同じ差し替えにする。
vi.mock('@/components/shared/entity-select', () => import('@/test-utils/entity-select-mock'))
