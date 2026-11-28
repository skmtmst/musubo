import { afterEach, beforeEach, expect, test } from 'vitest';
import { gapFixture, gapApp, gapCall } from '../test-utils/gap1.js';
import { accountAiFeatures } from './account-ai-features.js';
import { accountAiSetting, requireAccountAi } from '../services/account-ai-features.js';

let d: ReturnType<typeof gapFixture>;
beforeEach(() => { d = gapFixture(); });
afterEach(() => { d.raw.close(); });

test.each(['local', 'test', 'development', 'staging', 'production', 'unknown', undefined])('%s では同意のない両機能も常時オン', async (env) => {
 const response = await gapCall(gapApp(d, [accountAiFeatures], undefined, false, { DEPLOY_ENV: env }), '/api/ai-features?account_id=a');
 expect(response.status).toBe(200);
 const json = await response.json() as { data: { items: Array<{ feature: string; enabled: boolean; alwaysOn: boolean; consentAt: string | null }> } };
 expect(json.data.items).toEqual(expect.arrayContaining([
  expect.objectContaining({ feature: 'banner', enabled: true, alwaysOn: true, consentAt: null }),
  expect.objectContaining({ feature: 'google_review', enabled: true, alwaysOn: true, consentAt: null }),
 ]));
 expect(d.raw.prepare('SELECT count(*) n FROM account_ai_features').get()).toEqual({ n: 0 });
});

test.each(['staging', 'production', undefined])('%s の PUT は変更も監査もせず 409 を返す', async (env) => {
 for (const enabled of [true, false]) {
  const response = await gapCall(gapApp(d, [accountAiFeatures], undefined, false, { DEPLOY_ENV: env }), '/api/ai-features/banner?account_id=a', 'PUT', { enabled, expectedVersion: 0 });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: 'ai_always_on' });
 }
 expect(d.raw.prepare('SELECT count(*) n FROM account_ai_features').get()).toEqual({ n: 0 });
 expect(d.raw.prepare("SELECT count(*) n FROM operation_audit WHERE target_kind='account_ai_feature'").get()).toEqual({ n: 0 });
});

test('有効な店は全環境で設定行なしでも許可し、無効な店・テナント・他テナントは拒否する', async () => {
 for (const feature of ['banner', 'google_review'] as const) {
  await expect(requireAccountAi(d.db, 'a', feature, 't', { DEPLOY_ENV: 'staging' })).resolves.toBeUndefined();
  await expect(requireAccountAi(d.db, 'a', feature, 't', { DEPLOY_ENV: 'production' })).resolves.toBeUndefined();
  await expect(requireAccountAi(d.db, 'a', feature, 't')).resolves.toBeUndefined();
 }
 await expect(requireAccountAi(d.db, 'b', 'banner', 't', { DEPLOY_ENV: 'staging' })).rejects.toMatchObject({ code: 'ai_disabled' });
 d.raw.prepare("UPDATE line_accounts SET is_active=0 WHERE id='a'").run();
 await expect(requireAccountAi(d.db, 'a', 'banner', 't', { DEPLOY_ENV: 'staging' })).rejects.toMatchObject({ code: 'ai_disabled' });
 d.raw.prepare("UPDATE line_accounts SET is_active=1 WHERE id='a'").run();
 d.raw.prepare("UPDATE tenants SET status='suspended' WHERE id='t'").run();
 await expect(requireAccountAi(d.db, 'a', 'banner', 't', { DEPLOY_ENV: 'staging' })).rejects.toMatchObject({ code: 'ai_disabled' });
});

test('既存のオフ設定と同意情報を変更せず、全環境でオンを返す', async () => {
 d.raw.exec("INSERT INTO account_ai_features(account_id,feature,enabled,consent_by,consent_at,disclosure_version) VALUES('a','banner',0,'o','2026-01-01','v1')");
 expect(await accountAiSetting(d.db, 'a', 'banner', { DEPLOY_ENV: 'staging' })).toMatchObject({ enabled: true, alwaysOn: true, version: 1, consentBy: 'o' });
 expect(await accountAiSetting(d.db, 'a', 'banner', { DEPLOY_ENV: 'production' })).toMatchObject({ enabled: true, alwaysOn: true, version: 1, consentBy: 'o' });
 const response = await gapCall(gapApp(d, [accountAiFeatures]), '/api/ai-features/banner?account_id=a', 'PUT', { enabled: true, expectedVersion: 1 });
 expect(response.status).toBe(409);
 expect(d.raw.prepare("SELECT enabled,version,consent_by,consent_at,disclosure_version FROM account_ai_features WHERE account_id='a' AND feature='banner'").get()).toEqual({ enabled: 0, version: 1, consent_by: 'o', consent_at: '2026-01-01', disclosure_version: 'v1' });
});
