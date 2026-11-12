import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

let api:typeof import('./api').api
beforeAll(async()=>{process.env.NEXT_PUBLIC_API_URL='https://worker.example.com';({api}=await import('./api'))})
afterEach(()=>vi.unstubAllGlobals())

describe('リッチメニュー画像の確認世代',()=>{
  it('画像保存の世代を送り、新しい世代を受け取る',async()=>{
    const fetchSpy=vi.fn(async()=>new Response(JSON.stringify({success:true,data:{imageR2Key:'image',imageContentType:'image/png',size:'large',publishingGeneration:4}}),{status:200,headers:{'content-type':'application/json'}}));
    vi.stubGlobal('fetch',fetchSpy);
    const result=await api.richMenuGroups.uploadImage('group','page',new File(['image'],'image.png',{type:'image/png'}),3);
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/api/rich-menu-groups/group/pages/page/image?expectedGeneration=3');
    expect(result.data.publishingGeneration).toBe(4);
  });
})
