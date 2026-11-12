import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommonVarReasonRequiredError,
  CommonVarStatusTransitionError,
  CommonVarVersionConflictError,
  createCommonVar,
  deleteCommonVar,
  getCommonVarById,
  getCommonVarVersions,
  isSecretLikeValue,
  listCommonVarExpiryCandidates,
  markCommonVarExpiryNotice,
  resolveCommonVarValuesAt,
  setCommonVarStatus,
  updateCommonVar,
} from '../src/common-vars/index.js';
import { asD1 } from './d1-test-helper.js';

/*
 * 共通情報の状態・変える理由・期限の知らせ・秘密値。
 * 使う先が画面・API・cronの3経路なので、ここではDB層の約束ごとを固定する。
 */
describe('共通情報の状態と理由（Q）', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(readFileSync(join(import.meta.dirname, '..', 'bootstrap.sql'), 'utf8'));
    sqlite.exec(`
      INSERT INTO line_accounts (id, channel_id, name, channel_access_token, channel_secret)
      VALUES ('account-a', 'channel-a', '本店', 'token-a', 'secret-a');
    `);
    db = asD1(sqlite);
  });

  afterEach(() => sqlite.close());

  const seed = (key = 'shop_hours') =>
    createCommonVar(db, {
      name: '営業時間', lineAccountId: 'account-a', varKey: key, value: '10-19',
    });

  describe('変える理由', () => {
    it('理由なし・空白だけの更新は ReasonRequired で止まり値は変わらない', async () => {
      const created = await seed();
      await expect(updateCommonVar(db, created.id, 'account-a', { value: '11-20' }))
        .rejects.toBeInstanceOf(CommonVarReasonRequiredError);
      await expect(updateCommonVar(db, created.id, 'account-a', { value: '11-20', changeReason: '   ' }))
        .rejects.toBeInstanceOf(CommonVarReasonRequiredError);
      expect((await getCommonVarById(db, created.id, 'account-a'))?.value).toBe('10-19');
    });

    it('理由は版履歴にそのまま残る', async () => {
      const created = await seed();
      await updateCommonVar(db, created.id, 'account-a', {
        value: '11-20', changeReason: '年末の営業時間に合わせる', actorId: 'staff-1',
      });
      const versions = await getCommonVarVersions(db, created.id, 'account-a');
      expect(versions[0]).toMatchObject({
        version_no: 2, value: '11-20', change_reason: '年末の営業時間に合わせる', actor_id: 'staff-1',
      });
    });

    it('削除（アーカイブ）も理由なしでは止まる', async () => {
      const created = await seed();
      await expect(deleteCommonVar(db, created.id, 'account-a', 'staff-1', ''))
        .rejects.toBeInstanceOf(CommonVarReasonRequiredError);
      expect(await getCommonVarById(db, created.id, 'account-a')).not.toBeNull();
      await deleteCommonVar(db, created.id, 'account-a', 'staff-1', '店舗統合のため');
      const versions = await getCommonVarVersions(db, created.id, 'account-a');
      expect(versions[0]?.change_reason).toBe('店舗統合のため');
    });
  });

  describe('状態の切替', () => {
    it('下書き→使用中→止めた→使用中を進め、理由を履歴に残す', async () => {
      // 下書きから「止めた」には直接行けない（公開していないものを止める意味がない）。
      const drafted = await createCommonVar(db, {
        name: '下書き', lineAccountId: 'account-a', varKey: 'draft_key', value: 'x', status: 'draft',
      });
      await expect(setCommonVarStatus(db, drafted.id, 'account-a', { to: 'stopped', changeReason: 'x' }))
        .rejects.toBeInstanceOf(CommonVarStatusTransitionError);
      const created = drafted;
      const published = await setCommonVarStatus(db, created.id, 'account-a', {
        to: 'active', changeReason: '審査が通った',
      });
      expect(published?.status).toBe('active');
      const stopped = await setCommonVarStatus(db, created.id, 'account-a', {
        to: 'stopped', changeReason: '内容を見直す',
      });
      expect(stopped?.status).toBe('stopped');
      expect(stopped?.stopped_at).not.toBeNull();
      const resumed = await setCommonVarStatus(db, created.id, 'account-a', {
        to: 'active', changeReason: '見直し完了',
      });
      expect(resumed?.status).toBe('active');
      expect(resumed?.stopped_at).toBeNull();
      const reasons = (await getCommonVarVersions(db, created.id, 'account-a'))
        .map((version) => version.change_reason);
      expect(reasons).toEqual(['見直し完了', '内容を見直す', '審査が通った', '下書きとして作成']);
    });

    it('理由なしの切替は止まり、版番号の衝突は conflict になる', async () => {
      const created = await seed('conflict_key');
      await expect(setCommonVarStatus(db, created.id, 'account-a', { to: 'stopped', changeReason: ' ' }))
        .rejects.toBeInstanceOf(CommonVarReasonRequiredError);
      await expect(setCommonVarStatus(db, created.id, 'account-a', {
        to: 'stopped', changeReason: 'x', expectedVersion: 99,
      })).rejects.toBeInstanceOf(CommonVarVersionConflictError);
    });

    it('下書き・止めた共通情報は差し込みで失敗として表面化する', async () => {
      const draft = await seed('draft_var');
      await setCommonVarStatus(db, draft.id, 'account-a', { to: 'stopped', changeReason: '一時停止' });
      const stoppedResult = await resolveCommonVarValuesAt(
        db, 'account-a', ['draft_var'], '2026-09-27T00:00:00.000Z',
      );
      expect(stoppedResult).toEqual({
        ok: false, failures: [{ varKey: 'draft_var', reason: 'stopped' }],
      });
      await createCommonVar(db, {
        name: '未公開', lineAccountId: 'account-a', varKey: 'hidden_var', value: 'x', status: 'draft',
      });
      const draftResult = await resolveCommonVarValuesAt(
        db, 'account-a', ['hidden_var'], '2026-09-27T00:00:00.000Z',
      );
      expect(draftResult).toEqual({
        ok: false, failures: [{ varKey: 'hidden_var', reason: 'draft' }],
      });
    });
  });

  describe('期限の知らせ', () => {
    it('14日以内の使用中だけ拾い、止めた・下書き・アーカイブは拾わない', async () => {
      const base = { name: 'x', lineAccountId: 'account-a' };
      await createCommonVar(db, {
        ...base, varKey: 'soon', value: 'x', validUntil: '2026-10-05T00:00:00.000Z',
      });
      await createCommonVar(db, {
        ...base, varKey: 'far', value: 'x', validUntil: '2026-12-31T00:00:00.000Z',
      });
      const stopped = await createCommonVar(db, {
        ...base, varKey: 'stopped', value: 'x', validUntil: '2026-10-05T00:00:00.000Z',
      });
      await setCommonVarStatus(db, stopped.id, 'account-a', { to: 'stopped', changeReason: '止める' });
      await createCommonVar(db, {
        ...base, varKey: 'draft', value: 'x', status: 'draft', validUntil: '2026-10-05T00:00:00.000Z',
      });
      const archived = await createCommonVar(db, {
        ...base, varKey: 'archived', value: 'x', validUntil: '2026-10-05T00:00:00.000Z',
      });
      await deleteCommonVar(db, archived.id, 'account-a', 'staff-1', 'もう使わない');

      const candidates = await listCommonVarExpiryCandidates(db, '2026-09-27T00:00:00.000Z');
      expect(candidates.map((candidate) => candidate.var_key)).toEqual(['soon']);
    });

    it('同じ種類の印は2回目の実行で再度立たない', async () => {
      const created = await createCommonVar(db, {
        name: 'x', lineAccountId: 'account-a', varKey: 'soon',
        value: 'x', validUntil: '2026-10-05T00:00:00.000Z',
      });
      const at = '2026-09-27T00:00:00.000Z';
      expect(await markCommonVarExpiryNotice(db, created.id, '14d', at)).toBe(true);
      // 印済みの行は二重に立てられない（並走する別 sweep の主張が負ける）。
      expect(await markCommonVarExpiryNotice(db, created.id, '14d', at)).toBe(false);
      expect(await markCommonVarExpiryNotice(db, created.id, '3d', at)).toBe(true);
      expect(await markCommonVarExpiryNotice(db, created.id, '3d', at)).toBe(false);
    });

    it('期限を延ばすと送った印が消えて新しい期限へ向け直せる', async () => {
      const created = await createCommonVar(db, {
        name: 'x', lineAccountId: 'account-a', varKey: 'soon',
        value: 'x', validUntil: '2026-10-05T00:00:00.000Z',
      });
      await markCommonVarExpiryNotice(db, created.id, '14d', '2026-09-27T00:00:00.000Z');
      await updateCommonVar(db, created.id, 'account-a', {
        validUntil: '2026-12-31T00:00:00.000Z', changeReason: 'キャンペーン延長',
      });
      const row = await getCommonVarById(db, created.id, 'account-a');
      expect(row?.expiry_notice_14_at).toBeNull();
      expect(row?.valid_until).toBe('2026-12-31T00:00:00.000Z');
    });
  });

  describe('秘密の値の見立て', () => {
    it('有名な鍵の形と長い乱数を止める', () => {
      // 鍵の形の文字列はリポジトリの秘匿情報スキャンに引っかかるため、
      // 断片を連結して組み立てる。判定は組み立て後の文字列で行う。
      for (const secret of [
        ['sk', 'live', 'fakefake12345'].join('_'),
        'AKIA' + 'FAKEFAKEFAKE1234',
        'AIza' + 'SyD4iE2xVSpkLLOXoyq2jxnKUBr9SlMV4ws',
        ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'].join('.'),
        'xoxb-' + '123456789012-ABCDEFGHIJKLM',
        'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
        'Xk9#mP2$vL8&qR4!nW7@tY3*uI6pO1sD5fGh',
      ]) {
        expect(isSecretLikeValue(secret), secret).toBe(true);
      }
    });

    it('店舗の案内・URL・電話番号・日付・長文のお知らせは通す', () => {
      for (const normal of [
        '営業時間 10:00-19:00',
        'https://example.com/shop/notice?campaign=autumn2026',
        '03-0000-5678',
        '2026-10-01',
        '株式会社サンプル',
        '本日は臨時休業です',
        '利用規約を更新しました。'.repeat(40),
        'ID-2026-0927-ABCDEF',
      ]) {
        expect(isSecretLikeValue(normal), normal).toBe(false);
      }
    });
  });
});
