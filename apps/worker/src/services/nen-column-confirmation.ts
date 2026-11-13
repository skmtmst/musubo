import { jstNow } from '@line-crm/db';
import { DELIVERY_CONSENT_ALLOWED_SQL } from '@line-crm/db/src/friend-delivery-consents.js';
import { readNenCampaignSnapshot, type CampaignRow } from './nen-engagement.js';
import { NenColumnOperationError } from './nen-column-operations.js';

type Column = {
  id: string; title: string; excerpt: string; article_url: string; image_url: string | null;
  intro_text: string | null; target_mode: string; target_tag_id: string | null; updated_at: string;
};
type Recipient = { id: string; line_user_id: string };
const COLUMN_SQL = `SELECT id,title,excerpt,article_url,image_url,intro_text,target_mode,target_tag_id,updated_at
  FROM nen_columns WHERE id=? AND line_account_id=?`;
const BASE_SQL = `SELECT json_object('campaign_key',campaign_key,'label',label,'category',category,
  'trigger_event',trigger_event,'delay_days',delay_days,'delivery_time',delivery_time,'is_enabled',is_enabled,
  'title',title,'body_text',body_text,'button_label',button_label,'button_url',button_url,
  'image_url',image_url,'updated_at',updated_at) AS value FROM nen_campaign_settings WHERE campaign_key='column'`;
const AUDIENCE_SQL = `SELECT f.id,f.line_user_id FROM friends f
  WHERE f.line_account_id=? AND f.is_following=1 AND COALESCE(f.is_hidden,0)=0 AND (${DELIVERY_CONSENT_ALLOWED_SQL}) AND f.line_user_id IS NOT NULL AND trim(f.line_user_id)<>''
  AND (? != 'tag' OR EXISTS(SELECT 1 FROM friend_tags ft WHERE ft.friend_id=f.id AND ft.tag_id=?))
  AND NOT EXISTS(SELECT 1 FROM nen_delivery_jobs j WHERE j.campaign_key='column' AND j.friend_id=f.id AND j.source_key=?)`;

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('');
}

export async function nenColumnConfirmation(db: D1Database, accountId: string, columnId: string) {
  const column = await db.prepare(COLUMN_SQL).bind(columnId, accountId).first<Column>();
  if (!column) throw new NenColumnOperationError('column_not_found', 'コラムが見つかりません', 404);
  const [base, saved] = await Promise.all([
    db.prepare(BASE_SQL).first<{ value: string }>(),
    db.prepare("SELECT value FROM account_settings WHERE line_account_id=? AND key='nen.campaign.column'").bind(accountId).first<{ value: string }>(),
  ]);
  if (!base) throw new NenColumnOperationError('column_disabled', 'コラム配信の状態を確認してください', 409);
  const campaign: CampaignRow | null = saved
    ? readNenCampaignSnapshot(saved.value, 'column')
    : { ...JSON.parse(base.value), dedup_window_days: 30, exclude_form_respondents: 0 };
  if (!campaign) throw new NenColumnOperationError('column_disabled', 'コラム配信の状態を確認してください', 409);
  const sourceKey = `column:${columnId}`;
  const recipients = (await db.prepare(`${AUDIENCE_SQL} ORDER BY f.id`).bind(accountId, column.target_mode, column.target_tag_id, sourceKey).all<Recipient>()).results;
  const token = await digest([accountId, column, base.value, saved?.value ?? null, campaign, recipients]);
  return { column, base: base.value, saved: saved?.value ?? null, campaign, recipients, sourceKey, recipientCount: recipients.length, confirmationToken: token };
}

export class NenColumnConfirmationConflict extends Error {
  constructor(public readonly current: Awaited<ReturnType<typeof nenColumnConfirmation>> | null) { super('配信内容または対象が変わりました。もう一度確認してください'); }
}

export async function enqueueConfirmedNenColumn(db: D1Database, accountId: string, columnId: string, scheduledAt: string, expected: { recipientCount: number; confirmationToken: string }) {
  let snapshot: Awaited<ReturnType<typeof nenColumnConfirmation>>;
  try { snapshot = await nenColumnConfirmation(db, accountId, columnId); }
  catch (error) { if (error instanceof NenColumnOperationError && (error.status === 404 || error.status === 409)) throw new NenColumnConfirmationConflict(null); throw error; }
  if (snapshot.campaign.is_enabled !== 1 || snapshot.recipientCount !== expected.recipientCount || snapshot.confirmationToken !== expected.confirmationToken) throw new NenColumnConfirmationConflict(snapshot);
  const rows = snapshot.recipients.map((recipient) => ({ ...recipient, jobId: crypto.randomUUID() }));
  const article = JSON.stringify(snapshot.column);
  const now = jstNow();
  const col = snapshot.column;
  const audienceParams = [accountId, col.target_mode, col.target_tag_id, snapshot.sourceKey];
  try {
    const operations: D1PreparedStatement[] = [
      db.prepare(`SELECT CASE WHEN
        EXISTS(SELECT 1 FROM nen_columns WHERE id=? AND line_account_id=? AND title IS ? AND excerpt IS ? AND article_url IS ? AND image_url IS ? AND intro_text IS ? AND target_mode IS ? AND target_tag_id IS ? AND updated_at IS ?)
        AND (${BASE_SQL}) IS ?
        AND (SELECT value FROM account_settings WHERE line_account_id=? AND key='nen.campaign.column') IS ?
        AND (SELECT COUNT(*) FROM (${AUDIENCE_SQL}))=?
        THEN 1 ELSE json('NEN_CONFIRMATION_CHANGED') END`)
        .bind(col.id, accountId, col.title, col.excerpt, col.article_url, col.image_url, col.intro_text, col.target_mode, col.target_tag_id, col.updated_at,
          snapshot.base, accountId, snapshot.saved, ...audienceParams, rows.length),
    ];
    for (let offset = 0; offset < rows.length; offset += 500) {
      const chunk = rows.slice(offset, offset + 500);
      operations.push(db.prepare(`INSERT OR IGNORE INTO nen_delivery_jobs
        (id,campaign_key,friend_id,line_account_id,source_key,payload,campaign_snapshot,scheduled_at,status,attempts,created_at,updated_at)
        SELECT json_extract(e.value,'$.jobId'),'column',q.id,?,?,
          json_object('article',json(?),'expectedLineUserId',q.line_user_id),?,?, 'pending',0,?,?
        FROM json_each(?) e JOIN (${AUDIENCE_SQL}) q
          ON q.id=json_extract(e.value,'$.id') AND q.line_user_id=json_extract(e.value,'$.line_user_id')`)
        .bind(accountId, snapshot.sourceKey, article, JSON.stringify(snapshot.campaign), scheduledAt, now, now, JSON.stringify(chunk), ...audienceParams));
      operations.push(db.prepare("SELECT CASE WHEN changes()=? THEN 1 ELSE json('NEN_CONFIRMATION_CHANGED') END").bind(chunk.length));
    }
    operations.push(db.prepare('UPDATE nen_columns SET delivery_status=?,delivery_at=?,updated_at=? WHERE id=? AND line_account_id=?')
      .bind(rows.length ? 'queued' : 'scheduled', scheduledAt, now, columnId, accountId));
    await db.batch(operations);
  } catch (error) {
    let current: Awaited<ReturnType<typeof nenColumnConfirmation>>;
    try { current = await nenColumnConfirmation(db, accountId, columnId); }
    catch (readError) { if (readError instanceof NenColumnOperationError && (readError.status === 404 || readError.status === 409)) throw new NenColumnConfirmationConflict(null); throw readError; }
    if (current.recipientCount !== snapshot.recipientCount || current.confirmationToken !== snapshot.confirmationToken) throw new NenColumnConfirmationConflict(current);
    throw error;
  }
  return rows.length;
}
