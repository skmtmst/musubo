import { expect, it, vi } from 'vitest';
import { createTestD1 } from '../../test-utils/d1-sqlite.js';
import { broadcastWideContext } from './broadcast-wide-context.js';

it('配信前に共通情報を解決し、無い値は空文字にしない', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
  const sql = createTestD1({ now: () => new Date() });
  try {
    sql.raw.prepare("INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret) VALUES('account','店','ch','token','secret')").run();
    const context = () => broadcastWideContext(sql.db, 'account', '営業時間: {{var.hours}}', undefined, 'broadcast');
    await expect(context()).rejects.toThrow('common_var_unresolved');
    expect(sql.raw.prepare('SELECT source_kind,source_id,var_key,reason FROM common_var_resolution_failures').all())
      .toEqual([{ source_kind: 'broadcast', source_id: 'broadcast', var_key: 'hours', reason: 'missing' }]);
    sql.raw.prepare("INSERT INTO common_vars(id,line_account_id,name,var_key,type,value) VALUES('v','account','営業時間','hours','text','10時')").run();
    expect(await context()).toMatchObject({ vars: { hours: '10時' }, deliveredAt: new Date('2026-11-17T00:00:00Z') });
    expect(await broadcastWideContext(sql.db, 'account', '{{var.hours}}', { hours: '固定' }, 'broadcast')).toMatchObject({ vars: { hours: '固定' } });
  } finally { sql.raw.close(); vi.useRealTimers(); }
});
