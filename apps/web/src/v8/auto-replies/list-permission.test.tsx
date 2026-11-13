// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity, readStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
import type { AutoReply } from './list-model'

const net = vi.hoisted(() => ({ list: vi.fn(), folders: vi.fn(), templates: vi.fn(), summary: vi.fn(), update: vi.fn(), stop: vi.fn(), remove: vi.fn(), create: vi.fn(), push: vi.fn() }))
const state = vi.hoisted(() => ({ account: 'account-a', previewPending: false }))
const delayed = vi.hoisted(() => [] as Array<Parameters<typeof import('@/lib/undoable').runUndoable>[0]>)
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, autoReplies: { ...actual.api.autoReplies, list: net.list, summary: net.summary, update: net.update, stop: net.stop, delete: net.remove, create: net.create }, templates: { ...actual.api.templates, list: net.templates }, folders: { ...actual.api.folders, list: net.folders } } }
})
vi.mock('@/lib/undoable', async original => {
  const actual = await original<typeof import('@/lib/undoable')>()
  const { scheduledConfirmation } = await import('@/test-utils/confirmed-undo-test-handle')
  return { ...actual, runUndoable: (options: Parameters<typeof actual.runUndoable>[0] & { confirmation?: boolean }) => {
    if (options.confirmation) { const scheduled = scheduledConfirmation(options); delayed.push({ ...options, get failureMessage() { return options.failureMessage }, commit: scheduled.execute }); return scheduled.handle }
    delayed.push(options)
  } }
})
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: net.push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), forward: vi.fn(), prefetch: vi.fn() }), useSearchParams: () => new URLSearchParams('') }))
vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: state.account, accounts: [], loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async original => {
  const actual = await original<typeof import('@/lib/staff-role')>()
  return { ...actual, useStaffRole: () => { const role = actual.useStaffRole(); return state.previewPending ? null : role } }
})
vi.mock('@/lib/use-feature-access', async original => {
  const actual = await original<typeof import('@/lib/use-feature-access')>()
  return { ...actual, useFeatureAccess: (...args: Parameters<typeof actual.useFeatureAccess>) => { const allowed = actual.useFeatureAccess(...args); return state.previewPending || allowed } }
})
import AutoRepliesList from './list'
import { clearToastsForTest } from '@/components/shared/toast'

const row: AutoReply = {
  id: 'rule-a', confirmationRevision: 1, name: '営業時間', keyword: '営業時間', matchType: 'contains', keywords: null, respondToAll: false,
  responseType: 'text', responseContent: '10時からです', templateId: null, lineAccountId: 'account-a', isActive: true,
  activeFrom: null, activeUntil: null, cooldownMinutes: null, skipWhenOperatorActive: false, priority: 0, messageKinds: null,
  receiveSources: ['line'], actions: null, responseWeekdays: null, responseHolidayRule: null, oncePerFriend: false,
  friendConditions: null, keywordMatchMode: 'any', folderId: 'folder-a', internalMemo: null, lifecycleStatus: 'published',
  stoppedAt: null, stoppedByStaffId: null, stoppedByStaffName: null, stopReason: null, createdAt: '', hits: { period: 3, total: 8 },
}
const second = { ...row, id: 'rule-b', name: '予約受付', keyword: '予約', priority: 1 }
const proxy = (mode: 'read' | 'write') => ({ impersonation: { id: 'proxy', tenantId: 'tenant', mode, piiRevealed: false, startedAt: '' }, unfamiliarAt: null, stepUpMethod: 'none' as const })
async function flush() { for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve() }) }
async function mount() { const view = render(<AutoRepliesList />); await flush(); return view }
function restrict(kind: string) {
  act(() => {
    if (kind === 'unknown') forgetStaffIdentity()
    else if (kind === 'read-proxy') rememberSessionSnapshot(proxy('read'))
    else rememberStaffIdentity({ ...readStaffIdentity()!, role: kind === 'viewer' ? 'viewer' : 'staff', permissionKeys: [], ...(kind === 'readOnly' ? { readOnly: true } : kind === 'view_only' ? { roleBundle: 'view_only' as const } : {}) })
  })
}
function menu() { fireEvent.click(screen.getByRole('button', { name: '自動応答「営業時間」の操作' })); return screen.getByRole('menu') }
function menuAction(label: string) { fireEvent.click(within(menu()).getByRole('menuitem', { name: label })) }
function writes() { return net.update.mock.calls.length + net.stop.mock.calls.length + net.remove.mock.calls.length + net.create.mock.calls.length }
let media: typeof window.matchMedia
beforeEach(() => {
  verifiedStaffRole('owner'); forgetSessionSnapshot(); vi.clearAllMocks(); delayed.length = 0
  state.account = 'account-a'; state.previewPending = false
  window.history.replaceState(null, '', '/auto-replies')
  media = window.matchMedia
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, media: '', addEventListener: () => {}, removeEventListener: () => {} }) })
  net.list.mockResolvedValue({ success: true, data: [row, second] })
  net.folders.mockResolvedValue({ success: true, data: [{ id: 'folder-a', name: '問合せ', color: '#117755' }], unfiledCount: 0 })
  net.templates.mockResolvedValue({ success: true, data: [] }); net.summary.mockResolvedValue({ success: true, data: { conflictCount: 0 } })
  net.update.mockReset().mockResolvedValue({ success: true, data: null }); net.stop.mockReset().mockResolvedValue({ success: true, data: null })
  net.remove.mockReset().mockResolvedValue({ success: true, data: null }); net.create.mockReset().mockResolvedValue({ success: true, data: { id: 'copy' } })
})
afterEach(() => { cleanup(); clearToastsForTest(); forgetStaffIdentity(); forgetSessionSnapshot(); Object.defineProperty(window, 'matchMedia', { configurable: true, value: media }) })

it.each(['unknown', 'viewer', 'readOnly', 'view_only', 'staff-no-key', 'read-proxy'])('%sでも同じ変更項目を残して拒否し、選択・解除・実行結果は使える', async kind => {
  await mount(); restrict(kind); await flush()
  const creates = screen.getAllByRole('button', { name: /ルールを作る/ }) as HTMLButtonElement[]
  expect(creates.length).toBeGreaterThan(0)
  for (const create of creates) {
    expect(kind === 'unknown' ? create.disabled : create.getAttribute('aria-disabled')).toBe(kind === 'unknown' ? true : 'true')
    fireEvent.click(create)
  }
  const listMenu = menu()
  for (const label of ['編集する', '複製する', '止める', 'フォルダへ移す', '削除する']) {
    const item = within(listMenu).getByRole('menuitem', { name: label }) as HTMLButtonElement
    expect(kind === 'unknown' ? item.disabled : item.getAttribute('aria-disabled')).toBe(kind === 'unknown' ? true : 'true')
    fireEvent.click(item)
  }
  if (kind === 'unknown') expect(document.querySelector('[data-permission-locked], [data-read-only-notice]')).toBeNull()
  fireEvent.click(within(listMenu).getByRole('menuitem', { name: '実行結果を見る' }))
  expect(net.push).toHaveBeenCalledWith('/auto-replies/runs?id=rule-a')
  fireEvent.click(screen.getByRole('checkbox', { name: '営業時間を選択' }))
  const bulk = screen.getByRole('region', { name: '選択中のまとめ操作' })
  for (const label of ['まとめて止める', 'まとめて再開', 'フォルダへ移す']) fireEvent.click(within(bulk).getByRole('button', { name: label }))
  fireEvent.click(within(bulk).getByRole('button', { name: '選択を外す' }))
  expect((screen.getByRole('checkbox', { name: '営業時間を選択' }) as HTMLInputElement).checked).toBe(false)
  expect(writes()).toBe(0); expect(delayed).toHaveLength(0)
  expect(net.list).toHaveBeenCalled(); expect(net.folders).toHaveBeenCalled()
})

it('previewの許可だけtrueで役割hookがnullなら、頭と本文は理由なしdisabled・帯0・操作0となり確定後に動く', async () => {
  state.previewPending = true
  const view = await mount()
  for (const button of screen.getAllByRole('button', { name: /ルールを作る/ })) { expect(button).toHaveProperty('disabled', true); fireEvent.click(button) }
  expect(document.querySelector('[data-permission-locked], [data-read-only-notice]')).toBeNull()
  expect(writes()).toBe(0)
  state.previewPending = false; view.rerender(<AutoRepliesList />); await flush()
  menuAction('複製する'); await flush(); expect(net.create).toHaveBeenCalledTimes(1)
})

it.each(['止める', '削除する', 'フォルダへ移す'])('開いた%sの確認もread切替に追従し、確定を送らない', async label => {
  await mount(); menuAction(label); restrict('read-proxy'); await flush()
  const dialog = screen.getByRole('dialog')
  const confirm = within(dialog).getByRole('button', { name: label === 'フォルダへ移す' ? '移動する' : label })
  expect(confirm.getAttribute('aria-disabled')).toBe('true'); fireEvent.click(confirm)
  expect(writes()).toBe(0); expect(delayed).toHaveLength(0)
  act(() => rememberSessionSnapshot(proxy('write'))); await flush(); fireEvent.click(within(dialog).getByRole('button', { name: label === 'フォルダへ移す' ? '移動する' : label })); await flush()
  expect(label === 'フォルダへ移す' ? delayed.length : writes()).toBe(1)
})

it.each(['移動', '順番'])('遅延する%sはread切替後に送らず、読取を再開する', async kind => {
  await mount()
  if (kind === '移動') { menuAction('フォルダへ移す'); fireEvent.click(screen.getByRole('button', { name: '移動する' })) }
  else fireEvent.keyDown(screen.getByRole('button', { name: '予約受付を並び替え。上下キーで移動' }), { key: 'ArrowUp' })
  expect(delayed).toHaveLength(1)
  restrict('read-proxy')
  await expect(delayed[0].commit()).rejects.toThrow()
  expect(net.update).not.toHaveBeenCalled()
  const reads = net.list.mock.calls.length
  act(() => delayed[0].onCommitError?.()); await flush()
  expect(net.list.mock.calls.length).toBeGreaterThan(reads)
})

it.each(['移動', '順番'])('まとめた%sの1件目を待つ間にreadへ変わると2件目を送らない', async kind => {
  await mount()
  if (kind === '移動') {
    fireEvent.click(screen.getByRole('checkbox', { name: 'このページのルールをすべて選択' }))
    fireEvent.click(within(screen.getByRole('region', { name: '選択中のまとめ操作' })).getByRole('button', { name: 'フォルダへ移す' }))
    fireEvent.click(screen.getByRole('button', { name: '移動する' }))
  } else fireEvent.keyDown(screen.getByRole('button', { name: '予約受付を並び替え。上下キーで移動' }), { key: 'ArrowUp' })
  let release!: (value: { success: boolean; data: null }) => void
  net.update.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const pending = delayed[0].commit()
  expect(net.update).toHaveBeenCalledTimes(1)
  restrict('read-proxy'); release({ success: true, data: null })
  await expect(pending).rejects.toThrow()
  expect(net.update).toHaveBeenCalledTimes(1)
})

it('移動の確認前に店が変わると元の店のルールへ送らず、選択も持ち越さない', async () => {
  const view = await mount()
  fireEvent.click(screen.getByRole('checkbox', { name: '営業時間を選択' })); menuAction('フォルダへ移す')
  state.account = 'account-b'; view.rerender(<AutoRepliesList />); await flush()
  const confirm = screen.getByRole('button', { name: '移動する' }) as HTMLButtonElement
  expect(confirm.disabled).toBe(true); fireEvent.click(confirm)
  expect(writes()).toBe(0); expect(delayed).toHaveLength(0)
  expect((screen.getByRole('checkbox', { name: '営業時間を選択' }) as HTMLInputElement).checked).toBe(false)
})

it.each(['owner', 'viewer'])('自動応答一覧の説明は %s が使える操作に合う', async role => {
  await mount()
  if (role === 'viewer') { restrict('viewer'); await flush() }
  fireEvent.click(screen.getByRole('button', { name: 'この画面の説明' }))
  const note = screen.getAllByRole('note').find(element => element.textContent?.includes('最初に当たった1つだけが動きます'))!
  expect(note).toBeTruthy()
  expect(note.textContent?.includes('行を押すと編集')).toBe(role === 'owner')
  expect(note.textContent?.includes('順番は行の左のつまみで入れ替えます')).toBe(role === 'owner')
  if (role === 'viewer') expect(note.textContent).toContain('実行結果を確認できます')
})
