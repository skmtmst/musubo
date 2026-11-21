import { afterEach, beforeAll, expect, it, vi } from 'vitest'

let fetchApi: typeof import('./request').fetchApi
beforeAll(async () => { process.env.NEXT_PUBLIC_API_URL='https://worker.example.com'; ({fetchApi}=await import('./request')) })
afterEach(() => vi.unstubAllGlobals())

it('共通情報の422は名前を画面に渡し、ほかの422はdataを渡さない', async () => {
    const variables = [{key:'hours',displayName:'営業時間'}]
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success:false, code:'COMMON_VAR_UNRESOLVED', error:'共通情報を解決できません: {{var.hours}}', data:{variables},
    }), {status:422,headers:{'Content-Type':'application/json'}})))
    await expect(fetchApi('/api/example', {method:'POST'})).rejects.toMatchObject({status:422,code:'COMMON_VAR_UNRESOLVED',data:{variables}})
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({success:false,code:'OTHER',error:'入力を確認してください',data:{variables}}), {status:422})))
    await expect(fetchApi('/api/example', {method:'POST'})).rejects.toMatchObject({status:422,code:'OTHER',data:undefined})
  })
