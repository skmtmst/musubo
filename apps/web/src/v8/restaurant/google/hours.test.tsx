// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyHoursWorkspace, HOURS_WEEKDAYS, type HoursWorkspace, type OpeningWeek, type StaffMember } from '@line-crm/shared'
import type { GoogleProfileData } from '@/lib/restaurant-google-api'
import { forgetStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import HoursPage from './hours'
const mocks=vi.hoisted(()=>({profile:vi.fn(),hoursWorkspace:vi.fn(),saveHoursWorkspace:vi.fn(),reviewHoursWorkspace:vi.fn(),sendChange:vi.fn(),change:vi.fn(),proposeHours:vi.fn(),allowed:true}))
vi.mock('@/lib/restaurant-google-api',()=>({restaurantGoogleApi:mocks}))
vi.mock('./use-google-permission',()=>({useGooglePermission:()=>({allowed:mocks.allowed,known:true,lockedReason:mocks.allowed?undefined:'管理者のみ変更できます'})}))
vi.mock('next/navigation',async()=>(await import('@/test-utils/navigation-mock')).navigationMock())
const weekly=Object.fromEntries(HOURS_WEEKDAYS.map(d=>[d,d==='WEDNESDAY'?[]:[{open:'11:00',close:'22:00'}]])) as OpeningWeek
const profile:GoogleProfileData={success:true,store:{id:'store-a',name:'対象店',lineAccountId:'a'},profile:{name:'locations/a',title:'対象店',address:null,phone:null,websiteUri:null,description:null,openStatus:'OPEN',regularHours:weekly,specialHours:[],mapsUri:null},today:{date:'2026-11-04',weekday:'WEDNESDAY',holidayName:null,periods:[],closed:true,special:false},holidays:[],timeZone:'Asia/Tokyo',closed:false,photoCount:0,googleUpdates:null,fetchedAt:'2026-11-04T03:00:00Z',stale:false,refreshError:null,pendingChangeCount:0,writeEnabled:true,aiAvailable:true,permissions:{canManageConnection:true,canPublishReply:true,canSendChange:true}}
let stored=emptyHoursWorkspace(),version=0
beforeEach(()=>{
 vi.clearAllMocks();mocks.allowed=true;stored=emptyHoursWorkspace();version=0
 mocks.profile.mockResolvedValue(profile)
 mocks.hoursWorkspace.mockImplementation(async()=>({version,data:structuredClone(stored),history:[],holidays:[{date:'2026-11-23',name:'勤労感謝の日'},{date:'2027-01-01',name:'元日'},{date:'2027-01-11',name:'成人の日'}],serviceTypes:[{id:'TAKEOUT',label:'テイクアウト'}]}))
 mocks.saveHoursWorkspace.mockImplementation(async(_id:string,_version:number,data:HoursWorkspace)=>{stored=structuredClone(data);return {version:++version,data:stored,history:[]}})
 mocks.reviewHoursWorkspace.mockResolvedValue({changes:[{id:'change-a',kind:'special_hours',status:'draft',target:{dates:['2026-11-14','2026-11-18']},before:[{date:'2026-11-14',periods:weekly.SATURDAY}],after:[{date:'2026-11-14',closed:true,periods:[]},{date:'2026-11-18',closed:true,periods:[]}],reservationImpactCount:0}]})
 mocks.sendChange.mockResolvedValue({success:true})
})
afterEach(()=>{cleanup();forgetStaffIdentity();sessionStorage.clear()})
async function open(){render(<HoursPage accountId="a" tabs={<span>営業時間</span>}/>);await screen.findByRole('heading',{name:'毎週の営業時間'})}
async function dates(){fireEvent.click(screen.getByRole('button',{name:'日付を指定'}));return await screen.findByRole('dialog',{name:'特別営業日の変更'})}
async function pick(dialog:HTMLElement,date:string){fireEvent.click(within(dialog).getByRole('button',{name:date,exact:true}));await waitFor(()=>expect(mocks.saveHoursWorkspace).toHaveBeenCalled())}
describe('営業時間ツールの操作',()=>{
 it('文章の変更案を日付の編集へ引き継ぎ、既存の別日の下書きも保持する',async()=>{
  stored.draft.days=[{date:'2026-11-14',closed:true,periods:[]}]
  mocks.proposeHours.mockResolvedValue({change:{id:'text-a',kind:'special_hours',summary:'11月18日と20日を休業',after:[{date:'2026-11-18',closed:true,periods:[]},{date:'2026-11-20',closed:true,periods:[]}]}})
  await open();fireEvent.click(screen.getByRole('button',{name:'文章で入力',exact:true}));const dialog=await screen.findByRole('dialog',{name:'文章で入力'});fireEvent.change(within(dialog).getByRole('textbox'),{target:{value:'11月18日を休業'}});fireEvent.click(within(dialog).getByRole('button',{name:'変更案を作る'}));await within(dialog).findByRole('heading',{name:'読み取った変更案'});expect(within(dialog).getByText('2日 休業')).toBeTruthy();expect(within(dialog).queryByText(/日から毎週の営業時間に戻ります/)).toBeNull();await waitFor(()=>expect(stored.draft.days.map(d=>d.date)).toEqual(['2026-11-14','2026-11-18','2026-11-20']));fireEvent.click(within(dialog).getByRole('button',{name:'日付や時間を直す'}));expect(await screen.findByRole('dialog',{name:'特別営業日の変更'})).toBeTruthy()
 })
 it('日付の選択を全部解除すると、その編集で追加した下書きも取り除く',async()=>{
  await open();const dialog=await dates();await pick(dialog,'2026-11-14');fireEvent.click(within(dialog).getByRole('button',{name:'2026-11-14',exact:true}));await waitFor(()=>expect(stored.draft.days).toEqual([]));expect(within(dialog).getByRole('button',{name:'変更内容を確認'})).toHaveProperty('disabled',true)
 })
 it('選択した複数の日付をまとめて解除すると、確認へ進めなくなる',async()=>{
  await open();const dialog=await dates();await pick(dialog,'2026-11-14');await pick(dialog,'2026-11-18');expect(within(dialog).getByText('選択中 2日')).toBeTruthy();fireEvent.click(within(dialog).getByRole('button',{name:'すべて解除'}));await waitFor(()=>expect(stored.draft.days).toEqual([]));expect(within(dialog).getByRole('button',{name:'変更内容を確認'})).toHaveProperty('disabled',true)
 })
 it('メモは追加操作で開き、指定した日の下書きに保存する',async()=>{
  await open();const dialog=await dates();await pick(dialog,'2026-11-14');expect(within(dialog).queryByRole('textbox',{name:'メモ'})).toBeNull();fireEvent.click(within(dialog).getByRole('button',{name:'メモを追加'}));fireEvent.change(within(dialog).getByRole('textbox',{name:'メモ'}),{target:{value:'振替営業'}});await waitFor(()=>expect(stored.notes['2026-11-14']).toBe('振替営業'));expect(mocks.sendChange).not.toHaveBeenCalled()
 })
 it('読み取り前の文章を閉じるときは確認し、編集を続ければ入力を保つ',async()=>{
  await open();fireEvent.click(screen.getByRole('button',{name:'文章で入力'}));const panel=await screen.findByRole('dialog',{name:'文章で入力'});const field=within(panel).getByRole('textbox');fireEvent.change(field,{target:{value:'来週の月曜は休業'}});fireEvent.click(within(panel).getAllByRole('button',{name:'閉じる',exact:true}).at(-1)!);const check=await screen.findByRole('dialog',{name:'入力を破棄しますか？'});fireEvent.click(within(check).getByRole('button',{name:'編集を続ける'}));expect((field as HTMLTextAreaElement).value).toBe('来週の月曜は休業');expect(screen.getByRole('dialog',{name:'文章で入力'})).toBeTruthy()
 })
 it('サービスの種類の候補だけをEscapeで閉じ、編集パネルは残す',async()=>{
  stored.services=[{id:'takeout',kind:'takeout',label:'テイクアウト',googleTypeId:'TAKEOUT',sameWeekdays:true,weekdays:HOURS_WEEKDAYS,periods:[{open:'17:00',close:'22:00'}],orderDeadline:'',menu:''}];version=1
  await open();fireEvent.click(screen.getByRole('button',{name:'開く'}));fireEvent.click(screen.getByRole('button',{name:'編集',exact:true}));const dialog=await screen.findByRole('dialog',{name:'サービスの営業時間'});const trigger=within(dialog).getByRole('button',{name:'サービスの種類'});fireEvent.click(trigger);fireEvent.keyDown(trigger,{key:'Escape'});expect(within(dialog).getByRole('button',{name:'サービスの種類'}).getAttribute('aria-expanded')).toBe('false');expect(screen.getByRole('dialog',{name:'サービスの営業時間'})).toBeTruthy()
 })
 it('離れた日付の下書きを復元し、無選択では確認を止める',async()=>{
  await open();const dialog=await dates();expect(within(dialog).getByRole('button',{name:'変更内容を確認'})).toHaveProperty('disabled',true)
  await pick(dialog,'2026-11-14');await pick(dialog,'2026-11-18');await waitFor(()=>expect(stored.draft.days.map(d=>d.date)).toEqual(['2026-11-14','2026-11-18']))
  expect(stored.draft.days.some(d=>d.date==='2026-11-15')).toBe(false)
  expect(mocks.sendChange).not.toHaveBeenCalled();cleanup();await open();expect(screen.getByRole('button',{name:'変更内容を確認'})).toBeTruthy()
 })
 it('再読み込みで同じ日付の編集と未保存入力を戻し、保存を実行しない',async()=>{
  rememberStaffIdentity({id:'owner',tenantId:'tenant',name:'担当者',role:'owner'} as StaffMember)
  await open();const dialog=await dates()
  fireEvent.click(within(dialog).getByRole('button',{name:'2026-11-14',exact:true}))
  cleanup();await open()
  const restored=await screen.findByRole('dialog',{name:'特別営業日の変更'})
  expect(within(restored).getByRole('button',{name:'2026-11-14',exact:true}).getAttribute('aria-pressed')).toBe('true')
  expect(mocks.saveHoursWorkspace).not.toHaveBeenCalled()
  expect(mocks.reviewHoursWorkspace).not.toHaveBeenCalled()
  expect(mocks.sendChange).not.toHaveBeenCalled()
 })
 it('変更内容を確認中の再読み込みは保存済みの変更案だけを読み直す',async()=>{
  rememberStaffIdentity({id:'owner',tenantId:'tenant',name:'担当者',role:'owner'} as StaffMember)
  await open();const dialog=await dates();await pick(dialog,'2026-11-14')
  fireEvent.click(within(dialog).getByRole('button',{name:'変更内容を確認'}))
  await screen.findByRole('heading',{name:'選択した2日の営業時間'})
  const reviewed=await mocks.reviewHoursWorkspace.mock.results[0].value
  mocks.change.mockResolvedValue({change:reviewed.changes[0]})
  cleanup();render(<HoursPage accountId="a" tabs={<span>営業時間</span>}/>)
  await screen.findByRole('heading',{name:'選択した2日の営業時間'})
  expect(mocks.change).toHaveBeenCalledWith('a','change-a')
  expect(mocks.reviewHoursWorkspace).toHaveBeenCalledTimes(1)
  expect(mocks.sendChange).not.toHaveBeenCalled()
 })
 it('確認前にGoogleへ送らず、送信失敗後も同じ変更案で再試行する',async()=>{
  await open();const dialog=await dates();await pick(dialog,'2026-11-14');await waitFor(()=>expect(within(dialog).getByRole('button',{name:'変更内容を確認'})).toHaveProperty('disabled',false))
  fireEvent.click(within(dialog).getByRole('button',{name:'変更内容を確認'}));await screen.findByRole('heading',{name:'選択した2日の営業時間'});expect(mocks.sendChange).not.toHaveBeenCalled()
  mocks.sendChange.mockRejectedValueOnce(new Error('connection failed'));mocks.change.mockResolvedValue({change:{id:'change-a',kind:'special_hours',status:'pending_confirm',target:{dates:['2026-11-14']},before:[],after:[{date:'2026-11-14',closed:true,periods:[]}],reservationImpactCount:0}})
  fireEvent.click(screen.getByRole('button',{name:'Googleに反映する'}));await screen.findByText(/Googleに送信できませんでした/);expect(screen.getByRole('heading',{name:'営業時間',exact:true})).toBeTruthy();expect(stored.draft.reviewIds).toEqual(['change-a'])
  fireEvent.click(screen.getByRole('button',{name:'確認して再送する'}));await screen.findByRole('heading',{name:'選択した1日の営業時間'});fireEvent.click(screen.getByRole('button',{name:'Googleに反映する'}));await screen.findByText('Googleに営業時間の変更を送信しました');expect(mocks.sendChange).toHaveBeenLastCalledWith('a','change-a')
 })
 it('保存が競合したときに入力を上書きせず、送信も起動しない',async()=>{
  mocks.saveHoursWorkspace.mockRejectedValue(new Error('conflict'));await open();const dialog=await dates();fireEvent.click(within(dialog).getByRole('button',{name:'2026-11-14',exact:true}));await screen.findByText(/下書きを保存できませんでした/);expect(mocks.sendChange).not.toHaveBeenCalled();expect(within(dialog).getByRole('button',{name:'2026-11-14',exact:true}).getAttribute('aria-pressed')).toBe('true')
 })
 it('閲覧だけの人は内容を見られるが変更・保存・送信できない',async()=>{
  mocks.allowed=false;await open();fireEvent.click(screen.getByRole('button',{name:'日付を指定'}));expect(screen.queryByRole('dialog',{name:'特別営業日の変更'})).toBeNull();expect(mocks.saveHoursWorkspace).not.toHaveBeenCalled();expect(mocks.sendChange).not.toHaveBeenCalled()
 })
})
