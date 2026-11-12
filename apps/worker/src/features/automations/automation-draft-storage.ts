import type { AutomationVersionContent } from './automation-version-content.js';

/** 停止した初版下書きと、関連する所有情報を同じbatchで作るための共通SQL。 */
export function automationDraftCreationStatements(db:D1Database,input:{
 id:string;versionId:string;lineAccountId:string;name:string;description:string|null;
 folderId?:string|null;createdBy?:string|null;now:string;content:AutomationVersionContent;
}):D1PreparedStatement[]{
 const {id,versionId,folderId,now}=input;
  return [
      db.prepare(
        `INSERT OR IGNORE INTO automation_definitions
           (id, line_account_id, name, description, status, created_by, created_at, updated_at, folder_id)
         VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
      ).bind(id, input.lineAccountId, input.name, input.description, input.createdBy ?? null, now, now, folderId ?? null),
      db.prepare(
        // まだ版が付いていない下書きのときだけ足す。先に作った側の版を
        // 上書きしないよう、`current_draft_version_id IS NULL` で守る。
        `INSERT INTO automation_versions
           (id, automation_id, version_number, status, trigger_type, trigger_config,
            condition_config, action_config, created_by, created_at)
         SELECT ?, ?, 1, 'draft', ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM automation_definitions
             WHERE id = ? AND line_account_id = ? AND status = 'draft'
               AND current_draft_version_id IS NULL
          )`,
      ).bind(
        versionId,
        id,
        input.content.trigger_type,
        input.content.trigger_config,
        input.content.condition_config,
        input.content.action_config,
        input.createdBy ?? null,
        now,
        id,
        input.lineAccountId,
      ),
      db.prepare(
        `UPDATE automation_definitions SET confirmation_revision = confirmation_revision + 1, current_draft_version_id = ?
          WHERE id = ? AND line_account_id = ? AND status = 'draft'
            AND current_draft_version_id IS NULL`,
      ).bind(versionId, id, input.lineAccountId),
  ];
}
