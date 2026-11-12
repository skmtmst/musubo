// @vitest-environment happy-dom
import type {ComponentProps} from 'react'
import {afterEach,beforeEach,expect,test,vi} from 'vitest'
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react'
import {verifiedStaffRole} from '@/test-utils/verified-staff-role'
import {forgetStaffIdentity,readStaffIdentity,rememberStaffIdentity} from '@/lib/staff-identity-state'
import {forgetSessionSnapshot,rememberSessionSnapshot} from '@/lib/session-snapshot'
import {ApiError} from '@/lib/api'
import {DEFAULT_CUSTOMER_LOOK} from '@line-crm/shared'
const mock=vi.hoisted(()=>({role:'owner' as string|null,get:vi.fn(),save:vi.fn(),retainedSave:undefined as undefined|(()=>Promise<boolean>)}))
vi.mock('@/lib/api',async original=>({...await original<typeof import('@/lib/api')>(),api:{accountSettings:{getCustomerLook:mock.get,saveCustomerLook:mock.save}}}))
vi.mock('@/contexts/account-context',()=>({useAccount:()=>({selectedAccountId:'a',selectedAccount:{id:'a',name:'店A'},accounts:[{id:'a',name:'店A'}]})}))
vi.mock('@/lib/staff-role',()=>({useStaffRole:()=>mock.role,canManageRole:(role:string)=>['owner','admin'].includes(role)}))
vi.mock('@/components/shell/page-chrome',()=>({usePageTitle:()=>{},usePageCrumbs:()=>{},useHideSettingsNav:()=>{}}))
vi.mock('@/components/layout/settings-inner-nav',()=>({default:()=>null}))
vi.mock('@/components/templates/settings-page',()=>({SettingsPage:({children,preview,saveActions,saveStatus,notice,help}:Pick<ComponentProps<typeof import('@/components/templates/settings-page').SettingsPage>, 'children'|'preview'|'saveActions'|'saveStatus'|'notice'|'help'>)=><div>{help}{notice}{children}{preview}{saveStatus}{saveActions}</div>}))
vi.mock('@/components/shared/customer-look-preview',()=>({default:({look}:{look:typeof DEFAULT_CUSTOMER_LOOK})=><p>見本：{look.preset}</p>}))
vi.mock('@/components/shared/toast',()=>({notifyToast:()=>{}}))
vi.mock('@/lib/use-unsaved-guard',()=>({useUnsavedGuard:()=>({guarded:(fn:()=>void)=>fn(),disarm:()=>{},leaveTarget:null})}))
vi.mock('@/lib/unsaved-leave-dialog',()=>({UnsavedLeaveDialog:({onSave}:{onSave:()=>Promise<boolean>})=>{mock.retainedSave=onSave;return null}}))
import CustomerLookScreen from './screen'
beforeEach(()=>{mock.role=verifiedStaffRole('owner')})
afterEach(()=>{cleanup();forgetStaffIdentity();forgetSessionSnapshot();vi.clearAllMocks();mock.role='owner';mock.retainedSave=undefined})
test('REQ-F01 競合時は入力を残し、最新の版を読んでから保存する',async()=>{
 mock.get.mockResolvedValue({success:true,data:{look:DEFAULT_CUSTOMER_LOOK,version:3}});render(<CustomerLookScreen/>);await screen.findByRole('radio',{name:/モダン/});
 fireEvent.click(screen.getByRole('radio',{name:/モダン/}));expect(screen.getByText('見本：modern')).toBeTruthy();expect(mock.save).not.toHaveBeenCalled();
 mock.save.mockRejectedValue(new ApiError(409,'他の人が変更しました'));fireEvent.click(screen.getByRole('button',{name:'保存する'}));await screen.findByRole('alert');expect(screen.getByText('見本：modern')).toBeTruthy();
 expect((screen.getByRole('button',{name:'保存する'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.getByRole('button',{name:'保存する'}).getAttribute('aria-description')).toBe('最新のデザインを読み直してから保存してください');
 mock.get.mockResolvedValue({success:true,data:{look:DEFAULT_CUSTOMER_LOOK,version:4}});fireEvent.click(screen.getByRole('button',{name:'最新を読み直す'}));await vi.waitFor(()=>expect(mock.get).toHaveBeenCalledTimes(2));expect(screen.getByText('見本：modern')).toBeTruthy();
 mock.save.mockResolvedValue({success:true,data:{look:{...DEFAULT_CUSTOMER_LOOK,preset:'modern'},version:5}});await vi.waitFor(()=>expect((screen.getByRole('button',{name:'保存する'}) as HTMLButtonElement).disabled).toBe(false));fireEvent.click(screen.getByRole('button',{name:'保存する'}));await vi.waitFor(()=>expect(mock.save).toHaveBeenCalledTimes(2));expect(mock.save).toHaveBeenLastCalledWith('a',expect.objectContaining({preset:'modern'}),4);
})
test('閲覧だけなら設定は読め、保存は灰色と理由で止める',async()=>{mock.role=verifiedStaffRole('viewer');mock.get.mockResolvedValue({success:true,data:{look:DEFAULT_CUSTOMER_LOOK,version:3}});render(<CustomerLookScreen/>);await screen.findByText('見本：line');expect(screen.getAllByRole('radio')).toHaveLength(6);for(const radio of screen.getAllByRole('radio'))expect((radio as HTMLInputElement).disabled).toBe(true);const save=screen.getByRole('button',{name:'保存する'}) as HTMLButtonElement;expect(save.getAttribute('aria-disabled')).toBe('true');expect(save.disabled).toBe(false);fireEvent.click(save);expect(mock.save).not.toHaveBeenCalled();expect(document.querySelectorAll('[data-read-only-notice]')).toHaveLength(1)})

test('未変更では帯を出さず、変更後は保存できる', async () => {
 mock.get.mockResolvedValue({success:true,data:{look:DEFAULT_CUSTOMER_LOOK,version:3}})
 render(<CustomerLookScreen/>); await screen.findByRole('radio',{name:/モダン/})
 for (const name of ['キャンセル','保存する']) expect(screen.queryByRole('button',{name})).toBeNull()
 fireEvent.click(screen.getByRole('radio',{name:/モダン/}))
 const save = screen.getByRole('button',{name:'保存する'}) as HTMLButtonElement
 expect(save.disabled).toBe(false); expect(save.hasAttribute('aria-description')).toBe(false)
})

test('型の下からカスタムへ進み、色と書体を変えて保存できる',async()=>{
 mock.get.mockResolvedValue({success:true,data:{look:DEFAULT_CUSTOMER_LOOK,version:3}})
 mock.save.mockResolvedValue({success:true,data:{look:{...DEFAULT_CUSTOMER_LOOK,preset:'custom',headingFont:'mincho'},version:4}})
 render(<CustomerLookScreen/>);await screen.findByRole('radio',{name:/モダン/})
 const summary=screen.getByText('カスタムの色と書体').closest('summary')!
 expect(summary.parentElement?.hasAttribute('open')).toBe(false)
 expect(summary.textContent).toContain('主の色・背景の色・見出しの書体')
 fireEvent.click(screen.getByRole('radio',{name:/カスタム/}))
 expect(screen.getByText('カスタムの色と書体').closest('details')?.hasAttribute('open')).toBe(true)
 fireEvent.click(screen.getByRole('button',{name:'見出しの書体'}))
 fireEvent.click(screen.getByRole('option',{name:'明朝'}).querySelector('button')!)
 await vi.waitFor(()=>expect(screen.getByRole('button',{name:'見出しの書体'}).textContent).toContain('明朝'))
 fireEvent.click(screen.getByRole('button',{name:'保存する'}))
 await vi.waitFor(()=>expect(mock.save).toHaveBeenCalledWith('a',expect.objectContaining({preset:'custom',headingFont:'mincho'}),3))
})


const proxy=(mode:'read'|'write')=>({impersonation:{id:'proxy',tenantId:'tenant',mode,piiRevealed:false,startedAt:''},unfamiliarAt:null,stepUpMethod:'none' as const})

test('編集中の閲覧代理への切替でもdraftは残り、古い保存handlerは0回、writeへ戻して同じ版で保存1回',async()=>{
 mock.get.mockResolvedValue({success:true,data:{look:DEFAULT_CUSTOMER_LOOK,version:3}})
 mock.save.mockResolvedValue({success:true,data:{look:{...DEFAULT_CUSTOMER_LOOK,preset:'modern'},version:4}})
 render(<CustomerLookScreen/>);await screen.findByRole('radio',{name:/モダン/})
 fireEvent.click(screen.getByRole('radio',{name:/モダン/}))
 const retained=mock.retainedSave!
 act(()=>rememberSessionSnapshot(proxy('read')))
 const save=screen.getByRole('button',{name:'保存する'})
 expect(save.getAttribute('aria-disabled')).toBe('true')
 expect(screen.getByText('見本：modern')).toBeTruthy()
 expect(document.querySelectorAll('[data-read-only-notice]')).toHaveLength(1)
 fireEvent.click(save)
 await act(async()=>{expect(await retained()).toBe(false)})
 expect(mock.save).not.toHaveBeenCalled()
 act(()=>rememberSessionSnapshot(proxy('write')))
 expect(document.querySelector('[data-read-only-notice]')).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:'保存する'}))
 await vi.waitFor(()=>expect(mock.save).toHaveBeenCalledExactlyOnceWith('a',expect.objectContaining({preset:'modern'}),3))
})

test.each(['readOnly','view_only'])('%sは元のowner役割に優先し、見本のGETは残して保存0',async restriction=>{
 const identity=readStaffIdentity()!
 rememberStaffIdentity({...identity,readOnly:restriction==='readOnly',roleBundle:restriction==='view_only'?'view_only':undefined})
 mock.role='viewer'
 mock.get.mockResolvedValue({success:true,data:{look:DEFAULT_CUSTOMER_LOOK,version:3}})
 render(<CustomerLookScreen/>);await screen.findByText('見本：line')
 expect(mock.get).toHaveBeenCalledTimes(1)
 fireEvent.click(screen.getByRole('button',{name:'保存する'}))
 expect(mock.save).not.toHaveBeenCalled()
 expect(screen.getByRole('button',{name:'保存する'}).getAttribute('aria-disabled')).toBe('true')
})

test('本人未知の保存は理由なしdisabled/帯0、owner確定後に通常の編集を使える',async()=>{
 mock.role=verifiedStaffRole(null)
 mock.get.mockResolvedValue({success:true,data:{look:DEFAULT_CUSTOMER_LOOK,version:3}})
 render(<CustomerLookScreen/>);await screen.findByText('見本：line')
 const save=screen.getByRole('button',{name:'保存する'}) as HTMLButtonElement
 expect(save.disabled).toBe(true)
 expect(document.querySelector('[data-permission-locked]')).toBeNull()
 expect(document.querySelector('[data-read-only-notice]')).toBeNull()
 expect(save.getAttribute('aria-description')).toBeNull()
 fireEvent.click(save);expect(mock.save).not.toHaveBeenCalled()
 mock.role='owner';verifiedStaffRole('owner')
 await screen.findByRole('radio',{name:/モダン/})
 expect(screen.queryByRole('button',{name:'保存する'})).toBeNull()
})

test('adminも変更を同じ版で1回だけ保存する',async()=>{
 mock.role=verifiedStaffRole('admin')
 mock.get.mockResolvedValue({success:true,data:{look:DEFAULT_CUSTOMER_LOOK,version:3}})
 mock.save.mockResolvedValue({success:true,data:{look:{...DEFAULT_CUSTOMER_LOOK,preset:'modern'},version:4}})
 render(<CustomerLookScreen/>);await screen.findByRole('radio',{name:/モダン/})
 fireEvent.click(screen.getByRole('radio',{name:/モダン/}))
 fireEvent.click(screen.getByRole('button',{name:'保存する'}))
 await vi.waitFor(()=>expect(mock.save).toHaveBeenCalledExactlyOnceWith('a',expect.objectContaining({preset:'modern'}),3))
})


test('閲覧者にも6枚の型と同じ色見本/明朝の欄を残し、native disabledで選択と保存を止める',async()=>{
 mock.role=verifiedStaffRole('viewer')
 mock.get.mockResolvedValue({success:true,data:{look:{...DEFAULT_CUSTOMER_LOOK,preset:'custom',primaryColor:'#117755',backgroundColor:'#f8fbf9',headingFont:'mincho'},version:3}})
 const view=render(<CustomerLookScreen/>);await screen.findByRole('radio',{name:/カスタム/})
 const custom=screen.getByRole('radio',{name:/カスタム/}) as HTMLInputElement
 expect(custom.checked).toBe(true)
 for(const radio of screen.getAllByRole('radio')){expect((radio as HTMLInputElement).disabled).toBe(true);fireEvent.click(radio)}
 for(const name of [/主の色（今の色/,/背景の色（今の色/,/^見出しの書体$/]){
  const field=screen.getByRole('button',{name}) as HTMLButtonElement
  expect(field.disabled).toBe(true);fireEvent.click(field)
 }
 expect(screen.getByRole('button',{name:'見出しの書体'}).textContent).toContain('明朝')
 expect(view.container.querySelector('dl')).toBeNull()
 expect(screen.queryByRole('dialog')).toBeNull();expect(screen.queryByRole('listbox')).toBeNull()
 expect(screen.getByText('見本：custom')).toBeTruthy();expect(custom.checked).toBe(true)
 fireEvent.click(screen.getByRole('button',{name:'保存する'}));expect(mock.save).not.toHaveBeenCalled()
})

test.each(['viewer', null] as const)('編集できない%sには型を押す案内を出さない', async role => {
 mock.role=verifiedStaffRole(role)
 mock.get.mockResolvedValue({success:true,data:{look:DEFAULT_CUSTOMER_LOOK,version:3}})
 render(<CustomerLookScreen/>);await screen.findByText('見本：line')
 expect(screen.queryByText('型を押すと、右の見本がすぐ変わります')).toBeNull()
 expect(screen.getByText('予約・回答フォームなどに使われるデザインです')).toBeTruthy()
})


test.each([true, false])('画面の説明も編集可否 %s に合う', async canEdit => {
 mock.role=verifiedStaffRole(canEdit?'owner':'viewer')
 mock.get.mockResolvedValue({success:true,data:{look:DEFAULT_CUSTOMER_LOOK,version:3}})
 render(<CustomerLookScreen/>);await screen.findByText('見本：line')
 expect(screen.getByText(/予約・回答フォーム・履歴・スタンプなど/)).toBeTruthy()
 expect(Boolean(screen.queryByText(/保存するとお客さまの画面に反映されます/))).toBe(canEdit)
})
