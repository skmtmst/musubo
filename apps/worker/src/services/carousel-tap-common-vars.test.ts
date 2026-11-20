import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { LineClient } from '@line-crm/line-sdk';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { handleCarouselTap } from './carousel-tap.js';

let fixture: SqliteD1;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
  fixture = createTestD1({ now: () => new Date() });
  fixture.raw.exec(`
    INSERT INTO line_accounts(id,name,channel_id,channel_access_token,channel_secret) VALUES('account','店','channel','token','secret');
    INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES ('friend','U1','友だち','account');
    INSERT INTO templates(id,name,message_type,message_content,line_account_id,carousel_tap_limit_mode,carousel_tap_limit_text)
      VALUES ('template','案内','carousel','{}','account','once','営業時間は{{var.hours}}です');
    INSERT INTO carousel_taps(id,template_id,column_index,action_index,friend_id,line_account_id) VALUES ('tap','template',0,0,'friend','account');
  `);
});
afterEach(() => { fixture.raw.close(); vi.useRealTimers(); });

it('回数制限の返信は共通情報を解決し、存在しなければ送らない', async () => {
  const replyMessage = vi.fn(async () => undefined);
  const send = () => handleCarouselTap(fixture.db, { replyMessage } as unknown as LineClient,
    { id: 'friend', line_user_id: 'U1' }, { templateId: 'template', columnIndex: 0, actionIndex: 0 },
    { lineAccountId: 'account', replyToken: 'reply' });
  expect(await send()).toEqual({ kind: 'blocked', replyTokenConsumed: false });
  expect(replyMessage).not.toHaveBeenCalled();
  expect(fixture.raw.prepare('SELECT var_key, reason FROM common_var_resolution_failures').all())
    .toEqual([{ var_key: 'hours', reason: 'missing' }]);
  fixture.raw.prepare("INSERT INTO common_vars(id,line_account_id,name,var_key,type,value) VALUES ('var','account','営業時間','hours','text','10時')").run();
  expect(await send()).toEqual({ kind: 'blocked', replyTokenConsumed: true });
  expect(replyMessage).toHaveBeenCalledWith('reply', [{ type: 'text', text: '営業時間は10時です' }]);
});
