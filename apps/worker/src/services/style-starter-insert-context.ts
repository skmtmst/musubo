import type {AccountStyle} from '@line-crm/shared';
import { profile } from './style-profile.js';
import { starter } from './style-starter-set.js';
import { loadStarterPresence } from './style-starter-presence.js';
import { StyleError } from './style-setup-core.js';

export async function prepareStarterInsert(db:D1Database,account:string,tenant:string|null,style:AccountStyle,input:Record<string,unknown>,options:{set?:Awaited<ReturnType<typeof starter>>;skipExisting?:boolean;initialMenu?:boolean;repairMissing?:boolean}) {
  const set = options.set ?? (await starter(db, tenant, style, options.initialMenu));
  const existing = options.repairMissing
    ? await loadStarterPresence(db, account, true)
    : (await db.prepare('SELECT *, NULL AS present, NULL AS current_snapshot FROM style_starter_items WHERE line_account_id=?').bind(account)
        .all<{item_key:string;target_id:string;kind:string;style:string;is_sample:number;source_snapshot:string|null;present:number|null;current_snapshot:string|null}>()).results;
  const oldProfile = await profile(db, account);
  const choice = input.choices as
    | Record<
        string,
        { mode: 'sample' | 'existing' | 'configured'; resourceId?: string }
      >
    | undefined;
  if (
    choice !== undefined &&
    (!choice || typeof choice !== 'object' || Array.isArray(choice))
  )
    throw new StyleError('invalid_choices');
  for (const [key, chosen] of Object.entries(choice ?? {})) {
    const item = set.definition.items.find((i) => i.key === key);
    if (
      !item ||
      !chosen ||
      !['sample', 'existing', 'configured'].includes(chosen.mode)
    )
      throw new StyleError('invalid_choices');
    if (chosen.mode !== 'sample') {
      const table =
        item.kind === 'template'
          ? 'templates'
          : item.kind === 'rich_menu'
            ? 'rich_menu_groups'
            : item.kind === 'automation'
              ? 'automation_definitions'
              : item.kind === 'reminder'
                ? 'reminders'
                : item.kind === 'booking_menu'
                  ? 'menus'
                  : item.kind === 'scenario'
                    ? 'scenarios'
                    : null;
      if ((!table && item.kind!=='form') || !chosen.resourceId)
        throw new StyleError('invalid_resource');
      const col = item.kind === 'rich_menu' ? 'account_id' : 'line_account_id';
      if (
        !(await db
          .prepare(item.kind==='form' ? `SELECT 1 FROM forms f JOIN form_accounts a ON a.form_id=f.id WHERE f.id=? AND a.line_account_id=? AND f.status!='archived' AND (SELECT COUNT(*) FROM form_accounts b WHERE b.form_id=f.id)=1` : `SELECT 1 FROM ${table} WHERE id=? AND ${col}=?`)
          .bind(chosen.resourceId, account)
          .first())
      )
        throw new StyleError('resource_not_found', 404);
    }
  }
  return {set,existing,oldProfile,choice};
}
