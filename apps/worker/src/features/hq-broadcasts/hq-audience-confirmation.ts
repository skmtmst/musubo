import { broadcastAudienceToken } from '../broadcasts/broadcast-audience-snapshot/index.js';
import { StampError } from '../../services/visit-stamps.js';
import { DELIVERY_CONSENT_ALLOWED_SQL } from '@line-crm/db/src/friend-delivery-consents.js';
import type { HqBroadcastInput } from '@line-crm/shared';
import { buildBroadcastAudienceQuery } from '../broadcasts/broadcast-audience-query/index.js';
import { restrictSegmentInput, scopeStoredBroadcastSegmentQuery } from '../../services/segment-query-scope.js';
import { resolveHqBroadcastAudience } from './hq-broadcast-audience.js';

/** 実際に送れるIDとLINE宛先の集合を固定し、画面にはハッシュだけを渡す。 */
export async function hqAudienceSnapshot(db:D1Database,tenantId:string,accountId:string,input:HqBroadcastInput) {
  const condition=await resolveHqBroadcastAudience(db,tenantId,accountId,input);
  const scoped=await scopeStoredBroadcastSegmentQuery(db,buildBroadcastAudienceQuery(condition),accountId);
  const query=restrictSegmentInput(scoped,`${DELIVERY_CONSENT_ALLOWED_SQL} AND f.line_user_id IS NOT NULL AND trim(f.line_user_id)<>''`);
  const rows=(await db.prepare(`SELECT q.id,q.line_user_id FROM (${query.sql}) q ORDER BY q.id`).bind(...query.bindings).all<{id:string;line_user_id:string}>()).results;
  const token=await broadcastAudienceToken(accountId,rows);
  return {accountId,recipientCount:rows.length,recipientToken:token,rows,query};
}

export type HqConfirmedAudience = {accountId:string;recipientCount:number;recipientToken:string};
export class HqAudienceConflict extends StampError {
  constructor(public current:{count:number|null;perAccount:Array<{accountId:string;recipientCount:number}>}) {
    super('送る相手が変わりました。もう一度確かめてください',409);
  }
}
