import { querySupplementaryPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
/*
 * V8 一斉配信の詳細・予約したあと（src/v8/broadcast-detail）の動きの試験。BEHAVIOR.md の主な動きを守る。
 * V8 のテーマで表示し、下書きの続き・閲覧のみ（押せないボタンを置かない）・競合の帯・
 * 承認する人の操作・予約の取り消しの窓のボタンの並びを確かめる。
 */
import React, { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://worker.test'
})

const access = vi.hoisted(() => ({ role: 'owner' as string | null }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => access.role }))
const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/broadcasts/detail',
  useSearchParams: () => new URLSearchParams(''),
}))

import BroadcastDetail, { type BroadcastDetailProps } from './detail'
import Reserved, { type ReservedProps } from './reserved'
import { ApiError, api, type ApiBroadcast, type BroadcastApprovalState } from '@/lib/api'
import type { StaffMember } from '@line-crm/shared'
import { rememberStaffIdentity, forgetStaffIdentity } from '@/lib/staff-identity-state'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function broadcast(overrides: Partial<ApiBroadcast> = {}): ApiBroadcast {
  return {
    id: 'broadcast-1',
    title: '未購入者フォロー',
    messageType: 'text',
    messageContent: 'まだご購入いただいていない方へ。',
    targetType: 'all',
    targetTagId: null,
    status: 'draft',
    scheduledAt: null,
    sentAt: null,
    totalCount: 18,
    successCount: 0,
    lineAccountId: 'account-a',
    accountIds: null,
    dedupPriority: null,
    failedAccountIds: null,
    trackLinks: false,
    draftStep: 'message',
    approvalStatus: 'none',
    displayStatus: 'draft',
    displayStatusLabel: '下書き',
    version: 1,
    createdAt: '2026-08-16T00:00:00.000Z',
    ...overrides,
  } as ApiBroadcast
}

function approvalProps(state: BroadcastApprovalState | null = null): BroadcastDetailProps['approval'] {
  return {
    state,
    busy: false,
    message: null,
    requesterName: '見本 121',
    approverName: '見本 110',
    candidates: [],
    messageSummary: null,
    canReRequest: false,
    reApproverId: '',
    reApprovalNote: '',
    onApproverChange: vi.fn(),
    onNoteChange: vi.fn(),
    onRequest: vi.fn(),
    onCancel: vi.fn(),
    onRemind: vi.fn(),
    onReject: vi.fn(),
    onApprove: vi.fn(),
  }
}

function detailProps(overrides: Partial<BroadcastDetailProps> = {}): BroadcastDetailProps {
  return {
    broadcast: broadcast(),
    insight: null,
    insightState: 'ready',
    audienceLabel: '条件なし',
    accountName: '然 - NEN -',
    tab: 'overview',
    onSelectTab: vi.fn(),
    recipients: <p>宛先の中身</p>,
    activity: <p>記録の中身</p>,
    onExportCsv: vi.fn(),
    onReload: vi.fn(),
    canEdit: true,
    contentRef: createRef<HTMLElement>(),
    approval: approvalProps(),
    ...overrides,
  }
}

function reservedProps(overrides: Partial<ReservedProps> = {}): ReservedProps {
  return {
    broadcast: broadcast({
      id: 'broadcast-0', title: '8月キャンペーンのお知らせ', status: 'scheduled', messageType: 'image',
      scheduledAt: '2026-08-24T01:00:00.000Z', displayStatus: 'scheduled', displayStatusLabel: '予約中', draftStep: null,
    }),
    estimate: { audienceCount: 1213, hiddenExcluded: 12, warnings: [] },
    audienceLabel: 'このアカウントの友だち全員',
    approverName: null,
    accountName: '然 - NEN -',
    notificationText: '',
    canEdit: true,
    testSend: vi.fn(),
    duplicate: vi.fn(),
    actionBusy: null,
    actionError: '',
    clearActionError: vi.fn(),
    cancelOpen: false,
    openCancel: vi.fn(),
    closeCancel: vi.fn(),
    confirmCancel: vi.fn(),
    cancelling: false,
    cancelError: '',
    cancelled: false,
    ...overrides,
  }
}

const stored = new Map<string, string>()
Object.defineProperty(window, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, value) },
  removeItem: (key: string) => { stored.delete(key) },
  clear: () => { stored.clear() },
} })
let root: Root
let host: HTMLDivElement

beforeEach(() => {
  access.role = 'owner'
  window.localStorage.clear()
  forgetStaffIdentity()
  document.documentElement.dataset.theme = 'v8'
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  push.mockReset()
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
})

async function render(node: React.ReactNode) {
  await act(async () => { root.render(node) })
  await act(async () => {})
}

const buttons = () => [...document.querySelectorAll('button')] as HTMLButtonElement[]
const buttonText = (text: string) => (buttons().find((button) => button.textContent?.trim() === text) ?? querySupplementaryPageAction(text))
const linkText = (text: string) => ([...document.querySelectorAll('a')].find((a) => a.textContent?.trim() === text) ?? querySupplementaryPageAction(text)) as HTMLAnchorElement | undefined

describe('V8 一斉配信の詳細', () => {
  it('編集できてもテスト送信の鍵が無ければ押し口を隠す', async () => {
    access.role = 'staff'
    rememberStaffIdentity({ role: 'staff', permissionKeys: ['/broadcasts', 'broadcast.definition.edit'] } as StaffMember)
    await render(<BroadcastDetail {...detailProps()} />)
    expect(buttonText('テストを送る')).toBeUndefined()
    rememberStaffIdentity({ role: 'staff', permissionKeys: ['/broadcasts', 'broadcast.definition.edit', 'broadcast.test.send'] } as StaffMember)
    await render(<BroadcastDetail {...detailProps()} />)
    expect(buttonText('テストを送る')).toBeTruthy()
  })

  it('保存値がオーナーでもサーバーの役割が未確認ならテスト送信とCSVを隠す', async () => {
    access.role = null
    window.localStorage.setItem('lh_staff_role', 'owner')
    await render(<BroadcastDetail {...detailProps()} />)
    expect(buttonText('テストを送る')).toBeUndefined()
    expect(buttonText('CSVで書き出す')).toBeUndefined()
  })

  it('下書きは止まった手順（3 メッセージ）から続けるボタンと、テスト送信・CSV・「…」を置く', async () => {
    await render(<BroadcastDetail {...detailProps()} />)
    const resume = linkText('3 メッセージから続ける')
    expect(resume?.getAttribute('href')).toBe('/broadcasts/new?draft=broadcast-1&step=message')
    expect(buttonText('テストを送る')).toBeTruthy()
    expect(buttonText('CSVで書き出す')).toBeTruthy()
    expect(document.querySelector('[aria-label="配信「未購入者フォロー」の操作"]')).toBeTruthy()
    // 済んだ手順は押すとその手順へ戻る（手順は型の共通部品 Steps。今の段・まだの段は押せない）。
    expect(document.querySelector('[aria-label="メッセージに戻る"]')).toBeNull()
    await act(async () => { (document.querySelector('[aria-label="対象者に戻る"]') as HTMLButtonElement).click() })
    expect(push).toHaveBeenCalledWith('/broadcasts/new?draft=broadcast-1&step=audience')
    expect(host.textContent).toContain('「3 メッセージから続ける」で作るのを続けられます。')
  })

  it.each(['削除する', '予約を取り消す'])('詳細の%sは記録済みの対象を示し配信の変更で閉じる', async action => {
    const first = broadcast({ status: 'scheduled', scheduledAt: '2026-08-24T01:00:00.000Z' })
    await render(<BroadcastDetail {...detailProps({ broadcast: first })} />)
    await act(async () => { (document.querySelector('[aria-label="配信「未購入者フォロー」の操作"]') as HTMLButtonElement).click() })
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === action)!
    await act(async () => item.click())
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]')!
    expect(dialog.textContent).toContain('LINEアカウント'); expect(dialog.textContent).toContain('環境')
    expect(dialog.querySelector('[title="account-a"]')).toBeTruthy()
    await render(<BroadcastDetail {...detailProps({ broadcast: { ...first, id: 'other' } })} />)
    expect(document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull()
  })

  it('詳細の予約取消は確認時の版を送り、409後は読み直すまで再実行しない', async () => {
    const cancel = vi.spyOn(api.broadcasts, 'cancelReservation').mockRejectedValueOnce(new ApiError(409))
    const reload = vi.fn()
    await render(<BroadcastDetail {...detailProps({ broadcast: broadcast({ status: 'scheduled', scheduledAt: '2026-08-24T01:00:00.000Z', version: 7 }), onReload: reload })} />)
    await act(async () => { (document.querySelector('[aria-label="配信「未購入者フォロー」の操作"]') as HTMLButtonElement).click() })
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === '予約を取り消す')!
    await act(async () => item.click())
    const dialog = document.querySelector('[role="dialog"]')!
    const confirm = [...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === '予約を取り消す')!
    await act(async () => { confirm.click() })
    expect(cancel).toHaveBeenCalledWith('broadcast-1', 7)
    expect(dialog.textContent).toContain('ほかの人が予約を変えました。読み直してから、もう一度選んでください')
    expect(dialog.querySelector('[data-save-conflict]')).not.toBeNull()
    expect([...dialog.querySelectorAll('button')].some(button => button.textContent?.trim() === '予約を取り消す')).toBe(false)
    expect(cancel).toHaveBeenCalledTimes(1)
    const reloadButton = [...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === '最新を読み込んで続ける')!
    await act(async () => reloadButton.click())
    expect(reload).toHaveBeenCalledTimes(1)
    cancel.mockRestore()
  })

  it('詳細の取消が409になり閉じたときも最新の予約を読み直す', async () => {
    const cancel = vi.spyOn(api.broadcasts, 'cancelReservation').mockRejectedValueOnce(new ApiError(409, '', 'VERSION_CONFLICT', { status: 'sending' }))
    const reload = vi.fn()
    await render(<BroadcastDetail {...detailProps({ broadcast: broadcast({ status: 'scheduled', scheduledAt: '2026-08-24T01:00:00.000Z' }), onReload: reload })} />)
    await act(async () => { (document.querySelector('[aria-label="配信「未購入者フォロー」の操作"]') as HTMLButtonElement).click() })
    const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === '予約を取り消す')!
    await act(async () => item.click())
    const dialog = document.querySelector('[role="dialog"]')!
    const confirm = [...dialog.querySelectorAll('button')].find(button => button.textContent?.trim() === '予約を取り消す')!
    await act(async () => { confirm.click() })
    expect(dialog.textContent).toContain('送信が始まったため取り消せません')
    const close = dialog.querySelector<HTMLButtonElement>('button[aria-label="閉じる"]')!
    await act(async () => close.click())
    expect(reload).toHaveBeenCalledTimes(1)
    cancel.mockRestore()
  })

  it('閲覧のみには変える操作を置かない（押せないボタンも残さない）。CSV は出す', async () => {
    access.role = 'staff'
    rememberStaffIdentity({ role: 'staff', permissionViewKeys: ['/broadcasts', 'broadcast.result.export'] } as StaffMember)
    await render(<BroadcastDetail {...detailProps({ canEdit: false })} />)
    expect(linkText('3 メッセージから続ける')).toBeUndefined()
    expect(buttonText('テストを送る')).toBeUndefined()
    expect(document.querySelector('[aria-label="配信「未購入者フォロー」の操作"]')).toBeNull()
    expect(linkText('2 対象者')).toBeUndefined()
    expect(buttonText('CSVで書き出す')).toBeTruthy()
    expect(host.textContent).not.toContain('から続ける')
    expect(buttons().filter((button) => button.disabled).map((button) => button.textContent)).toEqual([])
  })

  it('ほかの人が更新したら帯を出し、「読み直す」で読み直しを頼む（Q28Gb）', async () => {
    const onConflictReload = vi.fn()
    await render(<BroadcastDetail {...detailProps({ conflict: true, onConflictReload })} />)
    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('ほかの人が配信「未購入者フォロー」を更新しました')
    expect(alert?.textContent).toContain('この画面では書き換えません')
    await act(async () => { buttonText('最新を読み込んで続ける')!.click() })
    expect(onConflictReload).toHaveBeenCalledTimes(1)
  })

  it('承認を頼まれた人は、理由を入れるまで差し戻せない。承認して送るは押せる（pNiUk）', async () => {
    const state: BroadcastApprovalState = {
      approval: {
        status: 'pending', requestedByStaffId: 'staff-a', requestedAt: '2026-09-25T11:10:00.000Z', approverStaffId: 'staff-b',
        note: '秋の案内です', decidedByStaffId: null, decidedAt: null, rejectReason: null, confirmedCount: null,
      },
      gate: { required: true, recipientCount: 1248, threshold: 1000, singleOperator: false, operatorCount: 2 },
      viewer: { isApprover: true, canApprove: true, isRequester: false },
    }
    const approval = approvalProps(state)
    await render(<BroadcastDetail {...detailProps({
      broadcast: broadcast({ id: 'broadcast-0', status: 'scheduled', scheduledAt: '2026-08-24T01:00:00.000Z', approvalStatus: 'pending', displayStatus: 'pending_approval', displayStatusLabel: '承認待ち' }),
      approval,
    })} />)
    expect(host.textContent).toContain('あなたの承認を待っています')
    expect(host.textContent).toContain('を過ぎると、送らずに期限切れになります。')
    const reject = buttonText('差し戻す')!
    expect(reject.disabled).toBe(true)
    const input = document.getElementById('approval-reject-reason') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '日時を10月に')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(buttonText('差し戻す')!.disabled).toBe(false)
    await act(async () => { buttonText('差し戻す')!.click() })
    expect(approval.onReject).toHaveBeenCalledWith('日時を10月に')
    await act(async () => { buttonText('承認して送る')!.click() })
    expect(approval.onApprove).toHaveBeenCalledTimes(1)
  })

  it('送った配信は 複製して作る と CSV。テスト送信は出さない（F3X1Mo）', async () => {
    await render(<BroadcastDetail {...detailProps({
      broadcast: broadcast({ id: 'broadcast-2', status: 'sent', sentAt: '2026-08-20T03:00:00.000Z', successCount: 624, totalCount: 626, displayStatus: 'sent', displayStatusLabel: '送信済み', draftStep: null }),
    })} />)
    expect(linkText('複製して作る')?.getAttribute('href')).toBe('/broadcasts/new?duplicateFrom=broadcast-2')
    expect(buttonText('テストを送る')).toBeUndefined()
    expect(host.textContent).toContain('配信結果')
    expect(host.textContent).toContain('送信に失敗した人がいます（2 人）。')
  })
})

describe('V8 一斉配信を予約したあと', () => {
  it('送る日時・人数・取り消せる期限を、説明を開かず見出しの直下で読める', async () => {
    await render(<Reserved {...reservedProps()} />)
    const heading = host.querySelector('[data-template-region="heading"]')!
    expect(heading.querySelector('p')?.textContent).toContain('1,213人へ送ります。開始の前までは確かめる・取り消すができます。')
    expect(heading.querySelector('p')?.textContent).toContain('8月24日')
    expect(heading.querySelector('[aria-label="8月キャンペーンのお知らせの説明"]')).toBeNull()
    await render(<Reserved {...reservedProps({ estimate: null })} />)
    expect(host.querySelector('[data-template-region="heading"] p')?.textContent).toContain('対象の友だちへ送ります')
    expect(host.querySelector('[data-template-region="heading"] p')?.textContent).not.toContain('0人')
  })
  it('「予約を取り消す…」で確かめの窓を開く。窓のボタンは 取り消す・やめる・予約のまま残す の順（BeNtj）', async () => {
    const props = reservedProps()
    await render(<Reserved {...props} />)
    await act(async () => { buttonText('予約を取り消す…')!.click() })
    expect(props.openCancel).toHaveBeenCalledTimes(1)
    await render(<Reserved {...props} cancelOpen />)
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]')!
    expect(dialog.textContent).toContain('「8月キャンペーンのお知らせ」の予約を取り消しますか？')
    expect(dialog.textContent).toContain('1,213 人 に送らなくなります。取り消すと下書きに戻り、もう一度予約できます。')
    expect(dialog.textContent).toContain('LINEアカウント')
    expect(dialog.textContent).toContain('環境')
    const order = [...dialog.querySelectorAll('button')].map((button) => button.textContent?.trim()).filter((text) => text && text !== '')
    expect(order.slice(-3)).toEqual(['予約を取り消す', 'やめる', '予約のまま残す'])
    await act(async () => { buttonText('予約を取り消す')!.click() })
    expect(props.confirmCancel).toHaveBeenCalledTimes(1)
  })

  it('予約取消は配信記録の複数アカウントを示し、対象が変わると旧窓を閉じる', async () => {
    const multi = broadcast({ id: 'one', targetType: 'multi-account-dedup', lineAccountId: null, accountIds: ['account-a', 'account-b'] })
    const props = reservedProps({ broadcast: multi, cancelOpen: true })
    await render(<Reserved {...props} />)
    const dialog = document.querySelector('[role="alertdialog"], [role="dialog"]')!
    expect(dialog.querySelector('[title="account-a"]')).toBeTruthy()
    expect(dialog.querySelector('[title="account-b"]')).toBeTruthy()
    await render(<Reserved {...props} broadcast={{ ...multi, id: 'two' }} />)
    expect(document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull()
    expect(props.confirmCancel).not.toHaveBeenCalled()
  })
  it('送信元が記録されていない配信は選択中のアカウントで埋めない', async () => {
    await render(<Reserved {...reservedProps({ cancelOpen: true, broadcast: broadcast({ lineAccountId: null, accountIds: null }) })} />)
    expect(document.querySelector('[role="alertdialog"], [role="dialog"]')?.textContent).toContain('名前を確認できません')
  })

  it('閲覧のみには 次にできること の操作を置かない（押せないボタンも残さない）', async () => {
    await render(<Reserved {...reservedProps({ canEdit: false })} />)
    expect(buttonText('テストを送る')).toBeUndefined()
    expect(buttonText('複製して別の配信を作る')).toBeUndefined()
    expect(buttonText('予約を取り消す…')).toBeUndefined()
    expect(host.textContent).not.toContain('次にできること')
    expect(buttons().filter((button) => button.disabled)).toEqual([])
    expect(linkText('予約の内容を見る')?.getAttribute('href')).toBe('/broadcasts/detail?id=broadcast-0')
  })
})
