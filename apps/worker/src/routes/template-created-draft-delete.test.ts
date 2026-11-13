import { expect, it } from 'vitest';
import { createTestD1 } from '../test-utils/d1-sqlite.js';
import { createTemplate, deleteCreatedTemplateDraft, saveTemplateDraft, updateTemplate } from '@line-crm/db';

it('自動作成した未公開の版だけを原子的に削除する', async () => {
  const {db,raw} = createTestD1();
  try {
    const draft = await createTemplate(db,{name:'案内',messageType:'text',messageContent:'本文'});
    const revision = Number(draft.draft_revision ?? 0);
    raw.prepare('UPDATE templates SET draft_revision = ? WHERE id = ?').run(revision + 1, draft.id);
    expect(await deleteCreatedTemplateDraft(db,draft.id,revision)).toBe(false);
    expect(raw.prepare('SELECT deleted_at FROM templates WHERE id=?').get(draft.id)).toEqual({deleted_at:null});
    raw.prepare('UPDATE templates SET published_version = 1 WHERE id = ?').run(draft.id);
    expect(await deleteCreatedTemplateDraft(db,draft.id,revision + 1)).toBe(false);
    raw.prepare('UPDATE templates SET published_version = 0 WHERE id = ?').run(draft.id);
    expect(await deleteCreatedTemplateDraft(db,draft.id,revision + 1)).toBe(true);
    expect((raw.prepare('SELECT deleted_at FROM templates WHERE id=?').get(draft.id) as {deleted_at:string|null}).deleted_at).toBeTruthy();
  } finally {raw.close()}
});

it('編集と下書き保存は確認の版を進める', async () => {
  const { db, raw } = createTestD1();
  try {
    const draft = await createTemplate(db, { name: '案内', messageType: 'text', messageContent: '本文' });
    const version = () => (raw.prepare('SELECT confirmation_revision FROM templates WHERE id=?').get(draft.id) as { confirmation_revision: number }).confirmation_revision;
    expect(version()).toBe(1);
    await updateTemplate(db, draft.id, { name: '変更' }); expect(version()).toBe(2);
    await saveTemplateDraft(db, draft.id, { messageContent: '下書き' }); expect(version()).toBe(3);
  } finally { raw.close(); }
});
