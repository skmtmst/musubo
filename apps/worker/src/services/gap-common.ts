import type { Context } from 'hono';
import type { Env } from '../worker-env.js';
import { canAccessAllLineAccounts } from './account-access.js';
import { isHqBusinessOperation } from '../middleware/hq-role-policy.js';
export class GapError extends Error {
  constructor(public code:string, public status:400|401|403|404|409|410|429|503=400) {super(code);}
}
export async function gapAccount(c:Context<Env>, explicit?:string) {
  const id=explicit??c.req.query('account_id');
  if(!id) throw new GapError('account_id_required');
  if(!c.get('staff') || !await canAccessAllLineAccounts(c.env.DB,c.get('staff'),[id])) throw new GapError('not_found',404);
  c.header('Cache-Control','no-store');
  return id;
}
export function gapWrite(c:Context<Env>, options:{admin?:boolean;impersonation?:boolean}={}) {
  const staff=c.get('staff');
  if(!staff || staff.readOnly || (options.admin && !['owner','admin'].includes(staff.role)
    && !(staff.hqRole === 'operator' && isHqBusinessOperation(c.req.method,c.req.path,staff.id)))) throw new GapError('forbidden',403);
  if(c.get('impersonation') && !options.impersonation) throw new GapError('IMPERSONATION_WRITE_BLOCKED',403);
}
export function gapVersion(v:unknown):number {
  if(!Number.isSafeInteger(v)||Number(v)<0) throw new GapError('expectedVersion_required');
  return v as number;
}
export async function gapBody(c:Context<Env>):Promise<Record<string,unknown>> {
  const b=await c.req.json().catch(()=>null);
  if(!b || typeof b!=='object'||Array.isArray(b)) throw new GapError('invalid_body');
  return b;
}
export function gapKey(c:Context<Env>):string {
  const key=c.req.header('Idempotency-Key')?.trim();
  if(!key||key.length>128||!/^[-\w:]+$/.test(key)) throw new GapError('idempotency_key_required');
  return key;
}
