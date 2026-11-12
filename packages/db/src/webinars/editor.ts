import { jstNow } from '../utils.js';
import { type WebinarEditorSettings, type WebinarEditorSettingsInput } from './types.js';


export async function getWebinarEditorSettings(
  db: D1Database,
  webinarId: string,
): Promise<WebinarEditorSettings | null> {
  return db.prepare('SELECT * FROM webinar_editor_settings WHERE webinar_id = ?')
    .bind(webinarId)
    .first<WebinarEditorSettings>();
}

export function webinarEditorSnapshot(row: WebinarEditorSettings): string {
  return JSON.stringify({
    deliveryKind: row.delivery_kind,
    viewingCondition: JSON.parse(row.viewing_condition_json),
    publicDescription: row.public_description,
    registrationFormId: row.registration_form_id,
    notificationMessages: JSON.parse(row.notification_messages_json),
    notificationTest: row.notification_test_json ? JSON.parse(row.notification_test_json) : null,
    actionTemplateBody: row.action_template_body,
    missingResultPolicy: row.missing_result_policy,
    publicPageTest: row.public_page_test_json ? JSON.parse(row.public_page_test_json) : null,
  });
}

/**
 * 編集設定を楽観ロック付きで保存する。公開版は webinar_versions に残し、
 * 同じ version の行を上書きしない。
 */
export async function saveWebinarEditorSettings(
  db: D1Database,
  webinarId: string,
  expectedVersion: number,
  patch: WebinarEditorSettingsInput,
): Promise<WebinarEditorSettings | null> {
  const existing = await getWebinarEditorSettings(db, webinarId);
  const now = jstNow();
  if (!existing) {
    if (expectedVersion !== 0) return null;
    await db.prepare(
      `INSERT INTO webinar_editor_settings
         (webinar_id, version, delivery_kind, viewing_condition_json, public_description,
          registration_form_id, notification_messages_json, notification_test_json,
          action_template_body, missing_result_policy, public_page_test_json,
          created_at, updated_at)
       VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      webinarId,
      patch.deliveryKind ?? 'on_demand',
      JSON.stringify(patch.viewingCondition ?? { kind: 'registered', label: '申込者向け' }),
      patch.publicDescription ?? '',
      patch.registrationFormId ?? null,
      JSON.stringify(patch.notificationMessages ?? {}),
      patch.notificationTest === undefined || patch.notificationTest === null
        ? null : JSON.stringify(patch.notificationTest),
      patch.actionTemplateBody ?? '',
      patch.missingResultPolicy ?? 'escalate',
      patch.publicPageTest === undefined || patch.publicPageTest === null
        ? null : JSON.stringify(patch.publicPageTest),
      now,
      now,
    ).run();
  } else {
    if (existing.version !== expectedVersion) return null;
    const result = await db.prepare(
      `UPDATE webinar_editor_settings
          SET version = version + 1,
              delivery_kind = ?, viewing_condition_json = ?, public_description = ?,
              registration_form_id = ?, notification_messages_json = ?,
              notification_test_json = ?, action_template_body = ?, missing_result_policy = ?,
              public_page_test_json = ?, updated_at = ?
        WHERE webinar_id = ? AND version = ?`,
    ).bind(
      patch.deliveryKind ?? existing.delivery_kind,
      JSON.stringify(patch.viewingCondition ?? JSON.parse(existing.viewing_condition_json)),
      patch.publicDescription ?? existing.public_description,
      patch.registrationFormId !== undefined ? patch.registrationFormId : existing.registration_form_id,
      JSON.stringify(patch.notificationMessages ?? JSON.parse(existing.notification_messages_json)),
      patch.notificationTest !== undefined
        ? (patch.notificationTest === null ? null : JSON.stringify(patch.notificationTest))
        : existing.notification_test_json,
      patch.actionTemplateBody ?? existing.action_template_body,
      patch.missingResultPolicy ?? existing.missing_result_policy,
      patch.publicPageTest !== undefined
        ? (patch.publicPageTest === null ? null : JSON.stringify(patch.publicPageTest))
        : existing.public_page_test_json,
      now,
      webinarId,
      expectedVersion,
    ).run();
    if ((result.meta.changes ?? 0) !== 1) return null;
  }
  const saved = await getWebinarEditorSettings(db, webinarId);
  if (!saved) return null;
  await db.prepare(
    `INSERT INTO webinar_versions
       (id, webinar_id, version, state, snapshot_json, created_at)
     VALUES (?, ?, ?, 'draft', ?, ?)`,
  ).bind(
    crypto.randomUUID(), webinarId, saved.version, webinarEditorSnapshot(saved), now,
  ).run();
  return saved;
}

export async function publishWebinarEditorVersion(
  db: D1Database,
  webinarId: string,
  expectedVersion: number,
): Promise<WebinarEditorSettings | null> {
  const settings = await getWebinarEditorSettings(db, webinarId);
  if (!settings || settings.version !== expectedVersion) return null;
  const now = jstNow();
  await db.batch([
    db.prepare(
      `UPDATE webinar_versions SET state = 'superseded'
       WHERE webinar_id = ? AND state = 'published'`,
    ).bind(webinarId),
    db.prepare(
      `UPDATE webinar_versions SET state = 'published', published_at = ?
       WHERE webinar_id = ? AND version = ?`,
    ).bind(now, webinarId, expectedVersion),
    db.prepare(
      `UPDATE webinar_editor_settings SET published_version = ?, published_at = ?, updated_at = ?
       WHERE webinar_id = ? AND version = ?`,
    ).bind(expectedVersion, now, now, webinarId, expectedVersion),
  ]);
  return getWebinarEditorSettings(db, webinarId);
}

/** 公開版の確定と公開状態への変更を同一 batch で行う。 */
export async function publishWebinarAndActivate(
  db: D1Database,
  webinarId: string,
  expectedVersion: number,
): Promise<boolean> {
  const now = jstNow();
  const result = await db.batch([
    db.prepare(`UPDATE webinars SET status='active',updated_at=?
      WHERE id=? AND status<>'archived' AND EXISTS (
        SELECT 1 FROM webinar_editor_settings s JOIN webinar_versions v
          ON v.webinar_id=s.webinar_id AND v.version=s.version
        WHERE s.webinar_id=webinars.id AND s.version=?)`).bind(now, webinarId, expectedVersion),
    db.prepare(`UPDATE webinar_editor_settings SET version=version+1,published_version=?,published_at=?,updated_at=?
      WHERE webinar_id=? AND version=? AND changes()=1`).bind(expectedVersion, now, now, webinarId, expectedVersion),
    db.prepare(`UPDATE webinar_versions SET
        state=CASE WHEN version=? THEN 'published' ELSE 'superseded' END,
        published_at=CASE WHEN version=? THEN ? ELSE published_at END
      WHERE webinar_id=? AND (version=? OR state='published') AND changes()=1`)
      .bind(expectedVersion, expectedVersion, now, webinarId, expectedVersion),
    db.prepare(`INSERT INTO webinar_versions(id,webinar_id,version,state,snapshot_json,created_at)
      SELECT ?,webinar_id,?,'draft',snapshot_json,? FROM webinar_versions
      WHERE webinar_id=? AND version=? AND changes()>0`)
      .bind(crypto.randomUUID(), expectedVersion + 1, now, webinarId, expectedVersion),
  ]);
  return Number(result[0].meta?.changes ?? 0) === 1;
}
