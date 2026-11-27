// @vitest-environment happy-dom
import {afterEach,expect,test,vi} from 'vitest'
import {cleanup,fireEvent,render,screen} from '@testing-library/react'
import {useState} from 'react'
import {DEFAULT_CUSTOMER_LOOK,type FormOptions} from '@line-crm/shared'
import {AppearanceTab} from './appearance-tab'
vi.mock('next/link',()=>({default:({children,...props}:React.ComponentProps<'a'>)=><a {...props}>{children}</a>}))
afterEach(cleanup)
function Editor({portable=false,readOnly=false}:{portable?:boolean;readOnly?:boolean}) {
 const [options,setOptions]=useState<FormOptions>({});return <AppearanceTab readOnly={readOnly} portable={portable} accountId={null} accountLook={{...DEFAULT_CUSTOMER_LOOK,preset:'natural'}} options={options} name="フォーム" nameError={null} description="" ogTitle="" ogDescription="" ogImageUrl="" onChangeOptions={patch=>setOptions(current=>({...current,...patch}))} onChangeName={()=>{}} onChangeDescription={()=>{}} onChangeOgTitle={()=>{}} onChangeOgDescription={()=>{}} onChangeOgImageUrl={()=>{}}/>
}
test('店に合わせる初期値・5型＋カスタム・カスタムだけ色の入力',()=>{
 render(<Editor/>);expect(screen.getByText('今：ナチュラル')).toBeTruthy();expect(screen.queryByRole('group',{name:'デザインの型'})).toBeNull();
 fireEvent.click(screen.getByRole('radio',{name:/このフォームだけ変更する/}));expect(screen.getAllByRole('radio')).toHaveLength(8);
  expect(screen.queryByText('おまかせで組む')).toBeNull();fireEvent.click(screen.getByRole('radio',{name:/^カスタム/}));expect(screen.getByText('おまかせで組む')).toBeTruthy();
 fireEvent.click(screen.getByRole('radio',{name:/モダン/}));expect(screen.queryByText('おまかせで組む')).toBeNull();
});
test('統括の初期値は配布先の店。固定すると優先の案内を示す',()=>{
 render(<Editor portable/>);expect(screen.getByRole('radio',{name:/配った先の店のデザインに合わせる/})).toBeTruthy();
 fireEvent.click(screen.getByRole('radio',{name:/色を決めて配る/}));expect(screen.getByText(/このフォームは色を固定して配ります/)).toBeTruthy();
});
test('閲覧だけの人には型・色の変更を出さない',()=>{render(<Editor readOnly/>);expect(screen.queryByRole('radio')).toBeNull()});
