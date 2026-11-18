import { readFileSync } from 'node:fs';
import { readImplementationSource } from '../../test-utils/implementation-source.js';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const source = (path: string) => readImplementationSource(join(ROOT, path));
// 薄い入口が実際に読む機能モジュールだけをたどる。登録を外した故障も元どおり落とす。
function routeSource(feature: 'booking' | 'events'): string {
  const directory=resolve(ROOT,'routes',feature)+sep,seen=new Set<string>();
  const visit=(file:string):string=>{
    if(seen.has(file))return '';seen.add(file);
    const text=readFileSync(file,'utf8');
    return text+'\n'+[...text.matchAll(/from ['"]([^'"]+\.js)['"]/g)].map(match=>{
      const target=resolve(dirname(file),match[1].replace(/\.js$/,'.ts'));
      return target.startsWith(directory)?visit(target):'';
    }).join('\n');
  };
  return visit(resolve(ROOT,'routes',feature+'.ts'));
}

describe('オートメーションの発生元配線', () => {
  it('予約は確定経路だけが予約IDで発火する', () => {
    const salon = routeSource('booking');
    const event = routeSource('events');
    const confirmed = source('features/booking/booking-confirmed-effects.ts');
    const payment = source('features/booking/booking-payment-recovery.ts');
    // 新規・承認・代理登録と決済回収は、同じ確定処理の入口を通る。
    expect(salon.match(/await runConfirmedBookingSideEffects\(/g)).toHaveLength(3);
    expect(payment).toContain('await runConfirmedBookingSideEffects(');
    expect(confirmed.match(/dispatchAutomationEventWithLogging\(db,/g)).toHaveLength(1);
    expect(confirmed).toContain(`eventType: 'calendar_booked'`);
    expect(event.match(/eventType: 'calendar_booked'/g)).toHaveLength(3);
    expect(confirmed).toContain(`sourceEventId: bookingId`);
    expect(salon).toContain(`sourceEventId: id`);
    expect(event).toContain(`sourceEventId: booking.id`);
    expect(event).toContain(`sourceEventId: result.bookingId`);
  });
});
