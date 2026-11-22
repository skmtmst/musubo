import { expect, test } from 'vitest';
import { gapFixture } from '../test-utils/gap1.js';

test('purge-only trigger exceptions mention every protected schema column', () => {
  const f=gapFixture();
  const check=(table:string,trigger:string,excluded:string[] = []) => {
    const row=f.raw.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(trigger) as {sql:string};
    const columns=(f.raw.pragma(`table_info("${table}")`) as {name:string}[]).map(c=>c.name);
    for (const col of columns) {
      if (excluded.includes(col)) continue;
      expect(row.sql,`${trigger}: NEW.${col}`).toMatch(new RegExp(`NEW\\.(?:"${col}"|${col}\\b)`,'i'));
      expect(row.sql,`${trigger}: OLD.${col}`).toMatch(new RegExp(`OLD\\.(?:"${col}"|${col}\\b)`,'i'));
    }
  };
  check('booking_monthly_contracts','booking_monthly_contract_identity',['updated_at']);
  check('booking_monthly_attempts','booking_monthly_attempt_identity');
  check('form_versions','trg_form_versions_immutable',['on_submit_webhook_url','on_submit_webhook_headers']);
  check('common_action_versions','trg_common_action_published_version_immutable',['action_config']);
  f.raw.exec('ALTER TABLE form_versions ADD COLUMN sensitive_new TEXT');
  expect(()=>check('form_versions','trg_form_versions_immutable',['on_submit_webhook_url','on_submit_webhook_headers'])).toThrow();
});

test('migration 790 creates nullable billing retry claim fields', () => {
  const f=gapFixture();
  try {
    const columns=f.raw.pragma('table_info(security_alerts)') as {name:string;type:string;notnull:number}[];
    expect(columns.filter(column => column.name === 'billing_retry_token' || column.name === 'billing_retry_until'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({name:'billing_retry_token',type:'TEXT',notnull:0}),
        expect.objectContaining({name:'billing_retry_until',type:'TEXT',notnull:0}),
      ]));
  } finally { f.raw.close(); }
});
