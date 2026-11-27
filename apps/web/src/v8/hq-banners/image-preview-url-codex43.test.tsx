// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { BannerImageDetailV8 } from './image-detail'
afterEach(cleanup)
it('画像を読み込めなかった後、同じ画像の新しい URL を表示する',()=>{
 const image={id:'img',projectId:'p',sequence:1,isFavorite:false,source:'generated',createdAt:'2026-10-01T00:00:00Z',media:{id:'m',filename:'sample.png',mimeType:'image/png',sizeBytes:100,width:100,height:100,url:'https://example.invalid/old.png'},generation:null,deliveredAccountIds:[]}
 const props={presets:[],accounts:[],canManage:true,onClose:vi.fn(),onToggleFavorite:vi.fn(),onDeliver:async()=>false,onRemove:async()=>false}
 const view=render(<BannerImageDetailV8 {...props} image={image as never} />)
 const old=document.querySelector('img[src="https://example.invalid/old.png"]')!
 expect(old).toBeTruthy();fireEvent.error(old);expect(document.querySelector('img[src="https://example.invalid/old.png"]')).toBeNull()
 view.rerender(<BannerImageDetailV8 {...props} image={{...image,media:{...image.media,url:'https://example.invalid/new.png'}} as never} />)
 expect(document.querySelector('img[src="https://example.invalid/new.png"]')).toBeTruthy()
})
