import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity, readStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
import { DELIVERY_FEATURE_POLICIES, deliveryPermissionKey } from '@line-crm/shared'
import { canEditWizardNow } from './wizard-access'
import { getPageAction } from '@/test-utils/page-action'
// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ query: 'id=synthetic-rule&step=response', saveAction: undefined as undefined | (() => void), createDraft: vi.fn(), templates: vi.fn(), folders: vi.fn(), getDraft: vi.fn(), conflicts: vi.fn(), validateDraft: vi.fn(), list: vi.fn(), saveDraft: vi.fn(), testDraft: vi.fn(), publishDraft: vi.fn(), accounts: [{id:'synthetic-account'}], pageTitle: vi.fn(), liveStatus: 'published' }))
vi.mock('next/navigation', () => ({useRouter: () => ({replace: (url: string) => {net.query = url.split('?')[1]}, push: vi.fn()}), useSearchParams: () => new URLSearchParams(net.query)}))
vi.mock('@/components/shared/button', async importOriginal => {
  const actual = await importOriginal<typeof import('@/components/shared/button')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.children === '下書きとして保存' && props.onClick) {
      const handler = props.onClick
      net.saveAction = () => Reflect.apply(handler, undefined, [new MouseEvent('click')])
    }
    return <actual.default {...props} />
  } }
})
vi.mock('@/contexts/account-context', () => ({useAccount: () => ({selectedAccountId: 'synthetic-account', accounts: net.accounts})}))
vi.mock('@/components/shell/page-chrome', () => ({usePageTitle: net.pageTitle}))
vi.mock('@/lib/use-feature-visibility', () => ({ useFeatureVisibility: () => ({enabled: () => false, status: 'ready'}) }))
vi.mock('@/components/auto-replies/inline-action-list', () => ({default: () => null, useActionOptions: () => ({tags:[],fields:[],marks:[],scenarios:[],vars:[]})}))
vi.mock('@/components/shared/select', () => ({ default: ({value,onChange,options,...props}: {value: string; onChange: (value: string) => void; options: Array<{value: string; label: string}>; 'aria-label'?: string}) => <select aria-label={props['aria-label']} value={value} onChange={e=>onChange(e.target.value)}>{options.map((o)=><option key={o.value} value={o.value}>{o.label}</option>)}</select> }))
vi.mock('@/lib/api', async importOriginal => {const actual = await importOriginal<typeof import('@/lib/api')>(); return {...actual,api:{autoReplies:{createDraft:net.createDraft,getDraft:net.getDraft,get:async()=>({success:true,data:{isActive:net.liveStatus==='published',lifecycleStatus:net.liveStatus}}),list:net.list,conflicts:net.conflicts,validateDraft:net.validateDraft,saveDraft:net.saveDraft,testDraft:net.testDraft,publishDraft:net.publishDraft},templates:{list:net.templates},folders:{list:net.folders},friends:{list:async()=>({success:true,data:{items:[{id:'synthetic-friend',displayName:'試験の友だち'}],total:1}})}}}})
import Page from './wizard'
import { ApiError } from '@/lib/api'
import { MESSAGE_KIND_WORDS } from '../auto-reply-words'
const DRAFT = {
  autoReplyId: 'synthetic-rule',
  versionId: 'synthetic-version',
  versionNumber: 1,
  status: 'draft',
  settings: {
    keyword: 'test',
    matchType: 'exact',
    responseType: 'text',
    responseContent: 'test',
    templateId: null,
    lineAccountId: 'synthetic-account',
    activeFrom: null,
    activeUntil: null,
    cooldownMinutes: null,
    skipWhenOperatorActive: false,
    priority: 0,
    messageKinds: null,
    receiveSources: ['line'],
    friendConditions: null,
    actions: null,
    responseWeekdays: null,
    responseHolidayRule: null,
    oncePerFriend: false,
    keywords: null,
    respondToAll: false,
    name: 'J7 synthetic reply',
    keywordMatchMode: 'any',
    folderId: null,
    internalMemo: null,
    replyDelaySeconds: null,
    unmatchedAction: null,
  },
  lastTestStatus: null,
  lastTestedAt: null,
  publishedAt: null,
}

beforeEach(()=> {
 verifiedStaffRole('owner'); forgetSessionSnapshot()
 net.templates.mockResolvedValue({success:true,data:[]});net.folders.mockResolvedValue({success:true,data:[]});net.createDraft.mockResolvedValue({success:true,data:{...DRAFT,autoReplyId:'created'}})
 net.liveStatus='published';net.query='id=synthetic-rule&step=response';net.accounts=[{id:'synthetic-account'}];vi.clearAllMocks()
 net.getDraft.mockResolvedValue({success:true,data:DRAFT});net.validateDraft.mockResolvedValue({success:true,data:{errors:[],warnings:[],conflicts:[]}})
 net.conflicts.mockResolvedValue({success:true,data:{conflicts:[]}});net.list.mockResolvedValue({success:true,data:[]});net.saveDraft.mockResolvedValue({success:true,data:{...DRAFT,versionNumber:2}})
})
afterEach(() => { cleanup(); forgetSessionSnapshot(); forgetStaffIdentity(); vi.resetAllMocks() })

vi.mock('@/components/shared/entity-picker-sources', () => ({ EntityKindField: ({ value, onChange, options, label }: { value: string; onChange: (v: string) => void; options: Array<{ id: string; name: string }>; label: string }) => <select aria-label={label} value={value} onChange={event => onChange(event.target.value)}><option value="">選ばない</option>{options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select> }))
vi.mock('@/components/shared/image-uploader', () => ({ default: ({ onChange }: { onChange: (v: unknown) => void }) => <button onClick={() => onChange({ mode: 'line-image', originalContentUrl: 'https://example.test/full.png', previewImageUrl: 'https://example.test/thumb.png' })}>試験の画像を選ぶ</button> }))
vi.mock('@/components/shared/condition-builder', () => ({ default: ({ value }: { value: unknown }) => <output data-testid="condition-draft">{JSON.stringify(value)}</output> }))
vi.mock('@/components/auto-replies/inline-action-rows-v8', () => ({ default: ({ onChange }: { onChange: (value: unknown) => void }) => <button onClick={() => onChange([{key:'a',actionType:'tag',config:{op:'add',tagIds:['tag-1']},onFailure:'continue'}])}>試験のタグ処理を足す</button>, actionRowTitle: () => 'タグ処理' }))
async function mount(step: string, settings: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}) {
  net.query=`id=synthetic-rule&step=${step}`
  net.getDraft.mockResolvedValue({success:true,data:{...DRAFT,...metadata,settings:{...DRAFT.settings,...settings}}})
  const view=render(<Page/>);await act(async()=>{})
  return view
}
async function save() { await act(async()=>fireEvent.click(getPageAction({name:'下書きとして保存'}))) }
const saved = () => net.saveDraft.mock.lastCall?.[1]

it('実際の一致選択と追加された言葉を保存する', async () => {
  await mount('trigger', { keyword:'予約', matchType:'exact' })
  fireEvent.click(screen.getByRole('button',{name:'部分一致（含む）'}))
  const field=screen.getByRole('textbox',{name:'反応する言葉を足す'})
  expect(field.getAttribute('maxlength')).toBe('200')
  fireEvent.change(field,{target:{value:'変更'}})
  fireEvent.keyDown(field,{key:'Enter'})
  await save()
  expect(saved().keywords).toEqual([expect.objectContaining({keyword:'予約',matchType:'contains'}),expect.objectContaining({keyword:'変更',matchType:'contains'})])
})

it('最後の曜日を外しても保存が全曜日へ広がらない', async () => {
  await mount('trigger',{responseWeekdays:[5]})
  const friday=screen.getByRole('button',{name:'金',exact:true})
  fireEvent.click(friday)
  expect(friday.getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByText(/曜日を1つ以上/)).toBeTruthy()
  await save()
  expect(saved().responseWeekdays).toEqual([5])
})

it('祝日・一人一回・有人対応の設定を変更して保存する', async () => {
  const view=await mount('trigger')
  fireEvent.change(screen.getByRole('combobox',{name:'祝日の扱い'}),{target:{value:'exclude'}})
  net.query='id=synthetic-rule&step=response';view.rerender(<Page/>);await act(async()=>{})
  fireEvent.click(screen.getByRole('switch',{name:'1人につき1回だけ返す'}))
  fireEvent.click(screen.getByRole('switch',{name:'担当者が対応中のトークには返さない'}))
  await save()
  expect(saved()).toMatchObject({responseHolidayRule:'exclude',oncePerFriend:true,skipWhenOperatorActive:true})
})

it('8種のメッセージの選択状態と保存対象が一致する', async () => {
  await mount('trigger',{messageKinds:['text','image','video','audio','file','location','sticker','postback']})
  const group=screen.getByRole('group',{name:'反応するメッセージの種類'})
  const selected=within(group).getAllByRole('button',{pressed:true})
  expect(selected).toHaveLength(8)
  for (const kind of MESSAGE_KIND_WORDS) {
    expect(within(group).getByRole('button', { name: kind.label, exact: true }).getAttribute('aria-pressed')).toBe('true')
  }
  fireEvent.click(within(group).getByRole('button',{name:'画像',exact:true}))
  expect(within(group).getByRole('button',{name:'画像',exact:true}).getAttribute('aria-pressed')).toBe('false')
  await save()
  expect(saved().messageKinds).not.toContain('image')
  expect(saved().messageKinds).toHaveLength(7)
})

it.each([
  {operator:'AND',rules:[],groups:[{operator:'OR',rules:[],groups:[]}]},
  {operator:'AND',rules:[{type:'name',value:{}}],groups:[]},
])('不完全な条件は保存せず入力を残す %j',async condition=>{
  await mount('trigger',{friendConditions:condition})
  await save()
  expect(net.saveDraft).not.toHaveBeenCalled()
  expect(screen.getByTestId('condition-draft').textContent).toBe(JSON.stringify(condition))
})

it('テンプレート選択は見本と保存する種類・本文が一致する', async () => {
  net.templates.mockResolvedValue({success:true,data:[{id:'tpl',name:'保存する見本',messageType:'text',messageContent:'見本の本文'}]})
  await mount('response')
  fireEvent.click(screen.getByRole('button',{name:'テンプレートから',exact:true}))
  fireEvent.change(screen.getByRole('combobox',{name:'テンプレート'}),{target:{value:'tpl'}})
  expect(screen.getAllByText('見本の本文').length).toBeGreaterThan(0)
  await save()
  expect(saved()).toMatchObject({templateId:'tpl',responseType:'text',responseContent:'見本の本文'})
})

it('画像を選ぶとテキスト入力を隠し、URLのJSONを保存する',async()=>{
  await mount('response')
  fireEvent.click(screen.getByRole('button',{name:'画像',exact:true}))
  expect(screen.queryByRole('textbox',{name:'返す文'})).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'試験の画像を選ぶ'}))
  await save()
  expect(saved().responseType).toBe('image')
  expect(JSON.parse(saved().responseContent)).toEqual({originalContentUrl:'https://example.test/full.png',previewImageUrl:'https://example.test/thumb.png'})
})

it.each(['{}','[]','null','JSONではない'])('不正なカード%sはAPIを呼ばず入力を残す',async value=>{
  await mount('response')
  fireEvent.click(screen.getByRole('button',{name:'カード',exact:true}))
  const field=screen.getByRole('textbox',{name:'カードの内容（JSON）'}) as HTMLTextAreaElement
  fireEvent.change(field,{target:{value}})
  await save()
  expect(net.saveDraft).not.toHaveBeenCalled()
  expect(field.value).toBe(value)
})

it('返信しない設定でも後続処理を編集して保存できる',async()=>{
  await mount('response')
  fireEvent.click(screen.getByRole('button',{name:'返信しない（後の処理だけ）'}))
  expect(screen.queryByRole('textbox',{name:'返す文'})).toBeNull()
  expect(screen.queryByRole('button',{name:'試験の画像を選ぶ'})).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'試験のタグ処理を足す'}))
  await save()
  expect(saved()).toMatchObject({responseType:'silent',responseContent:'',actions:[{actionType:'tag',config:{op:'add',tagIds:['tag-1']},onFailure:'continue'}]})
})

it('保存失敗・409でも入力を残し、公開せず、同じ版で再送できる',async()=>{
  await mount('basic')
  const field=screen.getByRole('textbox',{name:'ルール名'}) as HTMLInputElement
  fireEvent.change(field,{target:{value:'編集を残す'}})
  net.saveDraft.mockRejectedValueOnce(new ApiError(503,'一時的に保存できません'))
  await save()
  expect(field.value).toBe('編集を残す')
  expect(net.publishDraft).not.toHaveBeenCalled()
  net.saveDraft.mockRejectedValueOnce(new ApiError(409,'先に保存されました'))
  await save()
  expect(field.value).toBe('編集を残す')
  expect(screen.getByRole('button',{name:/比べ/})).toBeTruthy()
  expect(net.saveDraft.mock.calls.map(call=>call[1].expectedVersion)).toEqual([1,1])
})

it('新規保存の応答消失を再送するときは同じ作成キーを使う',async()=>{
  net.query='step=basic'
  net.createDraft.mockRejectedValueOnce(new ApiError(503,'応答消失'))
  const view=render(<Page/>);await act(async()=>{})
  const starters=screen.getAllByRole('button',{name:/使う/})
  fireEvent.click(starters[0]);view.rerender(<Page/>);await act(async()=>{})
  await save()
  expect(net.createDraft).toHaveBeenCalledTimes(1)
  await save()
  expect(net.createDraft).toHaveBeenCalledTimes(2)
  expect(net.createDraft.mock.calls[1][1]).toBe(net.createDraft.mock.calls[0][1])
  expect(String(net.createDraft.mock.calls[0][1] ?? '')).not.toBe('')
  expect(net.publishDraft).not.toHaveBeenCalled()
})

it('フォルダ取得失敗を空一覧と混ぜず、再読込しても入力と保存済み所属を残す',async()=>{
  net.folders.mockRejectedValueOnce(new Error('offline'))
  await mount('basic',{folderId:'folder-a'})
  fireEvent.change(screen.getByRole('textbox',{name:'ルール名'}),{target:{value:'編集中の名前'}})
  expect(await screen.findByText(/フォルダを読み込めませんでした/)).toBeTruthy()
  net.folders.mockResolvedValue({success:true,data:[{id:'folder-a',name:'保存済みフォルダ'}]})
  fireEvent.click(screen.getByRole('button',{name:'フォルダをもう一度読み込む'}))
  await waitFor(()=>expect(net.folders).toHaveBeenCalledTimes(2))
  expect((screen.getByRole('textbox',{name:'ルール名'}) as HTMLInputElement).value).toBe('編集中の名前')
  expect(net.getDraft).toHaveBeenCalledTimes(1)
  await save()
  expect(saved()).toMatchObject({name:'編集中の名前',folderId:'folder-a'})
})

it('待ち時間の入力不正ではAPIを呼ばず、修正後は指定値を保存する',async()=>{
  await mount('response',{cooldownMinutes:60})
  const field=screen.getByRole('spinbutton',{name:'あける時間（分）'}) as HTMLInputElement
  fireEvent.change(field,{target:{value:'-1'}})
  await save()
  expect(net.saveDraft).not.toHaveBeenCalled()
  expect(field.value).toBe('-1')
  fireEvent.change(field,{target:{value:'90'}})
  await save()
  expect(saved().cooldownMinutes).toBe(90)
})

it('テキストのまま画像へ切り替えても未選択の画像は送信しない',async()=>{
  await mount('response')
  fireEvent.click(screen.getByRole('button',{name:'画像',exact:true}))
  await save()
  expect(net.saveDraft).not.toHaveBeenCalled()
  expect(screen.getAllByText('返信する画像を選んでください').length).toBeGreaterThan(0)
})

it('現行の5段の順序と現在の段を明示する',async()=>{
  await mount('trigger')
  const steps=screen.getByRole('navigation',{name:'自動応答を作る進み方'})
  expect(steps.textContent).toMatch(/基本設定.*どんなときに動くか.*何を返すか.*優先順位.*確認/)
  expect(steps.querySelector('[aria-current="step"]')?.textContent).toContain('どんなときに動くか')
})

it('狭幅用の見本は操作して開き、保存は見本の外の下部帯に置く',async()=>{
  await mount('response')
  expect(document.querySelector('[data-template-region="preview"]')?.getAttribute('data-preview-narrow')).toBe('hidden')
  expect(document.querySelector('[data-template-region="footer"]')?.contains(getPageAction({name:'下書きとして保存'}))).toBe(true)
  expect(document.querySelector('[data-template-region="footer"]')?.textContent).toContain('次へ')
  fireEvent.click(screen.getByRole('button',{name:'LINEの見え方を確認'}))
  expect(await screen.findByRole('dialog',{name:'LINEの見え方'})).toBeTruthy()
})

it('優先順位は上から動く順で表示し、数値の直接入力欄を出さない',async()=>{
  net.list.mockResolvedValue({success:true,data:[
    {id:'first',name:'先に動くルール',priority:0,createdAt:'2026-01-01',keyword:'予約',isActive:true},
    {id:'synthetic-rule',name:'自分のルール',priority:1,createdAt:'2026-01-02',keyword:'変更',isActive:true},
  ]})
  await mount('priority',{priority:1})
  expect(screen.getByText(/上のルールから順に見て/)).toBeTruthy()
  expect(screen.getAllByText('先に動くルール').length).toBeGreaterThan(0)
  expect(screen.getByText('いまの順番：いちばん下')).toBeTruthy()
  expect(screen.queryByRole('spinbutton')).toBeNull()
})

it('返信文の入力上限を示し、本文の後ろの差し込み操作が保存する文に反映される', async () => {
  await mount('response', { responseContent: 'こんにちは' })
  const field = screen.getByRole('textbox', { name: '返す文' }) as HTMLTextAreaElement
  const insert = screen.getByRole('button', { name: '名前', exact: true })
  fireEvent.change(field, { target: { value: 'あ'.repeat(5001) } })
  expect(field.value).toBe('あ'.repeat(5000))
  fireEvent.change(field, { target: { value: 'こんにちは' } })
  expect(field.compareDocumentPosition(insert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(insert)
  expect(field.value).toBe('こんにちは{{name}}')
  await save()
  expect(saved().responseContent).toBe('こんにちは{{name}}')
})

it('取得した実測値と版を復元し、編集内容と同じ版で下書きを保存する', async () => {
  await mount('trigger', {
    folderId: 'folder-a', internalMemo: '一次対応', replyDelaySeconds: 30,
    unmatchedAction: { type: 'notify_operator' },
  }, { versionNumber: 3, matchedLast28Days: 214 })
  expect(screen.getByLabelText('当たった受信（過去28日）').textContent).toBe('214件')
  await save()
  expect(net.saveDraft).toHaveBeenCalledWith('synthetic-rule', expect.objectContaining({
    expectedVersion: 3, folderId: 'folder-a', internalMemo: '一次対応',
    replyDelaySeconds: 30, unmatchedAction: { type: 'notify_operator' },
  }))
  expect(saved()).not.toHaveProperty('matchedLast28Days')
})

it.each([
  ['basic', '基本設定', 'ルール名'],
  ['trigger', 'どんなときに動くか', '反応する言葉を足す'],
  ['response', '何を返すか', '返す文'],
])('URLで指定した%sの段と入力欄を開く', async (step, label, field) => {
  await mount(step)
  const steps = screen.getByRole('navigation', { name: '自動応答を作る進み方' })
  expect(steps.querySelector('[aria-current="step"]')?.textContent).toContain(label)
  expect(screen.getByRole('textbox', { name: field, exact: true })).toBeTruthy()
})

const proxyMode = (mode: 'read' | 'write') => ({ impersonation: { id: 'proxy', tenantId: 'tenant', mode, piiRevealed: false, startedAt: '' }, unfamiliarAt: null, stepUpMethod: 'none' as const })

it.each(['owner', 'admin', 'staff'] as const)('本人%sの既存編集鍵がある時は下書き保存1', async role => {
  rememberStaffIdentity({ ...readStaffIdentity()!, role, permissionKeys: [DELIVERY_FEATURE_POLICIES.autoReplies.key, deliveryPermissionKey('autoReplies', 'edit')] })
  await mount('basic'); expect(canEditWizardNow()).toBe(true); await save()
  expect(net.saveDraft).toHaveBeenCalledTimes(1)
})

it.each(['unknown', 'staff-no-key', 'viewer', 'readOnly', 'view_only', 'read-proxy'] as const)('保持した保存操作も%sへ変わればsave/create0、writeへ戻すと保存1', async restriction => {
  await mount('basic')
  const heldSave = net.saveAction!
  await act(async () => {
    const identity = readStaffIdentity()!
    if (restriction === 'unknown') forgetStaffIdentity()
    else if (restriction === 'staff-no-key' || restriction === 'viewer') rememberStaffIdentity({ ...identity, role: restriction === 'viewer' ? 'viewer' : 'staff', permissionKeys: [] })
    else if (restriction === 'readOnly') rememberStaffIdentity({ ...identity, readOnly: true })
    else if (restriction === 'view_only') rememberStaffIdentity({ ...identity, roleBundle: 'view_only' })
    else rememberSessionSnapshot(proxyMode('read'))
    heldSave()
  })
  expect(canEditWizardNow()).toBe(false)
  expect(net.saveDraft).not.toHaveBeenCalled(); expect(net.createDraft).not.toHaveBeenCalled()
  await act(async () => { verifiedStaffRole('owner'); rememberSessionSnapshot(proxyMode('write')) }); await save()
  expect(net.saveDraft).toHaveBeenCalledTimes(1)
})

it('read代理でも保存済みGETと順番GETは保ち、edit制約のconflicts/validateを呼ばない', async () => {
  rememberSessionSnapshot(proxyMode('read'))
  const view = await mount('priority')
  expect(net.getDraft).toHaveBeenCalledWith('synthetic-rule'); expect(net.list).toHaveBeenCalled()
  expect(net.conflicts).not.toHaveBeenCalled(); expect(net.validateDraft).not.toHaveBeenCalled()
  net.query = 'id=synthetic-rule&step=confirm'; view.rerender(<Page />); await act(async () => {})
  expect(net.list).toHaveBeenCalled(); expect(net.validateDraft).not.toHaveBeenCalled()
  expect(net.saveDraft).not.toHaveBeenCalled(); expect(net.publishDraft).not.toHaveBeenCalled(); expect(net.testDraft).not.toHaveBeenCalled()
})

it('read代理に切り替えた直後の試し送りをAPIへ進めない', async () => {
  await mount('priority')
  fireEvent.change(screen.getByRole('textbox', { name: '届いたメッセージ' }), { target: { value: '試す言葉' } })
  await act(async () => {
    rememberSessionSnapshot(proxyMode('read'))
    fireEvent.click(screen.getByRole('button', { name: '試す', exact: true }))
  })
  expect(net.testDraft).not.toHaveBeenCalled()
})

it('新規の有効な入力でもread代理へ切り替えたらcreate0、writeへ戻せばcreate1', async () => {
  net.query = ''
  const view = render(<Page />); await act(async () => {})
  fireEvent.change(screen.getByLabelText(/ルール名/), { target: { value: '新規の確認' } })
  net.query = 'step=trigger'
  view.rerender(<Page />); await act(async () => {})
  fireEvent.change(screen.getByRole('textbox', { name: '反応する言葉を足す' }), { target: { value: '確認' } })
  fireEvent.keyDown(screen.getByRole('textbox', { name: '反応する言葉を足す' }), { key: 'Enter' })
  net.query = 'step=response'; view.rerender(<Page />); await act(async () => {})
  fireEvent.change(screen.getByRole('textbox', { name: '返す文' }), { target: { value: '確認用の返信' } })
  const heldSave = net.saveAction!
  await act(async () => { rememberSessionSnapshot(proxyMode('read')); heldSave() })
  expect(net.createDraft).not.toHaveBeenCalled()
  await act(async () => { rememberSessionSnapshot(proxyMode('write')) })
  await save()
  expect(net.createDraft).toHaveBeenCalledTimes(1)
})

it('保存結果に版番号がないときは成功と見せず、入力と以前の版を保つ', async () => {
  await mount('basic')
  const field = screen.getByRole('textbox', { name: 'ルール名' }) as HTMLInputElement
  fireEvent.change(field, { target: { value: '残しておく名前' } })
  net.saveDraft.mockResolvedValueOnce({ success: true, data: {} })
  await save()
  expect(screen.getByText(/保存結果を確認できません/)).toBeTruthy()
  expect(field.value).toBe('残しておく名前')
  expect(net.publishDraft).not.toHaveBeenCalled()
  await save()
  expect(net.saveDraft.mock.calls.map(call => call[1].expectedVersion)).toEqual([1, 1])
})

it('新規保存の応答に下書き番号がないときは画面を移さず、同じ作成キーで確認できる', async () => {
  net.query = 'step=basic'
  net.createDraft.mockResolvedValueOnce({ success: true, data: { ...DRAFT, autoReplyId: '' } })
  const view = render(<Page />); await act(async () => {})
  fireEvent.click(screen.getAllByRole('button', { name: /使う/ })[0]); view.rerender(<Page />); await act(async () => {})
  const before = net.query
  await save()
  expect(screen.getByText(/保存結果を確認できません/)).toBeTruthy()
  expect(net.query).toBe(before)
  await save()
  expect(net.createDraft).toHaveBeenCalledTimes(2)
  expect(net.createDraft.mock.calls[1][1]).toBe(net.createDraft.mock.calls[0][1])
})
