import { validateAccountHierarchy } from './account-access.js';
export interface RegistrationOptions { tagIds?: string[]; staffIds?: string[]; parentLineAccountId?: string | null }
export class RegistrationOptionsError extends Error {
  constructor(public readonly status: 403 | 409 | 422, public readonly code: string) {super(code)}
}
export interface CheckedRegistrationOptions extends RegistrationOptions { tenantId: string; staffVersions: Array<{id:string;version:number}>; hierarchy?: string }
export async function validateRegistrationOptions(db:D1Database,tenantId:string,options:RegistrationOptions,actorId?:string):Promise<CheckedRegistrationOptions> {
  const checked:CheckedRegistrationOptions={...options,tenantId,staffVersions:[]};
  if(options.parentLineAccountId || options.tagIds?.length || options.staffIds?.length) {
    if(!actorId || !await db.prepare("SELECT id FROM staff_members WHERE id=? AND tenant_id=? AND role='owner' AND is_active=1 AND access_level='full' AND account_scope='all'").bind(actorId,tenantId).first()) throw new RegistrationOptionsError(403,'INVALID_REGISTRATION_AUTHORITY');
  }

  if(options.parentLineAccountId && !await db.prepare('SELECT id FROM line_accounts WHERE id=? AND tenant_id=? AND is_active=1 AND archived_at IS NULL').bind(options.parentLineAccountId,tenantId).first()) throw new RegistrationOptionsError(403,'INVALID_PARENT_SCOPE');
  if(options.parentLineAccountId) {
    const rows=(await db.prepare('SELECT id,parent_line_account_id FROM line_accounts WHERE tenant_id=? AND data_purged_at IS NULL ORDER BY id').bind(tenantId).all<{id:string;parent_line_account_id:string|null}>()).results;
    const temporary=crypto.randomUUID();
    if(validateAccountHierarchy([...rows,{id:temporary,parent_line_account_id:null}],[{id:temporary,parentLineAccountId:options.parentLineAccountId}])) throw new RegistrationOptionsError(422,'INVALID_ACCOUNT_HIERARCHY');
    checked.hierarchy=JSON.stringify(rows.map(r=>[r.id,r.parent_line_account_id]));
  }
  for(const id of options.tagIds??[]) if(!await db.prepare("SELECT id FROM line_account_tags WHERE id=? AND tenant_id=? AND EXISTS (SELECT 1 FROM tenants t WHERE t.id=line_account_tags.tenant_id AND t.purge_started_at IS NULL AND t.data_purged_at IS NULL) AND NOT EXISTS (SELECT 1 FROM tenant_purge_tombstone_progress p WHERE p.tenant_id=line_account_tags.tenant_id AND p.table_name='line_account_tags' AND p.row_id=line_account_tags.id)").bind(id,tenantId).first()) throw new RegistrationOptionsError(403,'INVALID_TAG_SCOPE');
  for(const id of options.staffIds??[]) {
    const row=await db.prepare("SELECT policy_version FROM staff_members WHERE id=? AND tenant_id=? AND is_active=1 AND account_scope='accounts' AND invite_status='active'").bind(id,tenantId).first<{policy_version:number}>();
    if(!row) throw new RegistrationOptionsError(403,'INVALID_STAFF_SCOPE');
    checked.staffVersions.push({id,version:row.policy_version});
  }
  return checked;
}
export async function applyRegistrationOptions(db:D1Database,accountId:string,actorId:string,checked:CheckedRegistrationOptions) {
  if(!checked.tagIds?.length && !checked.staffVersions.length && !checked.parentLineAccountId) return;
  const guard=(sql:string,args:Array<string|number>)=>db.prepare(`SELECT json(CASE WHEN (${sql}) THEN '{}' ELSE 'REGISTRATION_CONFLICT' END)`).bind(...args);
  const statements=[guard('EXISTS(SELECT 1 FROM line_accounts WHERE id=? AND tenant_id=? AND archived_at IS NULL)',[accountId,checked.tenantId])];
  statements.push(guard("EXISTS(SELECT 1 FROM staff_members WHERE id=? AND tenant_id=? AND role='owner' AND is_active=1 AND access_level='full' AND account_scope='all')",[actorId,checked.tenantId]));
  if(checked.parentLineAccountId) statements.push(guard('EXISTS(SELECT 1 FROM line_accounts WHERE id=? AND tenant_id=? AND is_active=1 AND archived_at IS NULL)',[checked.parentLineAccountId,checked.tenantId]));
  if(checked.hierarchy) statements.push(guard('((SELECT json_group_array(json_array(id,parent_line_account_id)) FROM (SELECT id,parent_line_account_id FROM line_accounts WHERE tenant_id=? AND id!=? AND data_purged_at IS NULL ORDER BY id)))=?',[checked.tenantId,accountId,checked.hierarchy]));
  for(const id of checked.tagIds??[]) statements.push(guard("EXISTS(SELECT 1 FROM line_account_tags WHERE id=? AND tenant_id=? AND EXISTS (SELECT 1 FROM tenants t WHERE t.id=line_account_tags.tenant_id AND t.purge_started_at IS NULL AND t.data_purged_at IS NULL) AND NOT EXISTS (SELECT 1 FROM tenant_purge_tombstone_progress p WHERE p.tenant_id=line_account_tags.tenant_id AND p.table_name='line_account_tags' AND p.row_id=line_account_tags.id))",[id,checked.tenantId]),db.prepare('INSERT INTO line_account_tag_links(line_account_id,tag_id,tenant_id) VALUES (?,?,?)').bind(accountId,id,checked.tenantId));
  for(const member of checked.staffVersions) statements.push(
    guard("EXISTS(SELECT 1 FROM staff_members WHERE id=? AND tenant_id=? AND is_active=1 AND account_scope='accounts' AND invite_status='active' AND policy_version=?)",[member.id,checked.tenantId,member.version]),
    db.prepare("INSERT INTO staff_account_scopes(staff_id,line_account_id,created_at) VALUES (?,?,strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours'))").bind(member.id,accountId),
    db.prepare("UPDATE staff_members SET policy_version=policy_version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%f','now','+9 hours') WHERE id=? AND tenant_id=?").bind(member.id,checked.tenantId),
    db.prepare("INSERT INTO audit_events(id,tenant_id,line_account_id,category,actor_principal_id,actor_role,action,target_kind,target_id,result) VALUES (?, ?,?,'auth',?,'owner','staff.account_scope_added','staff',?,'success')").bind(crypto.randomUUID(),checked.tenantId,accountId,actorId,member.id),
  );
  statements.push(db.prepare("INSERT INTO audit_events(id,tenant_id,line_account_id,category,actor_principal_id,actor_role,action,target_kind,target_id,result) VALUES (?,?,?,'business',?,'owner','line_account.registration_options','line_account',?,'success')").bind(crypto.randomUUID(),checked.tenantId,accountId,actorId,accountId));
  try {await db.batch(statements)} catch {throw new RegistrationOptionsError(409,'REGISTRATION_OPTIONS_CHANGED')}
}
