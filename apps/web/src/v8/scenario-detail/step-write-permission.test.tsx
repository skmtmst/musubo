// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { StrictMode, type PropsWithChildren } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StaffMember } from '@line-crm/shared'
import { forgetStaffIdentity, readStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
const account = vi.hoisted(() => ({ selectedAccountId: 'account-a', loading: false }))
const calls = vi.hoisted(() => ({ update: vi.fn(), add: vi.fn(), reorder: vi.fn(), remove: vi.fn(), listActions: vi.fn(), removeAction: vi.fn(), createAction: vi.fn() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => account }))
// The hook under test uses the production access lease; screen imports are irrelevant here.
vi.mock('@/v8/scenarios', async () => await import('@/v8/scenarios/write-access'))
const validation = vi.hoisted(() => ({ problem: null as null | { field: 'question' | 'content'; message: string } }))
vi.mock('./step-validation', () => ({ validateScenarioStep: () => validation.problem }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, scenarios: { ...actual.api.scenarios,
    updateStep: calls.update, addStep: calls.add, reorderSteps: calls.reorder, deleteStep: calls.remove,
    actions: { ...actual.api.scenarios.actions, list: calls.listActions, remove: calls.removeAction, create: calls.createAction },
  } } }
})
import { useScenarioStepActions } from './use-scenario-step-actions'
import { emptyStepForm } from './detail-model'
import { emptyMessageKindState } from '@/components/scenarios/message-kind-fields'
const question = { text: '選んでください', choices: [{ id: 'choice-a', key: 'a', label: 'A', behavior: 'none' }, { id: 'choice-b', key: 'b', label: 'B', behavior: 'none' }] }
const step = { id: 'step-1', stepOrder: 1, messageType: 'text', messageContent: '残す本文', question, offsetDays: 0, deliveryTime: '10:00', afterSend: 'continue' }
const second = { ...step, id: 'step-2', stepOrder: 2 }
const person = (role: 'owner'|'admin'|'staff'|'viewer', extra: object = {}) => rememberStaffIdentity({ id: 'person', role, permissionKeys: [], ...extra } as unknown as StaffMember)
const readProxy = () => rememberSessionSnapshot({ stepUpMethod: 'totp', unfamiliarAt: null, impersonation: { mode: 'read' } as never })
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { resolve, promise } }
function props() {
  const result = {
    scenario: { id: 'scenario-a', lineAccountId: 'account-a', steps: [step, second] }, id: 'scenario-a',
    stepForm: { ...emptyStepForm(1), messageContent: '残す本文', question: { ...question, choices: [...question.choices].reverse() } },
    kindState: emptyMessageKindState(), editingStepId: 'step-1', deliveryMode: 'absolute_time',
    sortedSteps: [step, second], insertAfter: null, templates: [], duplicatingStepId: null, deletingStepId: null, deleteStepTarget: step, deleteStepRevision: 1, deleteStepConfirmationValid: () => true,
    saveErrors: { capture: vi.fn() }, stepFields: { reset: vi.fn() }, stepDraft: { clear: vi.fn() },
    failStep: vi.fn(), loadScenario: vi.fn(async () => {}), reloadStats: vi.fn(),
    setStepForm: vi.fn(), setEditingStepId: vi.fn(), setShowStepForm: vi.fn(), setInsertAfter: vi.fn(), setStepError: vi.fn(), setStepFormNonce: vi.fn(), setKindState: vi.fn(), setStepSaving: vi.fn(), setDuplicatingStepId: vi.fn(), setDeletingStepId: vi.fn(), setDeleteStepError: vi.fn(), setDeleteStepTarget: vi.fn(), setError: vi.fn(),
  }
  return result as unknown as Parameters<typeof useScenarioStepActions>[0] & { [K in 'setStepError'|'setError'|'setDeleteStepError'|'setShowStepForm']: ReturnType<typeof vi.fn> }
}
const writes = () => Object.entries(calls).filter(([name]) => name !== 'listActions').map(([,fn]) => fn)
const invoke = async (fn: () => unknown) => { await act(async () => { await fn() }) }
beforeEach(() => {
  validation.problem = null
  forgetSessionSnapshot(); person('owner'); account.selectedAccountId = 'account-a'; account.loading = false
  Object.values(calls).forEach(fn => fn.mockReset())
  writes().forEach(fn => fn.mockResolvedValue({ success: true, data: step }))
  calls.listActions.mockResolvedValue({ success: true, data: [] })
})
afterEach(() => { cleanup(); forgetStaffIdentity(); forgetSessionSnapshot() })
const actions = ['save', 'add', 'duplicate', 'delete', 'move'] as const
function runAction(hook: ReturnType<typeof useScenarioStepActions>, kind: typeof actions[number]) {
  return kind === 'save' || kind === 'add' ? hook.handleSaveStep() : kind === 'duplicate' ? hook.handleDuplicateStep(step as never) : kind === 'delete' ? hook.handleDeleteStep() : hook.handleMoveStep('step-1', 'down')
}
it.each(['owner','admin','staff'] as const)('%sの編集権限で更新・追加・複製・削除・並べ替えを通す', async role => {
  person(role, role === 'staff' ? { permissionKeys: ['/scenarios','scenario.definition.edit'] } : {})
  for (const kind of actions) {
    const p = props(); if (kind === 'add') p.editingStepId = null
    const view = renderHook(() => useScenarioStepActions(p))
    await invoke(() => runAction(view.result.current, kind)); view.unmount()
  }
  expect(calls.update).toHaveBeenCalledTimes(1); expect(calls.add).toHaveBeenCalledTimes(2)
  expect(calls.remove).toHaveBeenCalledTimes(1); expect(calls.reorder).toHaveBeenCalledTimes(2)
})
it.each(['viewer','staff','readOnly','view_only','proxy','unknown'] as const)('%sへ替わると保持された全writeは0で、読む編集は残る', async kind => {
  const p = props(); const view = renderHook(() => useScenarioStepActions(p)); const held = view.result.current
  act(() => {
    if (kind === 'viewer' || kind === 'staff') person(kind)
    else if (kind === 'proxy') readProxy()
    else if (kind === 'unknown') forgetStaffIdentity()
    else person('owner', kind === 'readOnly' ? { readOnly: true } : { roleBundle: 'view_only' })
  })
  for (const action of actions) await invoke(() => runAction(held, action))
  writes().forEach(fn => expect(fn).not.toHaveBeenCalled())
  await invoke(() => held.openEditStep(step as never)); expect(p.setStepForm).toHaveBeenCalled()
  expect(p.stepDraft.clear).not.toHaveBeenCalled()
  expect(p.setStepError).toHaveBeenCalledWith(expect.stringMatching(kind === 'unknown' ? /本人の確認/ : /権限が変わった/))
})
it.each(['person','session','id','account','loading','unmount'] as const)('%sが替わった古い操作は許可が戻っても復活しない', async kind => {
  let p = props(); const view = renderHook(() => useScenarioStepActions(p)); const held = view.result.current
  if (kind === 'person') { const owner = readStaffIdentity()!; forgetStaffIdentity(); rememberStaffIdentity(owner) }
  if (kind === 'session') { readProxy(); forgetSessionSnapshot() }
  if (kind === 'id') { const old=p; p={...p,id:'scenario-b'}; view.rerender(); p=old; view.rerender() }
  if (kind === 'account') { account.selectedAccountId='b'; view.rerender(); account.selectedAccountId='account-a'; view.rerender() }
  if (kind === 'loading') { account.loading=true; view.rerender(); account.loading=false; view.rerender() }
  if (kind === 'unmount') view.unmount()
  for (const action of actions) await invoke(() => runAction(held, action))
  writes().forEach(fn => expect(fn).not.toHaveBeenCalled()); expect(p.stepDraft.clear).not.toHaveBeenCalled()
})
it.each(['add','duplicate'] as const)('挿入%sの並べ替え後に権限が外れると、後続追加は0・入力と窓を残す', async kind => {
  const pending=deferred<unknown>(); calls.reorder.mockReturnValue(pending.promise)
  const p=props(); p.editingStepId=null; p.insertAfter=1
  const view=renderHook(() => useScenarioStepActions(p)); let task!: Promise<unknown>
  act(() => { task=runAction(view.result.current,kind) }); expect(calls.reorder).toHaveBeenCalledTimes(1)
  act(() => readProxy()); await act(async () => { pending.resolve({success:true}); await task })
  expect(calls.add).not.toHaveBeenCalled(); expect(p.stepDraft.clear).not.toHaveBeenCalled(); expect(p.setShowStepForm).not.toHaveBeenCalledWith(false)
  expect(p.setStepError).toHaveBeenCalledWith(expect.stringMatching(/権限が変わった/))
})
it('更新応答後に権限が外れると動作の付け替えと下書き削除をしない', async () => {
  const pending=deferred<unknown>(); calls.update.mockReturnValue(pending.promise)
  const p=props(); const view=renderHook(() => useScenarioStepActions(p)); let task!: Promise<unknown>
  act(() => { task=view.result.current.handleSaveStep() }); act(() => readProxy())
  await act(async () => { pending.resolve({success:true}); await task })
  expect(calls.update).toHaveBeenCalledTimes(1); expect(calls.listActions).not.toHaveBeenCalled(); expect(calls.removeAction).not.toHaveBeenCalled(); expect(p.stepDraft.clear).not.toHaveBeenCalled()
})
it.each(['list','remove'] as const)('選択肢の動作の%sの後に権限が外れると、次の書き込みは0', async phase => {
  const pending=deferred<unknown>(); const rows=[{id:'action-a',hook:'choice_selected',stepId:'step-1',choiceIndex:0,actionType:'add_tag',config:{tagId:'tag-a'}}]
  calls.listActions.mockResolvedValue({success:true,data:rows})
  if (phase==='list') calls.listActions.mockReturnValue(pending.promise); else calls.removeAction.mockReturnValue(pending.promise)
  const p=props(); const view=renderHook(() => useScenarioStepActions(p)); let task!: Promise<unknown>
  await act(async () => { task=view.result.current.handleSaveStep(); await Promise.resolve() })
  expect(phase==='list'?calls.listActions:calls.removeAction).toHaveBeenCalledTimes(1)
  act(() => readProxy()); await act(async () => { pending.resolve({success:true,data:phase==='list'?rows:undefined}); await task })
  if(phase==='list') expect(calls.removeAction).not.toHaveBeenCalled()
  expect(calls.createAction).not.toHaveBeenCalled(); expect(p.stepDraft.clear).not.toHaveBeenCalled(); expect(p.setShowStepForm).not.toHaveBeenCalledWith(false)
})
it('正しい編集者の質問更新は既存の動作を削除して同じ内容でつなぎ直す', async () => {
  calls.listActions.mockResolvedValue({success:true,data:[{id:'action-a',hook:'choice_selected',stepId:'step-1',choiceIndex:0,actionType:'add_tag',config:{tagId:'tag-a'}}]})
  const p=props(); const view=renderHook(() => useScenarioStepActions(p)); await invoke(view.result.current.handleSaveStep)
  expect(calls.removeAction).toHaveBeenCalledWith('scenario-a','action-a')
  expect(calls.createAction).toHaveBeenCalledWith('scenario-a',expect.objectContaining({choiceIndex:1,config:{tagId:'tag-a'}}))
  expect(p.stepDraft.clear).toHaveBeenCalledTimes(1); expect(p.setShowStepForm).toHaveBeenCalledWith(false)
})

it('削除の開始後に権限が外れた場合も、APIの直前で止める', async () => {
  const p=props(); vi.mocked(p.setDeletingStepId).mockImplementation(() => { person('viewer') })
  const view=renderHook(() => useScenarioStepActions(p)); calls.remove.mockClear()
  // The scope initialization calls the setter too; establish the editor again before rendering.
  person('owner'); view.rerender()
  await invoke(view.result.current.handleDeleteStep)
  expect(calls.remove).not.toHaveBeenCalled(); expect(p.setDeleteStepError).toHaveBeenCalledWith(expect.stringMatching(/権限が変わった/))
})
it('古い対象の更新応答は新しい対象の入力や成功表示を変えない', async () => {
  const pending=deferred<unknown>(); calls.update.mockReturnValue(pending.promise)
  let p=props(); const first=p; const view=renderHook(() => useScenarioStepActions(p)); let task!: Promise<unknown>
  act(() => { task=view.result.current.handleSaveStep() })
  p={...props(),id:'scenario-b',scenario:{...p.scenario!,id:'scenario-b'}}; view.rerender()
  await act(async () => { pending.resolve({success:true}); await task })
  expect(first.stepDraft.clear).not.toHaveBeenCalled(); expect(p.stepDraft.clear).not.toHaveBeenCalled()
  expect(first.setShowStepForm).not.toHaveBeenCalledWith(false); expect(p.setShowStepForm).not.toHaveBeenCalledWith(false)
  expect(calls.removeAction).not.toHaveBeenCalled()
})

it('StrictModeの2回描画とeffect再設定でも編集者の保存を誤って拒否しない', async () => {
  const p=props(); const view=renderHook(() => useScenarioStepActions(p), { wrapper: ({children}: PropsWithChildren) => <StrictMode>{children}</StrictMode> })
  await invoke(view.result.current.handleSaveStep)
  expect(calls.update).toHaveBeenCalledTimes(1); expect(p.stepDraft.clear).toHaveBeenCalledTimes(1)
  expect(p.setStepError).not.toHaveBeenCalledWith(expect.stringMatching(/権限が変わった/))
})
it('保存の途中で失効して復帰しても、保持した古い保存を押し直すと次のAPIは0', async () => {
  const pending=deferred<unknown>(); calls.update.mockReturnValue(pending.promise)
  const p=props(); const view=renderHook(() => useScenarioStepActions(p)); const old=view.result.current.handleSaveStep; let task!: Promise<unknown>
  act(() => { task=old() }); expect(calls.update).toHaveBeenCalledTimes(1)
  act(() => readProxy()); await act(async () => { pending.resolve({success:true}); await task })
  act(() => forgetSessionSnapshot()); writes().forEach(fn => fn.mockClear())
  await invoke(old); writes().forEach(fn => expect(fn).not.toHaveBeenCalled()); expect(p.stepDraft.clear).not.toHaveBeenCalled()
})

it.each(['loading','missing','mismatch'] as const)('%sは権限拒否と混同せず読み込みの案内で全writeを止める', async kind => {
  const p=props(); if(kind==='loading') account.loading=true
  if(kind==='missing') p.scenario=null
  if(kind==='mismatch') p.id='scenario-b'
  const view=renderHook(() => useScenarioStepActions(p))
  for(const action of actions) await invoke(() => runAction(view.result.current,action))
  writes().forEach(fn => expect(fn).not.toHaveBeenCalled())
  expect(p.setStepError).toHaveBeenCalledWith('画面の読み込みが終わるまで、この操作はできません。')
  expect(p.setStepError).not.toHaveBeenCalledWith(expect.stringMatching(/権限が変わった/))
  expect(p.stepDraft.clear).not.toHaveBeenCalled()
})

it('長い選択肢のclient検証が落ちたらserver誤りに変えず、保存せずに欄へ案内する', async () => {
  validation.problem = { field: 'question', message: 'ボタンの文字は20文字以内で入力してください。' }
  const p = props()
  const submit = vi.fn(() => [{ key: 'question', label: '質問' }])
  p.stepFields.submit = submit
  const view = renderHook(() => useScenarioStepActions(p))
  await invoke(() => view.result.current.handleSaveStep())
  expect(submit).toHaveBeenCalledOnce()
  expect(p.setStepError).toHaveBeenCalledWith('')
  expect(p.failStep).not.toHaveBeenCalled()
  expect(calls.update).not.toHaveBeenCalled()
  expect(calls.add).not.toHaveBeenCalled()
  view.unmount()
})

it.each(['question', 'content'] as const)('既存の%sの問題は従来の欄の失敗経路を保つ', async field => {
  validation.problem = { field, message: '入力を確認してください。' }
  const p = props()
  const submit = vi.fn(() => [])
  p.stepFields.submit = submit
  const view = renderHook(() => useScenarioStepActions(p))
  await invoke(() => view.result.current.handleSaveStep())
  expect(submit).toHaveBeenCalledTimes(field === 'question' ? 1 : 0)
  expect(p.failStep).toHaveBeenCalledWith(field, '入力を確認してください。')
  expect(calls.update).not.toHaveBeenCalled()
  expect(calls.add).not.toHaveBeenCalled()
  view.unmount()
})
