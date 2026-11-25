// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const heldSend = vi.hoisted(() => ({ current: null as null | (() => void) }))
vi.mock('@/components/shared/button', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/shared/button')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.busyLabel === '送っています…') heldSend.current = () => props.onClick?.({} as React.MouseEvent<HTMLButtonElement>)
    return <actual.default {...props} />
  } }
})
const mocks = vi.hoisted(() => ({ create: vi.fn(), send: vi.fn(), get: vi.fn(), request: vi.fn(), preflight: vi.fn(), config: vi.fn(), notify: vi.fn() }))
vi.mock('@/components/shared/toast', () => ({ notifyToast: mocks.notify }))
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  const mocked = await (() => ({ api: {
  tags: { list: async () => ({ success: true, data: [{ id: 'tag-a', name: '購入者' }] }) },
  broadcasts: { ...mocks, approval: { config: mocks.config, request: mocks.request, candidates: async () => ({ success: true, data: [{ id: 'owner', name: '担当', role: 'owner' }] }) } },
} }))()
  return { ...actual, ...mocked }
})
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }))
vi.mock('@/components/shared/select', () => ({ default: ({ value, onChange, options, ...props }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; 'aria-label': string }) => <select aria-label={props['aria-label']} value={value} onChange={e => onChange(e.target.value)}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select> }))
vi.mock('@/components/shared/date-time-field', () => ({ default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => <input aria-label="送る日時" value={value} onChange={e => onChange(e.target.value)} /> }))
import QuickSend from './quick-send'
import type { StaffMember } from '@line-crm/shared'
import { forgetStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
import { PERMISSION_LOCK_REASON } from '@/components/shared/permission-lock'
import { canUseQuickSendNow } from './quick-send-access'
const identity = (role = 'owner', permissionKeys: string[] = []) => ({ id: 'person', role, permissionKeys }) as StaffMember
const proxy = (mode: 'read' | 'write') => rememberSessionSnapshot({ stepUpMethod: 'totp', unfamiliarAt: null, impersonation: { id: 'proxy', tenantId: 'tenant', mode, piiRevealed: false, startedAt: '' } })
const revoke = (value: string) => {
  if (value === 'unknown') forgetStaffIdentity()
  else if (value === 'read' || value === 'write') proxy(value)
  else if (value === 'readOnly') rememberStaffIdentity({ ...identity(), readOnly: true })
  else if (value === 'view_only') rememberStaffIdentity({ ...identity(), roleBundle: 'view_only' })
  else rememberStaffIdentity(identity(value))
}
const posts = () => expect([mocks.preflight.mock.calls.length, mocks.create.mock.calls.length, mocks.send.mock.calls.length, mocks.request.mock.calls.length]).toEqual([0, 0, 0, 0])
const onSent = vi.fn()
const onClose = vi.fn()
async function fill() {
  render(<QuickSend open accountId="account-a" onClose={onClose} onSent={onSent} />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('radio', { name: '友だち全員' }))
  fireEvent.click(screen.getByRole('radio', { name: '今すぐ', exact: true }))
  fireEvent.change(screen.getByLabelText('本文'), { target: { value: 'お知らせ' } })
  await estimate()
}
async function estimate() { await act(async () => { vi.advanceTimersByTime(501); await Promise.resolve() }) }
beforeEach(() => {
  heldSend.current = null
  forgetStaffIdentity(); forgetSessionSnapshot(); rememberStaffIdentity(identity())
  document.documentElement.dataset.theme = 'v8'
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.clearAllMocks()
  mocks.config.mockResolvedValue({ success: true, data: { threshold: 1000, singleOperator: false, operatorCount: 2 } })
  mocks.create.mockResolvedValue({ success: true, data: { id: 'created-1' } })
  mocks.send.mockResolvedValue({ success: true })
  mocks.request.mockResolvedValue({ success: true })
  mocks.get.mockResolvedValue({ success: true, data: { status: 'draft', approvalStatus: null } })
  mocks.preflight.mockResolvedValue({ success: true, data: { audienceCount: 10, hiddenExcluded: 0 } })
})
afterEach(() => { cleanup(); forgetStaffIdentity(); forgetSessionSnapshot(); vi.useRealTimers() })
it('かんたん送信の窓にLINEアカウントと環境を出す', async () => {
  render(<QuickSend open accountId="account-a" onClose={onClose} onSent={onSent} />)
  await act(async () => {})
  const dialog = screen.getByRole('dialog', { name: 'かんたんに送る' })
  expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
  expect(within(dialog).getByText('環境')).toBeTruthy()
})
it('新規は相手も時間も未選択で、本文だけでは人数確認も送信もしない', async () => {
  render(<QuickSend open accountId="account-a" onClose={onClose} onSent={onSent} />)
  await act(async () => {})
  fireEvent.change(screen.getByLabelText('本文'), { target: { value: 'お知らせ' } })
  await estimate()
  expect(screen.getAllByRole('radio').filter(radio => radio.getAttribute('aria-checked') === 'true')).toHaveLength(0)
  expect(screen.getByText('送る相手を選んでください。')).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '送る', exact: true }).disabled).toBe(true)
  expect(heldSend.current).toBeTypeOf('function')
  await act(async () => heldSend.current!())
  posts()
})
it('日本時間10月5日10時を同じ時刻のISOで予約する', async () => {
  await fill()
  fireEvent.click(screen.getByRole('radio', { name: '日時を決める' }))
  fireEvent.change(screen.getByLabelText('送る日時'), { target: { value: '2026-10-05T10:00' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '予約する' })) })
  expect(mocks.notify).toHaveBeenCalledWith('配信を予約しました')
  expect(mocks.create.mock.calls[0][0].scheduledAt).toBe('2026-10-05T01:00:00.000Z')
  expect(new Date(mocks.create.mock.calls[0][0].scheduledAt).getTime()).toBe(new Date('2026-10-05T10:00:00+09:00').getTime())
})
it('送信失敗後は同じ配信から再試行し、下書きを増やさない', async () => {
  mocks.send.mockResolvedValueOnce({ success: false, error: '通信失敗' })
  await fill()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '送る', exact: true })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '送る', exact: true })) })
  expect(mocks.create).toHaveBeenCalledTimes(1)
  expect(mocks.send.mock.calls).toEqual([['created-1', undefined], ['created-1', undefined]])
  expect(onSent).toHaveBeenCalledTimes(1)
})
it('承認依頼の失敗後も同じ配信へ依頼する', async () => {
  mocks.preflight.mockResolvedValue({ success: true, data: { audienceCount: 1100, hiddenExcluded: 0 } })
  mocks.request.mockResolvedValueOnce({ success: false, error: '通信失敗' })
  await fill(); await estimate()
  fireEvent.change(screen.getByLabelText('承認する人'), { target: { value: 'owner' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '承認を頼む' })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '承認を頼む' })) })
  expect(mocks.create).toHaveBeenCalledTimes(1)
  expect(mocks.notify).toHaveBeenCalledTimes(1)
  expect(mocks.notify).toHaveBeenCalledWith('配信の承認を頼みました')
  expect(mocks.request.mock.calls).toEqual([['created-1', { approverStaffId: 'owner' }], ['created-1', { approverStaffId: 'owner' }]])
})
it('送信応答を失っても送信済みを確認して二重に送らない', async () => {
  mocks.send.mockRejectedValueOnce(new Error('応答なし'))
  await fill()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '送る', exact: true })) })
  mocks.get.mockResolvedValue({ success: true, data: { status: 'sent' } })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '送る', exact: true })) })
  expect(mocks.create).toHaveBeenCalledTimes(1)
  expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(mocks.notify).toHaveBeenCalledWith('配信を送りました')
  expect(onSent).toHaveBeenCalledTimes(1)
})
it('同じ描画中の連打で二つ作らない', async () => {
  await fill()
  const button = screen.getByRole('button', { name: '送る', exact: true })
  await act(async () => { button.click(); button.click() })
  expect(mocks.create).toHaveBeenCalledTimes(1)
  expect(mocks.send).toHaveBeenCalledTimes(1)
})
it('対象を変えたあとに遅れて届いた前の人数を捨てる', async () => {
  let resolveOld!: (v: unknown) => void
  mocks.preflight.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve }))
  await fill(); await estimate()
  fireEvent.click(screen.getByRole('radio', { name: 'タグで絞る' }))
  // 偽の時計なので findBy・waitFor は使わず、選ぶ窓をその場で操作する。
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'タグ：選択する' })) })
  const picker = screen.getAllByRole('dialog').at(-1)!
  await act(async () => { fireEvent.click(within(picker).getByRole('checkbox', { name: '購入者' })) })
  await act(async () => { fireEvent.click(within(picker).getByRole('button', { name: '選択する（1件）' })) })
  await estimate()
  expect(screen.getByText(/10 人に届く見込み/)).toBeTruthy()
  await act(async () => { resolveOld({ success: true, data: { audienceCount: 2000, hiddenExcluded: 0 } }) })
  expect(screen.queryByText(/2,000人に届く見込み/)).toBeNull()
  expect(screen.getByText(/10 人に届く見込み/)).toBeTruthy()
})

it('書きかけでアカウントを切り替えると確認まで止まる', async () => {
  await fill()
  const change = vi.fn()
  const { requestUnsavedAction } = await import('@/lib/unsaved-action')
  act(() => requestUnsavedAction(change))
  expect(change).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
  expect(change).not.toHaveBeenCalled()
})

it('WEB112: 設定の閾値と1人運用に従い人数を再入力して送信する', async () => {
  mocks.config.mockResolvedValue({ success: true, data: { threshold: 50, singleOperator: true, operatorCount: 1 } })
  mocks.preflight.mockResolvedValue({ success: true, data: { audienceCount: 60, hiddenExcluded: 0 } })
  await fill(); await estimate()
  expect(screen.queryByLabelText('承認する人')).toBeNull()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '送る', exact: true }).disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('人数を入れる'), { target: { value: '60' } })
  await act(async () => screen.getByRole('button', { name: '送る', exact: true }).click())
  expect(mocks.send).toHaveBeenCalledWith('created-1', { confirmedRecipientCount: 60 })
  expect(mocks.request).not.toHaveBeenCalled()
})

it('WEB112: 確定前に人数が変わったら作成せず新しい人数を再確認する', async () => {
  mocks.config.mockResolvedValue({ success: true, data: { threshold: 50, singleOperator: true, operatorCount: 1 } })
  mocks.preflight.mockResolvedValue({ success: true, data: { audienceCount: 60, hiddenExcluded: 0 } })
  await fill()
  fireEvent.change(screen.getByLabelText('人数を入れる'), { target: { value: '60' } })
  mocks.preflight.mockResolvedValue({ success: true, data: { audienceCount: 61, hiddenExcluded: 0 } })
  await act(async () => screen.getByRole('button', { name: '送る', exact: true }).click())
  expect(mocks.create).not.toHaveBeenCalled()
  expect(mocks.send).not.toHaveBeenCalled()
  expect(screen.getByLabelText<HTMLInputElement>('人数を入れる').value).toBe('')
  fireEvent.change(screen.getByLabelText('人数を入れる'), { target: { value: '61' } })
  await act(async () => screen.getByRole('button', { name: '送る', exact: true }).click())
  expect(mocks.send).toHaveBeenCalledWith('created-1', { confirmedRecipientCount: 61 })
})

// 選ぶ物の欄も、保存/API境界の試験では以前のSelectと同じ差し替えにする。
vi.mock('@/components/shared/entity-select', () => import('@/test-utils/entity-select-mock'))

it('送信の受付は完了や見込み人数で知らせない', async () => {
  mocks.send.mockResolvedValue({ success: true, data: { status: 'sending', sentCount: 0 } })
  await fill()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '送る', exact: true })) })
  expect(mocks.notify).toHaveBeenCalledWith('配信の送信を受け付けました')
  expect(mocks.notify).toHaveBeenCalledTimes(1)
})

it.each(['unknown', 'viewer', 'staff', 'read', 'readOnly', 'view_only'])('%sでは開いた窓を残し、同じ欄と理由付き送信口で全POSTを止める', async denied => {
  await fill()
  const previousPreflights = mocks.preflight.mock.calls.length
  act(() => revoke(denied)); await estimate()
  expect(mocks.preflight).toHaveBeenCalledTimes(previousPreflights)
  mocks.preflight.mockClear()
  const send = screen.getByRole<HTMLButtonElement>('button', { name: '送る', exact: true })
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.getByLabelText('本文').getAttribute('contenteditable')).toBe('false')
  expect(send.disabled).toBe(denied === 'unknown')
  expect(send.getAttribute('aria-disabled')).toBe(denied === 'unknown' ? null : 'true')
  expect(document.querySelectorAll('[data-read-only-notice]')).toHaveLength(denied === 'unknown' ? 0 : 1)
  const scheduled = screen.getByRole('radio', { name: '日時を決める' })
  expect(scheduled.getAttribute('aria-disabled')).toBe(denied === 'unknown' ? null : 'true')
  fireEvent.click(scheduled); expect(scheduled.getAttribute('aria-checked')).toBe('false')
  fireEvent.focus(send)
  if (denied === 'read') expect(screen.getByRole('tooltip').textContent).toBe(PERMISSION_LOCK_REASON.impersonationSend)
  fireEvent.click(send); await estimate(); posts()
  // GETの設定読みは、閲覧者にも従来どおり行う。
  expect(mocks.config).toHaveBeenCalledWith('account-a')
})
it.each(['admin', 'staff'])('%sのedit＋publishは直接送信を1回通す', async role => {
  rememberStaffIdentity(identity(role, ['/broadcasts', 'broadcast.definition.edit', 'broadcast.definition.publish']))
  await fill()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '送る', exact: true })))
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.send).toHaveBeenCalledTimes(1)
})
it.each([['broadcast.definition.edit'], ['broadcast.definition.publish']])('片方だけの専用鍵%sでは新規の直接送信を通さない', async key => {
  rememberStaffIdentity(identity('staff', ['/broadcasts', key]))
  await fill()
  fireEvent.click(screen.getByRole('button', { name: '送る', exact: true })); await estimate()
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
})
it('write代理では直接送信の理由だけが出て、予約は1回通る', async () => {
  proxy('write'); await fill()
  const send = screen.getByRole<HTMLButtonElement>('button', { name: '送る', exact: true })
  expect(send.getAttribute('aria-disabled')).toBe('true'); fireEvent.focus(send)
  expect(screen.getByRole('tooltip').textContent).toBe(PERMISSION_LOCK_REASON.impersonationSend)
  fireEvent.click(send); expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
  fireEvent.blur(send); fireEvent.click(screen.getByRole('radio', { name: '日時を決める' }))
  fireEvent.change(screen.getByLabelText('送る日時'), { target: { value: '2026-10-05T10:00' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '予約する' })))
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.send).not.toHaveBeenCalled()
  expect(mocks.notify).toHaveBeenCalledWith('配信を予約しました')
})
it('write代理でも承認依頼は1回通り、直接送信を呼ばない', async () => {
  proxy('write'); mocks.preflight.mockResolvedValue({ success: true, data: { audienceCount: 1100, hiddenExcluded: 0 } })
  await fill(); fireEvent.change(screen.getByLabelText('承認する人'), { target: { value: 'owner' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '承認を頼む' })))
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.request).toHaveBeenCalledExactlyOnceWith('created-1', { approverStaffId: 'owner' }); expect(mocks.send).not.toHaveBeenCalled()
})
it.each(['read', 'write', 'viewer', 'unknown'])('作成の応答待ちで%sへ替わるとIDを保って後続送信0、元へ戻った明示操作だけ同じIDで再開する', async denied => {
  let resolve!: (value: unknown) => void
  mocks.create.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  await fill()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '送る', exact: true })))
  expect(resolve).toBeTypeOf('function')
  act(() => revoke(denied))
  await act(async () => resolve({ success: true, data: { id: 'kept-id' } }))
  expect(mocks.send).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByText('権限が変わったため、続きの処理を中止しました。配信の状態は一覧で確認してください。')).toBeTruthy()
  act(() => { forgetSessionSnapshot(); rememberStaffIdentity(identity()) }); await estimate()
  expect(mocks.send).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '送る', exact: true })))
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.get).toHaveBeenCalledWith('kept-id')
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith('kept-id', undefined)
})
it('同じownerの参照を戻しても世代を越えた古い送信は再開しない', async () => {
  const person = identity(); rememberStaffIdentity(person)
  mocks.create.mockImplementationOnce(async () => { forgetStaffIdentity(); rememberStaffIdentity(person); return { success: true, data: { id: 'kept-id' } } })
  await fill(); await act(async () => fireEvent.click(screen.getByRole('button', { name: '送る', exact: true })))
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.send).not.toHaveBeenCalled()
})
it('人数の再確認待ちでread代理へ替わると、作成前に止まる', async () => {
  mocks.config.mockResolvedValue({ success: true, data: { threshold: 50, singleOperator: true } })
  mocks.preflight.mockResolvedValue({ success: true, data: { audienceCount: 60, hiddenExcluded: 0 } })
  await fill(); fireEvent.change(screen.getByLabelText('人数を入れる'), { target: { value: '60' } })
  let resolve!: (value: unknown) => void
  mocks.preflight.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '送る', exact: true })))
  act(() => proxy('read'))
  await act(async () => resolve({ success: true, data: { audienceCount: 60, hiddenExcluded: 0 } }))
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
})
it('承認用の作成待ちでread代理へ替わると承認依頼を呼ばない', async () => {
  mocks.preflight.mockResolvedValue({ success: true, data: { audienceCount: 1100, hiddenExcluded: 0 } })
  mocks.create.mockImplementationOnce(async () => { proxy('read'); return { success: true, data: { id: 'approval-id' } } })
  await fill(); fireEvent.change(screen.getByLabelText('承認する人'), { target: { value: 'owner' } })
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '承認を頼む' })))
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.request).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
})
it('役割が替わった後に届いた古い見込みを表示しない', async () => {
  let resolve!: (value: unknown) => void
  mocks.preflight.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  await fill(); act(() => revoke('viewer'))
  await act(async () => resolve({ success: true, data: { audienceCount: 2000, hiddenExcluded: 0 } }))
  expect(screen.queryByText(/2,000 人に届く見込み/)).toBeNull()
  expect(mocks.create).not.toHaveBeenCalled()
})
it.each(['account', 'account-roundtrip', 'reopen'])('%sで別の窓になった後に古い作成応答から送信も通知もしない', async change => {
  let resolve!: (value: unknown) => void
  mocks.create.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  const props = { open: true, accountId: 'account-a', onClose, onSent }
  const view = render(<QuickSend {...props} />); await act(async () => {})
  fireEvent.click(screen.getByRole('radio', { name: '友だち全員' }))
  fireEvent.click(screen.getByRole('radio', { name: '今すぐ', exact: true }))
  fireEvent.change(screen.getByLabelText('本文'), { target: { value: '前の窓' } }); await estimate()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '送る', exact: true })))
  if (change === 'account' || change === 'account-roundtrip') { view.rerender(<QuickSend {...props} accountId="account-b" />); if (change === 'account-roundtrip') view.rerender(<QuickSend {...props} />) }
  else { view.rerender(<QuickSend {...props} open={false} />); view.rerender(<QuickSend {...props} />) }
  await act(async () => resolve({ success: true, data: { id: 'old-id' } }))
  expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.notify).not.toHaveBeenCalled(); expect(onSent).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByLabelText('本文').textContent).toBe('')
})
it('門の鍵はcreateとpreflightで分かれ、ページ鍵なしとreadOnlyでは両方拒む', () => {
  rememberStaffIdentity(identity('staff', ['broadcast.definition.edit', 'broadcast.definition.publish']))
  expect(canUseQuickSendNow('create')).toBe(false); expect(canUseQuickSendNow('preflight')).toBe(false)
  rememberStaffIdentity({ ...identity(), readOnly: true })
  expect(canUseQuickSendNow('create')).toBe(false); expect(canUseQuickSendNow('preflight')).toBe(false)
})

it.each(['unknown', 'viewer', 'read', 'write'])('保持した送信callbackも%sへの切替を実行直前に読み、作成から0回', async denied => {
  await fill()
  const submit = heldSend.current
  expect(submit).toBeTypeOf('function')
  act(() => revoke(denied)); mocks.preflight.mockClear()
  await act(async () => submit!())
  posts()
  expect(screen.getByText('権限が変わったため、続きの処理を中止しました。配信の状態は一覧で確認してください。')).toBeTruthy()
})

it('保持した配信のGET待ちでread代理へ替わっても、状態読取の後に再送しない', async () => {
  mocks.send.mockRejectedValueOnce(new Error('応答なし'))
  await fill(); await act(async () => fireEvent.click(screen.getByRole('button', { name: '送る', exact: true })))
  let resolve!: (value: unknown) => void
  mocks.get.mockImplementationOnce(() => new Promise(r => { resolve = r }))
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '送る', exact: true })))
  act(() => proxy('read'))
  await act(async () => resolve({ success: true, data: { status: 'draft' } }))
  expect(mocks.get).toHaveBeenCalledWith('created-1'); expect(mocks.send).toHaveBeenCalledTimes(1)
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(onSent).not.toHaveBeenCalled()
})
it('前の窓のfinallyが新しい送信中の連打防止を解除しない', async () => {
  let oldResolve!: (value: unknown) => void, newResolve!: (value: unknown) => void
  mocks.create.mockImplementationOnce(() => new Promise(r => { oldResolve = r }))
    .mockImplementationOnce(() => new Promise(r => { newResolve = r }))
  const props = { open: true, accountId: 'account-a', onClose, onSent }
  const view = render(<QuickSend {...props} />); await act(async () => {})
  fireEvent.click(screen.getByRole('radio', { name: '友だち全員' }))
  fireEvent.click(screen.getByRole('radio', { name: '今すぐ', exact: true }))
  fireEvent.change(screen.getByLabelText('本文'), { target: { value: '前の窓' } }); await estimate()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: '送る', exact: true })))
  view.rerender(<QuickSend {...props} open={false} />); view.rerender(<QuickSend {...props} />); await act(async () => {})
  fireEvent.click(screen.getByRole('radio', { name: '友だち全員' }))
  fireEvent.click(screen.getByRole('radio', { name: '今すぐ', exact: true }))
  fireEvent.change(screen.getByLabelText('本文'), { target: { value: '次の窓' } }); await estimate()
  const retained = heldSend.current
  expect(retained).toBeTypeOf('function')
  await act(async () => retained!())
  expect(mocks.create).toHaveBeenCalledTimes(2)
  await act(async () => oldResolve({ success: true, data: { id: 'old-id' } }))
  await act(async () => retained!())
  expect(mocks.create).toHaveBeenCalledTimes(2); expect(mocks.send).not.toHaveBeenCalled()
  await act(async () => newResolve({ success: true, data: { id: 'new-id' } }))
  expect(mocks.send).toHaveBeenCalledExactlyOnceWith('new-id', undefined)
})
it('別の正規編集者へ替わっても、元の本人の待機中操作を継続しない', async () => {
  mocks.create.mockImplementationOnce(async () => { rememberStaffIdentity({ ...identity('admin'), id: 'another-person' }); return { success: true, data: { id: 'kept-id' } } })
  await fill(); await act(async () => fireEvent.click(screen.getByRole('button', { name: '送る', exact: true })))
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.send).not.toHaveBeenCalled()
})
it('readを経て通常モードへ戻っていても、以前のsessionで始めた操作を継続しない', async () => {
  rememberSessionSnapshot({ stepUpMethod: 'totp', unfamiliarAt: null, impersonation: null })
  mocks.create.mockImplementationOnce(async () => { proxy('read'); rememberSessionSnapshot({ stepUpMethod: 'totp', unfamiliarAt: null, impersonation: null }); return { success: true, data: { id: 'kept-id' } } })
  await fill(); await act(async () => fireEvent.click(screen.getByRole('button', { name: '送る', exact: true })))
  expect(mocks.create).toHaveBeenCalledTimes(1); expect(mocks.send).not.toHaveBeenCalled()
})

it.each(['account', 'reopen'])('%sの後に保持した前の窓の送信を呼んでも、前の本文とaccountで作成しない', async change => {
  const props = { open: true, accountId: 'account-a', onClose, onSent }
  const view = render(<QuickSend {...props} />); await act(async () => {})
  fireEvent.change(screen.getByLabelText('本文'), { target: { value: '以前の本文' } }); await estimate()
  const oldSubmit = heldSend.current
  expect(oldSubmit).toBeTypeOf('function')
  if (change === 'account') view.rerender(<QuickSend {...props} accountId="account-b" />)
  else { view.rerender(<QuickSend {...props} open={false} />); view.rerender(<QuickSend {...props} />) }
  await act(async () => oldSubmit!())
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled(); expect(onSent).not.toHaveBeenCalled()
  expect(screen.getByLabelText('本文').textContent).toBe('')
  expect(screen.queryByText('送っています…')).toBeNull()
  const cancel = screen.getByRole<HTMLButtonElement>('button', { name: 'キャンセル', exact: true })
  expect(cancel.disabled).toBe(false); fireEvent.click(cancel); expect(onClose).toHaveBeenCalledTimes(1)
})
it('write代理で日時を選んだ時点から直接送信の理由を外し、入力不足の1行だけを出す', async () => {
  proxy('write'); await fill()
  fireEvent.click(screen.getByRole('radio', { name: '日時を決める' }))
  const schedule = screen.getByRole<HTMLButtonElement>('button', { name: '予約する' })
  expect(schedule.disabled).toBe(true); expect(schedule.getAttribute('aria-disabled')).toBeNull()
  expect(schedule.hasAttribute('data-permission-locked')).toBe(false)
  expect(screen.getByText('送る日時を選んでください。').getAttribute('role')).toBe('status')
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
})

it('前の窓のcallbackを拒否しても、新しい窓の承認設定エラーを消さない', async () => {
  const props = { open: true, accountId: 'account-a', onClose, onSent }
  const view = render(<QuickSend {...props} />); await act(async () => {})
  fireEvent.change(screen.getByLabelText('本文'), { target: { value: '前の本文' } }); await estimate()
  const oldSubmit = heldSend.current
  expect(oldSubmit).toBeTypeOf('function')
  mocks.config.mockResolvedValueOnce({ success: false, error: '読取失敗' })
  view.rerender(<QuickSend {...props} accountId="account-b" />); await act(async () => {})
  expect(screen.getByText('承認の設定を読み込めませんでした。開き直してください。')).toBeTruthy()
  await act(async () => oldSubmit!())
  expect(screen.getByText('承認の設定を読み込めませんでした。開き直してください。')).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'キャンセル', exact: true }).disabled).toBe(false)
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
})


it('詳しく作る導線は共通の文字操作を使い、閲覧のみでも灰色と理由を保つ', async () => {
  render(<QuickSend open accountId="account-a" onClose={onClose} onSent={onSent} />)
  await act(async () => {})
  const link = screen.getByRole('link', { name: '詳しく作るへ' })
  expect(link.getAttribute('href')).toBe('/broadcasts/new')
  expect(link.getAttribute('data-variant')).toBe('text')
  cleanup()
  rememberStaffIdentity(identity('viewer'))
  render(<QuickSend open accountId="account-a" onClose={onClose} onSent={onSent} />)
  await act(async () => {})
  const locked = screen.getByRole('button', { name: '詳しく作るへ' })
  expect(locked.getAttribute('data-variant')).toBe('text')
  expect(locked.getAttribute('aria-disabled')).toBe('true')
  act(() => { locked.focus(); fireEvent.keyDown(locked, { key: 'Enter' }) })
  expect(screen.getByRole('tooltip').textContent).toContain('閲覧のみ')
  posts()
})

it.each(['友だち全員', '今すぐ'])('%sだけ選んでも送信しない', async choice => {
  render(<QuickSend open accountId="account-a" onClose={onClose} onSent={onSent} />)
  await act(async () => {})
  fireEvent.change(screen.getByLabelText('本文'), { target: { value: 'お知らせ' } })
  fireEvent.click(screen.getByRole('radio', { name: choice, exact: true }))
  await estimate()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: '送る', exact: true }).disabled).toBe(true)
  expect(screen.getByText(choice === '今すぐ' ? '送る相手を選んでください。' : '送る時間を選んでください。')).toBeTruthy()
  expect(heldSend.current).toBeTypeOf('function')
  await act(async () => heldSend.current!())
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled(); expect(mocks.request).not.toHaveBeenCalled()
})
it('全員と今すぐを選んだ古い押し口も、タグ未入力へ変えた後は送信しない', async () => {
  await fill()
  const previous = heldSend.current!
  fireEvent.click(screen.getByRole('radio', { name: 'タグで絞る' }))
  await act(async () => previous())
  expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.send).not.toHaveBeenCalled()
})
it('アカウントを替えると相手と日時を未選択へ戻す', async () => {
  const props = { open: true, accountId: 'account-a', onClose, onSent }
  const view = render(<QuickSend {...props} />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('radio', { name: '友だち全員' }))
  fireEvent.click(screen.getByRole('radio', { name: '今すぐ', exact: true }))
  await act(async () => view.rerender(<QuickSend {...props} accountId="account-b" />))
  expect(screen.getAllByRole('radio').filter(radio => radio.getAttribute('aria-checked') === 'true')).toHaveLength(0)
  posts()
})
