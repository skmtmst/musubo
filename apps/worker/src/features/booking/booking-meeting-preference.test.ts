import {afterEach,beforeEach,expect,it} from 'vitest';
import {gapFixture} from '../../test-utils/gap1.js';
import {preferredMeetingProvider,setPreferredMeetingProvider} from './booking-meeting-preference.js';
let d:ReturnType<typeof gapFixture>;
beforeEach(()=>{d=gapFixture();});
afterEach(()=>d.raw.close());
function connect(id:string,provider:string,created:string){
 d.raw.prepare(`INSERT INTO booking_meeting_connections (id,line_account_id,staff_id,provider,credential_enc,connected_by,created_at,updated_at)
 VALUES (?,'a','bs',?,'ciphertext','o',?,?)`).run(id,provider,created,created);
}
it('接続が一つならそのサービスを使い、複数なら最初に接続したサービスを使う',async()=>{
 expect(await preferredMeetingProvider(d.db,{accountId:'a',staffId:'bs'})).toBeNull();
 connect('z','zoom','2026-01-01');
 expect(await preferredMeetingProvider(d.db,{accountId:'a',staffId:'bs'})).toBe('zoom');
 connect('t','teams','2026-01-02');
 expect(await preferredMeetingProvider(d.db,{accountId:'a',staffId:'bs'})).toBe('zoom');
});
it('担当者が接続済みのサービスを選べ、別の店や未接続のサービスは選べない',async()=>{
 connect('z','zoom','2026-01-01');connect('t','teams','2026-01-02');
 expect(await setPreferredMeetingProvider(d.db,{accountId:'a',staffId:'bs',provider:'teams'})).toBe(true);
 expect(await preferredMeetingProvider(d.db,{accountId:'a',staffId:'bs'})).toBe('teams');
 expect(await setPreferredMeetingProvider(d.db,{accountId:'a',staffId:'bs',provider:'google_meet'})).toBe(false);
 expect(await setPreferredMeetingProvider(d.db,{accountId:'b',staffId:'bs',provider:'teams'})).toBe(false);
 expect(await preferredMeetingProvider(d.db,{accountId:'b',staffId:'bs'})).toBeNull();
});
