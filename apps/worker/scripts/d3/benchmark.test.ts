import { test } from 'vitest';
import { performance } from 'node:perf_hooks';
import { createStyleScheduleFixture } from '../../src/test-utils/style-schedule-fixture.js';
import { styleSnapshot } from '../../src/services/style-analytics.js';
import { styleSchedule } from '../../src/services/style-schedule.js';

test('synthetic performance', async () => {
for (const n of [100, 1000, 10000]) {
  const fixture = createStyleScheduleFixture();
  const addFriend = fixture.raw.prepare('INSERT INTO friends(id,line_user_id,line_account_id,display_name) VALUES(?,?,?,?)');
  const addReservation = fixture.raw.prepare("INSERT INTO rt_reservations(id,store_id,source,customer_name,line_uid,guest_count,starts_at,ends_at,status) VALUES(?,'store','line',?,?,2,?,?,'confirmed')");
  fixture.raw.transaction(() => { for (let i=0;i<n;i++) {
    const uid = `synthetic-${i}`; const day = 1 + (i % 90); const start = new Date(Date.UTC(2026, 8, day, 3)); const end = new Date(start.getTime()+3600000);
    addFriend.run(`synthetic-${i}`,uid,'a','架空'); addReservation.run(`synthetic-${i}`,'架空',uid,start.toISOString(),end.toISOString());
  } })();
  const access = { kinds: ['restaurant'] as const };
  const window = { style: 'restaurant' as const, asOf: '2026-11-01T00:00:00Z', timeZone: 'Asia/Tokyo', range: 'today' as const, from: '2026-10-31T15:00:00Z', to: '2026-11-01T15:00:00Z' };
  for (const name of ['summary','schedule'] as const) {
    const elapsed:number[]=[];
    for(let i=0;i<4;i++) { const start=performance.now();
      if(name==='summary') await styleSnapshot(fixture.db,'a','restaurant',{ date:'2026-11-01' },undefined,Date.parse('2026-11-01T00:00:00Z'),{kinds:[...access.kinds]});
      else await styleSchedule(fixture.db,'a',window,{display:'list'},undefined,undefined,{kinds:[...access.kinds]});
      elapsed.push(performance.now()-start);
    }
    process.stdout.write(JSON.stringify({n,name,ms:elapsed.map(v=>Math.round(v*100)/100)})+'\n');
  }
  fixture.raw.close();
}

}, 120000);
