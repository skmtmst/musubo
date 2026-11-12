import { afterEach, it, expect, vi } from 'vitest';
vi.mock('./liff-auth.js',()=>({getIdToken:()=> '本人確認',getLiffId:()=> 'shop-liff'}));
import { restaurantBookingApi } from './api.js';
afterEach(()=>vi.unstubAllGlobals());
it('予約の任意欄を本人確認付きで送り、確定時の省略と明示的な空欄を区別する',async()=>{
  vi.stubGlobal('window',{location:{origin:'https://example.test'}});
  const fetcher=vi.fn(async()=>Response.json({success:true,data:{id:'reservation'}}));
  vi.stubGlobal('fetch',fetcher);
  await restaurantBookingApi.hold({storeId:'store',startsAt:'2027-10-01T03:00:00Z',guestCount:2,requestId:'request_test',note:'窓際を希望',customerPhone:'090-0000-5678'});
  await restaurantBookingApi.confirm('予約/1',1,{note:'',customerPhone:null});
  await restaurantBookingApi.confirm('予約/1',1);
  const calls=fetcher.mock.calls as unknown as [URL,RequestInit][];
  expect(JSON.parse(String(calls[0][1].body))).toMatchObject({note:'窓際を希望',customerPhone:'090-0000-5678'});
  expect(new URL(String(calls[1][0])).pathname).toBe('/api/liff/restaurant/reservations/%E4%BA%88%E7%B4%84%2F1/confirm');
  expect(new URL(String(calls[1][0])).searchParams.get('liffId')).toBe('shop-liff');
  expect(calls[1][1].headers).toMatchObject({Authorization:'Bearer 本人確認'});
  expect(JSON.parse(String(calls[1][1].body))).toEqual({expectedVersion:1,note:'',customerPhone:null});
  expect(JSON.parse(String(calls[2][1].body))).toEqual({expectedVersion:1});
});
