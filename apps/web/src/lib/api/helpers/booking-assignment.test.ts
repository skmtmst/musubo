import { afterEach, describe, expect, it, vi } from 'vitest';
import { bookingAssignmentApi } from './booking-assignment';
afterEach(() => vi.unstubAllGlobals());
describe('割り当て設定の画面向けAPI関数', () => {
  it('自動配席は店舗とアカウントを指定して単一スイッチと版だけ保存する',async()=>{
    const fetchMock=vi.fn(async()=>Response.json({success:true,data:{enabled:false,version:1}}));vi.stubGlobal('fetch',fetchMock);
    await bookingAssignmentApi.getTableAutomation('a & b','store/1');
    await bookingAssignmentApi.saveTableAutomation('a & b','store/1',{enabled:false,expectedVersion:0});
    const [url,init]=fetchMock.mock.calls[1] as unknown as [string,RequestInit];
    expect(url).toContain('/table-auto-assignment-settings?account_id=a%20%26%20b&storeId=store%2F1');
    expect(JSON.parse(init.body as string)).toEqual({enabled:false,expectedVersion:0});
  });
  it('人と卓の読み取りでアカウント・店舗をエンコードする', async () => {
    const payload = { success: true, data: { storageReady: false, effectiveMethod: 'legacy_first' } };
    const fetchMock = vi.fn(async () => Response.json(payload)); vi.stubGlobal('fetch', fetchMock);
    expect(await bookingAssignmentApi.get('a & b')).toEqual(payload);
    expect(await bookingAssignmentApi.getTables('a & b', 'store/1')).toEqual(payload);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain('/api/booking/admin/assignment-settings?account_id=a%20%26%20b');
    expect((fetchMock.mock.calls[1] as unknown as [string])[0]).toContain('/api/restaurant-test/assignment-settings?account_id=a%20%26%20b&storeId=store%2F1');
  });
  it('保存の方式・上限なし・順序・読み込んだ版を両方の口へ渡す', async () => {
    const fetchMock = vi.fn(async () => Response.json({ success: true, data: {} })); vi.stubGlobal('fetch', fetchMock);
    const input = { method: 'priority' as const, balancePeriod: 'week' as const, expectedVersion: 4,
      resources: [{ resourceId: 'r', priority: 'preferred' as const, dailyLimit: null, sortOrder: 2 }] };
    await bookingAssignmentApi.save('a', input); await bookingAssignmentApi.saveTables('a', 's', input);
    for (const call of fetchMock.mock.calls) {
      const init = (call as unknown as [string, RequestInit])[1];
      expect(init.method).toBe('PUT'); expect(JSON.parse(init.body as string)).toEqual(input);
    }
  });
  it('未移行の保存拒否を成功に変えない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: false, error: 'assignment_storage_not_ready' }, { status: 503 })));
    await expect(bookingAssignmentApi.save('a', { method: 'balanced', balancePeriod: 'day', resources: [], expectedVersion: 0 }))
      .rejects.toThrow();
  });
});
