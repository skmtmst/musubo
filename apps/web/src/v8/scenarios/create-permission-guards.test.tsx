// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StaffMember } from '@line-crm/shared'
import { forgetStaffIdentity, rememberStaffIdentity, readStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { getPageAction } from '@/test-utils/page-action'

const fixture = vi.hoisted(() => ({ search: 'id=sc-1', account: 'account-a', loading: false }))
const calls = vi.hoisted(() => ({ push: vi.fn(), update: vi.fn(), create: vi.fn(), folderCreate: vi.fn(), read: vi.fn(), draftGet: vi.fn(), draftSave: vi.fn(), draftDelete: vi.fn() }))
// Keep the real shared controls. Retained callbacks simulate an event already queued before identity changes.
const held = vi.hoisted(() => ({ save: undefined as undefined | (() => unknown), draft: undefined as undefined | (() => unknown), cancel: undefined as undefined | (() => unknown), draftClear: undefined as undefined | (() => unknown), folder: undefined as undefined | ((name: string, color: string | null) => Promise<unknown>) }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(fixture.search), useRouter: () => ({ push: calls.push, replace: vi.fn(), back: vi.fn() }) }))
vi.mock('next/link', () => ({ default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.account, loading: fixture.loading }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => readStaffIdentity()?.role ?? null }))
vi.mock('@/components/templates', async original => {
  const actual = await original<typeof import('@/components/templates')>()
  const text = (value: React.ReactNode): string => React.Children.toArray(value).map(item => React.isValidElement<{ children?: React.ReactNode }>(item) ? text(item.props.children) : String(item)).join('')
  const capture = (value: React.ReactNode): void => {
    React.Children.forEach(value, item => {
      if (!React.isValidElement<{ children?: React.ReactNode; onClick?: () => unknown }>(item)) return
      const label = text(item.props.children)
      if (item.props.onClick) {
        if (label.includes('この方式で保存する')) held.save = item.props.onClick
        if (label.includes('あとで決める')) held.draft = item.props.onClick
        if (label === 'キャンセル') held.cancel = item.props.onClick
      }
      capture(item.props.children)
    })
  }
  return { ...actual, CreatePage: (props: React.ComponentProps<typeof actual.CreatePage>) => {
    capture(props.footerActions)
    return <actual.CreatePage {...props} />
  } }
})
vi.mock('@/v8/autosave/public/use-scenario-draft/index', async original => {
  const actual = await original<typeof import('@/v8/autosave/public/use-scenario-draft/index')>()
  return { ...actual, useScenarioDraft: <T,>(options: Parameters<typeof actual.useScenarioDraft<T>>[0]) => {
    const draft = actual.useScenarioDraft(options)
    held.draftClear = draft.clear
    return draft
  } }
})
vi.mock('@/components/shared/folder-select', async original => {
  const { default: FolderSelect, ...rest } = await original<typeof import('@/components/shared/folder-select')>()
  return { ...rest, default: (props: React.ComponentProps<typeof FolderSelect>) => { held.folder = props.onCreate; return <FolderSelect {...props} /> } }
})
vi.mock('@/components/scenarios/scenario-reference-data', () => ({ scenarioReferenceData: { scenario: calls.read, invalidateScenario: vi.fn() } }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    scenarios: { ...actual.api.scenarios, update: calls.update, create: calls.create },
    folders: { ...actual.api.folders, list: async () => ({ success: true, data: [] }), create: calls.folderCreate },
    scenarioDrafts: { get: calls.draftGet, save: calls.draftSave, delete: calls.draftDelete },
  } }
})
import * as toast from '@/components/shared/toast'
import ScenarioCreateV8 from './create'
import { ApiError } from '@/lib/api'
const base = { id: 'sc-1', name: '春のフォロー', folderId: null, lineAccountId: 'account-a', deliveryMode: 'elapsed' }
const name = () => screen.getByRole('textbox', { name: 'シナリオ名' }) as HTMLInputElement
const save = () => screen.getByRole('button', { name: /この方式で保存する/ })
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
const proxy = () => rememberSessionSnapshot({ stepUpMethod: 'totp', unfamiliarAt: null, impersonation: { mode: 'read' } as never })
const person = (role: 'owner' | 'admin' | 'staff' | 'viewer', extra: Partial<StaffMember> = {}) => {
  verifiedStaffRole(role)
  rememberStaffIdentity({ ...readStaffIdentity()!, ...extra })
}
const ready = async () => { const view = render(<ScenarioCreateV8 />); await screen.findByDisplayValue(base.name); return view }
const invoke = async (fn: (() => unknown) | undefined) => { expect(fn).toBeTypeOf('function'); await act(async () => { await fn!() }) }
beforeEach(() => {
  forgetSessionSnapshot(); person('owner')
  fixture.search = 'id=sc-1'; fixture.account = 'account-a'; fixture.loading = false
  Object.values(calls).forEach(mock => mock.mockReset())
  held.save = held.draft = held.folder = undefined
  calls.read.mockImplementation(async (id: string) => ({ success: true, data: { ...base, id } }))
  calls.update.mockImplementation(async (_id: string, patch: object) => ({ success: true, data: { ...base, ...patch } }))
  calls.create.mockResolvedValue({ success: true, data: { ...base, id: 'created-1' } })
  calls.folderCreate.mockResolvedValue({ success: true, data: { id: 'folder-new', name: '追加', color: '#008800' } })
  calls.draftGet.mockRejectedValue(new ApiError(404, 'not_found', 'not_found'))
  calls.draftSave.mockImplementation(async (account: string, key: string, body: { content: unknown }) => ({ success: true, data: { key, lineAccountId: account, content: body.content, version: 'v1', updatedAt: new Date().toISOString() } }))
  calls.draftDelete.mockResolvedValue({ success: true })
  document.documentElement.dataset.theme = 'v8'
})
afterEach(() => { cleanup(); forgetStaffIdentity(); forgetSessionSnapshot(); vi.useRealTimers(); localStorage.clear(); sessionStorage.clear() })

const createRoles = ['owner', 'admin', 'staff'] as const
it.each(createRoles.flatMap(role => (['save', 'later'] as const).map(action => ({ role, action }))))('$roleの新規$actionは下書きを1回だけ作り、配信を始めない', async ({ role, action }) => {
  person(role, role === 'staff' ? { permissionKeys: ['/scenarios', 'scenario.definition.edit'] } : {})
  fixture.search = ''
  render(<ScenarioCreateV8 />)
  expect(calls.create).not.toHaveBeenCalled()
  fireEvent.change(name(), { target: { value: '新しい案内' } })
  fireEvent.click(screen.getByRole('radio', { name: /経過時間で指定/ }))
  expect(calls.create).not.toHaveBeenCalled()
  fireEvent.click(getPageAction({ name: action === 'save' ? /この方式で保存する/ : /あとで決める/ }))
  await waitFor(() => expect(calls.push).toHaveBeenCalledWith('/scenarios/first-step?id=created-1'))
  expect(calls.create).toHaveBeenCalledTimes(1)
  expect(calls.create).toHaveBeenCalledWith(expect.objectContaining({
    name: '新しい案内', lineAccountId: 'account-a', isActive: false,
    deliveryMode: action === 'save' ? 'elapsed' : 'absolute_time',
  }))
  expect(calls.update).not.toHaveBeenCalled()
})

it('作成後に1通目の画面へ進むとき、下書き状態と重なる作成通知を出さない', async () => {
  const notify = vi.spyOn(toast, 'notifyToast')
  fixture.search = ''
  render(<ScenarioCreateV8 />)
  fireEvent.change(name(), { target: { value: '新しい案内' } })
  fireEvent.click(screen.getByRole('radio', { name: /経過時間で指定/ }))
  fireEvent.click(save())
  await waitFor(() => expect(calls.push).toHaveBeenCalledWith('/scenarios/first-step?id=created-1'))
  expect(calls.create).toHaveBeenCalledTimes(1)
  expect(notify).not.toHaveBeenCalledWith('シナリオを作りました')
  notify.mockRestore()
})

it.each([false, true])('既存シナリオの有効状態%sは、名前と方式を保存しても変えない', async isActive => {
  calls.read.mockResolvedValue({ success: true, data: { ...base, isActive } })
  await ready()
  fireEvent.click(screen.getByRole('radio', { name: /時刻で指定/ }))
  fireEvent.click(save())
  await waitFor(() => expect(calls.push).toHaveBeenCalledWith('/scenarios/first-step?id=sc-1'))
  expect(calls.update).toHaveBeenCalledWith('sc-1', { name: base.name, folderId: null, deliveryMode: 'absolute_time' })
  expect(calls.create).not.toHaveBeenCalled()
})

it.each(['viewer', 'staff', 'readOnly', 'view_only', 'proxy', 'unknown'] as const)('保持した保存/下書き/blurは%sへの切替後に書かない。読むGETと入力は残す', async kind => {
  await ready()
  fireEvent.change(name(), { target: { value: '残す入力' } })
  const oldSave = held.save, oldDraft = held.draft
  act(() => {
    if (kind === 'viewer' || kind === 'staff') person(kind)
    else if (kind === 'unknown') forgetStaffIdentity()
    else if (kind === 'proxy') proxy()
    else person('owner', kind === 'readOnly' ? { readOnly: true } : { roleBundle: 'view_only' })
  })
  await invoke(oldSave); await invoke(oldDraft)
  fireEvent.blur(name())
  expect(name().value).toBe('残す入力')
  expect(calls.read).toHaveBeenCalledWith('sc-1')
  for (const mutation of [calls.create, calls.update, calls.draftSave, calls.draftDelete]) expect(mutation).not.toHaveBeenCalled()
  expect(calls.push).not.toHaveBeenCalled()
})

it.each(['person', 'read-null', 'account', 'id'] as const)('許可が戻っても%sの古い保存処理は復活しない', async kind => {
  const view = await ready()
  const old = held.save
  act(() => {
    if (kind === 'person') { const owner = readStaffIdentity()!; forgetStaffIdentity(); rememberStaffIdentity(owner) }
    if (kind === 'read-null') { proxy(); forgetSessionSnapshot() }
  })
  if (kind === 'account' || kind === 'id') {
    if (kind === 'account') fixture.account = 'account-b'; else fixture.search = 'id=sc-2'
    view.rerender(<ScenarioCreateV8 />)
    if (kind === 'account') fixture.account = 'account-a'; else fixture.search = 'id=sc-1'
    view.rerender(<ScenarioCreateV8 />)
  }
  await invoke(old)
  expect(calls.update).not.toHaveBeenCalled()
  expect(calls.push).not.toHaveBeenCalled()
})

it('情報の保存を待つ間にread代理へ切り替わると、方式更新と下書き削除と遷移を止める', async () => {
  const pending = deferred<unknown>()
  calls.update.mockReturnValue(pending.promise)
  await ready()
  fireEvent.change(name(), { target: { value: '途中の入力' } })
  fireEvent.blur(name())
  expect(calls.update).toHaveBeenCalledTimes(1)
  let choosing!: unknown
  act(() => { choosing = held.save!() })
  act(() => proxy())
  await act(async () => { pending.resolve({ success: true, data: { ...base, name: '途中の入力' } }); await choosing })
  expect(calls.update).toHaveBeenCalledTimes(1)
  expect(calls.draftDelete).not.toHaveBeenCalled()
  expect(calls.push).not.toHaveBeenCalled()
  expect(name().value).toBe('途中の入力')
})

it('方式保存と下書き続行を同時に要求しても更新は1回', async () => {
  const pending = deferred<unknown>(); calls.update.mockReturnValue(pending.promise)
  await ready()
  const first = held.save, second = held.draft
  let saving!: unknown
  act(() => { saving = first!() })
  await invoke(second)
  expect(calls.update).toHaveBeenCalledTimes(1)
  await act(async () => { pending.resolve({ success: true, data: base }); await saving })
  expect(calls.push).toHaveBeenCalledTimes(1)
})

it('作成応答中に拒否へ変わっても作成済みIDを残し、許可復帰後に二重作成しない', async () => {
  fixture.search = ''; const pending = deferred<unknown>(); calls.create.mockReturnValue(pending.promise)
  render(<ScenarioCreateV8 />)
  fireEvent.change(name(), { target: { value: '残す新規入力' } })
  let creating!: unknown
  act(() => { creating = held.save!() })
  act(() => proxy())
  await act(async () => { pending.resolve({ success: true, data: { ...base, id: 'created-1' } }); await creating })
  expect(screen.getByRole('link', { name: '作成済みのシナリオを見る' }).getAttribute('href')).toBe('/scenarios/detail?id=created-1')
  expect(calls.push).not.toHaveBeenCalled()
  expect(calls.draftDelete).not.toHaveBeenCalled()
  act(() => forgetSessionSnapshot())
  await invoke(held.save)
  expect(calls.create).toHaveBeenCalledTimes(1)
  expect(name().value).toBe('残す新規入力')
})

it('所属を切り替えた後の古い作成応答を、新しい画面の作成済みIDにしない', async () => {
  fixture.search = ''; const pending = deferred<unknown>(); calls.create.mockReturnValue(pending.promise)
  const view = render(<ScenarioCreateV8 />)
  fireEvent.change(name(), { target: { value: '元の入力' } })
  let creating!: unknown
  act(() => { creating = held.save!() })
  fixture.account = 'account-b'; view.rerender(<ScenarioCreateV8 />)
  await act(async () => { pending.resolve({ success: true, data: { ...base, id: 'old-account-created' } }); await creating })
  expect(screen.queryByRole('link', { name: '作成済みのシナリオを見る' })).toBeNull()
  expect(calls.push).not.toHaveBeenCalled()
})

it('account読込中とunmount後の保持callbackは書かない', async () => {
  const view = await ready(); const old = held.save
  fixture.loading = true; view.rerender(<ScenarioCreateV8 />)
  await invoke(old); await invoke(held.save)
  expect(calls.update).not.toHaveBeenCalled()
  view.unmount()
  await invoke(old)
  expect(calls.update).not.toHaveBeenCalled()
})

it('folder管理は編集staffの保持callbackでも拒み、選択済みのfolderは変えない', async () => {
  await ready(); await waitFor(() => expect(held.folder).toBeTypeOf('function'))
  const oldFolder = held.folder!
  act(() => person('staff', { permissionKeys: ['/scenarios', 'scenario.definition.edit'] }))
  await expect(oldFolder('追加', null)).rejects.toThrow(/確認状態/)
  expect(calls.folderCreate).not.toHaveBeenCalled()
  expect(calls.update).not.toHaveBeenCalled()
})

it('folder作成の応答を待つ間のrole変更は追加選択と情報更新を止める', async () => {
  const pending = deferred<unknown>(); calls.folderCreate.mockReturnValue(pending.promise)
  await ready(); await waitFor(() => expect(held.folder).toBeTypeOf('function'))
  let creating!: Promise<unknown>
  act(() => { creating = held.folder!('追加', null) })
  act(() => proxy())
  const rejected = expect(creating).rejects.toThrow(/作成済み/)
  await act(async () => { pending.resolve({ success: true, data: { id: 'new-folder', name: '追加', color: '#008800' } }); await rejected })
  expect(calls.folderCreate).toHaveBeenCalledTimes(1)
  expect(calls.update).not.toHaveBeenCalled()
  expect(screen.queryByText('追加')).toBeNull()
})

it('ownerの情報保存とfolder作成は通常どおり進む', async () => {
  await ready()
  fireEvent.change(name(), { target: { value: '変更した名前' } })
  fireEvent.blur(name())
  await waitFor(() => expect(calls.update).toHaveBeenCalledWith('sc-1', { name: '変更した名前', folderId: null }))
  await waitFor(() => expect(held.folder).toBeTypeOf('function'))
  await act(async () => { await held.folder!('追加', null) })
  expect(calls.folderCreate).toHaveBeenCalledTimes(1)
})

it.each(['owner', 'staff'] as const)('%sの下書き接続は通常のGETと保存を維持する', async role => {
  person(role, role === 'staff' ? { permissionKeys: ['/scenarios', 'scenario.definition.edit'] } : {})
  await ready()
  await waitFor(() => expect(calls.draftGet).toHaveBeenCalledWith('account-a', 'scenario:sc-1:info'))
  // 下書きの初回取得と、その結果を反映する React の更新が終わってから時計を進める。
  await act(async () => { await calls.draftGet.mock.results[0].value.catch(() => {}) })
  vi.useFakeTimers()
  fireEvent.change(name(), { target: { value: '書きかけ' } })
  await act(async () => { await vi.advanceTimersByTimeAsync(2200) })
  expect(calls.draftGet).toHaveBeenCalled()
  expect(calls.draftSave).toHaveBeenCalledTimes(1)
  expect(calls.draftSave).toHaveBeenCalledWith('account-a', 'scenario:sc-1:info', expect.objectContaining({ content: { value: { name: '書きかけ', folderId: '', mode: 'elapsed' } } }))
  expect(calls.create).not.toHaveBeenCalled()
})

it('入力後タイマーの前にread代理へ変わると自動保存0。保存済みの読取と入力を残す', async () => {
  await ready()
  await waitFor(() => expect(calls.draftGet).toHaveBeenCalledWith('account-a', 'scenario:sc-1:info'))
  await act(async () => { await calls.draftGet.mock.results[0].value.catch(() => {}) })
  vi.useFakeTimers()
  fireEvent.change(name(), { target: { value: '書きかけを保持' } })
  act(() => proxy())
  await act(async () => { await vi.advanceTimersByTimeAsync(2200) })
  expect(calls.draftGet).toHaveBeenCalled()
  expect(calls.draftSave).not.toHaveBeenCalled()
  expect(calls.draftDelete).not.toHaveBeenCalled()
  expect(name().value).toBe('書きかけを保持')
})


it('read代理でキャンセルしても、新規下書きのキーを捨てない', async () => {
  fixture.search = ''
  render(<ScenarioCreateV8 />)
  await waitFor(() => expect(localStorage.getItem('lh:v8-draft-key:scenario-create:account-a')).toBeTruthy())
  const key = localStorage.getItem('lh:v8-draft-key:scenario-create:account-a')
  act(() => proxy())
  await invoke(held.cancel)
  expect(localStorage.getItem('lh:v8-draft-key:scenario-create:account-a')).toBe(key)
  expect(calls.draftDelete).not.toHaveBeenCalled()
  expect(calls.push).toHaveBeenCalledWith('/scenarios')
})

it('画面を閉じた後は、同じaccountの保持callbackでも書かない', async () => {
  const view = await ready(); const old = held.save
  view.unmount()
  await invoke(old)
  expect(calls.update).not.toHaveBeenCalled()
})

it('方式更新の応答前にread代理へ替わると、下書き削除と遷移を止める', async () => {
  const pending = deferred<unknown>(); calls.update.mockReturnValue(pending.promise)
  await ready()
  let saving!: unknown
  act(() => { saving = held.save!() })
  act(() => proxy())
  await act(async () => { pending.resolve({ success: true, data: base }); await saving })
  expect(calls.update).toHaveBeenCalledTimes(1)
  expect(calls.draftDelete).not.toHaveBeenCalled()
  expect(calls.push).not.toHaveBeenCalled()
})

it('blur保存中に本人が替わった時は、返答で手元の入力を置き換えない', async () => {
  const pending = deferred<unknown>(); calls.update.mockReturnValue(pending.promise)
  await ready()
  fireEvent.change(name(), { target: { value: '手元に残す名前' } })
  fireEvent.blur(name())
  act(() => proxy())
  await act(async () => { pending.resolve({ success: true, data: { ...base, name: 'サーバーの正規化名' } }); await Promise.resolve() })
  expect(name().value).toBe('手元に残す名前')
  expect(calls.update).toHaveBeenCalledTimes(1)
})


it.each(['proxy', 'person'] as const)('下書きの守りは保持した捨てる操作も%s切替後に止める', async kind => {
  calls.draftGet.mockImplementation(async (account: string, key: string) => ({ success: true, data: {
    key, lineAccountId: account, content: { value: { name: '残す下書き', folderId: '', mode: 'elapsed' } }, version: 'remote-v1', updatedAt: new Date().toISOString(),
  } }))
  await ready()
  await screen.findByRole('button', { name: '前の入力を戻す' })
  const discard = held.draftClear
  act(() => { if (kind === 'proxy') proxy(); else person('owner', { id: 'different-owner' }) })
  await invoke(discard)
  expect(calls.draftDelete).not.toHaveBeenCalled()
  expect(calls.draftGet).toHaveBeenCalled()
})


it('保持された空欄保存でもAPI0で、欄の必須理由と焦点を残す', async () => {
  fixture.search = ''
  render(<ScenarioCreateV8 />)
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
  await invoke(held.save)
  expect(calls.create).not.toHaveBeenCalled()
  expect(name().getAttribute('aria-invalid')).toBe('true')
  expect(name().getAttribute('aria-describedby')).toContain('scenario-name-error')
  expect(screen.getByText('シナリオ名を入力してください', { selector: '#scenario-name-error' })).toBeTruthy()
  expect(document.activeElement).toBe(name())
  expect(scroll).toHaveBeenCalledWith({ block: 'center' })
  scroll.mockRestore()
})


it.each(['new', 'existing'] as const)('保持した下書き保存の%sも、空欄の必須理由/焦点/スクロールを守り書込0', async kind => {
  if (kind === 'new') { fixture.search = ''; render(<ScenarioCreateV8 />) }
  else { await ready(); fireEvent.change(name(), { target: { value: '' } }) }
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
  try {
    await invoke(held.draft)
    expect(name().getAttribute('aria-invalid')).toBe('true')
    expect(name().getAttribute('aria-describedby')).toContain('scenario-name-error')
    expect(screen.getByText('シナリオ名を入力してください', { selector: '#scenario-name-error' })).toBeTruthy()
    expect(document.activeElement).toBe(name())
    expect(scroll).toHaveBeenCalledWith({ block: 'center' })
    for (const write of [calls.create, calls.update, calls.draftSave, calls.draftDelete, calls.push]) expect(write).not.toHaveBeenCalled()
  } finally { scroll.mockRestore() }
})
