import { queryPageAction, querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * ★V8 （詳細の下書きの頭出し）。
 * 下書きには「テストを送る」が出て、押すとテスト送信の口を呼ぶ。
 * 送った後・予約には出さない（送る相手が決まっているものは予約完了・詳細の流れを使う）。
 */
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import BroadcastDetailV8 from '@/v8/broadcast-detail/detail'
import { api, type ApiBroadcast } from '@/lib/api'
import type { StaffMember } from '@line-crm/shared'
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual }
})
vi.mock('@/components/shared/toast', () => ({ ...(() => { const notifyToast = vi.fn(); return { notifyToast, notifySaved: notifyToast } })() }))
const navigation = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock('next/navigation', async () => ({
  ...(await import('@/test-utils/navigation-mock')).navigationMock(),
  useRouter: () => ({ push: navigation.push }),
}))
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => <a {...props}>{children}</a> }))

const draft = {
  id: 'b1',
  title: '未購入者フォロー',
  status: 'draft',
  draftStep: 'message',
  messageContent: 'まだご購入いただいていない方へ',
  totalCount: 18,
  successCount: 0,
  scheduledAt: null,
  sentAt: null,
} as unknown as ApiBroadcast

const baseProps = {
  broadcast: draft,
  insight: null,
  insightState: 'ready' as const,
  audienceLabel: '条件なし',
  accountName: 'LINE公式アカウント',
  tab: 'overview' as const,
  onSelectTab: () => {},
  onExportCsv: () => {},
  onReload: () => {},
  canEdit: true,
  contentRef: { current: null } as React.RefObject<HTMLElement | null>,
  approval: {
    state: null,
    busy: false,
    message: null,
    requesterName: null,
    approverName: null,
    candidates: [],
    messageSummary: null,
    canReRequest: false,
    reApproverId: '',
    reApprovalNote: '',
    onApproverChange: () => {},
    onNoteChange: () => {},
    onRequest: () => {},
    onCancel: () => {},
    onRemind: () => {},
    onReject: () => {},
    onApprove: () => {},
  },
}

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  navigation.push.mockClear()
  rememberStaffIdentity({ role: 'owner', permissionKeys: [] } as unknown as StaffMember)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  forgetStaffIdentity()
  vi.restoreAllMocks()
})

describe('詳細の下書きのテスト送信（Q28Gb）', () => {
  it('下書きには「テストを送る」が出て、押すと口を呼ぶ', async () => {
    const testSend = vi.spyOn(api.broadcasts, 'testSend').mockResolvedValue({ success: true, sent: 1, failed: 0 })
    act(() => {
      root.render(<BroadcastDetailV8 {...baseProps} />)
    })
    const button = (Array.from(host.querySelectorAll('button')).find((el) => el.textContent === 'テストを送る') ?? querySupplementaryPageAction('テストを送る'))
    expect(button).toBeDefined()
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(testSend).toHaveBeenCalledWith('b1')
  })

  it('送った後には「テストを送る」が出ない', () => {
    act(() => {
      root.render(<BroadcastDetailV8 {...baseProps} broadcast={{ ...draft, status: 'sent' } as unknown as ApiBroadcast} />)
    })
    expect(
      (Array.from(host.querySelectorAll('button')).find((el) => el.textContent === 'テストを送る') ?? querySupplementaryPageAction('テストを送る')),
    ).toBeUndefined()
  })
})

describe('配信の訂正', () => {
  it('詳細を開いている間の再試行には同じキーを使う', async () => {
    const create = vi.spyOn(api.broadcasts, 'createCorrection').mockResolvedValue({ success: false, error: '再試行してください' })
    act(() => root.render(<BroadcastDetailV8 {...baseProps} broadcast={{ ...draft, status: 'sent' }} />))
    for (let i = 0; i < 2; i++) {
      const item = queryPageAction({ name: '訂正を送る' })
      expect(item).toBeTruthy()
      await act(async () => { item!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    }
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[0][1]).toBe(create.mock.calls[1][1])
  })
  it.each(['scheduled','sending'] as const)('既存の%s訂正は詳細を開く', async status => {
    vi.spyOn(api.broadcasts, 'createCorrection').mockResolvedValue({ success: true, data: { id: 'correction-1', status } })
    act(() => root.render(<BroadcastDetailV8 {...baseProps} broadcast={{ ...draft, status: 'sent' }} />))
    const item = queryPageAction({ name: '訂正を送る' })
    await act(async () => { item!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(navigation.push).toHaveBeenCalledWith('/broadcasts/detail?id=correction-1')
  })
  it('元の配信に訂正の下書きへのリンクを表示する', () => {
    act(() => root.render(<BroadcastDetailV8 {...baseProps} broadcast={{ ...draft, status: 'sent', correction: { id: 'correction-1', status: 'draft' } }} />))
    expect(host.textContent).toContain('訂正あり')
    expect(host.querySelector('a[href="/broadcasts/new?draft=correction-1"]')).not.toBeNull()
  })
  it('閲覧のみでは訂正を押せず、下書きには操作がない', () => {
    act(() => root.render(<BroadcastDetailV8 {...baseProps} canEdit={false} broadcast={{ ...draft, status: 'sent' }} />))
    expect((queryPageAction({ name: '訂正を送る' }) as HTMLButtonElement).disabled).toBe(true)
    act(() => root.render(<BroadcastDetailV8 {...baseProps} broadcast={draft} />))
    expect(queryPageAction({ name: '訂正を送る' })).toBeNull()
  })
})
