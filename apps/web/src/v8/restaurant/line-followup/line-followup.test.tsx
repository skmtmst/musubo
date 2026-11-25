// @vitest-environment happy-dom
import React from 'react'
import { act,cleanup,fireEvent,render,screen,waitFor,within } from '@testing-library/react'
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import { defaultRestaurantReservationForm,type RestaurantFollowupTrigger,type StaffMember } from '@line-crm/shared'
import { ApiError } from '@/lib/api/transport/errors'
import { forgetStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import { GuideSharedProvider } from '@/v8/onboarding/public/guide-shared/index'
const f=vi.hoisted(()=>({role:'owner' as string|null,account:'a',store:'s',read:vi.fn(),saveForm:vi.fn(),initialize:vi.fn(),saveRow:vi.fn(),test:vi.fn(),start:vi.fn(),notUsing:vi.fn(),push:vi.fn()}))
vi.mock('@/contexts/account-context',()=>({useAccount:()=>({selectedAccountId:f.account})}))
vi.mock('@/lib/staff-role',()=>({useStaffRole:()=>f.role}))
vi.mock('next/navigation',()=>({useRouter:()=>({push:f.push,replace:vi.fn(),back:vi.fn()}),usePathname:()=>'/restaurant-test/line-followup',useSearchParams:()=>new URLSearchParams()}))
vi.mock('@/v8/restaurant/common-a/public/frame/index',()=>({RestaurantFrame:({children}:{children:(ctx:unknown)=>React.ReactNode})=>children({store:{id:f.store,name:'試験店'}})}))
vi.mock('@/lib/api/helpers/restaurant-followup-board',()=>({followupBoardApi:{read:f.read,saveForm:f.saveForm,initialize:f.initialize,saveRow:f.saveRow,test:f.test,start:f.start,notUsing:f.notUsing}}))
vi.mock('./followup-template-picker',()=>({FollowupTemplatePicker:({onPick,onCancel}:{onPick:(bubbles:unknown[])=>void;onCancel:()=>void})=><section role="dialog" aria-label="テンプレートから選ぶ"><button onClick={()=>onPick([{id:'picked',type:'text',content:{text:'選んだテンプレートの本文'}}])}>このテンプレートを選ぶ</button><button onClick={onCancel}>選ぶのをやめる</button></section>}))
import LineFollowupV8 from './line-followup'
import { FOLLOWUP_ORDER,FOLLOWUP_NAMES } from './board-model'
let snapshot:ReturnType<typeof initial>
function initial(){
 const timing=(trigger:RestaurantFollowupTrigger)=>trigger==='anniversary_before'?{mode:'time',offsetDays:-7,sendAtTime:'10:00'}:trigger==='reservation_24h'?{mode:'time',offsetDays:-1,sendAtTime:'18:00'}:{mode:'countdown',offsetMinutes:trigger==='reservation_2h'?-120:trigger==='post_visit'?180:0}
 return {page:{setup:{notUsing:false,decidedAt:null,version:0},template:null,bindings:[],jobs:[],editor:'common_scenario',rows:FOLLOWUP_ORDER.map(trigger=>({store_id:'s',trigger,enabled:['reservation_created','reservation_24h'].includes(trigger),version:1,step_id:null,initial_key:trigger,default_offset_minutes:0,initial_message:`${FOLLOWUP_NAMES[trigger]}の本文`}))},board:{testRecipient:{state:'ready',recipientKind:'self',recipient:{id:'self',displayName:'本人',pictureUrl:null}},legacyContents:FOLLOWUP_ORDER.map(trigger=>({trigger,content:{timing:timing(trigger),messageParts:[{messageType:'text',messageContent:`${FOLLOWUP_NAMES[trigger]}の本文`}]}})),engines:FOLLOWUP_ORDER.map(trigger=>({trigger,engine:['reservation_24h','reservation_2h','anniversary_before'].includes(trigger)?'reminder':'automation',targetId:`resource-${trigger}`,targetVersion:1,contentRevision:'revision1',enabled:['reservation_created','reservation_24h'].includes(trigger),effectiveSendingStatus:'stopped',reason:'まだ送っていません',detailPath:trigger==='reservation_24h'?'/reminders/detail?id=resource-reservation_24h':`/automations/drafts?id=resource-${trigger}`,editorContent:{timing:timing(trigger),messageParts:[{messageType:'text',messageContent:`${FOLLOWUP_NAMES[trigger]}の本文`}]}}))},form:{version:0,definition:defaultRestaurantReservationForm()}}
}
beforeEach(()=>{
 f.role='owner';f.account='a';f.store='s';snapshot=initial()
 rememberStaffIdentity({ id: 'test-owner', tenantId: 'test-hq', role: 'owner' } as StaffMember)
 f.read.mockImplementation(async()=>structuredClone(snapshot))
 f.saveRow.mockImplementation(async(_a,_s,trigger,input)=>{const row=snapshot.page.rows.find(row=>row.trigger===trigger)!,engine=snapshot.board.engines.find(row=>row.trigger===trigger)!;row.enabled=input.enabled;row.version++;engine.enabled=input.enabled;engine.targetVersion++;engine.contentRevision='revision2';engine.editorContent={timing:input.timing,messageParts:input.messageBubbles.map((bubble:{content:{text:string}})=>({messageType:'text',messageContent:bubble.content.text}))};return {}})
 f.saveForm.mockImplementation(async(_a,_s,_v,definition)=>{snapshot.form={version:snapshot.form.version+1,definition};return snapshot.form})
 f.initialize.mockImplementation(async()=>{snapshot.board.engines=initial().board.engines;return {}})
 f.test.mockResolvedValue({recipientName:'本人',recipientKind:'self',contentHash:'tested-hash',versionId:'tested-version',sent:1,replayed:false})
 f.start.mockImplementation(async(_a,_s,trigger)=>{snapshot.board.engines.find(row=>row.trigger===trigger)!.effectiveSendingStatus='active';return {sendingStatus:'active'}})
 f.notUsing.mockImplementation(async()=>{snapshot.page.setup={notUsing:true,version:1,decidedAt:'2026-11-01'};return snapshot.page.setup})
})
afterEach(()=>{cleanup();sessionStorage.clear();forgetStaffIdentity();vi.resetAllMocks()})
const card=(trigger:RestaurantFollowupTrigger)=>screen.getByRole('article',{name:FOLLOWUP_NAMES[trigger]})
async function ready(){render(<LineFollowupV8/>);await screen.findByRole('article',{name:'予約の回答フォーム'})}
async function edit(trigger:RestaurantFollowupTrigger='reservation_created'){fireEvent.click(within(card(trigger)).getByRole('button',{name:'変える'}));await screen.findByRole('dialog',{name:`${FOLLOWUP_NAMES[trigger]}を変える`})}
async function text(value:string){const field=screen.getByRole('textbox',{name:'本文'});await act(async()=>{field.textContent=value;fireEvent.input(field)})}
async function accept(){fireEvent.click(screen.getByRole('button',{name:'この内容でオンにする'}));await waitFor(()=>expect(screen.queryByRole('button',{name:'この内容でオンにする'})).toBeNull())}
async function save(){fireEvent.click(screen.getByRole('button',{name:'保存して作る'}));await screen.findByRole('dialog',{name:'保存の結果'})}

describe('開店準備の案内', () => {
 const guideAt = (procedureIndex: number) => ({
  phase: 'active' as const, stepKey: 'followup', procedureIndex, anchor: null, pausedAnchor: null,
  start: vi.fn(), startAt: vi.fn(), pause: vi.fn(), resume: vi.fn(), reset: vi.fn(), advanceProcedure: vi.fn(),
 })

 it('初回はオフで始まり、本文の確定まで一覧を変えず、選んだ送り方だけを保存する', async () => {
  snapshot.board.engines = []
  snapshot.page.rows.forEach(row => { row.enabled = false })
  const guide = guideAt(1)
  const view = render(<GuideSharedProvider value={{ guide, summary: null }}><LineFollowupV8 /></GuideSharedProvider>)
  await screen.findByRole('article', { name: '予約の回答フォーム' })
  const toggle = within(card('reservation_created')).getByRole('switch')
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect((screen.getByRole('button', { name: '保存して作る' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(toggle)
  view.rerender(<GuideSharedProvider value={{ guide: { ...guide, procedureIndex: 2 }, summary: null }}><LineFollowupV8 /></GuideSharedProvider>)
  const body = screen.getByRole('textbox', { name: '本文' })
  expect(body.closest('[data-guide-anchor="followup.body"]')?.hasAttribute('data-guide-ready')).toBe(true)
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  expect(f.initialize).not.toHaveBeenCalled()
  view.rerender(<GuideSharedProvider value={{ guide: { ...guide, procedureIndex: 3 }, summary: null }}><LineFollowupV8 /></GuideSharedProvider>)
  expect(screen.getByRole('button', { name: 'この内容でオンにする' }).getAttribute('data-guide-anchor')).toBe('followup.confirm')
  await accept()
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  expect(f.initialize).not.toHaveBeenCalled()
  await save()
  expect(f.initialize).toHaveBeenCalledWith('a', 's', expect.arrayContaining([
   expect.objectContaining({ trigger: 'reservation_created', input: expect.objectContaining({ enabled: true }) }),
   expect.objectContaining({ trigger: 'reservation_24h', input: expect.objectContaining({ enabled: false }) }),
  ]))
  expect(f.test).not.toHaveBeenCalled()
  expect(f.start).not.toHaveBeenCalled()
 })

 it.each([2, 3])('手順 %s を再読込すると同じ本文と編集窓を戻す', async index => {
  snapshot.page.rows[0]!.enabled = false
  const first = render(<GuideSharedProvider value={{ guide: guideAt(1), summary: null }}><LineFollowupV8 /></GuideSharedProvider>)
  await screen.findByRole('article', { name: '予約の回答フォーム' })
  fireEvent.click(within(card('reservation_created')).getByRole('switch'))
  await text('再読込しても残す本文')
  fireEvent.click(screen.getByRole('radio', { name: 'きっかけから時間を置いて送る' }))
  fireEvent.change(screen.getByRole('spinbutton', { name: 'きっかけから待つ時間' }), { target: { value: '15' } })
  first.unmount()

  const guide = guideAt(index)
  render(<GuideSharedProvider value={{ guide, summary: null }}><LineFollowupV8 /></GuideSharedProvider>)
  await screen.findByRole('dialog', { name: '予約したときを変える' })
  const body = screen.getByRole('textbox', { name: '本文' })
  expect(body.textContent).toContain('再読込しても残す本文')
  expect((screen.getByRole('spinbutton', { name: 'きっかけから待つ時間' }) as HTMLInputElement).value).toBe('15')
  expect(within(card('reservation_created')).getByRole('switch').getAttribute('aria-checked')).toBe('false')
  if (index === 2) expect(body.closest('[data-guide-anchor="followup.body"]')).toBeTruthy()
  else expect(screen.getByRole('button', { name: 'この内容でオンにする' }).getAttribute('data-guide-anchor')).toBe('followup.confirm')
  expect(guide.startAt).not.toHaveBeenCalled()
  expect(f.initialize).not.toHaveBeenCalled()
  expect(f.saveRow).not.toHaveBeenCalled()
  expect(f.test).not.toHaveBeenCalled()
  expect(f.start).not.toHaveBeenCalled()
 })

 it('確定後の再読込では未保存の内容を手順4へ戻し、利用者が保存するまで登録しない', async () => {
  snapshot.page.rows[0]!.enabled = false
  const first = render(<GuideSharedProvider value={{ guide: guideAt(3), summary: null }}><LineFollowupV8 /></GuideSharedProvider>)
  await screen.findByRole('article', { name: '予約の回答フォーム' })
  fireEvent.click(within(card('reservation_created')).getByRole('switch'))
  await text('確定済みの未保存本文')
  await accept()
  first.unmount()

  const guide = guideAt(4)
  render(<GuideSharedProvider value={{ guide, summary: null }}><LineFollowupV8 /></GuideSharedProvider>)
  await waitFor(() => expect(within(card('reservation_created')).getByText('未保存')).toBeTruthy())
  expect(within(card('reservation_created')).getByRole('switch').getAttribute('aria-checked')).toBe('true')
  expect(within(card('reservation_created')).getByText('確定済みの未保存本文')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.saveRow).not.toHaveBeenCalled()
  await save()
  expect(f.saveRow).toHaveBeenCalledWith('a', 's', 'reservation_created', expect.objectContaining({
   enabled: true, messageBubbles: [expect.objectContaining({ content: expect.objectContaining({ text: '確定済みの未保存本文' }) })],
  }))
  expect(f.test).not.toHaveBeenCalled()
  expect(f.start).not.toHaveBeenCalled()
 })

 it('別の保存が先に行われたら、以前の下書きで現在の送り方を上書きしない', async () => {
  const first = render(<GuideSharedProvider value={{ guide: guideAt(2), summary: null }}><LineFollowupV8 /></GuideSharedProvider>)
  await screen.findByRole('article', { name: '予約の回答フォーム' })
  await edit()
  await text('前の版の本文')
  first.unmount()
  snapshot.page.rows[0]!.version++

  const guide = guideAt(3)
  render(<GuideSharedProvider value={{ guide, summary: null }}><LineFollowupV8 /></GuideSharedProvider>)
  await waitFor(() => expect(guide.startAt).toHaveBeenCalledWith('followup'))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(f.saveRow).not.toHaveBeenCalled()
 })

 it('途中から開いたときに未保存の編集窓がなければ、最初の案内へ戻す', async () => {
  const guide = guideAt(3)
  render(<GuideSharedProvider value={{ guide, summary: null }}><LineFollowupV8 /></GuideSharedProvider>)
  await waitFor(() => expect(guide.startAt).toHaveBeenCalledWith('followup'))
  expect(f.initialize).not.toHaveBeenCalled()
  expect(f.saveRow).not.toHaveBeenCalled()
 })
})

describe('8枚のカードと保存',()=>{
 it('状態の応答が欠けた時は画面を壊さず、読み直す理由を出して保存しない',async()=>{f.read.mockResolvedValue({...snapshot,board:{...snapshot.board,engines:undefined}});render(<LineFollowupV8/>);await screen.findByText('送り方の状態を読み込めませんでした。読み直してください');expect(screen.queryByRole('article')).toBeNull();expect(screen.getByRole('button',{name:'読み直す'})).toBeTruthy();expect(f.saveRow).not.toHaveBeenCalled();expect(f.initialize).not.toHaveBeenCalled()})
 it('予約フォームは切り替え無し、残る7枚は実物の中身と状態を表示する',async()=>{await ready();expect(screen.getAllByRole('article')).toHaveLength(8);expect(screen.getAllByRole('switch')).toHaveLength(7);expect(within(screen.getByRole('article',{name:'予約の回答フォーム'})).queryByRole('switch')).toBeNull();expect(within(card('reservation_created')).getByText('予約したときの本文')).toBeTruthy();expect(screen.getAllByText('準備済み・送信停止中')).toHaveLength(2)})
 it('オンとオフは保存まで送信を変えず、同じ行と実物の版で保存する',async()=>{await ready();fireEvent.click(within(card('reservation_created')).getByRole('switch'));expect(f.saveRow).not.toHaveBeenCalled();await save();expect(f.saveRow).toHaveBeenCalledWith('a','s','reservation_created',expect.objectContaining({expectedRowVersion:1,expectedTargetVersion:1,expectedContentRevision:'revision1',enabled:false}));expect(f.test).not.toHaveBeenCalled();expect(f.start).not.toHaveBeenCalled()})
 it('時刻の選択を分へ勝手に丸めず、日と現地の時刻を保存する',async()=>{await ready();await edit('reservation_24h');expect(screen.getByRole('combobox',{name:'送る時刻'})).toBeTruthy();fireEvent.change(screen.getByRole('spinbutton',{name:'予約の何日前'}),{target:{value:'3'}});await accept();await save();expect(f.saveRow).toHaveBeenCalledWith('a','s','reservation_24h',expect.objectContaining({timing:{mode:'time',offsetDays:-3,sendAtTime:'18:00'}}))})
 it('割り切れない既存の分数を正確に出し、本文だけ変えても保つ',async()=>{snapshot.board.engines.find(row=>row.trigger==='post_visit')!.editorContent.timing={mode:'countdown',offsetMinutes:185};await ready();await edit('post_visit');expect((screen.getByRole('spinbutton',{name:'きっかけから待つ時間'}) as HTMLInputElement).value).toBe('185');await text('内容の更新');await accept();await save();expect(f.saveRow).toHaveBeenCalledWith('a','s','post_visit',expect.objectContaining({timing:{mode:'countdown',offsetMinutes:185}}))})
 it('2通目以降を落とさず、本文を版付きで保存する',async()=>{snapshot.board.engines[0]!.editorContent.messageParts.push({messageType:'text',messageContent:'続きの本文'});await ready();await edit();await text('先頭の修正');await accept();await save();expect(f.saveRow).toHaveBeenCalledWith('a','s','reservation_created',expect.objectContaining({messageBubbles:expect.arrayContaining([expect.objectContaining({content:expect.objectContaining({text:'先頭の修正'})}),expect.objectContaining({content:expect.objectContaining({text:'続きの本文'})})])}))})
 it('テンプレートを選んだ本文を保存し、ダイアログのキャンセルは値を変えない',async()=>{await ready();await edit();fireEvent.click(screen.getByRole('button',{name:'テンプレートから選ぶ'}));fireEvent.click(screen.getByRole('button',{name:'このテンプレートを選ぶ'}));await accept();await save();expect(f.saveRow).toHaveBeenCalledWith('a','s','reservation_created',expect.objectContaining({messageBubbles:[expect.objectContaining({content:{text:'選んだテンプレートの本文'}})]}))})
 it('詳細で構成を増やした実物を空の本文で上書きしない',async()=>{snapshot.board.engines[0]!.editorContent=null as never;await ready();const change=within(card('reservation_created')).getByRole('button',{name:'変える'});fireEvent.click(change);expect(screen.queryByRole('dialog')).toBeNull();expect(within(card('reservation_created')).getByText('詳細で中身を確認してから試してください。')).toBeTruthy();expect(f.saveRow).not.toHaveBeenCalled()})
 it('詳しい設定の行き先は保存済みの実物のURLを使う',async()=>{await ready();expect(within(card('reservation_24h')).getByRole('link',{name:'詳しく設定する →'}).getAttribute('href')).toBe('/reminders/detail?id=resource-reservation_24h')})
 it('他のカードを開いても未保存の内容を保つ',async()=>{await ready();await edit();await text('まだ保存していない本文');await accept();await edit('reservation_24h');fireEvent.click(screen.getByRole('button',{name:'キャンセル'}));await edit();expect(screen.getByRole('textbox',{name:'本文'}).textContent).toContain('まだ保存していない本文')})
 it('競合した行は入力と理由を保ち、他の成功した行だけを反映する',async()=>{await ready();fireEvent.click(within(card('reservation_created')).getByRole('switch'));fireEvent.click(within(card('reservation_24h')).getByRole('switch'));f.saveRow.mockImplementationOnce(async()=>{snapshot.page.rows[0]!.enabled=false;return {}}).mockRejectedValueOnce(new Error('ほかの担当者が先に保存しました'));await save();expect(screen.getByText('保存できませんでした')).toBeTruthy();expect(screen.getByText('ほかの担当者が先に保存しました')).toBeTruthy();expect(f.saveRow).toHaveBeenCalledTimes(2)})
 it('読取時に版が進んでいれば保存せず、元の入力を残す',async()=>{await ready();await edit();await text('自分の変更');await accept();snapshot.page.rows[0]!.version=2;await save();expect(f.saveRow).not.toHaveBeenCalled();expect(screen.getByText('ほかの担当者が設定を変えました。読み直してください')).toBeTruthy()})
 it('初めての店はオンもオフも7行を1回で初期化する',async()=>{snapshot.board.engines=[];await ready();await edit();await text('初めての設定');await accept();await save();expect(f.initialize).toHaveBeenCalledTimes(1);expect(f.initialize.mock.calls[0]![2]).toHaveLength(7);expect(f.saveRow).not.toHaveBeenCalled()})
 it('保存失敗は成功の印にせず、送り始めやテストを呼ばない',async()=>{await ready();await edit();await text('保存失敗する内容');await accept();f.saveRow.mockRejectedValue(new ApiError(409,'LINE公式アカウントを接続してください','line_account_required'));await save();expect(screen.getByText('保存できませんでした')).toBeTruthy();expect(screen.getByText('LINE公式アカウントを接続してください')).toBeTruthy();expect(f.test).not.toHaveBeenCalled();expect(f.start).not.toHaveBeenCalled()})
})
describe('フォームと権限',()=>{
 it('フォームの題と完了文を保存し、予約に必須の3項目は解除できない',async()=>{await ready();fireEvent.click(within(screen.getByRole('article',{name:'予約の回答フォーム'})).getByRole('button',{name:'変える'}));expect(screen.getAllByText('表示する')).toHaveLength(6);expect(screen.getAllByText('必須にする')).toHaveLength(6);fireEvent.change(screen.getByRole('textbox',{name:'題名'}),{target:{value:'お席の受付'}});fireEvent.change(screen.getByRole('textbox',{name:'完了後の文'}),{target:{value:'受け付けました'}});expect((screen.getByRole('switch',{name:'お名前を表示する'}) as HTMLButtonElement).disabled).toBe(true);fireEvent.click(screen.getByRole('button',{name:'この内容にする'}));await save();expect(f.saveForm).toHaveBeenCalledWith('a','s',0,expect.objectContaining({title:'お席の受付',completionMessage:'受け付けました'}),undefined)})
 for(const role of ['staff','viewer'])it(`${role}は変更と保存と今は使わないを押せず、操作は残る`,async()=>{f.role=role;await ready();fireEvent.click(within(card('reservation_created')).getByRole('switch'));fireEvent.click(screen.getByRole('button',{name:'今は使わない'}));fireEvent.click(screen.getByRole('button',{name:'保存して作る'}));expect(screen.queryByRole('dialog')).toBeNull();expect(f.saveRow).not.toHaveBeenCalled();expect(f.notUsing).not.toHaveBeenCalled();expect(screen.getAllByRole('button',{name:'変える'})).toHaveLength(8)})
 it('権限が未取得なら閲覧のみと断定せず、全ての変更を止める',async()=>{f.role=null;await ready();expect(screen.queryByText(/閲覧のみで見ています/)).toBeNull();fireEvent.click(within(card('reservation_created')).getByRole('button',{name:'変える'}));expect(screen.queryByRole('dialog')).toBeNull()})
 it('全オフでだけ今は使わないを店ごとの版付きで保存する',async()=>{snapshot.page.rows.forEach(row=>row.enabled=false);snapshot.board.engines.forEach(row=>row.enabled=false);await ready();fireEvent.click(screen.getByRole('button',{name:'今は使わない'}));fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'今は使わない'}));await waitFor(()=>expect(f.notUsing).toHaveBeenCalledWith('a','s',0))})
 it('オンがある時に今は使わないを保存しない',async()=>{await ready();fireEvent.click(screen.getByRole('button',{name:'今は使わない'}));expect(screen.queryByRole('dialog')).toBeNull();expect(f.notUsing).not.toHaveBeenCalled()})
 it('取得失敗を未保存の見本として扱わず、理由と読み直しを出す',async()=>{f.read.mockRejectedValue(new Error('通信できません'));render(<LineFollowupV8/>);await screen.findByText('通信できません');expect(screen.queryByRole('article')).toBeNull();expect(screen.getByRole('button',{name:'読み直す'})).toBeTruthy()})
})
describe('テストと公開・承認',()=>{
 async function open(){await ready();fireEvent.click(within(card('reservation_created')).getByRole('button',{name:'試す・送り始める'}));await screen.findByRole('dialog')}
 it('試し送信と開始の確認に操作先と環境を表示する',async()=>{await open();const dialog=screen.getByRole('dialog');expect(dialog.textContent).toContain('LINEアカウント');expect(dialog.textContent).toContain('店舗');expect(dialog.textContent).toContain('環境')})
 it('本人のテスト成功後だけ、同じ指紋で公開と承認を呼ぶ',async()=>{await open();fireEvent.click(screen.getByRole('button',{name:'自分の LINE で試す'}));await screen.findByRole('button',{name:'この内容で送り始める'});expect(f.start).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'この内容で送り始める'}));await waitFor(()=>expect(f.start).toHaveBeenCalledWith('a','s','reservation_created',1,'tested-hash'))})
 it.each(['山田','山田さん','山田さま','山田様'])('テスト成功の宛先%sの敬称を重ねない',async recipientName=>{
  f.test.mockResolvedValue({recipientName,recipientKind:'self',contentHash:'tested-hash',versionId:'tested-version',sent:1,replayed:false})
  await open();fireEvent.click(screen.getByRole('button',{name:'自分の LINE で試す'}))
  const name=recipientName==='山田'?'山田さん':recipientName
  expect(await screen.findByText(`${name}へテスト送信できました。同じ版を公開し、承認してからお客さまへ送り始めます。`)).toBeTruthy()
 })
 it('登録済みの別宛先を自分のLINEとは呼ばず、名前を見せる',async()=>{snapshot.board.testRecipient.recipientKind='registered';snapshot.board.testRecipient.recipient.displayName='登録した宛先';await open();expect(screen.queryByRole('button',{name:'自分の LINE で試す'})).toBeNull();expect(screen.getByRole('button',{name:'登録済みのテスト宛先で試す'})).toBeTruthy();expect(screen.getByText(/登録した宛先/)).toBeTruthy()})
 it('テスト失敗と結果不明の時は開始せず、不明な送信は繰り返さない',async()=>{f.test.mockRejectedValue(new ApiError(409,'送信結果を確認できません','delivery_unconfirmed'));await open();fireEvent.click(screen.getByRole('button',{name:'自分の LINE で試す'}));await screen.findByText(/送信結果が分からないため/);fireEvent.click(screen.getByRole('button',{name:'自分の LINE で試す'}));expect(f.test).toHaveBeenCalledTimes(1);expect(f.start).not.toHaveBeenCalled()})
 it('開始が競合した時に成功とは表示せず、理由を残す',async()=>{f.start.mockRejectedValue(new Error('公開する内容が変わりました。読み直してください'));await open();fireEvent.click(screen.getByRole('button',{name:'自分の LINE で試す'}));await screen.findByRole('button',{name:'この内容で送り始める'});fireEvent.click(screen.getByRole('button',{name:'この内容で送り始める'}));await screen.findByText('公開する内容が変わりました。読み直してください');expect(screen.queryByText('公開と承認が完了しました。この内容で送り始めます。')).toBeNull()})
})

it('予約フォームだけを保存するときは未移行の7行を切り替えない',async()=>{
 snapshot.board.engines=[];await ready();fireEvent.click(within(screen.getByRole('article',{name:'予約の回答フォーム'})).getByRole('button',{name:'変える'}));fireEvent.change(screen.getByRole('textbox',{name:'題名'}),{target:{value:'変更した題'}});fireEvent.click(screen.getByRole('button',{name:'この内容にする'}));await save();expect(f.saveForm).toHaveBeenCalledTimes(1);expect(f.initialize).not.toHaveBeenCalled();expect(f.saveRow).not.toHaveBeenCalled();
});
it('壊れたフォームの案内を出し、内容を確認して同じ破損の指紋でだけ修復する',async()=>{
 Object.assign(snapshot,{formError:'予約フォームの設定が読めないため、最小の項目で受け付けています。直してください'});
 Object.assign(snapshot.form,{version:-1,repairToken:'broken-fingerprint'});
 await ready();expect(screen.getByText(/最小の項目で受け付けています/)).toBeTruthy();expect(f.saveForm).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'予約フォームを直す'}));fireEvent.click(screen.getByRole('button',{name:'この内容にする'}));await save();
 expect(f.saveForm).toHaveBeenCalledWith('a','s',-1,expect.anything(),'broken-fingerprint');
});
it('画面を離れた後に遅いテストの成功が返っても開始しない',async()=>{
 let resolve!:(value:unknown)=>void;f.test.mockImplementation(()=>new Promise(done=>{resolve=done}));
 const view=render(<LineFollowupV8/>);await screen.findByRole('article',{name:'予約の回答フォーム'});fireEvent.click(within(card('reservation_created')).getByRole('button',{name:'試す・送り始める'}));fireEvent.click(screen.getByRole('button',{name:'自分の LINE で試す'}));view.unmount();
 await act(async()=>resolve({contentHash:'late',recipientName:'本人'}));expect(f.start).not.toHaveBeenCalled();
});

it('画像の吹き出しを本文の編集で消さず、同じ画像を保存する',async()=>{
 snapshot.board.engines[0]!.editorContent.messageParts.push({messageType:'image',messageContent:JSON.stringify({originalContentUrl:'https://example.test/image.jpg',previewImageUrl:'https://example.test/preview.jpg'})});
 await ready();await edit();await text('画像と一緒に送る本文');await accept();await save();
 expect(f.saveRow.mock.calls[0][3].messageBubbles.some((bubble:{type:string})=>bubble.type==='image')).toBe(true);
});
it('以前の承認待ちと口コミ依頼の履歴を読み戻す',async()=>{
 Object.assign(snapshot.page,{template:{store_id:'s',scenario_id:'old',template_version:2,sending_status:'pending',approved_version_id:null,approval_id:'approval'}});Object.assign(snapshot,{reviewCount:3});
 await ready();expect(screen.getByRole('link',{name:'承認の状況を見る →'}).getAttribute('href')).toBe('/restaurant-test/approvals');expect(within(card('review_request')).getByText('送信履歴 3件')).toBeTruthy();
});
it('別の店に切り替えると、前の店の未保存内容を持ち込まない',async()=>{
 const view=render(<LineFollowupV8/>);await screen.findByRole('article',{name:'予約の回答フォーム'});await edit();await text('前の店の入力');await accept();
 f.store='other';view.rerender(<LineFollowupV8/>);await waitFor(()=>expect(f.read).toHaveBeenCalledWith('a','other'));
 expect(within(card('reservation_created')).queryByText('前の店の入力')).toBeNull();
});

it('予約の日時の差し込みは日本語で見せ、保存するキーを保つ',async()=>{
 snapshot.board.engines[0]!.editorContent.messageParts[0]!.messageContent='日時：{{var.reservation_datetime}}';
 await ready();await edit();
 const field=screen.getByRole('textbox',{name:'本文'});
 expect(field.textContent).toContain('予約の日時');expect(field.textContent).not.toContain('reservation_datetime');
 fireEvent.click(screen.getByRole('button',{name:'人数',exact:true}));await accept();await save();
 expect(f.saveRow.mock.calls[0][3].messageBubbles[0].content.text).toContain('{{var.reservation_datetime}}');
});

describe('保存失敗の欄への接続',()=>{
 it('本文の保存失敗は入力を残して編集を開き、直すと欄の理由が消える',async()=>{
  await ready();await edit();await text('残す本文');await accept()
  f.saveRow.mockRejectedValueOnce(new ApiError(422,'本文を確認してください','invalid_followup',undefined,undefined,undefined,{messageBubbles:'本文が長すぎます'}))
  fireEvent.click(screen.getByRole('button',{name:'保存して作る'}))
  await screen.findByRole('dialog',{name:'予約したときを変える'})
  const body=screen.getByRole('textbox',{name:'本文'})
  expect(body.textContent).toBe('残す本文');expect(await screen.findByText('本文が長すぎます')).toBeTruthy()
  expect(body.getAttribute('aria-invalid')).toBe('true')
  await text('直した本文');expect(screen.queryByText('本文が長すぎます')).toBeNull()
  await accept();await save();expect(screen.queryByText('本文が長すぎます')).toBeNull()
  expect(f.saveRow.mock.calls.at(-1)?.[3].messageBubbles[0].content.text).toBe('直した本文')
 })
 it('予約フォームの保存失敗は題名を残して開き、直して保存できる',async()=>{
  await ready();fireEvent.click(within(screen.getByRole('article',{name:'予約の回答フォーム'})).getByRole('button',{name:'変える'}))
  fireEvent.change(screen.getByRole('textbox',{name:'題名'}),{target:{value:'残す題名'}})
  fireEvent.click(screen.getByRole('button',{name:'この内容にする'}))
  f.saveForm.mockRejectedValueOnce(new ApiError(422,'題名を確認してください','invalid_form',undefined,undefined,undefined,{definition:'この題名は使えません'}))
  fireEvent.click(screen.getByRole('button',{name:'保存して作る'}))
  await screen.findByRole('dialog',{name:'予約の回答フォームを変える'})
  const title=screen.getByRole('textbox',{name:'題名'}) as HTMLInputElement
  expect(title.value).toBe('残す題名');expect(await screen.findByText('この題名は使えません')).toBeTruthy()
  fireEvent.change(title,{target:{value:'使える題名'}});expect(screen.queryByText('この題名は使えません')).toBeNull()
  fireEvent.click(screen.getByRole('button',{name:'この内容にする'}));await save()
  expect(f.saveForm.mock.calls.at(-1)?.[3].title).toBe('使える題名')
 })
})

it('行の失敗を閉じて別の行を開いても古い欄の理由を持ち込まない',async()=>{
 await ready();await edit();await text('Aの本文');await accept()
 f.saveRow.mockRejectedValueOnce(new ApiError(422,'本文を確認してください','invalid_followup',undefined,undefined,undefined,{messageBubbles:'Aだけの理由'}))
 fireEvent.click(screen.getByRole('button',{name:'保存して作る'}));await screen.findByText('Aだけの理由')
 fireEvent.click(screen.getByRole('button',{name:'キャンセル'}))
 await screen.findByRole('dialog',{name:'保存の結果'});fireEvent.click(screen.getByRole('button',{name:'閉じる',exact:true}))
 await edit('reservation_24h');expect(screen.queryByText('Aだけの理由')).toBeNull()
 expect(screen.getByRole('textbox',{name:'本文'}).getAttribute('aria-invalid')).not.toBe('true')
})
it('一括初期化の欄の理由に行の特定がなければ先頭の行へ結ばない',async()=>{
 snapshot.board.engines=[];await ready();await edit();await text('一括の入力');await accept()
 f.initialize.mockRejectedValueOnce(new ApiError(422,'送り方を確認してください','invalid_followup',undefined,undefined,undefined,{messageBubbles:'どれかの本文を確認してください'}))
 await save();expect(screen.queryByRole('dialog',{name:'予約したときを変える'})).toBeNull()
 expect(await screen.findAllByText('送り方を確認してください')).toHaveLength(7)
 expect(screen.getAllByText('保存できませんでした')).toHaveLength(7)
})

describe('時期の入力の保全',()=>{
 it.each([
  ['reservation_24h','予約の何日前','3',-3],
  ['reservation_2h','予約までの時間','2',-120],
  ['post_visit','きっかけから待つ時間','3',180],
  ['anniversary_before','記念日の何日前','7',-7],
 ] as const)('%sの負の入力を残して欄に理由を出し、直すまで保存しない',async(trigger,label,valid,_expected)=>{
  await ready();await edit(trigger)
  const input=screen.getByRole('spinbutton',{name:label}) as HTMLInputElement
  fireEvent.change(input,{target:{value:'-3'}})
  expect(input.value).toBe('-3')
  expect(input.getAttribute('aria-invalid')).toBe('true')
  const description=input.getAttribute('aria-describedby')?.split(' ').map(id=>document.getElementById(id)?.textContent).join(' ')
  expect(description).toMatch(/確認|選んで|以上/)
  const confirm=screen.getByRole('button',{name:'この内容でオンにする'})
  expect(confirm.getAttribute('aria-disabled')==='true'||confirm.hasAttribute('disabled')).toBe(true)
  fireEvent.click(confirm);expect(screen.getByRole('dialog')).toBeTruthy();expect(f.saveRow).not.toHaveBeenCalled()
  fireEvent.change(input,{target:{value:valid}})
  expect(input.getAttribute('aria-invalid')).not.toBe('true')
  expect(within(screen.getByRole('dialog')).queryByRole('alert')).toBeNull()
  await accept();await save()
  expect(f.saveRow.mock.calls[0][3].timing).toMatchObject(trigger==='reservation_24h'||trigger==='anniversary_before'?{offsetDays:_expected}:{offsetMinutes:_expected})
 })
 it.each(FOLLOWUP_ORDER)('表示できない%sの中身を準備済みと呼ばず、詳細への入口を残す',async trigger=>{
  snapshot.page.rows.find(row=>row.trigger===trigger)!.enabled=true
  snapshot.board.engines.find(row=>row.trigger===trigger)!.editorContent=null as never
  await ready();const row=card(trigger)
  expect(within(row).queryByText('準備済み・送信停止中')).toBeNull()
  expect(within(row).getByText('中身を確認してください')).toBeTruthy()
  expect(within(row).getByText('詳細で中身を確認してから試してください。')).toBeTruthy()
  expect(within(row).getByRole('button',{name:'試す・送り始める'}).hasAttribute('disabled')).toBe(false)
  expect(within(row).getByRole('link',{name:'詳しく設定する →'}).getAttribute('href')).toContain('id=')
 })
})
