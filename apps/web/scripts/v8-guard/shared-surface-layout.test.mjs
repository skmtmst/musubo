import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { expect } from '@playwright/test'
import { connectGuardBrowser } from './browser-session.mjs'
import { compileUiStyles } from './compile-ui-styles.mjs'
import scanRowHeights from './control-row-height-browser.mjs'
import { measureControlCentering } from '../../../../scripts/visual-qa/control-centering.mjs'

const require = createRequire(import.meta.url)
const fromVitest = createRequire(require.resolve('vitest/package.json'))
const { build } = createRequire(fromVitest.resolve('vite'))('esbuild')

const webRoot = fileURLToPath(new URL('../..', import.meta.url))
const sheets = new Set()
const compiled = await build({
  stdin: { resolveDir: webRoot, loader: 'tsx', contents: `
import React,{useState,useRef} from 'react'; import {createRoot} from 'react-dom/client';
import {Steps} from './src/components/templates/steps';
import {PageHeading} from './src/components/templates/page-frame';
import Checkbox,{SettingCheckbox} from './src/components/shared/checkbox';
import CheckCard from './src/components/shared/check-card';
import FilterChip from './src/components/shared/filter-chip';
import {RowMenu} from './src/components/shared/row-actions';
import Pagination from './src/components/shared/pagination';
import { ToggleGroupActions } from './src/components/shared/toggle';
import IconButton from './src/components/shared/icon-button';
import SegmentedControl from './src/components/shared/segmented';
import {Star} from 'lucide-react';
import {TextField,TextArea} from './src/components/shared/text-field';
import SearchField from './src/components/shared/search-field';
import NumberField from './src/components/shared/number-field';
import EntitySelect from './src/components/shared/entity-select';
import Select from './src/components/shared/select';
import FolderSelect from './src/components/shared/folder-select';
import {EntityPickerSummary,EntityPickerField} from './src/components/shared/entity-picker';
import Combobox from './src/components/shared/combobox';
import MultiSelect from './src/components/shared/multi-select';
import TimeField from './src/components/shared/time-field-v8';
import Radio from './src/components/shared/radio';
import Toggle from './src/components/shared/toggle';
import {DataTable,TableHeadRow,Th,Tr,Td} from './src/components/shared/table';
import {FolderDotName} from './src/components/shared/folder-dot';
import Dialog from './src/components/shared/dialog';
import ConfirmDialog from './src/components/shared/confirm-dialog';
import Drawer from './src/components/shared/drawer';
import Button from './src/components/shared/button';
import ActionMenu from './src/components/shared/action-menu';
import StickyBar from './src/components/shared/sticky-bar';
import {ListToolbarRow} from './src/components/shared/list-toolbar';
import {FilterPopover} from './src/components/shared/filter-popover';
import CommandPalette from './src/components/shared/command-palette';
import Notice from './src/components/shared/notice';
import {DialogContentRow} from './src/components/shared/dialog-form-row';
import {EntityPickerField} from './src/components/shared/entity-picker';
import KpiBand from './src/components/shared/kpi-band';
import KpiCard from './src/components/shared/kpi-card';
function Fixture(){
 const [menuOpen,setMenuOpen]=useState(false),menuAnchor=useRef(null);
 const reasonFault=globalThis.inputReasonFault;
 const [window,setWindow]=useState(''),[value,setValue]=useState(false),[current,setCurrent]=useState('now'),[failureCalls]=useState({}),[countState,setCountState]=useState('active');
 const [filterOpen,setFilterOpen]=useState(false);
 const steps=[{key:'done',label:'事前確認',state:'done',onSelect:()=>setCurrent('done')},{key:'now',label:'アカウント接続',state:'current'}, {key:'next',label:'接続確認',state:'todo'}, {key:'choice',label:'使い方を選ぶ',state:'todo'}, {key:'finish',label:'完了',state:'todo'}];
 const props={open:!!window,onCancel:()=>setWindow(''),onConfirm:()=>setWindow(''),title:'新しく作る',description:'名前を入力してください。内容は作成する前に確認できます。',headerIcon:<svg viewBox="0 0 16 16"><path d="M2 2h12v12H2z" fill="none" stroke="currentColor"/></svg>};
 return <main><CommandPalette items={[{href:"/friends",label:"友だち一覧"}]}/>
  <PageHeading title="LINEアカウントを登録" steps={<Steps label="登録の手順" steps={steps} currentKey={current}/>}/>
  <section id="selection"><DataTable cellPresentation="friends"><thead><TableHeadRow><Th columnKind="selection"><Checkbox aria-label="全選択" checked={value} onCheckedChange={setValue}/></Th><Th><Checkbox aria-label="見出しの選択" checked={value} onCheckedChange={setValue}/>タイトル・内容</Th></TableHeadRow></thead><tbody><Tr><Td columnKind="selection"><Checkbox aria-label="行を選ぶ" checked={value} onCheckedChange={setValue}/></Td><Td><FolderDotName selection={<Checkbox aria-label="名前の前の選択" checked={value} onCheckedChange={setValue}/>}>一斉配信の名前</FolderDotName></Td></Tr></tbody></DataTable>
  <DataTable><thead><TableHeadRow><Th>設定</Th></TableHeadRow></thead><tbody><Tr><Td><Toggle label="表の切り替え" checked={value} onChange={setValue}/></Td></Tr></tbody></DataTable><div data-center-row><SettingCheckbox label="設定" checked={value} onChange={setValue}/></div>
  <div data-center-row><Checkbox checked={value} onCheckedChange={setValue}>ラベル付き</Checkbox></div>
  <CheckCard title="確認行" size="row" checked={value} onChange={setValue}/>
  <CheckCard title="カード" checked={value} onChange={setValue}/>
  <div data-center-row><Radio name="channel" checked={value} onChange={()=>setValue(!value)}>ラジオ</Radio></div>
  <div data-center-row><Toggle label="切り替え" checked={value} onChange={setValue}/></div></section>
  <section id="control-density">
    <div data-control-row style={{display:'flex',alignItems:'center',gap:12}}>
      <TextField aria-label="寸法の名前" defaultValue="名前" />
      <SearchField aria-label="寸法の検索" value="" onChange={()=>{}} placeholder="名前で探す" />
      <Select aria-label="寸法の選択" menuAlign="end" label="状態" value="all" options={[{value:'all',label:'すべて'},{value:'active',label:'とても長い選択肢の名前を最後まで確認する'}]} onChange={()=>{}} />
      <Button variant="primary" aria-label="寸法の保存">保存する</Button>
    </div>
    <TextArea aria-label="寸法の本文" defaultValue="本文" />
  </section>
  <section id="choice-appearance" style={{display:'grid',gridTemplateColumns:'320px 320px',gap:16}}>
    <div data-choice-case="select"><Select size="full" aria-label="共通の選択" value="a" options={[{value:'a',label:'変えない'}]} onChange={()=>{}}/></div>
    <div data-choice-case="folder"><FolderSelect size="full" aria-label="共通のフォルダ" value="" folders={[]} onChange={()=>{}}/></div>
    <div data-choice-case="entity"><EntityPickerSummary label="親アカウント" noun="アカウント" name="変えない" onOpen={()=>{}}/></div>
    <div data-choice-case="combo"><Combobox aria-label="共通の候補" options={[{value:'a',label:'変えない'}]} value="" onChange={()=>{}}/></div>
    <div data-choice-case="multi"><MultiSelect aria-label="共通の複数選択" options={[{value:'a',label:'変えない'}]} values={[]} onChange={()=>{}}/></div>
    <div data-choice-case="text"><Select treatment="text" aria-label="文字型の選択" value="a" options={[{value:"a",label:"変えない"}]} onChange={()=>{}}/></div>
    <div data-choice-case="time"><TimeField aria-label="共通の時刻" value="09:00" onChange={()=>{}} /></div>
  </section>
  <section id="choice-time-narrow" style={{width:84}}><TimeField aria-label="狭い時刻" value="09:00" onChange={()=>{}}/></section>
  <section id="input-sample"><TextField aria-label="入力の見本" placeholder="you@example.com" /></section>
  <section id="display-choices" style={{width:320}}><SegmentedControl aria-label="表示の切り替え" value="line" size="panel" options={[{value:'line',label:'LINEの友だち',count:128},{value:'phone',label:'LINE未連携の電話客',count:64}]} onChange={()=>{}} /></section>
  <section id="intrinsic-choices" style={{width:'50vw',maxWidth:'100%'}}>
    {(['track','choices','reservation','intake-stop'] as const).flatMap(appearance=>[undefined,'content' as const].map(fit=><div key={appearance+'-'+fit} data-intrinsic-case={appearance+'-'+(fit??'default')}><SegmentedControl aria-label={appearance+' '+(fit??'default')} value="short" appearance={appearance} fit={fit} options={[{value:'short',label:'Short',count:128},{value:'long',label:'A much longer display choice',count:64}]} onChange={()=>{}}/></div>))}
    <div data-intrinsic-case="panel"><SegmentedControl aria-label="パネルの表示" size="panel" value="line" options={[{value:'line',label:'LINEの友だち',count:128},{value:'phone',label:'LINE未連携の電話客',count:64}]} onChange={()=>{}}/></div>
    <div data-intrinsic-case="fill"><SegmentedControl aria-label="幅いっぱいの表示" fit="fill" value="line" options={[{value:'line',label:'LINEの友だち',count:128},{value:'phone',label:'LINE未連携の電話客',count:64}]} onChange={()=>{}}/></div>
    <div data-intrinsic-case="toolbar" data-toolbar-row style={{display:'flex'}}><SegmentedControl aria-label="操作段の表示" fit="fill" value="line" options={[{value:'line',label:'LINEの友だち',count:128},{value:'phone',label:'LINE未連携の電話客',count:64}]} onChange={()=>{}}/></div>
    <div data-intrinsic-case="narrow" style={{width:240}}><SegmentedControl aria-label="狭い表示" fit="fill" value="line" options={[{value:'line',label:'LINEの友だち',count:128},{value:'phone',label:'LINE未連携の電話客',count:64}]} onChange={()=>{}}/></div>
  </section>
  <section id="empty-choices"><SegmentedControl aria-label="件数の切り替え" value={countState} options={[{value:'empty',label:'保留',count:0},{value:'active',label:'対応中',count:2},{value:'unknown',label:'未取得',count:'—'}]} onChange={setCountState}/></section>
  <section id="entity-selection"><EntityPickerField label="親候補" noun="アカウント" items={Array.from({length:20},(_,i)=>({id:String(i),name:"親候補"+i,meta:"候補の説明"}))} value="0" onChange={()=>{}} /></section><ToggleGroupActions total={6} enabled={4} label="配信" onChange={()=>{}} /><section id="favorites"><IconButton variant="attention" pressed aria-label="お気に入り済み"><Star /></IconButton><IconButton variant="attention" pressed={false} aria-label="お気に入りにする"><Star /></IconButton></section>
  <section id="filter-states" style={{display:'flex',alignItems:'center',gap:12}}>
    <FilterChip selected={value} onChange={setValue}>すばやく絞る</FilterChip>
    <FilterChip selected showCheck={false} onChange={()=>{}}>状態</FilterChip>
  </section>
  <section id="choice-states" style={{display:'flex',alignItems:'center',gap:24,padding:24}}>
    <Checkbox aria-label="未選択" checked={false} onCheckedChange={()=>{}}>未選択</Checkbox>
    <Checkbox aria-label="選択済み" checked onCheckedChange={()=>{}}>選択済み</Checkbox>
    <Checkbox aria-label="一部選択" checked={false} indeterminate onCheckedChange={()=>{}}>一部選択</Checkbox>
    <Checkbox aria-label="焦点" checked onCheckedChange={()=>{}}>焦点</Checkbox>
    <Checkbox aria-label="押せない" checked disabled onCheckedChange={()=>{}}>押せない</Checkbox>
    <Checkbox aria-label="誤り" checked={false} invalid onCheckedChange={()=>{}}>誤り</Checkbox>
  </section>
  <section id="owner-inputs" style={{display:'flex',gap:24,alignItems:'center'}}>
    <SearchField width={360} aria-label="幅を保つ検索" placeholder="注文番号やお客さまの名前で検索" value="" onChange={()=>{}}/>
    <EntitySelect width={114} aria-label="担当で絞り込む" label="担当" valuePrefix="担当：" value="all" options={[{value:'all',label:'すべて'},{value:'staff',label:'担当者'}]} onChange={()=>{}}/>
    <NumberField short aria-label="単位のある予算" defaultValue="12345" unit="円"/>
    <div style={{display:'flex'}}><NumberField aria-label="紹介者へのマイル付与" defaultValue="0" unit="mile"/></div>
  </section>
  <section id="toolbar-portal-boundary"><ListToolbarRow>
    <Select size="full" width={320} aria-label="段の状態" value="all" options={[{value:'all',label:'状態：すべて'}]} onChange={()=>{}}/>
    <FilterPopover open={filterOpen} onClose={()=>setFilterOpen(false)} label="窓の幅を確認する" trigger={<Button onClick={()=>setFilterOpen(true)}>幅の絞り込みを開く</Button>} actions={<Button onClick={()=>setFilterOpen(false)}>窓を閉じる</Button>}>
      <Select size="full" aria-label="窓の対応" value="all" options={[{value:'all',label:'対応：すべて'}]} onChange={()=>{}}/>
      <EntitySelect size="full" aria-label="窓の担当者" value="all" options={[{value:'all',label:'担当者：すべて'}]} onChange={()=>{}}/>
      <EntitySelect size="full" aria-label="窓のシナリオ" value="all" options={[{value:'all',label:'シナリオ：すべて'}]} onChange={()=>{}}/>
      <Select size="content" aria-label="窓の内容幅" value="short" options={[{value:'short',label:'短い'}]} onChange={()=>{}}/>
      <EntitySelect size="full" width={119} aria-label="窓の明示幅" value="fixed" options={[{value:'fixed',label:'固定'}]} onChange={()=>{}}/>
      <Button fullWidth>詳細条件</Button>
    </FilterPopover>
  </ListToolbarRow></section>
  <section id="row-controls"><RowMenu label="行の操作" items={[{label:'初期値に戻す…',tone:'danger',onSelect:()=>{}}]} /><RowMenu label="小さい行の操作" appearance="box" items={[{label:'編集',onSelect:()=>{}}]} /><Pagination page={1} pageCount={2} onPageChange={()=>{}} /><Pagination page={1} pageCount={1} summary="1件中1件" ariaLabel="1ページの送り" onPageChange={()=>{}} /></section>
  <section id="notices" style={{maxWidth:720}}>
   <Notice tone="info" heading="いつもと違う端末からのログイン" message="心当たりがない場合はログイン中の端末を確認してください。" action={<Button>確認する</Button>} onClose={()=>{}}/>
   <Notice tone="warn" heading="いつもと違う端末・場所からのログインです。心当たりがなければ、ほかの端末のログインを終えてパスワードを変えてください" message="大事な操作の前に毎回、本人確認をします。" action={<Button>ログイン中の端末を見る</Button>} onClose={()=>{}}/>
   <Notice tone="warn" heading="ほかの人がこの内容を保存しました" message="読み直すと、ほかの人の変更を見てから続けられます。" states={[{label:'済み',state:'done'},{label:'未保存',state:'pending'}]} footer={<button type="button">入力を破棄する</button>} action={<><Button>読み直す</Button><Button variant="primary">上書きする</Button></>} onClose={()=>{}}/>
   <Notice tone="info" action={<Button>開く</Button>} onClose={()=>{}}>題のない1行の知らせです。</Notice>
  </section>
  {[852,1140].map(w=><section key={w} data-kpi-fixture={w} style={{width:w}}><KpiBand appearance="cards">
   <KpiCard presentation="band" title="対応が必要な受信" icon={<svg viewBox="0 0 16 16"/>} value={5} unit="件" badge="最長 6日前" badgeTone="danger" detail="LINE 1・メール 4" action={{label:'受信箱へ',href:'/chats'}}/>
   <KpiCard presentation="band" title="今日の友だち" icon={<svg viewBox="0 0 16 16"/>} value={3} unit="人" detail="ブロック 0 人" sparkline={[1,2,2,3]}/>
   <KpiCard presentation="band" title="接続に問題" icon={<svg viewBox="0 0 16 16"/>} value={12345} unit="通" valueTone="warning" detail="枠 200 通のうち 2%" action={{label:'配信へ',href:'/broadcasts'}}/>
   <KpiCard presentation="band" title="今日の予約" icon={<svg viewBox="0 0 16 16"/>} value={0} unit="件" badge="なし" badgeTone="neutral" detail="次の予定はありません" action={{label:'予約へ',href:'/booking'}}/>
  </KpiBand></section>)}
  <section id="saving-bars">{[false,true,'input'].map(info=><StickyBar key={String(info)} status="未保存" info={info===true?<span>幅1200 × 高さ628</span>:null} destructive={<Button>削除する</Button>} actions={<><Button disabled={info==='input'} disabledReason={info==='input'?'名前を入れてください':undefined}>キャンセル</Button><Button variant="primary" disabled={info==='input'} disabledReason={info==='input'?'名前を入れてください':undefined}>保存する</Button></>}/>)}</section>
  {['normal','split','inline'].map(mode=><section key={mode} data-failing-bar={mode}><input aria-label="失敗時にも保持する入力" defaultValue="残す内容"/><StickyBar split={mode==='split'?{lead:<span>別の一覧</span>,trailingWidth:'360px'}:undefined} presentation={mode==='inline'?'distribution':undefined} actions={<><Button>キャンセル</Button><Button variant="primary" onClick={()=>{failureCalls[mode]=(failureCalls[mode]||0)+1;globalThis.failureCalls=failureCalls[mode];if(failureCalls[mode]===1)throw new Error('offline')}}>失敗を確かめる</Button></>}/></section>)}
  <section id="input-action"><Button disabled disabledReason="名前を入れてください" lockedReason={reasonFault?"名前を入れてください":undefined}>入力を保存する</Button></section>
  <section id="permission-action"><Button variant="primary" lockedReason="統括の担当者だけが作れます" onClick={()=>{globalThis.permissionCalls=(globalThis.permissionCalls||0)+1}}>送り先を作る</Button><Button count={3}>絞り込み</Button></section>
  <section id="permission-menu"><button ref={menuAnchor} onClick={()=>setMenuOpen(!menuOpen)}>権限メニュー</button><ActionMenu open={menuOpen} anchorRef={menuAnchor} onClose={()=>setMenuOpen(false)} items={[
   {id:'locked',label:'権限の操作',group:'destructive',lockedReason:'統括の担当者だけが作れます',href:'/unexpected',onSelect:()=>{globalThis.menuLockedCalls=(globalThis.menuLockedCalls||0)+1}},
   {id:'input',label:'入力不足の操作',group:'destructive',disabled:true,disabledReason:'名前を入れてください',onSelect:()=>{globalThis.menuInputCalls=(globalThis.menuInputCalls||0)+1}},
   {id:'allowed',label:'許可の操作',group:'destructive',onSelect:()=>{globalThis.menuAllowedCalls=(globalThis.menuAllowedCalls||0)+1}}
  ]}/></section>
  <section id="windows">{['通常','確認','危険','警告','手順','選択','長文','引き出し'].map(name=><Button key={name} onClick={()=>setWindow(name)}>{name}</Button>)}</section>
  <section><Button onClick={()=>setWindow('left-actions')}>左操作の窓を開く</Button></section>
  {window==='引き出し'?<Drawer open title="設定を編集する" headerIcon={props.headerIcon} description={props.description} onClose={()=>setWindow('')} footer={<Button onClick={()=>setWindow('')}>保存する</Button>}><input aria-label="名前" defaultValue="保持する名前"/></Drawer>:
   ['確認','危険','警告'].includes(window)?<ConfirmDialog {...props} title="内容を確認しますか？" destructive={window==='危険'} warning={window==='警告'}/>:
   <Dialog {...props} open={!!window} footerLead={window==='left-actions'?<Button onClick={()=>{globalThis.dialogLeadCalls=(globalThis.dialogLeadCalls||0)+1}}>左の操作</Button>:undefined} widthPreset={window==='選択'?'picker':undefined} steps={window==='手順'?<Steps label="窓の手順" steps={steps} currentKey="now"/>:null}>
    <DialogContentRow tone="muted"><label>名前<input aria-label="名前" defaultValue="保持する名前"/></label></DialogContentRow><Notice tone="warn">入力した内容を確認してください。</Notice>{window==='長文'?<div style={{height:1600}}>長い内容</div>:null}
   </Dialog>}
 </main>
}createRoot(document.getElementById('root')).render(<Fixture/>);

  ` },
  bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic',
  tsconfig: `${webRoot}/tsconfig.json`, define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_API_URL': '"http://127.0.0.1:8788"' },
  plugins: [{ name: 'fixture', setup(b) {
    b.onResolve({filter:/^next\/dynamic$/},()=>({path:'dynamic',namespace:'fixture'}))
    b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: 'navigation', namespace: 'fixture' }))
    b.onResolve({ filter: /^@\/contexts\/account-context$/ }, () => ({ path: 'account', namespace: 'fixture' }))
    b.onResolve({ filter: /^next\/link$|^@\/components\/shared\/list-navigation$/ }, () => ({ path: 'link', namespace: 'fixture' }))
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'navigation'
      ? 'export const useRouter=()=>({push(){},replace(){},prefetch(){}});export const usePathname=()=>"/fixture";export const useSearchParams=()=>new URLSearchParams();'
      : args.path === 'dynamic' ? 'export default function dynamic(){return function Preview(){return null}}'
      : args.path === 'account' ? 'export const useOptionalAccount=()=>null;export const useAccount=()=>({selectedAccountId:null,selectedAccount:null});'
      : 'import React from "react";export default function Link(p){return React.createElement("a",p)}', resolveDir: webRoot }))
    b.onLoad({ filter: /\.module\.css$/ }, args => {
      let css = readFileSync(args.path, 'utf8')
      const globals = []
      css = css.replace(/:global\(([^()]*)\)/g, (_, selector) => `GLOBAL_SELECTOR_${globals.push(selector) - 1}`)
      const names = Object.fromEntries([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map(m => [m[1], m[1]]))
      const prefix = `fixture_${sheets.size}_`
      for (const name of Object.keys(names)) names[name] = prefix + name
      css = css.replace(/\.([A-Za-z][\w-]*)/g, (_, name) => `.${names[name]}`)
        .replace(/GLOBAL_SELECTOR_(\d+)/g, (_, index) => globals[Number(index)])
      sheets.add(css)
      return { contents: `export default ${JSON.stringify(names)}`, loader: 'js' }
    })
    b.onLoad({ filter: /\.css$/ }, args => { sheets.add(readFileSync(args.path, 'utf8')); return { contents: '', loader: 'js' } })
  } }],
})
const globals = await compileUiStyles(fileURLToPath(new URL('../../src/app/globals.css', import.meta.url)), ['fixed', 'min-w-0'])
const css = [globals, ...sheets].join('\n').replace(/:global\(([^()]*)\)/g, '$1')

async function mount(page, width, inputReasonFault = false) {
  await page.setViewportSize({ width, height: 900 })
  await page.setContent(`<html data-theme="v8"><style>${css}*{box-sizing:border-box}.fixed{position:fixed}body{margin:0}main{margin:24px 24px 24px 264px}#selection{margin-top:24px}#windows{display:flex;gap:8px}[data-center-row]{height:40px;display:flex;align-items:center}#selection>label{margin-block:12px}</style><div id="root"></div></html>`)
  await page.addScriptTag({ content: `globalThis.inputReasonFault=${JSON.stringify(inputReasonFault)};` + compiled.outputFiles[0].text })
  await page.getByRole('button', { name: '通常', exact: true }).waitFor()
}

test('権限メニューは理由と焦点を保ち、実キー・タップでも起動しない', async () => {
  const browser = await connectGuardBrowser()
  const page = await browser.newPage({ hasTouch: true })
  try {
    for (const width of [1152, 1440]) {
      await mount(page, width)
      await page.evaluate(() => { globalThis.menuLockedCalls = 0; globalThis.menuInputCalls = 0; globalThis.menuAllowedCalls = 0 })
      const trigger = page.getByRole('button', { name: '権限メニュー', exact: true })
      await trigger.click()
      const locked = page.getByRole('menuitem', { name: /^権限の操作/ })
      const allowed = page.getByRole('menuitem', { name: '許可の操作', exact: true })
      await expect(locked).toBeFocused()
      await locked.evaluate(async el => {
        const portal = el.closest('[data-menu-portal]')
        await Promise.all(portal.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})))
      })
      assert.equal(await locked.evaluate(el => getComputedStyle(el.closest('[data-menu-portal]')).position), 'fixed')
      await expect(locked).toHaveAttribute('aria-disabled', 'true')
      assert.deepEqual(await locked.evaluate(el => ({ tag: el.tagName, disabled: el.disabled, href: el.getAttribute('href') })), { tag: 'BUTTON', disabled: false, href: null })
      const lockStyle = await locked.evaluate(el => ({ height: el.getBoundingClientRect().height, color: getComputedStyle(el).color, icon: getComputedStyle(el.querySelector('svg').parentElement).color, reasonHidden: document.getElementById(el.getAttribute('aria-describedby')).hidden }))
      assert.equal(lockStyle.height, await allowed.evaluate(el => el.getBoundingClientRect().height))
      assert.equal(lockStyle.color, lockStyle.icon)
      assert.equal(lockStyle.reasonHidden, true)
      await expect(page.getByRole('tooltip')).toHaveText('統括の担当者だけが作れます')
      if (process.env.V8_GUARD_ARTIFACT_DIR) {
        mkdirSync(process.env.V8_GUARD_ARTIFACT_DIR, { recursive: true })
        await page.screenshot({ path: `${process.env.V8_GUARD_ARTIFACT_DIR}/permission-menu-${width}.png` })
      }
      await page.keyboard.press('Enter')
      await page.keyboard.press('Space')
      const tapRect = await locked.boundingBox()
      assert.ok(tapRect)
      assert.ok(tapRect.x >= 0 && tapRect.y >= 0 && tapRect.x + tapRect.width <= width && tapRect.y + tapRect.height <= 900)
      assert.equal(await locked.evaluate(el => { const rect = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) }), true)
      await page.touchscreen.tap(tapRect.x + tapRect.width / 2, tapRect.y + tapRect.height / 2)
      assert.equal(await page.evaluate(() => globalThis.menuLockedCalls || 0), 0)
      assert.equal(await page.evaluate(() => location.pathname), 'blank')
      await page.keyboard.press('ArrowDown')
      await expect(allowed).toBeFocused()
      await page.keyboard.press('Home')
      await expect(locked).toBeFocused()
      await page.keyboard.press('End')
      await expect(allowed).toBeFocused()
      await page.keyboard.press('ArrowUp')
      await expect(locked).toBeFocused()
      await trigger.focus()
      await expect(page.getByRole('tooltip')).toHaveCount(0)
      await locked.hover()
      await expect(page.getByRole('tooltip')).toHaveText('統括の担当者だけが作れます')
      const reason = await locked.evaluate(el => document.getElementById(el.getAttribute('aria-describedby'))?.textContent)
      assert.equal(reason, '統括の担当者だけが作れます')
      await allowed.click()
      assert.equal(await page.evaluate(() => globalThis.menuAllowedCalls || 0), 1)
      assert.equal(await page.evaluate(() => globalThis.menuInputCalls || 0), 0)
    }
  } finally { await page.close(); await browser.close() }
})

test('入力理由の既定を権限tooltipへ戻す故障を検出する', async () => {
  const browser = await connectGuardBrowser()
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' })
    const inspect = () => page.locator('#input-action').evaluate(host => {
      const button = host.querySelector('button')
      return { disabled: button.disabled, permission: button.hasAttribute('data-permission-locked'), inline: host.querySelector('[role="status"]')?.textContent }
    })
    const conforms = row => row.disabled && !row.permission && row.inline === '名前を入れてください'
    await mount(page, 1152)
    assert.equal(conforms(await inspect()), true)
    // 以前の誤った既定を再現：入力理由までlockedReasonとして解釈する。
    await mount(page, 1152, true)
    const fault = await inspect()
    assert.equal(fault.disabled, false)
    assert.equal(fault.permission, true)
    assert.equal(conforms(fault), false)
  } finally { await browser.close() }
})

for (const width of [1024, 1152, 1440]) {
  test(`窓の取消と保存は中央、独立した操作は左に保ち、配置故障を検出する ${width}`, async () => {
    const browser = await connectGuardBrowser()
    try {
      const page = await browser.newPage({ reducedMotion: 'reduce' })
      await mount(page, width)
      await page.evaluate(() => { globalThis.dialogLeadCalls = 0 })
      await page.getByRole('button', { name: '左操作の窓を開く', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '新しく作る', exact: true })
      const measure = () => dialog.evaluate(root => {
        const actions = root.querySelector('[data-dialog-action-pair]'), box = actions.getBoundingClientRect()
        const lead = [...actions.querySelectorAll('button')].find(el => el.textContent === '左の操作').getBoundingClientRect()
        const pair = actions.querySelector('[data-dialog-action]').parentElement.getBoundingClientRect()
        return { center: Math.abs((pair.left + pair.right) / 2 - (box.left + box.right) / 2), leadInside: lead.left >= box.left && lead.right <= pair.left }
      })
      assert.ok((await measure()).center <= 0.5)
      assert.equal((await measure()).leadInside, true)
      const actions = dialog.locator('[data-dialog-action-pair]')
      const original = await actions.getAttribute('style')
      try {
        await actions.evaluate(el => { el.style.gridTemplateColumns = 'auto auto' })
        assert.ok((await measure()).center > 1)
      } finally {
        await actions.evaluate((el, original) => { if (original === null) el.removeAttribute('style'); else el.setAttribute('style', original) }, original)
      }
      assert.ok((await measure()).center <= 0.5)
      assert.equal((await measure()).leadInside, true)
      await dialog.getByRole('button', { name: '左の操作', exact: true }).click()
      assert.equal(await page.evaluate(() => globalThis.dialogLeadCalls), 1)
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click()
      await expect(dialog).toHaveCount(0)
    } finally { await browser.close() }
  })

  test(`補足付きの保存帯も操作を中央に置き、権限の灰ボタンと条件数を保つ ${width}`, async () => {
    const browser = await connectGuardBrowser()
    try {
      const page = await browser.newPage({ reducedMotion: 'reduce' })
      await mount(page, width)
      const offsets = () => page.locator('#saving-bars [data-shared-part="sticky-bar"]').evaluateAll(bars => bars.map(bar => {
        const b = bar.getBoundingClientRect(), a = bar.querySelector('[data-sticky-actions]').getBoundingClientRect()
        return { center: Math.abs(a.left + a.width / 2 - b.left - b.width / 2), overflow: bar.scrollWidth - bar.clientWidth }
      }))
      assert.ok((await offsets()).every(row => row.center <= 0.5 && row.overflow === 0), JSON.stringify(await offsets()))
      const fault = await page.addStyleTag({ content: '#saving-bars [data-shared-part="sticky-bar"]{display:flex!important;justify-content:flex-end!important}' })
      assert.ok((await offsets()).some(row => row.center > 1))
      await fault.evaluate(el => el.remove())
      assert.ok((await offsets()).every(row => row.center <= 0.5))
      for (const mode of ['normal', 'split', 'inline']) {
      const failing = page.locator(`[data-failing-bar="${mode}"]`)
      const actionCenter = () => failing.evaluate(host => {
        const barElement = host.querySelector('[data-shared-part="sticky-bar"]')
        const bar = (barElement.querySelector('[data-sticky-actions]')?.parentElement !== barElement ? barElement.querySelector('[data-sticky-actions]')?.parentElement ?? barElement : barElement).getBoundingClientRect()
        const buttons = [...host.querySelectorAll('button')].map(el => el.getBoundingClientRect())
        const error = host.querySelector('[role="alert"]')?.getBoundingClientRect()
        return { center: Math.abs((buttons[0].left + buttons[1].right) / 2 - (bar.left + bar.width / 2)), top: buttons[0].top - buttons[1].top, errorBelow: !error || error.top >= Math.max(...buttons.map(button => button.bottom)) }
      })
      const before = await actionCenter()
      assert.equal(await failing.getByRole('alert').count(), 0)
      await failing.getByRole('button', { name: '失敗を確かめる' }).click()
      await expect(failing.getByRole('alert')).toContainText('処理できませんでした')
      const after = await actionCenter()
      assert.ok(await failing.evaluate(host => host.querySelector('[role="alert"]').getBoundingClientRect().top >= Math.max(...[...host.querySelectorAll('button')].map(el => el.getBoundingClientRect().bottom))))
      assert.ok(after.center <= 0.5 && after.top === 0, JSON.stringify({ before, after }))
      const errorFault = await page.addStyleTag({ content: `[data-failing-bar="${mode}"] [data-sticky-actions],[data-failing-bar="${mode}"] [data-shared-part="sticky-bar"][data-presentation]{flex-wrap:nowrap!important}[data-failing-bar="${mode}"] [data-button-error]{flex-basis:auto!important;width:auto!important}` })
      const broken = await actionCenter()
      assert.ok(broken.center > 0.5 || broken.top !== 0 || !broken.errorBelow, JSON.stringify({mode, broken}))
      await errorFault.evaluate(el => el.remove())
      assert.ok((await actionCenter()).center <= 0.5)
      await expect(failing.getByRole('textbox')).toHaveValue('残す内容')
      await failing.getByRole('button', { name: '失敗を確かめる' }).click()
      await expect(failing.getByRole('alert')).toHaveCount(0)
      assert.equal(await page.evaluate(() => globalThis.failureCalls), 2)
      }
      const button = page.getByRole('button', { name: '送り先を作る', exact: true })
      const grey = await button.evaluate(el => ({ bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color, disabled: el.disabled }))
      assert.equal(grey.disabled, false)
      const channels = grey.bg.match(/[\d.]+/g).slice(0, 3).map(Number)
      assert.ok(Math.max(...channels) - Math.min(...channels) <= 20, JSON.stringify(grey))
      await button.focus()
      await expect(page.getByRole('tooltip')).toHaveText('統括の担当者だけが作れます')
      await button.press('Enter')
      await button.press('Space')
      await button.dispatchEvent('click')
      assert.equal(await page.evaluate(() => globalThis.permissionCalls || 0), 0)
      assert.equal(await page.locator('#saving-bars [role="status"]').count(), 1)
      assert.equal(await button.getAttribute('aria-disabled'), 'true')
      assert.equal(await page.getByLabel('3件の条件').textContent(), '3')
      if (process.env.V8_GUARD_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.V8_GUARD_ARTIFACT_DIR}/shared-permission-count-${width}.png` })
    } finally { await browser.close() }
  })
}

for (const width of [1152,1440,1920]) {
  test(`EntityPickerの選択印は行内中央で、最後の候補まで表示する ${width}`, async () => {
    const browser=await connectGuardBrowser()
    try {
      const page=await browser.newPage({reducedMotion:'reduce'})
      await mount(page,width)
      await page.getByRole('button',{name:'親候補：変更する',exact:true}).click()
      const dialog=page.getByRole('dialog',{name:'アカウントを選ぶ'})
      await dialog.waitFor()
      const radios=dialog.getByRole('radio')
      assert.equal(await radios.count(),20)
      const last=radios.last()
      await last.scrollIntoViewIfNeeded()
      const geometry=await last.evaluate(el=>{const row=el.closest('label'),r=row.getBoundingClientRect(),b=el.getBoundingClientRect();return {dy:b.y+b.height/2-r.y-r.height/2,contained:b.bottom<=r.bottom&&b.right<=r.right,marks:row.querySelectorAll('input[type="radio"]').length}})
      assert.ok(Math.abs(geometry.dy)<=1,JSON.stringify(geometry))
      assert.ok(geometry.contained,JSON.stringify(geometry))
      assert.equal(geometry.marks,1)
      await last.check()
      assert.equal(await last.isChecked(),true)
      const bounds=await last.evaluate(el=>({y:el.getBoundingClientRect().y,height:innerHeight}))
      assert.ok(bounds.y>=0&&bounds.y<bounds.height,JSON.stringify(bounds))
    } finally { await browser.close() }
  })

  test(`手順は名前を丸の下に置き、状態と接続と戻る操作を保つ ${width}`, async () => {
    const browser = await connectGuardBrowser()
    try {
      const page = await browser.newPage({ reducedMotion: 'reduce' })
      await mount(page,width)
      const measure = () => page.locator('[data-part="steps"]').first().evaluate(nav => {
        const dots=[...nav.querySelectorAll('[data-step-dot]')],names=[...nav.querySelectorAll('[data-step-name]')]
        const box=el=>el.getBoundingClientRect(),style=el=>getComputedStyle(el)
        return {dots:dots.map(el=>({state:el.dataset.stepDot,size:box(el).width,background:style(el).backgroundColor,color:style(el).color,ring:style(el).boxShadow})),
          positions:dots.map((el,i)=>({below:box(names[i]).top>=box(el).bottom,center:Math.abs(box(names[i]).left+box(names[i]).width/2-box(el).left-box(el).width/2)})),
          lines:[...nav.querySelectorAll('[data-step-line]')].map(el=>({state:el.dataset.stepLine,offset:Math.abs(box(el).top+box(el).height/2-box(dots[0]).top-box(dots[0]).height/2)})),
          overflow:nav.scrollWidth-nav.clientWidth}
      })
      const result=await measure()
      assert.equal(result.overflow,0)
      assert.ok(result.positions.every(row=>row.below && row.center<=0.5),JSON.stringify(result))
      assert.ok(result.dots.every(row=>row.size>=24 && row.size<=28))
      assert.ok(result.dots[1].ring.includes('2px'))
      assert.notEqual(result.dots[0].background,result.dots[1].background)
      assert.notEqual(result.dots[1].color,result.dots[2].color)
      assert.ok(result.lines.every(row=>row.offset<=0.5))
      assert.deepEqual(result.lines.map(row=>row.state),['done','todo','todo','todo'])
      await page.getByRole('button',{name:'事前確認に戻る'}).focus()
      await page.keyboard.press('Enter')
      assert.equal(await page.locator('[aria-current="step"]').textContent(),'1事前確認')
    } finally { await browser.close() }
  })

  test(`選択の箱をセル・行・名前の中心にそろえる ${width}`,async()=>{
    const browser=await connectGuardBrowser()
    try {
      const page=await browser.newPage({reducedMotion:'reduce'})
      await mount(page,width)
      const measure=()=>page.locator('#selection').evaluate(root=>[...root.querySelectorAll('input,button[role="switch"]')].map(input=>{
        const label=input.closest('label'),cell=input.closest('th,td'),row=input.closest('[data-center-row]')
        const target=cell??(label?.querySelector('[class*="title"], [class*="label"]')??row??label)
        const a=input.getBoundingClientRect(),b=target.getBoundingClientRect()
        return {label:input.getAttribute('aria-label')??label?.textContent,offset:a.top+a.height/2-b.top-b.height/2}
      }))
      const normal=await measure()
      assert.ok(normal.length>=8)
      assert.ok(normal.every(row=>Math.abs(row.offset)<=0.5),JSON.stringify(normal))
      assert.equal((await page.evaluate(measureControlCentering,'#selection')).findings.length,0)
      await page.getByRole('checkbox',{name:'全選択',exact:true}).check()
      assert.equal(await page.getByRole('checkbox',{name:'行を選ぶ',exact:true}).isChecked(),true)
      const boxes=await page.locator('#selection input[type="checkbox"]').evaluateAll(inputs=>inputs.map(input=>{
        const frame=input.nextElementSibling?.tagName==='SPAN'?input.nextElementSibling:input;
        const style=getComputedStyle(frame),rect=frame.getBoundingClientRect();
        return {width:rect.width,height:rect.height,radius:style.borderRadius,ring:style.outlineWidth,image:style.backgroundImage};
      }))
      assert.ok(boxes.every(box=>box.width===16&&box.height===16&&box.radius==='5px'&&box.ring==='1px'&&box.image.includes('linear-gradient')),JSON.stringify(boxes))
      const markOffsets = () => page.locator('#selection input[type="checkbox"]').evaluateAll(inputs => inputs.map(input => {
        const frame = input.nextElementSibling
        const path = frame.querySelector('svg path')
        const box = frame.getBoundingClientRect(), bbox = path.getBBox(), matrix = path.getScreenCTM()
        const center = new DOMPoint(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2).matrixTransform(matrix)
        return { dx: center.x - box.x - box.width / 2, dy: center.y - box.y - box.height / 2 }
      }))
      assert.ok((await markOffsets()).every(({dx,dy}) => Math.abs(dx) <= 0.1 && Math.abs(dy) <= 0.1))
      const mark = page.locator('#selection input[type="checkbox"] + span svg path').first()
      const centeredPath = await mark.getAttribute('d')
      await mark.evaluate(el => el.setAttribute('d', 'M4 12l5 5L20 6'))
      await expect.poll(async () => (await markOffsets()).some(({dy}) => Math.abs(dy) > 0.1)).toBe(true)
      await mark.evaluate((el, path) => el.setAttribute('d', path), centeredPath)
      await expect.poll(async () => (await markOffsets()).every(({dx,dy}) => Math.abs(dx) <= 0.1 && Math.abs(dy) <= 0.1)).toBe(true)
      await page.locator('#selection input[type="checkbox"] + span svg').first().evaluate(el => { el.style.transform = 'translateY(2px)' })
      await expect.poll(async () => (await markOffsets()).some(({dy}) => Math.abs(dy) > 0.1)).toBe(true)
      await page.locator('#selection input[type="checkbox"] + span svg').first().evaluate(el => { el.style.transform = '' })
      await expect.poll(async () => (await markOffsets()).every(({dx,dy}) => Math.abs(dx) <= 0.1 && Math.abs(dy) <= 0.1)).toBe(true)
      await page.getByRole('checkbox',{name:'ラベル付き',exact:true}).focus(); await page.keyboard.press('Space')
      assert.equal(await page.getByRole('checkbox',{name:'全選択',exact:true}).isChecked(),false)
      // 実寸をずらした場合に、この計測がずれを見逃さないことを確かめる。
      await page.getByRole('checkbox',{name:'全選択',exact:true}).evaluate(el=>el.style.top='-2px')
      assert.ok((await measure()).some(row=>Math.abs(row.offset)>0.5))
      await page.getByRole('checkbox',{name:'全選択',exact:true}).evaluate(el=>el.style.top='')
      assert.ok((await measure()).every(row=>Math.abs(row.offset)<=0.5))
    } finally {await browser.close()}
  })

  test(`共通の操作は36px、入力は選ぶ欄と同じ影と地を保つ ${width}`, async () => {
    const browser = await connectGuardBrowser()
    try {
      const page = await browser.newPage({ reducedMotion: 'reduce' })
      await mount(page, width)
      const read = () => page.locator('#control-density').evaluate(root => {
        const selectors = ['input[aria-label="寸法の名前"]', '[data-search-field]', 'button[aria-label="寸法の選択"]', 'button[aria-label="寸法の保存"]', 'textarea']
        return selectors.map(selector => { const el = root.querySelector(selector), box = el.getBoundingClientRect(), css = getComputedStyle(el); return { height: box.height, center: box.top + box.height / 2, image: css.backgroundImage, shadow: css.boxShadow } })
      })
      const controls = await read()
      assert.ok(controls.slice(0,4).every(control => control.height === 36), JSON.stringify(controls))
      assert.ok(controls.slice(0,4).every(control => Math.abs(control.center - controls[0].center) <= 0.5), JSON.stringify(controls))
      assert.deepEqual([controls[0], controls[1], controls[4]].map(control => control.image), ['none', 'none', 'none'])
      assert.equal(controls[2].image, 'linear-gradient(rgb(255, 255, 255), rgb(250, 250, 252))')
      assert.equal(controls[3].image, 'linear-gradient(rgb(8, 122, 62), rgb(6, 106, 53))')
      assert.ok(controls.every(control => control.shadow !== 'none'), JSON.stringify(controls))
      assert.equal(controls[0].image, controls[4].image)
      assert.equal(controls[0].shadow, controls[2].shadow)
      assert.equal(controls[1].shadow, controls[2].shadow)
      assert.equal(controls[4].shadow, controls[2].shadow)
      assert.deepEqual(await page.evaluate(scanRowHeights), [])
      const input = page.getByRole('textbox', { name: '寸法の名前', exact: true })
      await input.evaluate(el => { el.style.height = '30px'; el.style.minHeight = '0' })
      assert.ok((await page.evaluate(scanRowHeights)).some(finding => finding.kind === 'rowheight'))
      await input.evaluate(el => { el.style.height = ''; el.style.minHeight = '' })
      assert.deepEqual(await page.evaluate(scanRowHeights), [])
    } finally { await browser.close() }
  })

  test(`絞り込みの札は緑と選択の印を保ち、タッチでは44pxを確保する ${width}`, async () => {
    const browser = await connectGuardBrowser()
    try {
      const page = await browser.newPage({ reducedMotion: 'reduce' })
      await mount(page, width)
      const quick = page.getByRole('button', { name: 'すばやく絞る', exact: true })
      const style = () => quick.evaluate(el => { const css = getComputedStyle(el); return { height: el.getBoundingClientRect().height, whiteSpace: css.whiteSpace, background: css.backgroundColor, color: css.color, marks: el.querySelectorAll('svg').length } })
      assert.equal((await style()).height, 36)
      assert.equal((await style()).whiteSpace, 'nowrap')
      assert.equal((await style()).background, 'rgb(255, 255, 255)')
      await quick.click()
      const selected = await style()
      await expect.poll(async () => (await style()).background).toBe('rgb(232, 245, 236)')
      await expect.poll(async () => (await style()).color).toBe('rgb(8, 122, 62)')
      assert.equal(selected.marks, 1)
      assert.equal(await page.getByRole('button', { name: '状態', exact: true }).locator('svg').count(), 0)
      await quick.evaluate(el => { el.style.background = 'black' })
      await expect.poll(async () => (await style()).background).toBe('rgb(0, 0, 0)')
      await quick.evaluate(el => { el.style.background = '' })
      await expect.poll(async () => (await style()).background).toBe('rgb(232, 245, 236)')
      const touch = await browser.newPage({ hasTouch: true, reducedMotion: 'reduce' })
      await mount(touch, width)
      assert.ok(await touch.getByRole('button', { name: 'すばやく絞る', exact: true }).evaluate(el => el.getBoundingClientRect().height >= 44))
      const touchHeights=()=>touch.locator('#choice-appearance [data-choice-field]').evaluateAll(fields=>fields.map(el=>el.getBoundingClientRect().height))
      assert.ok((await touchHeights()).every(height=>height===44))
      const touchCombo=touch.locator('[data-choice-case="combo"] [data-choice-field]')
      await touchCombo.evaluate(el=>{el.style.setProperty('--choice-touch-h','40px')})
      await expect.poll(async ()=>(await touchHeights()).some(height=>height!==44)).toBe(true)
      await touchCombo.evaluate(el=>{el.style.removeProperty('--choice-touch-h')})
      await expect.poll(async ()=>(await touchHeights()).every(height=>height===44)).toBe(true)
    } finally { await browser.close() }
  })

  test(`チェックの6状態で緑・角丸・焦点・誤りを保つ ${width}`, async () => {
    const browser = await connectGuardBrowser()
    try {
      const page = await browser.newPage({ reducedMotion: 'reduce' })
      await mount(page, width)
      await page.getByRole('checkbox', { name: '焦点', exact: true }).focus()
      await page.keyboard.press('Tab')
      await page.keyboard.press('Shift+Tab')
      const states = await page.locator('#choice-states input').evaluateAll(inputs => inputs.map(input => {
        const frame = input.nextElementSibling, style = getComputedStyle(frame)
        return { name: input.getAttribute('aria-label'), radius: style.borderRadius, image: style.backgroundImage, ring: style.outlineColor, focus: input.matches(':focus-visible'), disabled: input.disabled, opacity: getComputedStyle(input.closest('[data-disabled]') ?? frame).opacity }
      }))
      assert.ok(states.every(state => state.radius === '5px'), JSON.stringify(states))
      for (const name of ['選択済み', '一部選択', '焦点', '押せない']) assert.ok(states.find(state => state.name === name).image.includes('linear-gradient'), JSON.stringify(states))
      assert.equal(states.find(state => state.name === '焦点').focus, true)
      assert.notEqual(states.find(state => state.name === '焦点').ring, states.find(state => state.name === '誤り').ring)
      assert.equal(states.find(state => state.name === '押せない').disabled, true)
      assert.ok(+states.find(state => state.name === '押せない').opacity < 1)
      if (process.env.V8_CHOICE_SHOTS_DIR) {
        mkdirSync(process.env.V8_CHOICE_SHOTS_DIR, { recursive: true })
        await page.locator('#choice-states').screenshot({ path: join(process.env.V8_CHOICE_SHOTS_DIR, `resume-six-states-${width}.png`) })
      }
    } finally { await browser.close() }
  })

  test(`スイッチは見える軌道の外にも当たりがあり、当たりを壊すと押せない ${width}`, async () => {
    const browser=await connectGuardBrowser()
    try {
      const page=await browser.newPage({reducedMotion:'reduce'})
      await mount(page,width)
      const toggle=page.getByRole('switch',{name:'切り替え',exact:true})
      const clickOutside=async()=>{const rect=await toggle.boundingBox();await page.mouse.click(rect.x+rect.width/2,rect.y-1)}
      await clickOutside()
      await expect(toggle).toHaveAttribute('aria-checked','true')
      await toggle.evaluate(el=>el.setAttribute('data-hit-fault',''))
      await page.addStyleTag({content:'[data-hit-fault]::before { content: none !important; }'})
      await clickOutside()
      await expect(toggle).toHaveAttribute('aria-checked','true')
      await toggle.evaluate(el=>el.removeAttribute('data-hit-fault'))
      await clickOutside()
      await expect(toggle).toHaveAttribute('aria-checked','false')
      const touch=await browser.newPage({hasTouch:true,reducedMotion:'reduce'})
      await mount(touch,width)
      const touchToggle=touch.getByRole('switch',{name:'切り替え',exact:true}),touchRect=await touchToggle.boundingBox()
      await touch.touchscreen.tap(touchRect.x+touchRect.width/2,touchRect.y-10)
      await expect(touchToggle).toHaveAttribute('aria-checked','true')
    } finally {await browser.close()}
  })

  test(`検索幅・すべての名前・数値の単位を欄内で保つ ${width}`, async()=>{
    const browser=await connectGuardBrowser()
    try {
      const page=await browser.newPage({reducedMotion:'reduce'});await mount(page,width)
      const result=await page.locator('#owner-inputs').evaluate(root=>{
        const input=root.querySelector('input[type=search]'),search=input.parentElement,label=root.querySelector('[data-choice-value]'),number=root.querySelector('input[type=number]'),unit=root.querySelector('[data-number-unit]'),frame=number.parentElement
        return {search:search.getBoundingClientRect().width,textFits:label.scrollWidth<=label.clientWidth,unitInside:unit.getBoundingClientRect().right<=frame.getBoundingClientRect().right-8,minimumInput:root.querySelector('input[aria-label="紹介者へのマイル付与"]').getBoundingClientRect().width,displayWidth:root.querySelector('[data-number-display]').getBoundingClientRect().width,inputWidth:number.getBoundingClientRect().width,numberValue:number.value,display:root.querySelector('[data-number-display]').textContent,height:frame.getBoundingClientRect().height}
      })
      assert.ok(result.minimumInput>=48,JSON.stringify(result));assert.ok(result.displayWidth<=result.inputWidth+0.5,JSON.stringify(result));assert.equal(result.search,360);assert.ok(result.textFits,JSON.stringify(result));assert.ok(result.unitInside,JSON.stringify(result));assert.equal(result.numberValue,'12345');assert.equal(result.display,'12,345');assert.equal(result.height,36)
      await page.getByRole('spinbutton',{name:'単位のある予算'}).focus();await expect(page.locator('[data-number-display]')).toHaveCount(0)
    } finally {await browser.close()}
  })

  test(`道具段は内容幅へそろえ、絞り込み窓の幅指定を保持する ${width}`, async () => {
    const browser=await connectGuardBrowser()
    try {
      const page=await browser.newPage({reducedMotion:'reduce'})
      await mount(page,width)
      const direct=await page.getByRole('button',{name:'段の状態',exact:true}).evaluate(el=>{const b=el.closest('[data-choice-field]').getBoundingClientRect();return {x:b.x,width:b.width}})
      assert.ok(direct.width>40&&direct.width<200,JSON.stringify(direct))
      await page.getByRole('button',{name:'幅の絞り込みを開く',exact:true}).click()
      const panel=page.getByRole('dialog',{name:'窓の幅を確認する',exact:true})
      const measure=()=>panel.evaluate(root=>{
        const r=root.getBoundingClientRect(),s=getComputedStyle(root)
        const box=name=>{const frame=root.querySelector('button[aria-label="'+name+'"]').closest('[data-choice-field]'),b=frame.getBoundingClientRect();return {x:b.x,right:b.right,width:b.width}}
        const detail=[...root.querySelectorAll('button')].find(el=>el.textContent==='詳細条件').getBoundingClientRect()
        return {width:r.width,left:r.x+parseFloat(s.paddingLeft),right:r.right-parseFloat(s.paddingRight),full:['窓の対応','窓の担当者','窓のシナリオ'].map(box),content:box('窓の内容幅'),fixed:box('窓の明示幅'),detail:{x:detail.x,right:detail.right}}
      })
      const assertFull=value=>assert.ok(value.full.every(box=>Math.abs(box.x-value.left)<=0.5&&Math.abs(box.right-value.right)<=0.5),JSON.stringify(value))
      await expect.poll(async()=>{const value=await measure();return value.full.every(box=>Math.abs(box.x-value.left)<=0.5&&Math.abs(box.right-value.right)<=0.5)}).toBe(true)
      assertFull(await measure())
      for(const panelWidth of [280,180]) {
        await panel.evaluate((el,panelWidth)=>{el.style.width=panelWidth+'px'},panelWidth)
        await expect.poll(async()=>Math.abs((await measure()).width-panelWidth)<=0.5).toBe(true)
        await expect.poll(async()=>{const value=await measure();return value.full.every(box=>Math.abs(box.x-value.left)<=0.5&&Math.abs(box.right-value.right)<=0.5)}).toBe(true)
        const value=await measure()
        assertFull(value)
        assert.ok(value.content.width<value.right-value.left-1,JSON.stringify(value))
        assert.ok(value.content.right<=value.right+0.5,JSON.stringify(value))
        assert.ok(Math.abs(value.fixed.width-119)<=0.5,JSON.stringify(value))
        assert.ok(Math.abs(value.detail.x-value.left)<=0.5&&Math.abs(value.detail.right-value.right)<=0.5,JSON.stringify(value))
      }
      for(const name of ['窓の対応','窓の担当者']) {
        const control=page.getByRole('button',{name,exact:true})
        const original=await control.evaluate(el=>el.closest('[data-choice-field]').getAttribute('style'))
        try {
          await control.evaluate(el=>{el.closest('[data-choice-field]').style.width='max-content'})
          const broken=await measure()
          assert.throws(()=>assertFull(broken))
        } finally {
          await control.evaluate((el,original)=>{const frame=el.closest('[data-choice-field]');if(original===null)frame.removeAttribute('style');else frame.setAttribute('style',original)},original)
        }
        assertFull(await measure())
      }
    } finally {await browser.close()}
  })

  test(`7種類の選ぶ欄は高さ・影・矢印・焦点をそろえる ${width}`, async () => {
    const browser=await connectGuardBrowser()
    try {
      const page=await browser.newPage({reducedMotion:'reduce'})
      await mount(page,width)
      const measure=()=>page.locator('#choice-appearance [data-choice-case]').evaluateAll(cases=>cases.map(item=>{
        const field=item.querySelector('[data-choice-field]'),arrow=field.querySelector('[data-choice-chevron],[data-choice-action]:not([data-choice-clear]) > svg'),b=field.getBoundingClientRect(),a=arrow.getBoundingClientRect(),s=getComputedStyle(field)
        return {kind:item.dataset.choiceCase,height:b.height,image:s.backgroundImage,shadow:s.boxShadow,radius:s.borderRadius,border:s.borderWidth,dy:a.y+a.height/2-b.y-b.height/2,right:b.right-a.right}
      }))
      const good=await measure()
      if (process.env.V8_CHOICE_SHOTS_DIR) {
        mkdirSync(process.env.V8_CHOICE_SHOTS_DIR, { recursive: true })
        await page.locator('#choice-appearance').screenshot({ path: join(process.env.V8_CHOICE_SHOTS_DIR, `choice-surfaces-${width}.png`) })
      }
      assert.equal(good.length,7)
      assert.ok(good.every(item=>item.height===36&&Math.abs(item.dy)<=1&&Math.abs(item.right-12)<=1),JSON.stringify(good))
      assert.deepEqual(good.map(({kind,image})=>({kind,image})), ['select','folder','entity','combo','multi','text','time'].map(kind=>({kind,image:['select','folder','entity','multi'].includes(kind)?'linear-gradient(rgb(255, 255, 255), rgb(250, 250, 252))':'none'})))
      assert.ok(good.every(item=>item.shadow===good[0].shadow&&item.radius===good[0].radius&&item.border==='0px'),JSON.stringify(good))
      const entity=page.locator('[data-choice-case="entity"] [data-choice-chevron]')
      await entity.evaluate(el=>el.style.transform='translateY(calc(-50% + 2px))')
      await expect.poll(async () => (await measure()).some(item=>Math.abs(item.dy)>1)).toBe(true)
      await entity.evaluate(el=>el.style.transform='')
      await expect.poll(async () => (await measure()).every(item=>Math.abs(item.dy)<=1)).toBe(true)
      const narrow=await page.getByRole('combobox',{name:'狭い時刻'}).evaluate(input=>{const css=getComputedStyle(input),ctx=document.createElement('canvas').getContext('2d');ctx.font=`${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;return {text:ctx.measureText(input.value).width+(input.value.length-1)*(parseFloat(css.letterSpacing)||0),space:input.clientWidth-(parseFloat(css.paddingLeft)||0)-(parseFloat(css.paddingRight)||0)}})
      assert.ok(narrow.text<=narrow.space+1,JSON.stringify(narrow))
      const textChoice=page.getByRole('button',{name:'文字型の選択',exact:true})
      await page.keyboard.press('Tab')
      await textChoice.focus()
      await expect.poll(() => textChoice.evaluate(el=>getComputedStyle(el).outlineWidth)).toBe('2px')
      await expect.poll(() => textChoice.evaluate(el=>getComputedStyle(el).outlineColor)).toBe('rgb(37, 99, 235)')
      await textChoice.evaluate(el=>el.setAttribute('data-choice-invalid','true'))
      await expect.poll(() => textChoice.evaluate(el=>{const probe=document.createElement('i');probe.style.color='var(--color-danger)';el.append(probe);const color=getComputedStyle(probe).color;probe.remove();return getComputedStyle(el).boxShadow.includes(color)})).toBe(true)
    } finally { await browser.close() }
  })

  test(`見本・表示切替・お気に入りは共通の形を保つ ${width}`, async () => {
    const browser=await connectGuardBrowser()
    try {
      const page=await browser.newPage({reducedMotion:'reduce'})
      await mount(page,width)
      const sample=page.getByRole('textbox',{name:'入力の見本'})
      assert.equal(await sample.getAttribute('placeholder'),'例：you@example.com')
      const colors=await sample.evaluate(el=>({sample:getComputedStyle(el,'::placeholder').color,value:getComputedStyle(el).color}))
      assert.notEqual(colors.sample,colors.value,JSON.stringify(colors))
      const group=page.getByRole('group',{name:'表示の切り替え'})
      const layout=await group.evaluate(root=>({height:root.getBoundingClientRect().height,endGap:root.getBoundingClientRect().right-root.querySelector('button:last-child').getBoundingClientRect().right-parseFloat(getComputedStyle(root).paddingRight),background:getComputedStyle(root).backgroundColor,thumb:getComputedStyle(root.querySelector('[data-sliding-indicator]')||root.firstElementChild).backgroundColor,items:[...root.querySelectorAll('button')].map(el=>({width:el.getBoundingClientRect().width,scroll:el.scrollWidth,client:el.clientWidth,title:el.title}))}))
      assert.equal(layout.height,36,JSON.stringify(layout))
      assert.equal(layout.thumb,'rgb(255, 255, 255)',JSON.stringify(layout))
      assert.equal(layout.background,'rgb(245, 245, 247)',JSON.stringify(layout))
      assert.ok(Math.abs(layout.items[0].width-layout.items[1].width)<=0.5,JSON.stringify(layout))
      assert.ok(Math.abs(layout.endGap)<=0.5,JSON.stringify(layout))
      assert.ok(layout.items.every(item=>item.title),JSON.stringify(layout))
      const trigger=page.getByRole('button',{name:'寸法の選択',exact:true})
      await trigger.click()
      const menu=page.locator('[data-menu-portal][data-ready="true"]')
      await menu.waitFor()
      const right=await menu.evaluate(el=>el.getBoundingClientRect().right)
      const anchorRight=await trigger.evaluate(el=>el.getBoundingClientRect().right)
      assert.ok(Math.abs(right-anchorRight)<=1,JSON.stringify({right,anchorRight}))
      assert.equal(await menu.getAttribute('data-align'),'end')
      await page.keyboard.press('Escape')
      const star=page.getByRole('button',{name:'お気に入り済み'}).locator('svg')
      const paint=await star.evaluate(el=>({fill:getComputedStyle(el).fill,color:getComputedStyle(el).color}))
      assert.equal(paint.fill,'rgb(251, 191, 36)',JSON.stringify(paint))
      assert.equal(paint.color,'rgb(245, 158, 11)',JSON.stringify(paint))
      await star.evaluate(el=>el.parentElement.setAttribute('data-part','attention-star'))
      assert.deepEqual(await star.evaluate(el=>({fill:getComputedStyle(el).fill,color:getComputedStyle(el).color})),paint)
      const batch=page.getByRole('group',{name:'配信の一括設定'})
      assert.ok((await batch.innerText()).includes('6 件中 4 件オン'))
      assert.equal(await batch.getByRole('switch').count(),0)
      for (const name of ['配信をすべてオン','配信をすべてオフ']) {
        const button=batch.getByRole('button',{name})
        assert.equal(await button.evaluate(el=>getComputedStyle(el).color),'rgb(8, 122, 62)')
        assert.equal(await button.evaluate(el=>document.getElementById(el.getAttribute('aria-describedby')).textContent),'6 件中 4 件オン')
      }
      const empty=page.getByRole('button',{name:'保留 0',exact:true})
      const faint=await empty.evaluate(el=>{const probe=document.createElement('span');probe.style.color='var(--color-ink-faint)';el.append(probe);const color=getComputedStyle(probe).color;probe.remove();return color})
      assert.equal(await empty.evaluate(el=>getComputedStyle(el).color),faint)
      assert.equal(await empty.locator('[data-segment-count]').evaluate(el=>getComputedStyle(el).color),faint)
      await empty.click()
      assert.equal(await empty.getAttribute('aria-pressed'),'true')
      assert.equal(await empty.evaluate(el=>getComputedStyle(el).color),faint)
      assert.equal(await page.getByRole('button',{name:'未取得 —',exact:true}).getAttribute('data-empty'),null)
      const offStar=page.getByRole('button',{name:'お気に入りにする'})
      await page.mouse.move(0,0)
      await page.locator('body').click({position:{x:1,y:1}})
      assert.equal(await offStar.locator('svg').evaluate(el=>getComputedStyle(el).opacity),'0')
      await page.keyboard.press('Tab')
      await offStar.focus()
      await expect.poll(()=>offStar.locator('svg').evaluate(el=>getComputedStyle(el).opacity)).toBe('1')
      await offStar.evaluate(el=>el.blur())
      const touch=await browser.newContext({hasTouch:true,isMobile:true,viewport:{width,height:900},reducedMotion:'reduce'})
      try {
        const touchPage=await touch.newPage()
        await mount(touchPage,width)
        const faded=await touchPage.getByRole('button',{name:'お気に入りにする'}).locator('svg').evaluate(el=>Number(getComputedStyle(el).opacity))
        assert.ok(faded>0 && faded<1,String(faded))
        assert.equal(await touchPage.getByRole('button',{name:'お気に入り済み'}).locator('svg').evaluate(el=>getComputedStyle(el).opacity),'1')
      } finally { await touch.close() }

    } finally { await browser.close() }
  })

  test(`内容幅の切り替えも等分し、空きがある長い項目を切らない ${width}`,async()=>{
    const browser=await connectGuardBrowser()
    try {
      const page=await browser.newPage({reducedMotion:'reduce'})
      await mount(page,width)
      const measure=root=>root.evaluate(el=>{
        const rect=el.getBoundingClientRect(),parent=el.parentElement.getBoundingClientRect()
        const items=[...el.querySelectorAll('button')].map(button=>{const b=button.getBoundingClientRect();return {width:b.width,fits:button.scrollWidth<=button.clientWidth,contained:b.left>=rect.left-1&&b.right<=rect.right+1}})
        return {items,width:rect.width,parentWidth:parent.width,kind:el.parentElement.dataset.intrinsicCase,contained:rect.left>=parent.left-1&&rect.right<=parent.right+1}
      })
      for(const root of await page.locator('#intrinsic-choices [data-segmented-control]').all()){
        const geometry=await measure(root)
        assert.ok(geometry.contained&&geometry.items.every(item=>item.contained),JSON.stringify(geometry))
        if(geometry.kind==='narrow') assert.ok(geometry.items.some(item=>!item.fits),JSON.stringify(geometry))
        else assert.ok(geometry.items.every(item=>item.fits),JSON.stringify(geometry))
        assert.ok(Math.abs(geometry.items[0].width-geometry.items[1].width)<=1,JSON.stringify(geometry))
        if(['panel','fill','toolbar','narrow'].includes(geometry.kind)) assert.ok(Math.abs(geometry.width-geometry.parentWidth)<=1,JSON.stringify(geometry))
      }
      await expect(page.locator('[data-intrinsic-case="narrow"] button').last()).toHaveAttribute('title','LINE未連携の電話客')
      await expect(page.locator('[data-intrinsic-case="narrow"] button').last()).toHaveAttribute('aria-label','LINE未連携の電話客 64')
      const root=page.locator('[data-intrinsic-case="track-content"] [data-segmented-control]')
      await root.evaluate(el=>el.style.display='inline-flex')
      await expect.poll(async ()=>(await measure(root)).items.every(item=>item.fits)).toBe(false)
      await root.evaluate(el=>el.style.removeProperty('display'))
      await expect.poll(async ()=>(await measure(root)).items.every(item=>item.fits)).toBe(true)
    } finally {await browser.close()}
  })

  test(`候補の選択印は1個で行内中央、最後の候補まで操作できる ${width}`, async () => {
    const browser=await connectGuardBrowser()
    try {
      const page=await browser.newPage({reducedMotion:'reduce'})
      await mount(page,width)
      await page.getByRole('button',{name:'親候補：変更する',exact:true}).click()
      const dialog=page.getByRole('dialog',{name:'アカウントを選ぶ'})
      await dialog.waitFor()
      const radios=dialog.getByRole('radio')
      assert.equal(await radios.count(),20)
      const last=radios.last()
      await last.scrollIntoViewIfNeeded()
      const geometry=await last.evaluate(el=>{const row=el.closest('label'),r=row.getBoundingClientRect(),b=el.getBoundingClientRect(),text=row.querySelector('[class*="tpCardText"]').getBoundingClientRect();return {dy:b.y+b.height/2-r.y-r.height/2,left:b.left-r.left,padding:parseFloat(getComputedStyle(row).paddingLeft),beforeText:b.right<=text.left,contained:b.bottom<=r.bottom&&b.right<=r.right,marks:row.querySelectorAll('input[type="radio"]').length}})
      assert.ok(Math.abs(geometry.dy)<=1,JSON.stringify(geometry))
      assert.ok(geometry.contained,JSON.stringify(geometry))
      assert.ok(Math.abs(geometry.left-geometry.padding)<=1,JSON.stringify(geometry))
      assert.ok(geometry.beforeText,JSON.stringify(geometry))
      assert.equal(geometry.marks,1)
      await last.check()
      assert.equal(await last.isChecked(),true)
      const bounds=await last.evaluate(el=>({y:el.getBoundingClientRect().y,height:innerHeight}))
      assert.ok(bounds.y>=0&&bounds.y<bounds.height,JSON.stringify(bounds))
      if(process.env.V8_CHOICE_SHOTS_DIR){
        mkdirSync(process.env.V8_CHOICE_SHOTS_DIR,{recursive:true})
        await page.screenshot({path:join(process.env.V8_CHOICE_SHOTS_DIR,`entity-picker-${width}.png`)})
      }
    } finally { await browser.close() }
  })

  test(`行のメニューは線なし、現在のページは灰、1ページでは件数だけ ${width}`, async () => {
    const browser = await connectGuardBrowser()
    try {
      const page = await browser.newPage({reducedMotion:'reduce'})
      await mount(page,width)
      for (const name of ['行の操作','小さい行の操作']) {
        await page.mouse.move(0,0)
        const trigger=page.getByRole('button',{name,exact:true})
        const measure=()=>trigger.evaluate(el=>{
          const s=getComputedStyle(el),after=getComputedStyle(el,'::after'),clear='rgba(0, 0, 0, 0)'
          const borderVisible=['Top','Right','Bottom','Left'].some(side=>parseFloat(after[`border${side}Width`])>0&&after[`border${side}Color`]!==clear)
          const afterVisible=!['none','normal'].includes(after.content)&&after.display!=='none'&&Number(after.opacity)>0&&(
            after.backgroundColor!==clear||after.backgroundImage!=='none'||after.boxShadow!=='none'||borderVisible||
            parseFloat(after.outlineWidth)>0&&after.outlineColor!==clear)
          return {background:s.backgroundColor,image:s.backgroundImage,shadow:s.boxShadow,border:s.borderWidth,outlineVisible:parseFloat(s.outlineWidth)>0&&s.outlineColor!==clear,afterVisible,hoverBackground:s.backgroundColor!==clear?s.backgroundColor:after.backgroundColor}
        })
        const assertResting=appearance=>{
          assert.equal(appearance.background,'rgba(0, 0, 0, 0)',JSON.stringify(appearance))
          assert.equal(appearance.image,'none',JSON.stringify(appearance))
          assert.equal(appearance.shadow,'none',JSON.stringify(appearance))
          assert.equal(appearance.border,'0px',JSON.stringify(appearance))
          assert.equal(appearance.outlineVisible,false,JSON.stringify(appearance))
          assert.equal(appearance.afterVisible,false,JSON.stringify(appearance))
        }
        assertResting(await measure())
        await trigger.evaluate(el=>el.setAttribute('data-menu-frame-fault',''))
        for(const faultRule of ['outline:1px solid rgb(20,20,20)','border-right:1px solid rgb(20,20,20)','background-image:linear-gradient(black,black)']){
          const fault=await page.addStyleTag({content:`[data-menu-frame-fault]::after{content:"";${faultRule}!important}`})
          await expect.poll(async ()=>(await measure()).afterVisible,{message:faultRule}).toBe(true)
          const faultAppearance=await measure()
          assert.throws(()=>assertResting(faultAppearance),/afterVisible/)
          await fault.evaluate(el=>el.remove())
          await expect.poll(async ()=>(await measure()).afterVisible).toBe(false)
          assertResting(await measure())
        }
        await trigger.evaluate(el=>el.removeAttribute('data-menu-frame-fault'))
        assertResting(await measure())
        await trigger.hover()
        await expect.poll(async ()=>(await measure()).hoverBackground).not.toBe('rgba(0, 0, 0, 0)')
      }
      await page.getByRole('button',{name:'行の操作',exact:true}).click()
      await page.getByRole('menuitem',{name:'初期値に戻す',exact:true}).waitFor()
      const menu=await page.getByRole('menu').evaluate(el=>({width:el.getBoundingClientRect().width,text:el.innerText}))
      assert.ok(menu.width<224,JSON.stringify(menu))
      assert.ok(!menu.text.endsWith('…'),JSON.stringify(menu))
      await page.keyboard.press('Escape')
      const current=page.locator('[aria-current="page"]')
      assert.equal(await current.count(),1)
      const state=await current.evaluate(el=>({background:getComputedStyle(el).backgroundColor,weight:getComputedStyle(el).fontWeight,outline:getComputedStyle(el).outlineColor,shadow:getComputedStyle(el).boxShadow,border:getComputedStyle(el).borderWidth}))
      assert.equal(state.background,'rgb(247, 247, 245)',JSON.stringify(state))
      assert.ok(Number(state.weight)>=600,JSON.stringify(state))
      assert.equal(state.outline,'rgba(0, 0, 0, 0)',JSON.stringify(state))
      assert.equal(state.shadow,'none',JSON.stringify(state))
      assert.equal(state.border,'0px',JSON.stringify(state))
      await current.evaluate(el => el.style.outlineColor='rgb(20, 20, 20)')
      await expect.poll(()=>current.evaluate(el=>getComputedStyle(el).outlineColor)).not.toBe('rgba(0, 0, 0, 0)')
      await current.evaluate(el => el.style.removeProperty('outline-color'))
      await expect.poll(()=>current.evaluate(el=>getComputedStyle(el).outlineColor)).toBe('rgba(0, 0, 0, 0)')
      await page.keyboard.press('Tab')
      await current.focus()
      await expect.poll(()=>current.evaluate(el=>getComputedStyle(el).outlineColor)).toBe('rgb(37, 99, 235)')
      await current.evaluate(el=>el.blur())
      assert.equal(await page.getByRole('navigation',{name:'1ページの送り'}).count(),0)
      await expect(page.getByText('1件中1件',{exact:true})).toBeVisible()
      await page.close()
    } finally { await browser.close() }
  })

  test(`8種類の窓で頭と操作が切れず、明るい面と任意の印を保つ ${width}`,async()=>{
    const browser=await connectGuardBrowser()
    try{
      const page=await browser.newPage({reducedMotion:'reduce'})
      await mount(page,width)
      for(const name of ['通常','確認','危険','警告','手順','選択','長文','引き出し']){
        await page.getByRole('button',{name,exact:true}).click()
        const panel=page.locator('[aria-modal="true"]')
        await panel.waitFor()
        // 開いた直後の描画と遷移を終えてから、表示中の窓を測る。
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
        await panel.evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)))
        const measure=()=>panel.evaluate(el=>{
          const rect=el.getBoundingClientRect(),style=getComputedStyle(el)
          const heading=el.querySelector('h2').getBoundingClientRect()
          const controls=[...el.querySelectorAll('button')].map(button=>button.getBoundingClientRect())
          const iconEl=el.querySelector('[class*="headerIcon"]'),icon=iconEl.getBoundingClientRect(),close=el.querySelector('button[aria-label="閉じる"]'),closeRect=close.getBoundingClientRect(),closeStyle=getComputedStyle(close)
          return {background:style.backgroundColor,radius:style.borderTopLeftRadius,shadow:style.boxShadow,
            bounds:rect.left>=0&&rect.top>=0&&rect.right<=innerWidth&&rect.bottom<=innerHeight,
            heading:heading.top>=rect.top&&heading.bottom<=rect.bottom,icon:icon.width,iconRadius:getComputedStyle(iconEl).borderRadius,
            closeRound:parseFloat(closeStyle.borderRadius)>=Math.min(closeRect.width,closeRect.height)/2,
            controls:controls.every(b=>b.left>=rect.left&&b.right<=rect.right&&b.top>=rect.top&&b.bottom<=rect.bottom)}
        })
        let geometry
        await expect.poll(async()=>{geometry=await measure();return geometry.radius},{message:`${name}: 窓の角丸`}).toBe('16px')
        assert.equal(geometry.bounds,true,`${name}: ${JSON.stringify(geometry)}`)
        assert.equal(geometry.heading,true,name);assert.equal(geometry.controls,true,name)
        assert.equal(geometry.radius,'16px',`${name}: ${JSON.stringify(geometry)}`);assert.equal(geometry.icon,32)
        assert.ok(parseFloat(geometry.iconRadius)>=16);assert.equal(geometry.closeRound,true)
        assert.equal(geometry.background,'rgb(255, 255, 255)');assert.notEqual(geometry.shadow,'none')
        if(name!=='引き出し'){
          const cancel=panel.getByRole('button',{name:'キャンセル',exact:true});
          await page.keyboard.press('Tab');await cancel.focus();
          await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
          await cancel.evaluate(el=>Promise.all(el.getAnimations().map(animation=>animation.finished)))
          const focus=await cancel.evaluate(el=>({width:getComputedStyle(el).outlineWidth,color:getComputedStyle(el).outlineColor}));
          assert.equal(focus.width,'2px');assert.equal(focus.color,'rgb(37, 99, 235)',name);
        }
        await panel.getByRole('button',{name:'閉じる',exact:true}).click()
        await panel.waitFor({state:'detached'})
      }
    }finally{await browser.close()}
  })
}

for (const width of [1152,1440]) {
  test(`知らせの［×］を操作のボタンと縦の真ん中でそろえる（題が1行でも2行でも） ${width}`,async()=>{
    const browser=await connectGuardBrowser()
    try{
      const page=await browser.newPage({reducedMotion:'reduce'})
      await mount(page,width)
      const measure=()=>page.locator('#notices').evaluate(root=>[...root.querySelectorAll('[data-design-part="notice"]')].map(notice=>{
        const close=notice.querySelector('button[aria-label="通知を閉じる"]')
        const actions=[...notice.querySelectorAll('[class*="action"] [data-shared-button]')]
        const center=el=>{const r=el.getBoundingClientRect();return r.top+r.height/2}
        const heading=notice.querySelector('[class*="heading"]')
        return {lines:heading?Math.round(heading.getBoundingClientRect().height/parseFloat(getComputedStyle(heading).lineHeight)):0,
          offsets:actions.map(button=>center(close)-center(button))}
      }))
      const rows=await measure()
      assert.equal(rows.length,4)
      assert.ok(rows.some(row=>row.lines>=2),JSON.stringify(rows))
      assert.ok(rows.every(row=>row.offsets.length>0&&row.offsets.every(offset=>Math.abs(offset)<=0.5)),JSON.stringify(rows))
      // ［×］を2pxずらすと、この計測が見逃さないことを確かめる。
      await page.locator('#notices button[aria-label="通知を閉じる"]').first().evaluate(el=>{el.style.position='relative';el.style.top='-2px'})
      assert.ok((await measure()).some(row=>row.offsets.some(offset=>Math.abs(offset)>0.5)))
    }finally{await browser.close()}
  })
}

for (const stripWidth of [852,1140]) {
  test(`数のカードは札があっても題と補足を切らず、札は題・数字と重ならない（帯の幅 ${stripWidth}）`,async()=>{
    const browser=await connectGuardBrowser()
    try{
      const page=await browser.newPage({reducedMotion:'reduce'})
      await mount(page,1440)
      const measure=()=>page.locator(`[data-kpi-fixture="${stripWidth}"]`).evaluate(root=>[...root.querySelectorAll('[data-kpi-strip] > [data-design-version]')].map(card=>{
        const box=el=>el?.getBoundingClientRect()
        // 「…」で省略している（text-overflow: ellipsis で中身が入り切らない）要素があれば切れている。
        const cut=el=>!!el&&[el,...el.querySelectorAll('*')].some(node=>getComputedStyle(node).textOverflow==='ellipsis'&&node.scrollWidth>node.clientWidth+1)
        const text=card.querySelector('[data-kpi-label] [data-help-trigger] > span')??card.querySelector('[data-kpi-label]')
        const badge=box(card.querySelector('[data-kpi-badge]')),label=box(text),number=box(card.querySelector('[data-kpi-value]'))
        const hit=(a,b)=>!!a&&!!b&&a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top
        const note=card.querySelector('[data-kpi-detail] > span:first-child')
        return {labelCut:cut(card.querySelector('[data-kpi-label]'))||(!!label&&box(card).right<label.right),noteCut:cut(note),
          overlap:hit(badge,label)||hit(badge,number),inside:!badge||badge.right<=box(card).right,
          link:card.querySelector('[data-kpi-detail] a')?getComputedStyle(card.querySelector('[data-kpi-detail] a')).color:null}
      }))
      const rows=await measure()
      assert.equal(rows.length,4)
      assert.ok(rows.every(row=>!row.labelCut&&!row.noteCut&&!row.overlap&&row.inside),JSON.stringify(rows))
      // 行き先「〇〇へ →」は文字のリンクの決まり（緑）。
      assert.ok(rows.filter(row=>row.link).length===3&&rows.every(row=>!row.link||row.link==='rgb(8, 122, 62)'),JSON.stringify(rows))
      // 札を題の上へ重ねると、この計測が見逃さないことを確かめる。
      await page.locator(`[data-kpi-fixture="${stripWidth}"] [data-kpi-badge]`).first().evaluate(el=>{const label=el.closest('[data-design-version]').querySelector('[data-kpi-label]').getBoundingClientRect();Object.assign(el.style,{position:'fixed',left:`${label.left}px`,top:`${label.top}px`})})
      assert.ok((await measure()).some(row=>row.overlap))
    }finally{await browser.close()}
  })
}

test('窓の角丸が欠けたままなら描画待ちでも失敗し、復元後に通る',async()=>{
  const browser=await connectGuardBrowser()
  try{
    const page=await browser.newPage({reducedMotion:'reduce'})
    await mount(page,1152)
    await page.getByRole('button',{name:'通常',exact:true}).click()
    const panel=page.getByRole('dialog',{name:'新しく作る'})
    const radius=()=>panel.evaluate(el=>getComputedStyle(el).borderTopLeftRadius)
    await expect.poll(radius).toBe('16px')
    const fault=await page.addStyleTag({content:'[aria-modal="true"]{border-top-left-radius:0px!important}'})
    await expect.poll(radius).toBe('0px')
    await assert.rejects(expect.poll(radius,{timeout:300}).toBe('16px'))
    await fault.evaluate(el=>el.remove())
    await expect.poll(radius).toBe('16px')
  }finally{await browser.close()}
})

for(const reducedMotion of ['reduce','no-preference']) {
  test(`窓と探す窓は動きを減らす設定を守り、閉じかけでも開き直せる ${reducedMotion}`,async()=>{
    const browser=await connectGuardBrowser()
    try {
      const page=await browser.newPage({reducedMotion})
      await mount(page,1440)
      await page.getByRole('button',{name:'通常',exact:true}).click()
      const panel=page.getByRole('dialog',{name:'新しく作る'})
      const motion=await panel.evaluate(el=>({duration:getComputedStyle(el).transitionDuration,properties:getComputedStyle(el).transitionProperty,blur:getComputedStyle(el.parentElement).backdropFilter}))
      assert.equal(motion.blur,'blur(4px)')
      if(reducedMotion==='no-preference') { assert.equal(motion.duration,'0.2s, 0.2s'); assert.equal(motion.properties,'opacity, transform') }
      else assert.ok(motion.duration.split(',').every(value=>parseFloat(value)<0.001))
      await panel.getByRole('button',{name:'閉じる',exact:true}).click()
      await page.getByRole('button',{name:'通常',exact:true}).click()
      await panel.waitFor()
      assert.equal(await panel.getByLabel('名前',{exact:true}).inputValue(),'保持する名前')
      await panel.getByRole('button',{name:'閉じる',exact:true}).click()
      await panel.waitFor({state:'detached'})
      await page.keyboard.press('Control+k')
      const palette=page.getByRole('dialog',{name:'機能と友だちを探す'})
      await palette.waitFor()
      assert.equal(await palette.evaluate(el=>getComputedStyle(el).borderRadius),'16px')
      await page.getByRole('textbox',{name:'機能と友だちを探す',exact:true}).fill('友だち')
      assert.equal(await page.getByRole('option',{name:'友だち一覧'}).count(),1)
      await page.keyboard.press('Escape'); await page.keyboard.press('Control+k')
      await palette.waitFor()
      await page.keyboard.press('Escape'); await palette.waitFor({state:'detached'})
    } finally {await browser.close()}
  })
}
