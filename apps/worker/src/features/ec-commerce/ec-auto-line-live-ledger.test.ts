import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { gapFixture } from '../../test-utils/gap1.js';
import { scheduleLiveIntent, sendLiveIntent, type LiveIntent } from './ec-auto-line-live-ledger.js';

let fixture: ReturnType<typeof gapFixture>;
const now = new Date('2026-10-17T01:00:00.000Z');
const intent: LiveIntent = {id:'intent',accountId:'a',kind:'cart',occurrenceKey:'event',friendId:'f',productId:'p',dueAt:now.toISOString(),payload:'[]'};
beforeEach(() => { fixture = gapFixture(); });
afterEach(() => { fixture.raw.close(); });
it('同じ起点と友だちの予定は一つだけにし、受理後に送信済みとする', async () => {
 expect(await scheduleLiveIntent(fixture.db,intent,now)).toBe(true);
 expect(await scheduleLiveIntent(fixture.db,{...intent,id:'duplicate'},now)).toBe(false);
 const send=vi.fn(async()=>undefined);
 expect(await sendLiveIntent(fixture.db,intent,send,now)).toBe('sent');
 expect(await sendLiveIntent(fixture.db,intent,send,now)).toBe('unclaimed');
 expect(send).toHaveBeenCalledTimes(1);
 expect(fixture.raw.prepare('SELECT state FROM ec_auto_line_live_intents').get()).toEqual({state:'sent'});
});
it('応答が不明なら再送しない',async()=>{
 await scheduleLiveIntent(fixture.db,intent,now);
 const send=vi.fn(async()=>{throw new Error('connection lost');});
 expect(await sendLiveIntent(fixture.db,intent,send,now)).toBe('unknown');
 expect(await sendLiveIntent(fixture.db,intent,send,now)).toBe('unclaimed');
 expect(send).toHaveBeenCalledTimes(1);
});
