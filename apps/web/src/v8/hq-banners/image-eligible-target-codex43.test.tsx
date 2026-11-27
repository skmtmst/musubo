// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BannerImageDetailV8 } from './image-detail'
afterEach(cleanup)
it.each(['archive','delivered'])('選択したアカウントが %s になったら配布対象から外す',async mode=>{
 const image={id:'img',projectId:'p',sequence:1,isFavorite:false,source:'generated',createdAt:'2026-10-01T00:00:00Z',media:{id:'m',filename:'sample.png',mimeType:'image/png',sizeBytes:100,width:100,height:100,url:'https://example.invalid/sample.png'},generation:null,deliveredAccountIds:[] as string[]}
 const account={id:'a',name:'見本店',archivedAt:null,basicId:'sample',channelId:null,tags:[]};const deliver=vi.fn(async()=>false)
 const props={presets:[],canManage:true,onClose:vi.fn(),onToggleFavorite:vi.fn(),onDeliver:deliver,onRemove:async()=>false}
 const view=render(<BannerImageDetailV8 {...props} image={image as never} accounts={[account] as never} />)
 fireEvent.click(screen.getByRole('button',{name:'配るアカウント：選ぶ'}));const dialog=await screen.findByRole('dialog',{name:'配るアカウントを選ぶ'})
 fireEvent.click(within(dialog).getByRole('checkbox',{name:'見本店'}));fireEvent.click(within(dialog).getByRole('button',{name:'選ぶ（1件）'}))
 expect((screen.getByRole('button',{name:'1アカウントへ配る'}) as HTMLButtonElement).disabled).toBe(false)
 const changedImage=mode==='delivered'?{...image,deliveredAccountIds:['a']}:image
 const changedAccount=mode==='archive'?{...account,archivedAt:'2026-11-27T00:00:00Z'}:account
 view.rerender(<BannerImageDetailV8 {...props} image={changedImage as never} accounts={[changedAccount] as never} />)
 const button=screen.getByRole('button',{name:'0アカウントへ配る'}) as HTMLButtonElement
 expect(button.disabled).toBe(true);fireEvent.click(button);expect(deliver).not.toHaveBeenCalled()
 view.rerender(<BannerImageDetailV8 {...props} image={image as never} accounts={[account] as never} />)
 expect((screen.getByRole('button',{name:'0アカウントへ配る'}) as HTMLButtonElement).disabled).toBe(true)
})
