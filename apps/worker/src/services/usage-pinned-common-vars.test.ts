import { describe, expect, it, vi } from 'vitest';
import * as openingHours from './account-opening-hours.js';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { resolveUsagePinnedCommonVars } from './usage-pinned-common-vars.js';

describe('公開版の共通情報', () => {
  it('固定した値を返し、現在の停止と期限切れを拒む', async () => {
    const store = createTestD1();
    store.raw.exec(`
      INSERT INTO line_accounts(id,channel_id,name,channel_access_token,channel_secret) VALUES ('a','channel','店舗','token','secret');
      INSERT INTO common_vars(id,line_account_id,name,var_key,value,version) VALUES ('v','a','案内','notice','新しい値',2);
      INSERT INTO common_var_versions(id,common_var_id,version_no,name,value,change_reason) VALUES ('old','v',1,'案内','固定した値','test');
      INSERT INTO forms(id,name) VALUES ('f','回答');
      INSERT INTO form_versions(id,form_id,version_number,source_content_revision,name,save_to_metadata,status,published_at,created_at)
        VALUES ('fv','f',2,2,'回答',1,'published','2026-01-01','2026-01-01');
      INSERT INTO form_version_common_var_pins(form_version_id,common_var_id,version_id) VALUES ('fv','v','old');
    `);
    const resolve = () => resolveUsagePinnedCommonVars(store.db, 'a', ['notice'], { kind: 'form', versionId: 'fv' }, '2026-11-20T00:00:00Z');
    expect(await resolve()).toEqual({ ok: true, values: { notice: '固定した値' } });
    store.raw.prepare("UPDATE common_vars SET var_key='business_hours' WHERE id='v'").run();
    const spy = vi.spyOn(openingHours, 'accountOpeningHours').mockResolvedValue({ source: 'google_unavailable', profile: null });
    try {
      expect(await resolveUsagePinnedCommonVars(store.db, 'a', ['business_hours'], { kind: 'form', versionId: 'fv' }, '2026-11-20T00:00:00Z')).toMatchObject({ ok: false, pinnedFailure: true });
    } finally { spy.mockRestore(); }
    store.raw.prepare("UPDATE common_vars SET var_key='notice' WHERE id='v'").run();
    expect(() => store.raw.prepare("UPDATE form_version_common_var_pins SET version_id='old' WHERE form_version_id='fv'").run()).toThrow('published_pin_immutable');
    store.raw.prepare("UPDATE common_vars SET status='stopped' WHERE id='v'").run();
    expect(await resolve()).toEqual({ ok: false, failures: [{ varKey: 'notice', reason: 'stopped' }], pinnedFailure: true });
    store.raw.prepare("UPDATE common_vars SET status='active', valid_until='2026-11-20T00:00:00Z' WHERE id='v'").run();
    expect(await resolve()).toEqual({ ok: false, failures: [{ varKey: 'notice', reason: 'expired' }], pinnedFailure: true });
    store.raw.close();
  });
});
