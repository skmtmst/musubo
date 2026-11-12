import { jstNow } from '../utils.js';
import { type CreateRichMenuGroupInput, type RichMenuGroupWithPages, type UpdateRichMenuGroupMetaInput } from './types.js';
import { buildRichMenuAliasId, buildAreaInsert, getRichMenuGroupWithPages } from './reads.js';



export async function createRichMenuGroup(
  db: D1Database,
  input: CreateRichMenuGroupInput,
): Promise<RichMenuGroupWithPages> {
  const groupId = crypto.randomUUID();
  const now = jstNow();

  // pages の順序通りに alias_id を確定。
  // input.id は新規 group 作成時には信用しない (rich_menu_pages.id PK 衝突を防ぐ
  // ため。別 group のページから duplicate されたコピー由来の id 等)。
  // 既存 page を保持する PATCH 時のみ replaceRichMenuPages 側で id 維持する。
  const pageRecords = input.pages.map((p) => ({
    id: crypto.randomUUID(),
    orderIndex: p.orderIndex,
    name: p.name,
    aliasId: buildRichMenuAliasId(groupId, p.orderIndex),
    areas: p.areas,
  }));
  // 既定ページは作成時に決められる。未指定なら先頭ページ（従来どおり）。
  const defaultPage =
    (input.defaultPageIndex !== undefined && input.defaultPageIndex !== null
      ? pageRecords.find((p) => p.orderIndex === input.defaultPageIndex)
      : undefined) ?? pageRecords[0];
  const defaultPageId = defaultPage?.id ?? null;

  const stmts: D1PreparedStatement[] = [];
  stmts.push(
    db
      .prepare(
        `INSERT INTO rich_menu_groups
           (id, account_id, name, chat_bar_text, size, default_page_id,
            folder_id, is_default_for_all, status,
            targeting_condition, targeting_priority, targeting_enabled,
            default_open, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        groupId,
        input.accountId,
        input.name,
        input.chatBarText,
        input.size,
        defaultPageId,
        input.folderId ?? null,
        input.isDefaultForAll ? 1 : 0,
        input.targetingCondition ?? null,
        input.targetingPriority ?? 0,
        input.targetingEnabled ? 1 : 0,
        input.defaultOpen ? 1 : 0,
        now,
        now,
      ),
  );
  for (const p of pageRecords) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO rich_menu_pages
             (id, group_id, order_index, name, alias_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(p.id, groupId, p.orderIndex, p.name, p.aliasId, now, now),
    );
    for (const a of p.areas) {
      // 作成時の richmenuswitch はまだ page.id が無いので、画面からは
      // actionData.targetPageIndex (orderIndex) で受け、ここで実IDへ解決する。
      // 解決しても1 batch 内なので、失敗時に半分だけ残ることはない。
      let area = a;
      if (a.actionType === 'richmenuswitch' && a.actionData) {
        const rawIndex = a.actionData.targetPageIndex;
        if (typeof rawIndex === 'number' && Number.isInteger(rawIndex)) {
          const target = pageRecords.find((page) => page.orderIndex === rawIndex);
          if (target) {
            const { targetPageIndex: _drop, ...rest } = a.actionData;
            area = { ...a, actionData: { ...rest, targetPageId: target.id } };
          }
        }
      }
      stmts.push(buildAreaInsert(db, crypto.randomUUID(), p.id, area, now));
    }
  }
  await db.batch(stmts);

  const created = await getRichMenuGroupWithPages(db, groupId);
  if (!created) throw new Error('failed to read back created rich menu group');
  return created;
}

export async function updateRichMenuGroupMeta(
  db: D1Database,
  id: string,
  patch: UpdateRichMenuGroupMetaInput,
): Promise<void> {
  const built = buildMetaSets(patch);
  if (!built) return;
  const now = jstNow();
  await db
    .prepare(`UPDATE rich_menu_groups SET ${built.sets.join(', ')}, confirmation_revision = confirmation_revision + 1, updated_at = ? WHERE id = ?`)
    .bind(...built.vals, now, id)
    .run();
}

/** meta の差分を SET 句へ写す。差分が無ければ null。 */
export function buildMetaSets(patch: UpdateRichMenuGroupMetaInput): { sets: string[]; vals: unknown[] } | null {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    vals.push(patch.name);
  }
  if (patch.chatBarText !== undefined) {
    sets.push('chat_bar_text = ?');
    vals.push(patch.chatBarText);
  }
  if (patch.isDefaultForAll !== undefined) {
    sets.push('is_default_for_all = ?');
    vals.push(patch.isDefaultForAll ? 1 : 0);
  }
  if (patch.targetingCondition !== undefined) {
    sets.push('targeting_condition = ?');
    vals.push(patch.targetingCondition);
  }
  if (patch.targetingPriority !== undefined) {
    sets.push('targeting_priority = ?');
    vals.push(patch.targetingPriority);
  }
  if (patch.targetingEnabled !== undefined) {
    sets.push('targeting_enabled = ?');
    vals.push(patch.targetingEnabled ? 1 : 0);
  }
  if (patch.folderId !== undefined) {
    sets.push('folder_id = ?');
    vals.push(patch.folderId);
  }
  if (patch.displayOrder !== undefined) {
    sets.push('display_order = ?');
    vals.push(patch.displayOrder);
  }
  if (patch.defaultOpen !== undefined) {
    sets.push('default_open = ?');
    vals.push(patch.defaultOpen ? 1 : 0);
  }
  if (sets.length === 0) return null;
  return { sets, vals };
}
