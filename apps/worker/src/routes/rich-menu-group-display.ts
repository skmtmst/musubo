import { type RichMenuGroup } from '@line-crm/db';

// ----- Serialization (snake_case row → camelCase response) -----

export function serializeGroup(row: RichMenuGroup) {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    chatBarText: row.chat_bar_text,
    size: row.size,
    defaultPageId: row.default_page_id,
    isDefaultForAll: row.is_default_for_all === 1,
    status: row.status,
    publishingAt: row.publishing_at,
    publicationGeneration: row.publishing_generation,
    confirmationRevision: row.confirmation_revision,
    targetingCondition: row.targeting_condition,
    targetingPriority: row.targeting_priority,
    targetingEnabled: row.targeting_enabled === 1,
    folderId: row.folder_id,
    displayOrder: row.display_order,
    // V8「トークを開いたとき メニューを開いておく」。LINE payload の selected。
    defaultOpen: row.default_open === 1,
    // 保存時に送り返す版。古い版での保存は 409 で止める。
    version: row.version ?? 1,
    publishingGeneration: row.publishing_generation ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
