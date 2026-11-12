import { describe, expect, it, vi } from 'vitest';
import { createTestD1 } from '../../test-utils/d1-sqlite.js';
import { updateAutomationDefinitionStatus } from './automation-definitions.js';
import { deleteFolder } from '@line-crm/db';

function fixture() {
  const db = createTestD1();
  db.raw.prepare(`INSERT INTO line_accounts(id, channel_id, name, channel_access_token, channel_secret) VALUES('a','channel-a','店','','')`).run();
  db.raw.prepare(`INSERT INTO automation_definitions(id,line_account_id,name,status) VALUES('d','a','自動化','active')`).run();
  return db;
}

describe('自動化の確認版', () => {
  it('古い確認は停止せず競合を返す', async () => {
    const db = fixture();
    db.raw.prepare("UPDATE automation_definitions SET confirmation_revision=2 WHERE id='d'").run();
    await expect(updateAutomationDefinitionStatus(db.db, { id:'d', lineAccountId:'a', status:'stopped', ...{ expectedConfirmationRevision:1 } })).rejects.toMatchObject({ code:'version_conflict' });
    expect(db.raw.prepare("SELECT status,confirmation_revision FROM automation_definitions WHERE id='d'").get()).toEqual({ status:'active', confirmation_revision:2 });
  });
  it('読み取り後の版変更は更新文で拒む', async () => {
    const d = fixture(), original = d.db.prepare.bind(d.db);
    const spy = vi.spyOn(d.db, 'prepare').mockImplementation(sql => {
      if (sql.includes('UPDATE automation_definitions SET status = ?')) d.raw.exec("UPDATE automation_definitions SET confirmation_revision=2 WHERE id='d'");
      return original(sql);
    });
    try {
      await expect(updateAutomationDefinitionStatus(d.db, { id:'d', lineAccountId:'a', status:'stopped', expectedConfirmationRevision:1 })).rejects.toMatchObject({ code:'version_conflict' });
      expect(d.raw.prepare("SELECT status,confirmation_revision FROM automation_definitions WHERE id='d'").get()).toEqual({ status:'active', confirmation_revision:2 });
    } finally { spy.mockRestore(); }
  });
  it('一致する版は一度だけ停止し、次の版へ進む', async () => {
    const db = fixture();
    await updateAutomationDefinitionStatus(db.db, { id:'d', lineAccountId:'a', status:'stopped', ...{ expectedConfirmationRevision:1 } });
    expect(db.raw.prepare("SELECT status,confirmation_revision FROM automation_definitions WHERE id='d'").get()).toEqual({ status:'stopped', confirmation_revision:2 });
    await expect(updateAutomationDefinitionStatus(db.db, { id:'d', lineAccountId:'a', status:'stopped', ...{ expectedConfirmationRevision:1 } })).rejects.toMatchObject({ code:'version_conflict' });
  });
  it('版のない旧呼び出しも停止できる', async () => {
    const db = fixture();
    await updateAutomationDefinitionStatus(db.db, { id:'d', lineAccountId:'a', status:'stopped' });
    expect(db.raw.prepare("SELECT status,confirmation_revision FROM automation_definitions WHERE id='d'").get()).toEqual({ status:'stopped', confirmation_revision:2 });
  });
  it('フォルダ削除で対象が変わったとき、削除前の確認は使えない', async () => {
    const db = fixture();
    db.raw.prepare("INSERT INTO folders(id,kind,account_id,name) VALUES('f','automation','a','分類')").run();
    db.raw.prepare("UPDATE automation_definitions SET folder_id='f' WHERE id='d'").run();
    expect(await deleteFolder(db.db, 'f')).toBe(true);
    await expect(updateAutomationDefinitionStatus(db.db, { id:'d', lineAccountId:'a', status:'stopped', expectedConfirmationRevision:1 })).rejects.toMatchObject({ code:'version_conflict' });
  });
});
