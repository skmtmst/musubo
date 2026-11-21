import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import {gapApp,gapFixture,seedGapBooking} from '../test-utils/gap1.js';
import {useSqliteClock} from '../test-utils/sqlite-clock.js';
import {bookingGap3} from './booking-gap3.js';
const caller=vi.hoisted(()=>({friend:'f'}));
vi.mock('./booking.js',async original=>({...await original<object>(),resolveAccountIdFromLiff:async()=> 'a',verifyCallerLineUserId:async()=> 'Uf',resolveFriendId:async()=>caller.friend}));
let d:ReturnType<typeof gapFixture>;
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-20T00:00:00Z'));d=gapFixture();useSqliteClock(d.raw,()=>new Date());caller.friend='f';
 d.raw.exec("INSERT INTO booking_groups(id,line_account_id,friend_id,created_at,idempotency_key,request_json) VALUES('g','a','f','2026-11-16','key','{}')");seedGapBooking(d,'bk','confirmed','2026-11-20T05:00:00Z');d.raw.exec("UPDATE bookings SET group_id='g' WHERE id='bk'");vi.stubGlobal('fetch',vi.fn(()=>{throw Error('external_forbidden')}));});
afterEach(()=>{d.raw.close();vi.useRealTimers();vi.unstubAllGlobals()});
test('B5-10: 本人だけが組の取消料金を事前に確認できる',async()=>{
 const app=gapApp(d,[bookingGap3]),path='/api/liff/booking/groups/g/cancellation-quote';
 expect((await app.request(path)).status).toBe(200);caller.friend='f2';expect((await app.request(path)).status).toBe(404);expect(fetch).not.toHaveBeenCalled();
});
