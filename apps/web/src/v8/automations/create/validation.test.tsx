import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const createDraft = vi.hoisted(() => vi.fn())
const updateDraft = vi.hoisted(() => vi.fn())
const resources = vi.hoisted(() => vi.fn())
const getDraft = vi.hoisted(() => vi.fn())
const summaries = vi.hoisted(() => vi.fn())
const permission = vi.hoisted(() => ({ value: true }))
const listExisting = vi.hoisted(()=>vi.fn().mockResolvedValue({success:true,data:[]}))
vi.mock('./automation-dialogs', async importOriginal => {
  const actual = await importOriginal<typeof import('./automation-dialogs')>()
  return { ...actual, AutomationDialogs: (props: Parameters<typeof actual.AutomationDialogs>[0]) => {
    summaries(props.actionSummary)
    return <actual.AutomationDialogs {...props} />
  } }
})
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account' }) }))
vi.mock('@/components/automations/use-common-action-permission', () => ({ useCanManageCommonActions: () => permission.value }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, automations: {
    ...actual.api.automations,
    createDraftFromTemplate: createDraft,
    updateDraft,
    list: listExisting,
    draftResources: resources,
    getDraft,
  } } }
})

import { NewAutomationV8 } from './create'

beforeEach(() => {
  permission.value = true
  resources.mockReset().mockResolvedValue({ success: true, data: { tags: [{ id: 'tag', name: '予約希望' }], scenarios: [], commonActions: [] } })
  getDraft.mockReset()
  summaries.mockClear()
  window.sessionStorage.clear()
  window.history.replaceState(null, '', '/automations/new')
  vi.stubGlobal('sessionStorage', window.sessionStorage)
})
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })

it('名前の誤りは欄だけに出し、処理の誤りは設定を開いて選ぶ欄へ移る', async () => {
  render(<NewAutomationV8 />)
  const save = getPageAction({ name: '下書きを保存' })
  fireEvent.click(save)
  const name = screen.getByRole('textbox', { name: '名前', exact: true })
  await waitFor(() => expect(document.activeElement).toBe(name))
  expect(name.getAttribute('aria-invalid')).toBe('true')
  expect(screen.getAllByText('ルール名を入力してください')).toHaveLength(1)
  expect(createDraft).not.toHaveBeenCalled()

  fireEvent.change(name, { target: { value: '予約のお礼' } })
  fireEvent.click(screen.getByRole('button', { name: 'つくって動かす', exact: true }))
  const tag = await screen.findByRole('button', { name: '自動化で付けるタグ：選択する' })
  await waitFor(() => expect(document.activeElement).toBe(tag))
  expect(tag.getAttribute('aria-invalid')).toBe('true')
  expect(screen.getAllByText('付けるタグを選んでください')).toHaveLength(1)
  expect(createDraft).not.toHaveBeenCalled()
})

it('WEB-120: 名前を変えてキャンセルすると、入力を残して未保存を確認する', async () => {
  render(<NewAutomationV8 />)
  const name = screen.getByRole('textbox', { name: '名前', exact: true })
  fireEvent.change(name, { target: { value: '予約のお礼' } })
  fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
  expect(await screen.findByRole('dialog', { name: /保存していない変更/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
  expect((screen.getByRole('textbox', { name: '名前', exact: true }) as HTMLInputElement).value).toBe('予約のお礼')
})

it('WEB-120: 何も変えていないキャンセルは未保存の確認を出さない', () => {
  render(<NewAutomationV8 />)
  fireEvent.click(screen.getByRole('link', { name: 'キャンセル' }))
  expect(screen.queryByRole('alertdialog')).toBeNull()
})

it('既存ルールの取得失敗を重複なしとして隠さず、再取得する',async()=>{
 listExisting.mockRejectedValueOnce(new Error('fixture failure')).mockResolvedValue({success:true,data:[{id:'existing',eventType:'friend_added'}]})
 render(<NewAutomationV8/>)
 const error=await screen.findByText('既存のルールを読み込めませんでした')
 fireEvent.click(error.closest('[data-list-state="error"]')!.querySelector('button')!)
 await waitFor(()=>expect(screen.queryByText('既存のルールを読み込めませんでした')).toBeNull())
 expect(listExisting).toHaveBeenCalledTimes(2)
})


it('閲覧のみの人には保存と公開を出さず、入力した内容も送らない', async () => {
  permission.value = false
  render(<NewAutomationV8 />)
  expect(screen.queryByRole('button', { name: '下書きを保存' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'つくって動かす' })).toBeNull()
  expect(createDraft).not.toHaveBeenCalled()
})


it.each(['ready', 'loading', 'failed'] as const)('タグIDが空なら%sでも未選択を示し、保存を始めない', async state => {
  if (state === 'loading') resources.mockImplementationOnce(() => new Promise(() => {}))
  if (state === 'failed') resources.mockRejectedValueOnce(new Error('resources unavailable'))
  render(<NewAutomationV8 />)
  await waitFor(() => expect(resources).toHaveBeenCalledTimes(1))
  expect(screen.getByText('友だちになったら、タグ（未選択）を付けます。')).toBeTruthy()
  expect(summaries.mock.lastCall?.[0]).toBe('タグ（未選択）')
  fireEvent.change(screen.getByRole('textbox', { name: '名前', exact: true }), { target: { value: '未選択の確認' } })
  fireEvent.click(screen.getByRole('button', { name: 'つくって動かす', exact: true }))
  expect(await screen.findByText('付けるタグを選んでください')).toBeTruthy()
  expect(screen.queryByRole('dialog', { name: 'この内容で動かし始めますか' })).toBeNull()
  expect(createDraft).not.toHaveBeenCalled()
})

it.each(['loading', 'failed', 'missing', 'empty-name', 'named'] as const)('保存済み非空IDを%sで未選択に読み替えず、確認へ同じ要約を渡す', async state => {
  if (state === 'loading') resources.mockImplementationOnce(() => new Promise(() => {}))
  else if (state === 'failed') resources.mockRejectedValueOnce(new Error('resources unavailable'))
  else resources.mockResolvedValueOnce({ success: true, data: { tags: state === 'missing' ? [] : [{ id: 'retained-tag', name: state === 'empty-name' ? '' : '予約希望' }], scenarios: [], commonActions: [] } })
  getDraft.mockResolvedValueOnce({ success: true, data: {
    id: 'summary-draft', draftVersionId: 'v1', name: 'タグの確認', description: null,
    eventType: 'friend_add', triggerConfig: {}, conditions: {},
    actions: [{ id: 'tag-step', type: 'add_tag', params: { tagId: 'retained-tag' }, onFailure: 'stop' }],
  } })
  window.history.replaceState(null, '', '/automations/new?draft=summary-draft')
  render(<NewAutomationV8 />)
  await waitFor(() => expect((screen.getByRole('textbox', { name: '名前', exact: true }) as HTMLInputElement).value).toBe('タグの確認'))
  const named = state === 'named'
  await waitFor(() => expect(summaries.mock.lastCall?.[0]).toBe(named ? 'タグ「予約希望」を付ける' : '選んだタグを付ける'))
  expect(screen.getByText(named ? '友だちになったら、タグ「予約希望」を付けます。' : '友だちになったら、タグを付けます。')).toBeTruthy()
  expect(screen.queryByText(/タグ（未選択）/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'つくって動かす', exact: true }))
  const confirm = await screen.findByRole('dialog', { name: 'この内容で動かし始めますか' })
  expect(confirm.textContent).toContain(named ? 'タグ「予約希望」を付ける' : '選んだタグを付ける')
  expect(getDraft).toHaveBeenCalledWith('summary-draft', 'account')
  expect(createDraft).not.toHaveBeenCalled()
})

it.each(['ready', 'loading', 'failed'] as const)('シナリオIDが空なら%sでも未選択を示し、保存を始めない', async state => {
  if (state === 'loading') resources.mockImplementationOnce(() => new Promise(() => {}))
  if (state === 'failed') resources.mockRejectedValueOnce(new Error('resources unavailable'))
  getDraft.mockResolvedValueOnce({ success: true, data: {
    id: 'scenario-draft', draftVersionId: 'v1', name: 'シナリオの確認', description: null,
    eventType: 'friend_add', triggerConfig: {}, conditions: {},
    actions: [{ id: 'scenario-step', type: 'start_scenario', params: {}, onFailure: 'stop' }],
  } })
  window.history.replaceState(null, '', '/automations/new?draft=scenario-draft')
  render(<NewAutomationV8 />)
  await waitFor(() => expect((screen.getByRole('textbox', { name: '名前', exact: true }) as HTMLInputElement).value).toBe('シナリオの確認'))
  expect(screen.getByText('友だちになったら、シナリオ（未選択）を始めます。')).toBeTruthy()
  expect(summaries.mock.lastCall?.[0]).toBe('シナリオ（未選択）')
  fireEvent.click(screen.getByRole('button', { name: 'つくって動かす', exact: true }))
  expect(await screen.findByText('始めるシナリオを選んでください')).toBeTruthy()
  expect(screen.queryByRole('dialog', { name: 'この内容で動かし始めますか' })).toBeNull()
  expect(createDraft).not.toHaveBeenCalled()
})

it.each(['ready', 'loading', 'failed'] as const)('共通アクションIDが空なら%sでも未選択を示し、保存を始めない', async state => {
  if (state === 'loading') resources.mockImplementationOnce(() => new Promise(() => {}))
  if (state === 'failed') resources.mockRejectedValueOnce(new Error('resources unavailable'))
  getDraft.mockResolvedValueOnce({ success: true, data: {
    id: 'common-action-draft', draftVersionId: 'v1', name: '共通アクションの確認', description: null,
    eventType: 'friend_add', triggerConfig: {}, conditions: {},
    actions: [{ id: 'common-action-step', type: 'common_action', params: {}, onFailure: 'stop' }],
  } })
  window.history.replaceState(null, '', '/automations/new?draft=common-action-draft')
  render(<NewAutomationV8 />)
  await waitFor(() => expect((screen.getByRole('textbox', { name: '名前', exact: true }) as HTMLInputElement).value).toBe('共通アクションの確認'))
  expect(screen.getByText('友だちになったら、共通アクション（未選択）を実行します。')).toBeTruthy()
  expect(summaries.mock.lastCall?.[0]).toBe('共通アクション（未選択）')
  fireEvent.click(screen.getByRole('button', { name: 'つくって動かす', exact: true }))
  expect(await screen.findByText('使う共通アクションを選んでください')).toBeTruthy()
  expect(screen.queryByRole('dialog', { name: 'この内容で動かし始めますか' })).toBeNull()
  expect(createDraft).not.toHaveBeenCalled()
})

it.each(['loading', 'failed', 'missing', 'empty-name', 'named'] as const)('保存済みシナリオ非空IDを%sで未選択に読み替えず、確認へ同じ要約を渡す', async state => {
  if (state === 'loading') resources.mockImplementationOnce(() => new Promise(() => {}))
  else if (state === 'failed') resources.mockRejectedValueOnce(new Error('resources unavailable'))
  else resources.mockResolvedValueOnce({ success: true, data: { tags: [], scenarios: state === 'missing' ? [] : [{ id: 'retained-scenario', name: state === 'empty-name' ? '' : '来店フォロー' }], commonActions: [] } })
  getDraft.mockResolvedValueOnce({ success: true, data: {
    id: 'scenario-draft', draftVersionId: 'v1', name: 'シナリオの確認', description: null,
    eventType: 'friend_add', triggerConfig: {}, conditions: {},
    actions: [{ id: 'scenario-step', type: 'start_scenario', params: { scenarioId: 'retained-scenario' }, onFailure: 'stop' }],
  } })
  window.history.replaceState(null, '', '/automations/new?draft=scenario-draft')
  render(<NewAutomationV8 />)
  await waitFor(() => expect((screen.getByRole('textbox', { name: '名前', exact: true }) as HTMLInputElement).value).toBe('シナリオの確認'))
  const named = state === 'named'
  await waitFor(() => expect(summaries.mock.lastCall?.[0]).toBe(named ? 'シナリオ「来店フォロー」を始める' : 'シナリオを始める'))
  expect(screen.getByText(named ? '友だちになったら、シナリオ「来店フォロー」を始めます。' : '友だちになったら、シナリオを始めます。')).toBeTruthy()
  expect(screen.queryByText(/シナリオ（未選択）/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'つくって動かす', exact: true }))
  const confirm = await screen.findByRole('dialog', { name: 'この内容で動かし始めますか' })
  expect(confirm.textContent).toContain(named ? 'シナリオ「来店フォロー」を始める' : 'シナリオを始める')
  expect(getDraft).toHaveBeenCalledWith('scenario-draft', 'account')
  expect(createDraft).not.toHaveBeenCalled()
})

it.each(['loading', 'failed', 'missing', 'empty-name', 'named'] as const)('保存済み共通アクション非空IDを%sで未選択に読み替えず、確認へ同じ要約を渡す', async state => {
  if (state === 'loading') resources.mockImplementationOnce(() => new Promise(() => {}))
  else if (state === 'failed') resources.mockRejectedValueOnce(new Error('resources unavailable'))
  else resources.mockResolvedValueOnce({ success: true, data: { tags: [], scenarios: [], commonActions: state === 'missing' ? [] : [{ id: 'retained-common-action', name: state === 'empty-name' ? '' : '予約の案内' }] } })
  getDraft.mockResolvedValueOnce({ success: true, data: {
    id: 'common-action-draft', draftVersionId: 'v1', name: '共通アクションの確認', description: null,
    eventType: 'friend_add', triggerConfig: {}, conditions: {},
    actions: [{ id: 'common-action-step', type: 'common_action', params: { commonActionId: 'retained-common-action' }, onFailure: 'stop' }],
  } })
  window.history.replaceState(null, '', '/automations/new?draft=common-action-draft')
  render(<NewAutomationV8 />)
  await waitFor(() => expect((screen.getByRole('textbox', { name: '名前', exact: true }) as HTMLInputElement).value).toBe('共通アクションの確認'))
  const named = state === 'named'
  await waitFor(() => expect(summaries.mock.lastCall?.[0]).toBe(named ? '共通アクション「予約の案内」を実行' : '共通アクションを実行'))
  expect(screen.getByText(named ? '友だちになったら、共通アクション「予約の案内」を実行します。' : '友だちになったら、共通アクションを実行します。')).toBeTruthy()
  expect(screen.queryByText(/共通アクション（未選択）/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'つくって動かす', exact: true }))
  const confirm = await screen.findByRole('dialog', { name: 'この内容で動かし始めますか' })
  expect(confirm.textContent).toContain(named ? '共通アクション「予約の案内」を実行' : '共通アクションを実行')
  expect(getDraft).toHaveBeenCalledWith('common-action-draft', 'account')
  expect(createDraft).not.toHaveBeenCalled()
})

it('題は機能名を入れた「オートメーションを作る」（自動応答と分ける）', () => {
  render(<NewAutomationV8 />)
  expect(screen.getByRole('heading', { name: 'オートメーションを作る', level: 1 })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'ルールを作る', level: 1 })).toBeNull()
})


it('タグ未選択の途中でも下書きだけ保存できる', async () => {
  createDraft.mockResolvedValueOnce({ success: true, data: { id: 'draft-partial', draftVersionId: 'v1' } })
  updateDraft.mockResolvedValueOnce({ success: true, data: { draftVersionId: 'v2' } })
  getDraft.mockImplementationOnce(() => new Promise(() => {}))
  render(<NewAutomationV8 />)
  fireEvent.change(screen.getByRole('textbox', { name: '名前', exact: true }), { target: { value: '途中の下書き' } })
  fireEvent.click(getPageAction({ name: '下書きを保存' }))
  await waitFor(() => expect(updateDraft).toHaveBeenCalledWith('draft-partial', 'account', expect.objectContaining({ actions: [expect.objectContaining({ type: 'add_tag', params: expect.objectContaining({ tagId: '' }) })] })))
  expect(screen.queryByRole('dialog', { name: 'この内容で動かし始めますか' })).toBeNull()
})
