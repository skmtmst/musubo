// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ role: 'owner' as 'owner' | 'viewer', account: 'a', impact: vi.fn(), remove: vi.fn(), setStatus: vi.fn(), detail: vi.fn(), pin: vi.fn(), broadcast: vi.fn(), scenario: vi.fn(), form: vi.fn(), pinScenario: vi.fn(), pinScenarioAction: vi.fn(), pinForm: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams('id=var-1') }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: state.account, loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => state.role }))
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    folders: { ...actual.api.folders, list: async () => ({ success: true, data: [] }) },
    broadcasts: { ...actual.api.broadcasts, get: state.broadcast },
    scenarios: { ...actual.api.scenarios, get: state.scenario },
    forms: { ...actual.api.forms, get: state.form },
    commonVars: { ...actual.api.commonVars,
      detail: state.detail, pinBroadcast: state.pin, pinScenario: state.pinScenario, pinScenarioAction: state.pinScenarioAction, pinForm: state.pinForm,
      schedules: async () => ({ success: true, data: [] }), deleteImpact: state.impact, delete: state.remove, setStatus: state.setStatus,
    },
  } }
})
import Editor from './edit'
import { ApiError } from '@/lib/api'

beforeEach(() => {
  state.detail.mockReset().mockResolvedValue({ success: true, data: { id: 'var-1', name: '営業時間', key: 'hours', type: 'text', value: '10時', memo: '', status: 'active', validFrom: null, validUntil: null, version: 1, usages: [], history: [{ id: 'version-1', version: 1 }], usageCount: 0, usagePage: { total: 0, shown: 0 } } })
  state.pin.mockReset().mockResolvedValue({ success: true })
  state.broadcast.mockReset().mockResolvedValue({ success: true, data: { version: 4 } })
  state.scenario.mockReset().mockResolvedValue({ success: true, data: { contentRevision: 5 } })
  state.form.mockReset().mockResolvedValue({ success: true, data: { contentRevision: 6 } })
  state.pinScenario.mockReset().mockResolvedValue({ success: true })
  state.pinScenarioAction.mockReset().mockResolvedValue({ success: true })
  state.pinForm.mockReset().mockResolvedValue({ success: true })
  state.role = 'owner'
  state.account = 'a'
  state.impact.mockReset().mockResolvedValue({ success: true, data: {
    variable: { id: 'var-1', name: '営業時間', varKey: 'hours' }, total: 0, blockingTotal: 0,
    historicalTotal: 0, unscopedFormTotal: 0, canDelete: true, byKind: {}, items: [],
    unavailableReferences: [], checkedAt: '2026-10-14T00:00:00+09:00', recommendedAction: 'delete',
  } })
  state.remove.mockReset()
  state.setStatus.mockReset().mockResolvedValue({ success: true })
})
afterEach(cleanup)

it('下帯の削除入口は赤い文字で、押すと使用先を確認し、取消では削除しない', async () => {
  render(<Editor />)
  const trigger = await screen.findByRole('button', { name: '削除する', exact: true })
  expect(trigger.getAttribute('data-variant')).toBe('text')
  expect(trigger.className).toContain('textDanger')
  expect(trigger.querySelector('svg')).toBeNull()
  expect(trigger.closest('[data-shared-part="sticky-bar"]')).not.toBeNull()
  fireEvent.click(trigger)
  const dialog = await screen.findByRole('alertdialog')
  expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
  expect(within(dialog).getByText('環境')).toBeTruthy()
  await within(dialog).findByText('使っている設定はありません。')
  expect(state.impact).toHaveBeenCalledWith('var-1', 'a')
  expect(within(dialog).queryByRole('button', { name: '削除する', exact: true })).toBeNull()
  fireEvent.change(within(dialog).getByRole('textbox', { name: /消した理由/ }), { target: { value: '店舗情報の変更のため' } })
  const confirm = within(dialog).getByRole('button', { name: '削除する', exact: true })
  expect(confirm.getAttribute('data-variant')).toBe('text')
  expect(confirm.className).toContain('textDanger')
  expect(confirm.querySelector('svg')).toBeNull()
  expect(state.remove).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: '閉じる', exact: true }))
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
  expect(state.remove).not.toHaveBeenCalled()
})

it('閲覧のみの人には、下帯の削除入口を出さない', async () => {
  state.role = 'viewer'
  render(<Editor />)
  await screen.findByRole('heading', { name: '営業時間', exact: true })
  expect(screen.queryByRole('button', { name: '削除する', exact: true })).toBeNull()
  expect(state.impact).not.toHaveBeenCalled()
  expect(state.remove).not.toHaveBeenCalled()
})

it('状態変更の確認に対象アカウントと環境を表示する', async () => {
  render(<Editor />)
  fireEvent.click(await screen.findByRole('button', { name: '止める', exact: true }))
  const dialog = await screen.findByRole('dialog', { name: '「営業時間」を止める' })
  expect(within(dialog).getByText('LINEアカウント')).toBeTruthy()
  expect(within(dialog).getByText('環境')).toBeTruthy()
})

it('状態変更の理由は必須と表示し、空欄では送信しない', async () => {
  render(<Editor />)
  fireEvent.click(await screen.findByRole('button', { name: '止める', exact: true }))
  const dialog = await screen.findByRole('dialog', { name: '「営業時間」を止める' })
  expect(within(dialog).getByText('必須', { exact: true })).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '止める', exact: true }))
  expect(await within(dialog).findByText('変える理由を入力してください')).toBeTruthy()
  expect(state.setStatus).not.toHaveBeenCalled()
})

it('理由を入力した状態変更は対象アカウントへ一度だけ送る', async () => {
  render(<Editor />)
  fireEvent.click(await screen.findByRole('button', { name: '止める', exact: true }))
  const dialog = await screen.findByRole('dialog', { name: '「営業時間」を止める' })
  fireEvent.change(within(dialog).getByPlaceholderText('例：キャンペーンが終わったため'), { target: { value: '整理のため' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '止める', exact: true }))
  await waitFor(() => expect(state.setStatus).toHaveBeenCalledWith('var-1', 'a', { to: 'stopped', changeReason: '整理のため', expectedVersion: 1 }))
  expect(state.setStatus).toHaveBeenCalledTimes(1)
})

it('切り替えて戻した後に古い状態変更の確定は送らない', async () => {
  const view = render(<Editor />)
  fireEvent.click(await screen.findByRole('button', { name: '止める', exact: true }))
  const dialog = await screen.findByRole('dialog', { name: '「営業時間」を止める' })
  fireEvent.change(within(dialog).getByPlaceholderText('例：キャンペーンが終わったため'), { target: { value: '整理のため' } })
  const target = within(dialog).getByRole('button', { name: '止める', exact: true })
  const key = Object.keys(target).find(item => item.startsWith('__reactProps$'))!
  const handler = (target as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
  state.account = 'b'; view.rerender(<Editor />)
  state.account = 'a'; view.rerender(<Editor />)
  await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: target, target })
  expect(state.setStatus).not.toHaveBeenCalled()
})

it('確認と理由がそろったら対象アカウントで一度だけ削除する', async () => {
  state.remove.mockResolvedValue({ success: true })
  render(<Editor />)
  fireEvent.click(await screen.findByRole('button', { name: '削除する', exact: true }))
  const dialog = await screen.findByRole('alertdialog')
  await within(dialog).findByText('使っている設定はありません。')
  fireEvent.change(within(dialog).getByRole('textbox', { name: /消した理由/ }), { target: { value: '整理のため' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '削除する', exact: true }))
  await waitFor(() => expect(state.remove).toHaveBeenCalledWith('var-1', 'a', '整理のため'))
  expect(state.remove).toHaveBeenCalledTimes(1)
  expect(screen.queryByText(/LINEアカウントが切り替わりました/)).toBeNull()
})

it('アカウントを切り替えて戻しても古い削除確定は送らない', async () => {
  const view = render(<Editor />)
  fireEvent.click(await screen.findByRole('button', { name: '削除する', exact: true }))
  const dialog = await screen.findByRole('alertdialog')
  await within(dialog).findByText('使っている設定はありません。')
  fireEvent.change(within(dialog).getByRole('textbox', { name: /消した理由/ }), { target: { value: '整理のため' } })
  const target = within(dialog).getByRole('button', { name: '削除する', exact: true })
  const key = Object.keys(target).find(item => item.startsWith('__reactProps$'))!
  const handler = (target as unknown as Record<string, { onClick: (event: unknown) => unknown }>)[key].onClick
  state.account = 'b'; view.rerender(<Editor />)
  state.account = 'a'; view.rerender(<Editor />)
  await handler({ defaultPrevented: false, preventDefault() {}, stopPropagation() {}, currentTarget: target, target })
  expect(state.remove).not.toHaveBeenCalled()
})

it('送信開始時に固定した配信を、変更が反映される件数に含めない', async () => {
  state.impact.mockResolvedValue({ success: true, data: {
    variable: { id: 'var-1', name: '営業時間', varKey: 'hours' }, total: 3, blockingTotal: 1,
    historicalTotal: 1, sendingFixedTotal: 1, unscopedFormTotal: 0, canDelete: false,
    byKind: {}, items: [], unavailableReferences: [], checkedAt: '2026-10-14T00:00:00+09:00', recommendedAction: 'review_references',
  } })
  render(<Editor />)
  expect(await screen.findByRole('button', { name: '1か所に反映して保存' })).toBeTruthy()
  expect(screen.getByText(/送信開始時に固定した配信と届いた文は変わりません/)).toBeTruthy()
})

it('所属不明の使用先があるときは反映先の数を断定しない', async () => {
  state.impact.mockResolvedValue({ success: true, data: {
    variable: { id: 'var-1', name: '営業時間', varKey: 'hours' }, total: 2, blockingTotal: 2,
    historicalTotal: 0, sendingFixedTotal: 0, unscopedFormTotal: 1, canDelete: false,
    byKind: {}, items: [], unavailableReferences: [], checkedAt: '2026-10-14T00:00:00+09:00', recommendedAction: 'review_references',
  } })
  render(<Editor />)
  expect(await screen.findByText(/所属を確認できない使用先があります/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /か所に反映して保存/ })).toBeNull()
})

it('確認できた使用先がない場合は、変更が反映される場所がないと示す', async () => {
  render(<Editor />)
  expect(await screen.findByText(/確認できた使用先に変わる場所はありません/)).toBeTruthy()
})

it('使用先ごとに参照方法と確かめられた版を表示する', async () => {
  state.impact.mockResolvedValue({ success: true, data: {
    variable: { id: 'var-1', name: '営業時間', varKey: 'hours' }, total: 2, blockingTotal: 1,
    historicalTotal: 0, sendingFixedTotal: 1, unscopedFormTotal: 0, canDelete: false, byKind: {},
    items: [
      { kind: 'template', kindLabel: 'テンプレート', name: '案内', status: '使われています', href: '/templates/1', blocksDeletion: true, currentPreview: '10時', referenceMode: 'live', referencedVersion: 5 },
      { kind: 'broadcast', kindLabel: '一斉配信', name: '送信中', status: '配信中', href: '/broadcasts/1', blocksDeletion: false, currentPreview: '9時', referenceMode: 'pinned', referencedVersion: 3 },
    ], unavailableReferences: [], checkedAt: '2026-10-14T00:00:00+09:00', recommendedAction: 'review_references',
  } })
  render(<Editor />)
  const table = await screen.findByRole('table', { name: '使っている場所' })
  expect(within(table).getByText('最新の値')).toBeTruthy()
  expect(within(table).getByText('使用中')).toBeTruthy()
  expect(within(table).getByText('版 3 で固定')).toBeTruthy()
  expect(within(table).getByText('版 5')).toBeTruthy()
  expect(within(table).getByTitle('版 3')).toBeTruthy()
})

it('一斉配信の下書きに現在の版を固定できる', async () => {
  state.impact.mockResolvedValue({ success: true, data: {
    variable: { id: 'var-1', name: '営業時間', varKey: 'hours' }, total: 1, blockingTotal: 1, historicalTotal: 0,
    unscopedFormTotal: 0, canDelete: false, byKind: {}, items: [{ kind: 'broadcast', kindLabel: '一斉配信', name: '案内', status: '下書き', href: '/broadcasts/detail?id=b-1', blocksDeletion: true, currentPreview: '10時', referenceMode: 'live', referencedVersion: 1 }], unavailableReferences: [], checkedAt: '', recommendedAction: 'review_references',
  } })
  render(<Editor />)
  fireEvent.click(await screen.findByRole('button', { name: '案内の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '版 1 で固定' }))
  const dialog = await screen.findByRole('dialog', { name: 'この版で固定しますか' })
  expect(within(dialog).getByText(/承認が取り消されます/)).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '固定する' }))
  await waitFor(() => expect(state.pin).toHaveBeenCalledWith('b-1', 'var-1', { accountId: 'a', versionId: 'version-1', expectedVersion: 4 }))
})

it('固定に失敗したときは技術的なエラーを出さずに案内する', async () => {
  state.impact.mockResolvedValue({ success: true, data: {
    variable: { id: 'var-1', name: '営業時間', varKey: 'hours' }, total: 1, blockingTotal: 1, historicalTotal: 0,
    unscopedFormTotal: 0, canDelete: false, byKind: {}, items: [{ kind: 'broadcast', kindLabel: '一斉配信', name: '案内', status: '下書き', href: '/broadcasts/detail?id=b-1', blocksDeletion: true, currentPreview: '10時', referenceMode: 'live', referencedVersion: 1 }], unavailableReferences: [], checkedAt: '', recommendedAction: 'review_references',
  } })
  state.pin.mockRejectedValue(new ApiError(500))
  render(<Editor />)
  fireEvent.click(await screen.findByRole('button', { name: '案内の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '版 1 で固定' }))
  const dialog = await screen.findByRole('dialog', { name: 'この版で固定しますか' })
  fireEvent.click(within(dialog).getByRole('button', { name: '固定する' }))
  expect(await within(dialog).findByText('版の固定に失敗しました。時間をおいて、もう一度お試しください。')).toBeTruthy()
  expect(screen.queryByText('API error: 500')).toBeNull()
})

it.each([
  ['scenario', 'シナリオ', '/scenarios/detail?id=sc&step=step', 'sc', 'step', 5],
  ['form', 'フォーム', '/form-submissions/edit?id=form', 'form', null, 6],
])('%s の固定は次の公開から反映する', async (kind, name, href, id, step, revision) => {
  state.impact.mockResolvedValue({ success: true, data: {
    variable: { id: 'var-1', name: '営業時間', varKey: 'hours' }, total: 1, blockingTotal: 1, historicalTotal: 0,
    unscopedFormTotal: 0, canDelete: false, byKind: {}, items: [{ kind, kindLabel: name, name, status: '使用中', href, blocksDeletion: true, currentPreview: '10時', referenceMode: 'live', referencedVersion: 1 }], unavailableReferences: [], checkedAt: '', recommendedAction: 'review_references',
  } })
  render(<Editor />)
  expect(await screen.findByText('『次回』の札が付いた使用先と、シナリオ・フォームの下書きの変更は、次に公開した版から反映します。')).toBeTruthy()
  fireEvent.click(await screen.findByRole('button', { name: `${name}の操作` }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '版 1 で固定' }))
  const dialog = await screen.findByRole('dialog', { name: 'この版で固定しますか' })
  expect(within(dialog).getByText(/次に公開した版から反映します/)).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '固定する' }))
  if (kind === 'scenario') await waitFor(() => expect(state.pinScenario).toHaveBeenCalledWith(id, step, 'var-1', { accountId: 'a', versionId: 'version-1', expectedVersion: revision }))
  else await waitFor(() => expect(state.pinForm).toHaveBeenCalledWith(id, 'var-1', { accountId: 'a', versionId: 'version-1', expectedVersion: revision }))
})

it('Google連携後は公開中だけ固定のフォームにも公開し直す案内を出す', async () => {
  state.detail.mockResolvedValue({ success:true,data:{id:'var-1',name:'営業時間',key:'business_hours',type:'text',value:'10時',memo:'',status:'active',version:1,usages:[],history:[{id:'version-1',version:1}],usagePage:{total:0,shown:0},pinDisabledReason:'Google と連携した値は、いつも最新を使います'} })
  state.impact.mockResolvedValue({ success:true,data:{variable:{id:'var-1',name:'営業時間',varKey:'business_hours'},total:1,blockingTotal:1,historicalTotal:0,unscopedFormTotal:0,canDelete:false,byKind:{},items:[{kind:'form',kindLabel:'フォーム',name:'回答',status:'公開中',href:'/form-submissions/edit?id=form',blocksDeletion:true,currentPreview:'10時',referenceMode:'live',referencedVersion:1,publishedReferenceMode:'pinned',publishedReferencedVersion:1}],unavailableReferences:[],checkedAt:'',recommendedAction:'review_references'} })
  render(<Editor />)
  expect(await screen.findByText('Google と連携した固定版は送信・表示できません。下書きで最新の値に戻し、公開し直してください。')).toBeTruthy()
})

it('フォームは公開中と次の公開の参照を区別して示す', async () => {
  state.impact.mockResolvedValue({ success:true, data:{ variable:{id:'var-1',name:'営業時間',varKey:'hours'},total:1,blockingTotal:1,historicalTotal:0,
    unscopedFormTotal:0,canDelete:false,byKind:{},items:[{kind:'form',kindLabel:'フォーム',name:'回答',status:'公開中',href:'/form-submissions/edit?id=form',blocksDeletion:true,currentPreview:'10時',referenceMode:'pinned',referencedVersion:1,publishedReferenceMode:'live',publishedReferencedVersion:2}],unavailableReferences:[],checkedAt:'',recommendedAction:'review_references'} })
  render(<Editor />)
  expect((await screen.findByTitle('次に公開した版から 版 1 で固定します')).textContent).toBe('次回 版1')
  expect(screen.getByTitle('版 2')).toBeTruthy()
  expect(screen.getByText('『次回』の札が付いた使用先と、シナリオ・フォームの下書きの変更は、次に公開した版から反映します。')).toBeTruthy()
})

it('シナリオの送信アクションも行末から固定できる', async () => {
  state.impact.mockResolvedValue({ success: true, data: {
    variable: { id: 'var-1', name: '営業時間', varKey: 'hours' }, total: 1, blockingTotal: 1, historicalTotal: 0,
    unscopedFormTotal: 0, canDelete: false, byKind: {}, items: [{ kind:'scenario', kindLabel:'シナリオ', name:'送信アクション', status:'使用中', href:'/scenarios/detail?id=sc&action=act', blocksDeletion:true, currentPreview:'10時', referenceMode:'live', referencedVersion:1 }], unavailableReferences: [], checkedAt: '', recommendedAction: 'review_references',
  } })
  render(<Editor />)
  fireEvent.click(await screen.findByRole('button', {name:'送信アクションの操作'}))
  fireEvent.click(await screen.findByRole('menuitem', {name:'版 1 で固定'}))
  const dialog = await screen.findByRole('dialog', {name:'この版で固定しますか'})
  fireEvent.click(within(dialog).getByRole('button', {name:'固定する'}))
  await waitFor(() => expect(state.pinScenarioAction).toHaveBeenCalledWith('sc','act','var-1',{accountId:'a',versionId:'version-1',expectedVersion:5}))
})

it('Google連携の値は固定を押せず理由を示す', async () => {
  state.detail.mockResolvedValue({ success: true, data: { id: 'var-1', name: '営業時間', key: 'business_hours', type: 'text', value: '10時', memo: '', status: 'active', version: 1, usages: [], history: [{ id: 'version-1', version: 1 }], usagePage: { total: 0, shown: 0 }, pinDisabledReason: 'Google と連携した値は、いつも最新を使います' } })
  state.impact.mockResolvedValue({ success: true, data: {
    variable: { id: 'var-1', name: '営業時間', varKey: 'business_hours' }, total: 1, blockingTotal: 1, historicalTotal: 0,
    unscopedFormTotal: 0, canDelete: false, byKind: {}, items: [{ kind: 'broadcast', kindLabel: '一斉配信', name: '案内', status: '下書き', href: '/broadcasts/detail?id=b-1', blocksDeletion: true, currentPreview: '10時', referenceMode: 'live', referencedVersion: 1 }], unavailableReferences: [], checkedAt: '', recommendedAction: 'review_references',
  } })
  render(<Editor />)
  fireEvent.click(await screen.findByRole('button', { name: '案内の操作' }))
  const button = await screen.findByRole('menuitem', { name: /版 1 で固定/ })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  fireEvent.focus(button)
  expect((await screen.findByRole('tooltip')).textContent).toContain('Google と連携した値は、いつも最新を使います')
  expect(state.pin).not.toHaveBeenCalled()
})

it('固定済みの下書きは変更件数に含めず版を表示する', async () => {
  state.impact.mockResolvedValue({ success: true, data: {
    variable: { id: 'var-1', name: '営業時間', varKey: 'hours' }, total: 1, blockingTotal: 1, historicalTotal: 0,
    sendingFixedTotal: 0, unscopedFormTotal: 0, canDelete: false, byKind: {}, items: [{ kind: 'broadcast', kindLabel: '一斉配信', name: '案内', status: '下書き', href: '/broadcasts/detail?id=b-1', blocksDeletion: true, currentPreview: '旧', referenceMode: 'pinned', referencedVersion: 1 }], unavailableReferences: [], checkedAt: '', recommendedAction: 'review_references',
  } })
  render(<Editor />)
  const table = await screen.findByRole('table', { name: '使っている場所' })
  expect(within(table).getByText('版 1 で固定')).toBeTruthy()
  expect(within(table).getByText('版 1')).toBeTruthy()
  expect(screen.getByRole('button', { name: /0か所に反映して保存/ })).toBeTruthy()
  fireEvent.click(within(table).getByRole('button', { name: '案内の操作' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: '最新の値に戻す' }))
  const dialog = await screen.findByRole('dialog', { name: '最新の値に戻しますか' })
  expect(state.pin).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: '最新の値に戻す' }))
  await waitFor(() => expect(state.pin).toHaveBeenCalledWith('b-1', 'var-1', { accountId: 'a', versionId: null, expectedVersion: 4 }))
  expect(within(table).queryByRole('button', { name: '版 1 で固定し直す' })).toBeNull()
})

it('使用先の見出しに全件数と送信済みの補足を示す', async () => {
  state.impact.mockResolvedValue({ success: true, data: {
    variable: { id: 'var-1', name: '営業時間', varKey: 'hours' }, total: 8, blockingTotal: 1, historicalTotal: 1,
    unscopedFormTotal: 0, canDelete: false, byKind: {}, items: [{ kind: 'broadcast', kindLabel: '一斉配信', name: '過去の案内', status: '送信済み・変わりません', href: '/broadcasts/detail?id=b-1', blocksDeletion: false, currentPreview: '10時', referenceMode: 'pinned', referencedVersion: 1 }], unavailableReferences: [], checkedAt: '', recommendedAction: 'review_references',
  } })
  render(<Editor />)
  expect(await screen.findByRole('heading', { name: '使用先 8か所' })).toBeTruthy()
  expect(screen.getByTitle('送信済み')).toBeTruthy()
  expect(screen.getByRole('columnheader', { name: '使用先' })).toBeTruthy()
  expect(screen.getByRole('columnheader', { name: '版' })).toBeTruthy()
  expect(screen.getByText('送信済み・完了済みの内容は、値を変えても変わりません。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '過去の案内の操作' }))
  expect((await screen.findByRole('menuitem', { name: /版 1 で固定/ })).getAttribute('aria-disabled')).toBe('true')
  fireEvent.focus(screen.getByRole('menuitem', { name: /版 1 で固定/ }))
  expect((await screen.findByRole('tooltip')).textContent).toContain('送信済み・完了済みの配信は変更できません')
})

it('Google連携後の固定は理由を示し、手動で最新に戻せる', async () => {
  state.detail.mockResolvedValue({ success: true, data: { id: 'var-1', name: '営業時間', key: 'business_hours', type: 'text', value: '10時', memo: '', status: 'active', version: 2, usages: [], history: [{ id: 'version-2', version: 2 }], usagePage: { total: 0, shown: 0 }, pinDisabledReason: 'Google と連携した値は、いつも最新を使います' } })
  state.impact.mockResolvedValue({ success: true, data: {
    variable: { id: 'var-1', name: '営業時間', varKey: 'business_hours' }, total: 1, blockingTotal: 1, historicalTotal: 0,
    unscopedFormTotal: 0, canDelete: false, byKind: {}, items: [{ kind: 'broadcast', kindLabel: '一斉配信', name: '案内', status: '下書き', href: '/broadcasts/detail?id=b-1', blocksDeletion: true, currentPreview: '旧', referenceMode: 'pinned', referencedVersion: 1 }], unavailableReferences: [], checkedAt: '', recommendedAction: 'review_references',
  } })
  render(<Editor />)
  const table = await screen.findByRole('table', { name: '使っている場所' })
  expect(within(table).getByText('版 1 で固定')).toBeTruthy()
  expect(screen.getByText('Google と連携した固定版は送らず要確認になります。「…」から最新の値に戻せます。')).toBeTruthy()
  fireEvent.click(within(table).getByRole('button', { name: '案内の操作' }))
  expect((await screen.findByRole('menuitem', { name: /版 2 で固定/ })).getAttribute('aria-disabled')).toBe('true')
  fireEvent.focus(screen.getByRole('menuitem', { name: /版 2 で固定/ }))
  expect((await screen.findByRole('tooltip')).textContent).toContain('固定済みの場合は送らず要確認になります')
  fireEvent.click(screen.getByRole('menuitem', { name: '最新の値に戻す' }))
  expect(await screen.findByRole('dialog', { name: '最新の値に戻しますか' })).toBeTruthy()
  expect(state.pin).not.toHaveBeenCalled()
})

it('対応していない使用先は固定できない理由を表示する', async () => {
  state.impact.mockResolvedValue({ success: true, data: {
    variable: { id: 'var-1', name: '営業時間', varKey: 'hours' }, total: 1, blockingTotal: 1, historicalTotal: 0,
    unscopedFormTotal: 0, canDelete: false, byKind: {}, items: [{ kind: 'auto_reply', kindLabel: '自動応答', name: '自動応答', status: '公開中', href: '/auto-replies/edit?id=f-1', blocksDeletion: true, currentPreview: '10時', referenceMode: 'live', referencedVersion: 1 }], unavailableReferences: [], checkedAt: '', recommendedAction: 'review_references',
  } })
  render(<Editor />)
  fireEvent.click(await screen.findByRole('button', { name: '自動応答の操作' }))
  expect((await screen.findByRole('menuitem', { name: /版 1 で固定/ })).getAttribute('aria-disabled')).toBe('true')
  fireEvent.focus(screen.getByRole('menuitem', { name: /版 1 で固定/ }))
  expect((await screen.findByRole('tooltip')).textContent).toContain('この使用先では固定できません')
  expect(state.pin).not.toHaveBeenCalled()
})
