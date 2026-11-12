import { afterEach, beforeEach, expect, test } from 'vitest'
import { emptyLayout, type FormInputBlock } from '@line-crm/shared'

import { getFriendFieldsWithValues, setFriendFieldValue } from '@line-crm/db'
import { createTestD1, type SqliteD1 } from '../../test-utils/d1-sqlite'
import { applyFormLayoutEffects } from './form-layout-effects'

let fixture: SqliteD1
beforeEach(() => {
  fixture = createTestD1({ foreignKeys: true })
  fixture.raw.exec("INSERT INTO friends(id,line_user_id,real_name) VALUES ('f','line-f','前の名前'),('other','line-other',NULL); INSERT INTO forms(id,name,fields) VALUES ('form','登録フォーム','[]')")
})
afterEach(() => fixture.raw.close())

test('複数アレルギーを固定TEXTへJSONで保存し、旧文字を読める型で返す', async () => {
  const layout = emptyLayout()
  layout.sections[0].blocks = [{ id:'allergy', name:'allergy', kind:'input', type:'checkbox', label:'アレルギー', fixedField:'allergy', choices:[{id:'egg',label:'卵'},{id:'milk',label:'乳'},{id:'other',label:'そのほか',isOther:true}] }]
  const result = await applyFormLayoutEffects({ db:fixture.db, layout, friendId:'f', answers:{allergy:['卵','乳','キウイ']}, formId:'form' })
  expect(result.failedEffects).toEqual([])
  expect((await getFriendFieldsWithValues(fixture.db,'f')).find(row=>row.fixed_key==='allergy')).toMatchObject({type:'multi_select',value:'["卵","乳","キウイ"]',source_id:'form'})
  expect(fixture.raw.prepare("SELECT type FROM friend_fields WHERE id='fixed-allergy'").get()).toEqual({type:'text'})
  fixture.raw.exec("UPDATE friend_field_values SET value='旧自由記入' WHERE field_id='fixed-allergy'")
  expect((await getFriendFieldsWithValues(fixture.db,'f')).find(row=>row.fixed_key==='allergy')?.value).toBe('旧自由記入')
  expect(fixture.raw.prepare("SELECT COUNT(*) n FROM friend_field_values WHERE friend_id='other'").get()).toEqual({n:0})
})

test('seven answers persist with source, real name sync, and unsubmitted friend remains untouched', async () => {
  const layout = emptyLayout()
  const specs = [
    ['name','text','名前','山田花子'], ['kana','text','ふりがな','やまだはなこ'],
    ['birthday','date','生年月日','2000-01-01'], ['age','text','年齢','23'],
    ['email','text','メール','HANAKO@example.com'], ['tel','text','電話','090-0000-5678'],
    ['address','address','住所',{ postalCode:'1234567',prefecture:'東京都',city:'新宿区',addressLine1:'1-2',addressLine2:'101' }],
  ] as const
  layout.sections[0].blocks = specs.map(([key,type,label]) => ({ id:key, name:key, kind:'input', type, label, fixedField:key }) as FormInputBlock)
  const answers = Object.fromEntries(specs.map(([key,_type,_label,value]) => [key,value]))
  const result = await applyFormLayoutEffects({ db:fixture.db, layout, friendId:'f', answers, formId:'form', pushText:async()=>{} })
  expect(result.failedEffects).toEqual([])
  expect(result.destinationWrites).toEqual({attempted:7,succeeded:7,failed:0})
  const rows = await getFriendFieldsWithValues(fixture.db,'f')
  expect(rows.filter(r=>r.fixed_key)).toHaveLength(10)
  expect(rows.find(r=>r.fixed_key==='name')).toMatchObject({value:'山田花子',source_name:'登録フォーム',source_id:'form',source_type:'form'})
  expect(rows.find(r=>r.fixed_key==='email')?.value).toBe('hanako@example.com')
  expect(rows.find(r=>r.fixed_key==='address')?.value).toBe('〒123-4567 東京都新宿区1-2101')
  expect(fixture.raw.prepare('SELECT real_name FROM friends WHERE id=?').get('f')).toEqual({real_name:'山田花子'})
  expect(fixture.raw.prepare('SELECT COUNT(*) n FROM friend_field_values WHERE friend_id=?').get('other')).toEqual({n:0})
  await setFriendFieldValue(fixture.db,{ friendId:'f',fieldId:'fixed-name',value:'手動の名前',updatedBy:'owner' })
  expect((await getFriendFieldsWithValues(fixture.db,'f')).find(r=>r.fixed_key==='name')).toMatchObject({value:'手動の名前',source_type:null,source_id:null})
  expect(fixture.raw.prepare('SELECT real_name FROM friends WHERE id=?').get('f')).toEqual({real_name:'手動の名前'})
})
test('legacy name edits sync and clearing optional form answers keeps existing information', async()=>{
  fixture.raw.prepare("UPDATE friends SET real_name='編集した名前' WHERE id='f'").run()
  expect(fixture.raw.prepare("SELECT value FROM friend_field_values WHERE friend_id='f' AND field_id='fixed-name'").get()).toEqual({value:'編集した名前'})
  const layout=emptyLayout()
  layout.sections[0].blocks=[{id:'name',name:'name',kind:'input',type:'text',label:'名前',fixedField:'name'}]
  expect((await applyFormLayoutEffects({db:fixture.db,layout,friendId:'f',answers:{name:''},pushText:async()=>{}})).failedEffects).toEqual([])
  expect(fixture.raw.prepare("SELECT real_name FROM friends WHERE id='f'").get()).toEqual({real_name:'編集した名前'})
})
test('legacy email/tel/address inputs also save automatically and retry missing mappings remains unfinished',async()=>{
  const layout=emptyLayout()
  layout.sections[0].blocks=[{id:'email',name:'email',kind:'input',type:'text',label:'メール',limit:{format:'email'}}]
  expect((await applyFormLayoutEffects({db:fixture.db,layout,friendId:'f',answers:{email:'a@example.com'},formId:'form',pushText:async()=>{}})).destinationWrites.succeeded).toBe(1)
  fixture.raw.exec("DELETE FROM friend_fixed_fields WHERE fixed_key='email'")
  expect((await applyFormLayoutEffects({db:fixture.db,layout,friendId:'f',answers:{email:'b@example.com'},pushText:async()=>{}})).failedEffects).toContain('destinations:email')
})
