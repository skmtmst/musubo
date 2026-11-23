import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { publishMileageReward } from '@line-crm/db';
import { processHqDistributionJobs } from '../services/hq-templates/distribution-jobs.js';
import { readCatalogTarget } from '../services/hq-templates/catalog-target.js';
import { catalogDefinitions, createCatalogFixture, type CatalogFixture, type RedistributionJobView } from '../test-utils/hq-catalog-fixture.js';

let fx: CatalogFixture;
beforeEach(() => { fx = createCatalogFixture(); });
afterEach(() => fx.close());

const reward = (overrides: Record<string, unknown> = {}) => ({ schemaVersion: 1, settings: { ...catalogDefinitions.mileage_reward.settings, ...overrides } });
type RewardRow = { id: string; status: string; description: string | null; current_draft_version_id: string | null; current_published_version_id: string | null; hq_template_version_id: string | null };
const rewardOf = (accountId: string) => fx.f.raw.prepare('SELECT * FROM mileage_rewards WHERE line_account_id=? ORDER BY created_at LIMIT 1').get(accountId) as RewardRow;
const version = (id: string | null) => fx.f.raw.prepare('SELECT id,status,required_miles,stock_limit,revision FROM mileage_reward_versions WHERE id=?').get(id) as { id: string; status: string; required_miles: number; stock_limit: number | null; revision: number };
const addCode = (versionId: string, fingerprint: string) => fx.f.raw.prepare("INSERT INTO mileage_reward_codes(id,reward_version_id,code_ciphertext,code_fingerprint) VALUES(?,?,'sealed',?)").run(crypto.randomUUID(), versionId, fingerprint);
const storeReward = (rewardId: string, action: string, versionId: unknown, accountId = 'b') => fx.request<{ adoptedVersionId?: string; publishRequired?: boolean }>(`/api/mileage/rewards/${rewardId}/${action}`, 'POST', { accountId, versionId });

async function distributed(accountId: string, definition: unknown = catalogDefinitions.mileage_reward) {
  const id = await fx.create('mileage_reward', definition);
  expect((await fx.run(id, await fx.check(id, [accountId]))).body.data.status).toBe('completed');
  return id;
}
async function redistributeTo(id: string, accountId: string) {
  const p = await fx.check(id, [accountId]);
  const created = await fx.redistribute(id, [p.preflightId]);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  await processHqDistributionJobs(fx.f.db);
  return { preflight: p, job: (await fx.hq<RedistributionJobView>(`/${id}/redistributions/${created.body.data.jobId}`)).body.data };
}

describe('景品の配り直し', () => {
  test('まだ公開していない景品は、店の在庫の数と引換コードを残して新しい版に更新する', async () => {
    const id = await distributed('a');
    const before = rewardOf('a');
    fx.f.raw.prepare('UPDATE mileage_reward_versions SET stock_limit=5 WHERE id=?').run(before.current_draft_version_id);
    addCode(before.current_draft_version_id!, 'fp-a');
    const v2 = await fx.save(id, reward({ requiredMiles: 80, description: '本部の説明' }));
    const { preflight, job } = await redistributeTo(id, 'a');
    expect(preflight.stores[0].redistribution?.outcome).toBe('apply');
    expect(job).toMatchObject({ status: 'completed', counts: { applied: 1 } });
    const after = rewardOf('a');
    expect(after).toMatchObject({ id: before.id, status: 'draft', description: '本部の説明', current_draft_version_id: before.current_draft_version_id, hq_template_version_id: v2 });
    expect(version(after.current_draft_version_id)).toMatchObject({ required_miles: 80, stock_limit: 5, revision: 2 });
    expect(fx.f.raw.prepare('SELECT reward_version_id,status FROM mileage_reward_codes').all()).toEqual([{ reward_version_id: before.current_draft_version_id, status: 'available' }]);
    expect(fx.binding(id, 'a')).toMatchObject({ applied_version_id: v2, pending_version_id: null });
    expect((await readCatalogTarget(fx.f.db, 'mileage_reward', 'a', before.id))!.hash).toBe(fx.binding(id, 'a')!.applied_snapshot_hash);
  });

  test('公開中の景品は必要なマイルが減っても増えても書き換えず、取り込むと下書きに入って公開は店が行う', async () => {
    const id = await distributed('b');
    const draft = rewardOf('b').current_draft_version_id!;
    fx.f.raw.prepare('UPDATE mileage_reward_versions SET stock_limit=7 WHERE id=?').run(draft);
    addCode(draft, 'fp-b');
    await publishMileageReward(fx.f.db, { id: rewardOf('b').id, lineAccountId: 'b' });
    const published = rewardOf('b');
    expect(published).toMatchObject({ status: 'published', current_published_version_id: draft, current_draft_version_id: null });

    const lowered = await fx.save(id, reward({ requiredMiles: 80 }));
    const first = await redistributeTo(id, 'b');
    expect(first.preflight.stores[0].redistribution).toMatchObject({ outcome: 'pending', notices: ['published_reward'] });
    expect(first.job).toMatchObject({ status: 'completed', counts: { notified: 1 } });
    expect(version(draft)).toMatchObject({ status: 'published', required_miles: 100 });
    expect(fx.binding(id, 'b')!.pending_version_id).toBe(lowered);

    const raised = await fx.save(id, reward({ requiredMiles: 150 }));
    const second = await redistributeTo(id, 'b');
    expect(second.preflight.stores[0].redistribution).toMatchObject({ outcome: 'pending', notices: ['published_reward', 'required_miles_increase'] });
    const status = await fx.request<{ published: boolean; pendingVersion: { id: string; notices: string[] } }>(`/api/mileage/rewards/${published.id}/hq-status?accountId=b`);
    expect(status.body.data).toMatchObject({ published: true, pendingVersion: { id: raised, notices: ['published_reward', 'required_miles_increase'] } });
    expect((await storeReward(published.id, 'hq-adopt', lowered)).body.code).toBe('hq_version_conflict');

    const adopted = await storeReward(published.id, 'hq-adopt', raised);
    expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
    expect(adopted.body.data).toMatchObject({ adoptedVersionId: raised, publishRequired: true });
    const after = rewardOf('b');
    expect(after).toMatchObject({ status: 'published', current_published_version_id: draft, hq_template_version_id: raised });
    expect(version(draft)).toMatchObject({ status: 'published', required_miles: 100, stock_limit: 7 });
    expect(version(after.current_draft_version_id)).toMatchObject({ status: 'draft', required_miles: 150, stock_limit: 7 });
    expect(fx.f.raw.prepare('SELECT reward_version_id FROM mileage_reward_codes').all()).toEqual([{ reward_version_id: draft }]);
    expect(fx.binding(id, 'b')).toMatchObject({ applied_version_id: raised, pending_version_id: null });
    expect((await readCatalogTarget(fx.f.db, 'mileage_reward', 'b', published.id))!.hash).toBe(fx.binding(id, 'b')!.applied_snapshot_hash);
    // 公開は既存の公開の口の確かめに従う。下書きの版にはまだ引換コードが無い。
    await expect(publishMileageReward(fx.f.db, { id: published.id, lineAccountId: 'b' })).rejects.toMatchObject({ code: 'coupon_inventory_empty' });
    expect(rewardOf('b').current_published_version_id).toBe(draft);
  });

  test('手渡しの景品・渡し方の変わる版・店に無い処理を使う版は書き換えず競合として返す', async () => {
    const handgift = await distributed('a');
    fx.f.raw.prepare('INSERT INTO mileage_handgift_rewards(reward_id) VALUES(?)').run(rewardOf('a').id);
    await fx.save(handgift, reward({ requiredMiles: 80 }));
    const guarded = await redistributeTo(handgift, 'a');
    expect(guarded.preflight.stores[0].redistribution).toMatchObject({ outcome: 'conflict', code: 'handgift_protected' });
    expect(guarded.job.stores).toMatchObject([{ status: 'conflict', code: 'handgift_protected' }]);
    expect(version(rewardOf('a').current_draft_version_id)).toMatchObject({ required_miles: 100 });

    fx.f.raw.exec(`INSERT INTO common_actions(id,line_account_id,name,status) VALUES('action','b','お礼の処理','published');
      INSERT INTO common_action_versions(id,common_action_id,version_number,status,action_config) VALUES('action-v1','action',1,'published','[]');
      UPDATE common_actions SET current_published_version_id='action-v1' WHERE id='action';`);
    const tagReward = { schemaVersion: 1, settings: { name: '会員特典', rewardKind: 'tag', requiredMiles: 100, commonActionName: 'お礼の処理' } };
    const kind = await distributed('b', tagReward);
    await fx.save(kind, reward({ name: '会員特典' }));
    expect((await redistributeTo(kind, 'b')).job.stores).toMatchObject([{ status: 'conflict', code: 'reward_kind_changed' }]);

    const action = await distributed('b', { schemaVersion: 1, settings: { ...tagReward.settings, name: '処理つき特典' } });
    fx.f.raw.exec("UPDATE common_actions SET status='archived' WHERE id='action'");
    await fx.save(action, { schemaVersion: 1, settings: { ...tagReward.settings, name: '処理つき特典', requiredMiles: 90 } });
    // 店の処理が使えないので確かめの段階で止まる。対応表の店の物は書き換わらない。
    const before = fx.binding(action, 'b')!;
    expect((await fx.hq(`/${action}/preflight`, 'POST', { accountIds: ['b'] })).status).toBe(409);
    expect(fx.binding(action, 'b')).toEqual(before);
  });

  test('景品の取り込みと今のままは統括・管理者だけで、閲覧のみ・店のスタッフ・担当外の店はできない', async () => {
    const id = await distributed('b');
    const draft = rewardOf('b').current_draft_version_id!;
    addCode(draft, 'fp-b');
    await publishMileageReward(fx.f.db, { id: rewardOf('b').id, lineAccountId: 'b' });
    const v2 = await fx.save(id, reward({ requiredMiles: 80 }));
    await redistributeTo(id, 'b');
    const rewardId = rewardOf('b').id;
    fx.setStaff({ role: 'staff' });
    expect((await storeReward(rewardId, 'hq-adopt', v2)).status).toBe(403);
    expect((await storeReward(rewardId, 'hq-dismiss', v2)).status).toBe(403);
    fx.setStaff({ role: 'owner', readOnly: true });
    expect((await storeReward(rewardId, 'hq-adopt', v2)).status).toBe(403);
    fx.setStaff({ readOnly: false });
    expect((await storeReward(rewardId, 'hq-adopt', v2, 'other')).status).toBe(404);
    expect(fx.binding(id, 'b')).toMatchObject({ pending_version_id: v2, dismissed_version_id: null });
    const dismissed = await storeReward(rewardId, 'hq-dismiss', v2);
    expect(dismissed.status, JSON.stringify(dismissed.body)).toBe(200);
    expect(fx.binding(id, 'b')).toMatchObject({ pending_version_id: null, dismissed_version_id: v2 });
    expect(version(draft)).toMatchObject({ status: 'published', required_miles: 100 });
    expect(fx.f.raw.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='hq_template.store_dismissed'").get()).toEqual({ n: 1 });
    // 本部でひな形を消すと、景品の出所の記録は残っても店の状態の口は対応なしを返す。
    const detail = await fx.hq<{ template: { revision: number } }>(`/${id}`);
    expect((await fx.hq(`/${id}`, 'DELETE', { expectedRevision: detail.body.data.template.revision })).status).toBe(200);
    const status = await fx.request<{ bound: boolean; detached: string | null }>(`/api/mileage/rewards/${rewardId}/hq-status?accountId=b`);
    expect(status.body.data).toEqual({ bound: false, detached: 'template_archived' });
    expect(rewardOf('b').hq_template_version_id).toBe(fx.binding(id, 'b')!.applied_version_id);
  });
});
