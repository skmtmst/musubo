import { PERMISSION_LOCK_SUMMARY } from '@/components/shared/permission-lock'
// @vitest-environment happy-dom
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import { richVideoContent, richVideoDraftError, type RichVideoDraft } from './rich-video-core'
import { messageTemplateToBubble, bubbleLegacyMessage, assetBubbleError } from '@/lib/broadcast-template'
const mocks=vi.hoisted(()=>({role:'owner',account:'a',folders:vi.fn(),get:vi.fn(),create:vi.fn(),update:vi.fn(),push:vi.fn(),disarm:vi.fn(),guarded:vi.fn((action:()=>void)=>action())}))
vi.mock('next/navigation',()=>({useRouter:()=>({push:mocks.push}),usePathname:()=>'/templates/edit',useSearchParams:()=>new URLSearchParams('kind=rich_video')}))
vi.mock('@/lib/staff-role',()=>({useStaffRole:()=>mocks.role,canManageRole:(role:string)=>role==='owner'||role==='admin'}))
vi.mock('@/contexts/account-context',()=>({useAccount:()=>({selectedAccountId:mocks.account,accounts:[{id:'a',name:'本店'}]})}))
vi.mock('@/components/shell/page-chrome',()=>({usePageTitle:()=>{},usePageCrumbs:()=>{}}))
vi.mock('@/lib/use-unsaved-guard',()=>({useUnsavedGuard:()=>({leaveTarget:null,disarm:mocks.disarm,guarded:mocks.guarded})}))
vi.mock('@/lib/unsaved-leave-dialog',()=>({UnsavedLeaveDialog:()=>null}))
vi.mock('@/lib/api',()=>({api:{templates:{get:mocks.get,create:mocks.create,update:mocks.update},folders:{list:mocks.folders}}}))
vi.mock('./rich-video-core', async original => ({...await original<typeof import('./rich-video-core')>(),videoPreviewFile:vi.fn(async()=>({file:new File(['preview'],'preview.jpg',{type:'image/jpeg'}),height:520}))}))
import Editor from './rich-video'
import type { TemplateEditHost } from './host'
const draft:RichVideoDraft={name:'動画',folderId:'',originalContentUrl:'https://worker.example/images/video.mp4',previewImageUrl:'https://worker.example/images/preview.jpg',height:520,buttonEnabled:true,actionLabel:'詳しく見る',actionUrl:'https://example.com/menu',altText:'新しい動画です'}
function stored(button=true){return {...richVideoContent({...draft,buttonEnabled:button}),baseUrl:'https://worker.example/images/imagemaps/map'}}
beforeEach(()=>{vi.clearAllMocks();mocks.role = verifiedStaffRole('owner');mocks.account='a';mocks.folders.mockReset().mockResolvedValue({success:true,data:[]});mocks.get.mockResolvedValue({success:true,data:{id:'r',accountId:'a',name:'動画',messageType:'imagemap',messageContent:JSON.stringify(stored()),publishedVersion:1,draftRevision:0}});mocks.update.mockResolvedValue({success:true,data:{id:'r'}})})
afterEach(cleanup)
it('動画のプレビューは配信日時を決めつけない', () => {
  render(<Editor />)
  expect(screen.queryByText('配信日 10:00')).toBeNull()
  expect(screen.getByText('今日')).toBeTruthy()
})

describe('リッチビデオ編集',()=>{
 it('アカウント切替後に前のフォルダを出さず、遅い応答を捨てる',async()=>{
  let resolveOld!: (value: unknown) => void
  const old = new Promise(resolve => { resolveOld = resolve })
  mocks.folders.mockReturnValueOnce(old).mockResolvedValueOnce({success:true,data:[{id:'new',name:'新しい店のフォルダ'}]})
  const view=render(<Editor />)
  expect((screen.getByRole('button',{name:'フォルダ'}) as HTMLButtonElement).disabled).toBe(true)
  mocks.account='b';view.rerender(<Editor />)
  await waitFor(()=>expect(mocks.folders).toHaveBeenCalledTimes(2))
  await act(async()=>resolveOld({success:true,data:[{id:'old',name:'前の店のフォルダ'}]}))
  fireEvent.click(screen.getByRole('button',{name:'フォルダ'}))
  expect(await screen.findByText('新しい店のフォルダ')).toBeTruthy()
  expect(screen.queryByText('前の店のフォルダ')).toBeNull()
 })
 it('フォルダの取得失敗を知らせ、再取得できる',async()=>{
  mocks.folders.mockResolvedValueOnce({success:false}).mockResolvedValueOnce({success:true,data:[{id:'folder-1',name:'動画用'}]})
  render(<Editor />)
  await screen.findByText(/フォルダを読み込めませんでした/)
  fireEvent.click(screen.getByRole('button',{name:'もう一度読み込む'}))
  await waitFor(()=>expect(mocks.folders).toHaveBeenCalledTimes(2))
  await waitFor(()=>expect(screen.queryByText(/フォルダを読み込めませんでした/)).toBeNull())
 })

 it('統括は店を選ばず取り込み、ひな形の口へ保存して配る（Ni0V8）',async()=>{
  mocks.account='';
  const video={id:'video',kind:'video' as const,filename:'video.mp4',mimeType:'video/mp4',sizeBytes:3,width:null,height:null,durationMs:1000,r2Key:'hq-templates/tenant/uploads/video.mp4',publicUrl:draft.originalContentUrl,versionId:'video-v',versionNo:1,contentHash:'a'.repeat(64)}
  const image={...video,id:'preview',kind:'image' as const,mimeType:'image/jpeg',r2Key:'hq-templates/tenant/preview',publicUrl:draft.previewImageUrl,width:1040,height:520}
  const preview={media:[image],payload:{imageUrl:draft.previewImageUrl,baseUrl:'https://worker.example/images/imagemaps/map',baseSize:{width:1040,height:520}}}
  const upload=vi.fn().mockResolvedValue(video),uploadPreview=vi.fn().mockResolvedValue(preview),save=vi.fn(),folder=vi.fn()
  const host:TemplateEditHost={description:'統括のひな形',folders:[{value:'hq-folder',label:'統括の動画'}],folder:'hq-folder',onFolderChange:folder,busy:false,onSave:save,onCancel:vi.fn(),uploadRichVideo:upload,uploadRichVideoPreview:uploadPreview}
  const {container}=render(<Editor host={host}/>);
  fireEvent.change(screen.getByLabelText('テンプレート名'),{target:{value:'新しい動画'}})
  fireEvent.change(container.querySelector('input[type=file]')!,{target:{files:[new File(['mp4'],'video.mp4',{type:'video/mp4'})]}})
  await waitFor(()=>expect(uploadPreview).toHaveBeenCalledOnce())
  await screen.findByText('プレビュー画像も作りました')
  fireEvent.click(screen.getByRole('switch',{name:'見終わったあとのボタンを出す'}))
  fireEvent.change(screen.getByLabelText('通知に出る文'),{target:{value:'動画のお知らせ'}})
  fireEvent.click(screen.getByRole('button',{name:'保存して配る'}))
  await waitFor(()=>expect(save).toHaveBeenCalledOnce())
  const [content,distribute]=save.mock.calls[0]
  expect(distribute).toBe(true);expect(content.kind).toBe('rich_video');expect(content.media).toEqual([video,image])
  expect(JSON.parse(content.messageContent)).toMatchObject({baseUrl:preview.payload.baseUrl,baseSize:{height:520},video:{originalContentUrl:video.publicUrl,previewImageUrl:image.publicUrl}})
  expect(mocks.create).not.toHaveBeenCalled();expect(mocks.update).not.toHaveBeenCalled();expect(mocks.push).not.toHaveBeenCalled()
 })
 it('統括の編集は取り込み済みの画像の組を保持し、下書きも保存できる',async()=>{
  mocks.account='';const save=vi.fn().mockResolvedValue(false)
  const media=[{id:'v',kind:'video' as const,filename:'video.mp4',mimeType:'video/mp4',sizeBytes:3,width:null,height:null,durationMs:1000,r2Key:'hq-templates/tenant/video',publicUrl:draft.originalContentUrl,versionId:'v',versionNo:1,contentHash:'a'.repeat(64)},{id:'p',kind:'image' as const,filename:'preview.jpg',mimeType:'image/jpeg',sizeBytes:3,width:1040,height:520,durationMs:null,r2Key:'hq-templates/tenant/preview',publicUrl:draft.previewImageUrl,versionId:'p',versionNo:1,contentHash:'b'.repeat(64)}]
  const host:TemplateEditHost={description:'',folders:[],folder:'',onFolderChange:()=>{},busy:false,onSave:save,onCancel:vi.fn(),initialContent:{kind:'rich_video',name:'動画',messageContent:JSON.stringify(stored()),media}}
  render(<Editor host={host}/>);await screen.findByDisplayValue('新しい動画です')
  fireEvent.change(screen.getByLabelText('通知に出る文'),{target:{value:'直した通知'}})
  fireEvent.click(screen.getByRole('button',{name:'下書きを保存'}))
  await waitFor(()=>expect(save).toHaveBeenCalledOnce())
  expect(save.mock.calls[0][1]).toBe(false);expect(save.mock.calls[0][0].media).toEqual(media)
  expect(JSON.parse(save.mock.calls[0][0].messageContent).baseUrl).toBe(stored().baseUrl)
  expect(mocks.disarm).not.toHaveBeenCalled();expect(mocks.get).not.toHaveBeenCalled()
 })

 it('引用した動画はテンプレートを更新せず入れ直せる。入れ直しが失敗したときは変更を残す',async()=>{
  const insert=vi.fn().mockResolvedValue(false);const cancel=vi.fn()
  const host:TemplateEditHost={composer:{index:2,accountId:'a'},description:'',folders:[],folder:'',onFolderChange:()=>{},busy:false,onSave:insert,onCancel:cancel,initialContent:{kind:'message',name:'動画',messageType:'imagemap',messageContent:JSON.stringify(stored())}}
  render(<Editor host={host}/>);await screen.findByDisplayValue('新しい動画です')
  fireEvent.change(screen.getByLabelText('通知に出る文'),{target:{value:'この配信だけの通知'}})
  fireEvent.click(screen.getByRole('button',{name:'この吹き出しに入れる'}))
  await waitFor(()=>expect(insert).toHaveBeenCalledTimes(1))
  expect(JSON.parse(insert.mock.calls[0][0].messageContent).altText).toBe('この配信だけの通知')
  expect(mocks.create).not.toHaveBeenCalled();expect(mocks.update).not.toHaveBeenCalled();expect(mocks.disarm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'キャンセル',exact:true}));expect(mocks.guarded).toHaveBeenCalledWith(cancel)
 })
 it('読み直した値を表示し、ボタンを外して通知文を更新して保存する',async()=>{
  render(<Editor id="r"/>);await screen.findByDisplayValue('新しい動画です');
  fireEvent.click(screen.getByRole('switch',{name:'見終わったあとのボタンを出す'}));
  expect(screen.queryByLabelText('リンク先URL')).toBeNull();
  fireEvent.change(screen.getByLabelText('通知に出る文'),{target:{value:'新しい通知'}});
  fireEvent.click(screen.getByRole('button',{name:'保存する'}));
  await waitFor(()=>expect(mocks.update).toHaveBeenCalled());
  const content=JSON.parse(mocks.update.mock.calls[0][1].messageContent);
  expect(content.altText).toBe('新しい通知');expect(content.video.externalLink).toBeUndefined();expect(content.video.originalContentUrl).toBe(draft.originalContentUrl);
  await waitFor(()=>expect((screen.getByRole('button',{name:'保存する'}) as HTMLButtonElement).disabled).toBe(false));
  expect(mocks.push).not.toHaveBeenCalled();
  expect((screen.getByLabelText('通知に出る文') as HTMLInputElement).value).toBe('新しい通知');
 });
 it('閲覧のみには保存・アップロード・スイッチを出さない',async()=>{
  mocks.role = verifiedStaffRole('staff');render(<Editor id="r"/>);await screen.findByDisplayValue('新しい動画です');
  expect(screen.getByRole('status').textContent).toContain(PERMISSION_LOCK_SUMMARY.feature);expect(screen.queryByRole('button',{name:'保存する'})).toBeNull();expect(screen.queryByRole('button',{name:'ファイルを選ぶ'})).toBeNull();expect(screen.queryByRole('checkbox')).toBeNull();expect(screen.queryByRole('switch')).toBeNull();
 });
 it('読み込み失敗時に保存せず、別アカウントに切り替えても保存しない',async()=>{
  mocks.get.mockRejectedValue(new Error('failed'));const {unmount}=render(<Editor id="r"/>);await screen.findByRole('alert');expect((screen.getByRole('button',{name:'保存する'}) as HTMLButtonElement).disabled).toBe(true);unmount();
  mocks.account='b';mocks.get.mockResolvedValue({success:true,data:{id:'r',accountId:'a',name:'動画',messageType:'imagemap',messageContent:JSON.stringify(stored())}});render(<Editor id="r"/>);await screen.findByDisplayValue('新しい動画です');expect((screen.getByRole('button',{name:'保存する'}) as HTMLButtonElement).disabled).toBe(true);
 });
 it('必須が空なら主保存を止め、入力に応じて不足理由を切り替える',async()=>{
  render(<Editor/>);
  const save=screen.getByRole('button',{name:'保存する'}) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  expect(screen.getByText('テンプレート名を入力してください。')).toBeTruthy();
  fireEvent.click(save);expect(mocks.create).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('テンプレート名'),{target:{value:'動画'}});
  expect(save.disabled).toBe(true);expect(screen.getByText('動画を選んでください。')).toBeTruthy();
  expect(screen.queryByText('テンプレート名を入力してください。')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
 });
 it('値のあるURLの形式誤りは保存時にその欄へ知らせる',async()=>{
  render(<Editor id="r"/>);await screen.findByDisplayValue('新しい動画です');
  const input=screen.getByLabelText('リンク先URL');fireEvent.change(input,{target:{value:'javascript:bad'}});
  const save=screen.getByRole('button',{name:'保存する'}) as HTMLButtonElement;expect(save.disabled).toBe(false);
  fireEvent.click(save);await waitFor(()=>expect(document.activeElement).toBe(input));
  expect(input.getAttribute('aria-invalid')).toBe('true');expect(mocks.update).not.toHaveBeenCalled();
 });
 it('ボタン無しはURL不要、URL不正と通知文超過は拒否する',()=>{
  expect(richVideoDraftError({...draft,buttonEnabled:false,actionUrl:''})).toBeNull();
  expect(richVideoDraftError({...draft,actionUrl:'javascript:alert(1)'})).toContain('HTTPS');
  expect(richVideoDraftError({...draft,altText:'あ'.repeat(1501)})).toContain('1,500');
 });
 it('テンプレート引用はrich_videoの中身と通知を保ち、imagemapで保存する',()=>{
  const content=stored(false);const bubble=messageTemplateToBubble({id:'r',name:'動画',category:'general',messageType:'imagemap',messageContent:JSON.stringify(content)})!;
  expect(bubble.type).toBe('rich_video');expect(assetBubbleError(bubble)).toBe('');expect(JSON.parse(bubbleLegacyMessage(bubble).messageContent).video).toEqual(content.video);expect(bubbleLegacyMessage(bubble).messageType).toBe('imagemap');
 });
})

afterEach(() => { verifiedStaffRole(null) })
