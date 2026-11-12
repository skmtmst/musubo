// @vitest-environment happy-dom
import {afterEach, expect, test, vi} from 'vitest'
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react'
import {BASIC_FRIEND_FIELDS} from '@line-crm/shared'
import InfoTab from './info-tab'
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/components/shared/list-navigation',()=>({default:({children,...props}:React.ComponentProps<'a'>)=><a {...props}>{children}</a>}))
afterEach(cleanup)
test('未分類の項目も件数とタブに含め、選ぶとその項目だけを表示する',()=>{
 const fields=[{id:'name',name:'名前',fixedKey:'name',type:'text',value:''},{id:'anniversary',name:'記念日',fixedKey:'anniversary',type:'text',value:''},{id:'pet',name:'ペット',folderId:'pets',type:'text',value:''},{id:'a',name:'未分類A',folderId:null,type:'text',value:''},{id:'b',name:'未分類B',type:'text',value:''},{id:'c',name:'未分類C',folderId:'',type:'text',value:''},{id:'old',name:'非表示',folderId:null,type:'text',value:'',status:'archived'}];
 const data={fields,values:Object.fromEntries(fields.map(field=>[field.id,field.value])),fieldsStatus:'ready',fieldFolders:[{id:'pets',name:'ペット'}],fieldFoldersStatus:'ready',hiddenPersonalCount:0,warnings:[],setValues:vi.fn()};
 const props={friendId:'f',data:data as never,perms:{canEditField:()=>false} as never};
 const view=render(<InfoTab {...props} group="all"/>);
 expect(screen.getByRole('link',{name:'すべて 6'})).toBeTruthy();
 expect(screen.getByRole('link',{name:'基本 1'})).toBeTruthy();
 expect(screen.getByRole('link',{name:'飲食 1'})).toBeTruthy();
 expect(screen.getByRole('link',{name:'ペット 1'})).toBeTruthy();
 expect(screen.getByRole('link',{name:'未分類 3'}).getAttribute('href')).toContain('group=__unfiled__');
 view.rerender(<InfoTab {...props} group="__unfiled__"/>);
 for(const name of ['未分類A','未分類B','未分類C']) expect(screen.getByLabelText(name)).toBeTruthy();
 expect(screen.queryByLabelText('ペット')).toBeNull();
 expect(screen.queryByText('この分類は削除されたか、見つかりません。')).toBeNull();
})
test('飲食の項目を分類で選べ、個人情報は分類ごとにまとめて示す',()=>{
 const fields=[{id:'name',name:'名前',fixedKey:'name',type:'text',value:'花子',isPersonal:true},{id:'email',name:'メール',fixedKey:'email',type:'text',value:'',isPersonal:true},{id:'anniversary',name:'記念日',fixedKey:'anniversary',type:'date',value:'',isPersonal:true},{id:'seats',name:'席の希望',fixedKey:'seat_preference',type:'text',value:'',isPersonal:false},{id:'pet',name:'ペット',folderId:'pets',type:'text',value:'',isPersonal:false}];
 const data={fields,values:Object.fromEntries(fields.map(field=>[field.id,field.value])),fieldsStatus:'ready',fieldFolders:[{id:'pets',name:'ペット'}],fieldFoldersStatus:'ready',hiddenPersonalCount:0,warnings:[],setValues:vi.fn()};
 const props={friendId:'f',data:data as never,perms:{canEditField:()=>false} as never};
 const view=render(<InfoTab {...props} group="all"/>);
 const dining=screen.getByRole('link',{name:'飲食 2'}); expect(dining.getAttribute('href')).toContain('group=__dining__');
 const basics=screen.getByRole('region',{name:'基本'});
 expect(within(basics).queryByText('名前や連絡先などの基本情報')).toBeNull();
 fireEvent.click(within(basics).getByRole('button',{name:'基本（決まった欄）の説明'}));
 expect(screen.getByText('名前や連絡先などの基本情報')).toBeTruthy();
 expect(within(basics).getAllByText('個人情報を含む')).toHaveLength(1);
 const diningSection=screen.getByRole('region',{name:'飲食の情報'});
 expect(within(diningSection).getAllByText('個人情報を含む')).toHaveLength(1);
 expect(within(diningSection).queryByText('個人情報')).toBeNull();
 expect(screen.getByRole('link',{name:'すべて 5'})).toBeTruthy();
 view.rerender(<InfoTab {...props} group="__dining__"/>);
 expect(screen.getByRole('region',{name:'飲食の情報'})).toBeTruthy();
 expect(screen.queryByRole('region',{name:'基本'})).toBeNull();
 expect(screen.getByLabelText('記念日の値')).toBeTruthy();
 expect(screen.getByLabelText('席の希望')).toBeTruthy();
})
test('基本8欄は先頭、古い名前を読み替え、店の欄を分類し、出どころと満年齢を示す',()=>{
 const fields=[...BASIC_FRIEND_FIELDS.map(spec=>({id:spec.key,name:spec.key==='name'?'本名':spec.key==='birthday'?'誕生日':spec.label,fixedKey:spec.key,folderId:null,type:spec.key==='birthday'?'date':'text',value:spec.key==='birthday'?'2000-01-01':spec.key==='name'?'山田':null})),{id:'pet',name:'ペットの名前',type:'text',folderId:'pets',value:'もも'},{id:'anniversary',name:'記念日',type:'date',fixedKey:'anniversary',value:'2026-01-01'}];
 const data={fields,values:Object.fromEntries(fields.map(field=>[field.id,field.value??''])),fieldsStatus:'ready',fieldFolders:[{id:'pets',name:'ペット'}],fieldFoldersStatus:'ready',hiddenPersonalCount:0,warnings:[],setValues:vi.fn()};
 render(<InfoTab friendId="f" group="all" data={data as never} perms={{canEditField:()=>false} as never}/>);
 const basics=screen.getByRole('region',{name:'基本'});
 for(const spec of BASIC_FRIEND_FIELDS) expect(within(basics).getByText(spec.key==='birthday'?/生年月日（\d+歳）/:spec.label)).toBeTruthy();
 expect(screen.queryByText('本名')).toBeNull();expect(screen.queryByText('誕生日')).toBeNull();
 expect(within(basics).getAllByText('手で入れた').length).toBeGreaterThan(0);
 expect(screen.getByRole('region',{name:'お店が作った項目（ペット）'})).toBeTruthy();expect(screen.getByRole('region',{name:'飲食の情報'})).toBeTruthy();
 expect(screen.queryByRole('button',{name:'保存する'})).toBeNull();expect(screen.queryByRole('button',{name:'＋ 足す'})).toBeNull();
})

test('保存前の入力があるとき、ほかへのリンクを押すと「保存していない変更があります」の確認を出す（番兵）',async()=>{
 const fields=[{id:'pet',name:'ペットの名前',type:'text',folderId:'pets',value:'もも',status:'active'}];
 const data={fields,values:{pet:'こむぎ'},fieldsStatus:'ready',fieldFolders:[{id:'pets',name:'ペット'}],fieldFoldersStatus:'ready',hiddenPersonalCount:0,warnings:[],setValues:vi.fn(),saving:false,saveFields:vi.fn()};
 render(<InfoTab friendId="f" group="all" data={data as never} perms={{canEditField:()=>true,saveFields:true,manage:true} as never}/>);
 expect(screen.getByRole('button',{name:'キャンセル'}).hasAttribute('disabled')).toBe(false)
 fireEvent.click(screen.getByText('情報欄を管理'))
 expect(await screen.findByRole('dialog',{name:'保存していない変更があります'})).toBeTruthy()
})

test('空の氏名欄と編集用アレルギーに値や未設定行を重ねない', () => {
 const fields=[{id:'name',name:'名前',type:'text',fixedKey:'name',value:null},{id:'allergy',name:'アレルギー',type:'checkbox',fixedKey:'allergy',value:null}];
 const data={fields,values:{name:'',allergy:''},fieldsStatus:'ready',fieldFolders:[],fieldFoldersStatus:'ready',hiddenPersonalCount:0,warnings:[],setValues:vi.fn(),saving:false};
 render(<InfoTab friendId="f" group="all" data={data as never} perms={{canEditField:()=>true,saveFields:true} as never}/>);
 const name=screen.getByLabelText('名前') as HTMLInputElement;
 expect(name.value).toBe('');expect(name.placeholder).toBe('（未設定）');
 const allergy=screen.getByText('アレルギー').closest('label')!.parentElement!;
 expect(within(allergy).queryByText('未設定')).toBeNull();
 expect(within(allergy).getByRole('button',{name:'選んで足す'})).toBeTruthy();
 expect(data.setValues).not.toHaveBeenCalled();
})

test('閲覧のみの空の日付は架空の値を入れず、アレルギーの未設定は残す', () => {
 const fields=[{id:'anniversary',name:'記念日',type:'date',fixedKey:'anniversary',value:null},{id:'allergy',name:'アレルギー',type:'checkbox',fixedKey:'allergy',value:null}];
 const data={fields,values:{anniversary:'',allergy:''},fieldsStatus:'ready',fieldFolders:[],fieldFoldersStatus:'ready',hiddenPersonalCount:0,warnings:[],setValues:vi.fn()};
 render(<InfoTab friendId="f" group="all" data={data as never} perms={{canEditField:()=>false} as never}/>);
 const date=screen.getByRole('textbox',{name:'記念日の値'}) as HTMLInputElement;
 expect(date.value).toBe('');expect(date.placeholder).toBe('（未設定）');expect(date.readOnly).toBe(true);
 const allergy=screen.getByText('アレルギー').closest('label')!.parentElement!;
 expect(within(allergy).getByText('未設定')).toBeTruthy();expect(within(allergy).queryByRole('button')).toBeNull();
})


test('空の情報欄は実際の値を入れず、未設定と分かる例示を出す', () => {
 const fields=[{id:'pet',name:'ペット',type:'text',value:null,status:'active'}];
 const data={fields,values:{pet:''},fieldsStatus:'ready',fieldFolders:[],fieldFoldersStatus:'ready',hiddenPersonalCount:0,warnings:[],setValues:vi.fn(),saving:false};
 render(<InfoTab friendId="f" group="all" data={data as never} perms={{canEditField:()=>true,saveFields:true} as never}/>);
 const input=screen.getByLabelText('ペット') as HTMLInputElement;
 expect(input.value).toBe(''); expect(input.placeholder).toBe('（未設定）'); expect(data.setValues).not.toHaveBeenCalled();
})

test('A-34: 変更がないと保存できず、入力変更と元に戻す操作に連動する', () => {
 const fields=[{id:'pet',name:'ペットの名前',type:'text',folderId:null,value:'もも',status:'active'}];
 const data={fields,values:{pet:'もも'},fieldsStatus:'ready',fieldFolders:[],fieldFoldersStatus:'ready',hiddenPersonalCount:0,warnings:[],setValues:vi.fn(),saving:false,saveFields:vi.fn()};
 const props={friendId:'f',group:'all',data:data as never,perms:{canEditField:()=>true,saveFields:true,manage:true} as never};
 const view=render(<InfoTab {...props}/>);
 const save=screen.getByRole('button',{name:'保存する'}) as HTMLButtonElement;
 expect(save.disabled).toBe(true); fireEvent.click(save); expect(data.saveFields).not.toHaveBeenCalled();
 expect(screen.getByText('変更した項目はありません。')).toBeTruthy();
 view.rerender(<InfoTab {...props} data={{...data,values:{pet:'こむぎ'}} as never}/>);
 expect(save.disabled).toBe(false);
 view.rerender(<InfoTab {...props}/>); expect(save.disabled).toBe(true);
})
