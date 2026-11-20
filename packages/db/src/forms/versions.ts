import { jstNow } from '../utils.js';
import { type FormVersionContent, type PublishFormVersionResult, type PublishedFormVersion } from './types.js';
import { getFormById } from './reads.js';
import { formMediaUsageStatements } from './media-references.js';


export async function getFormVersionContent(
  db: D1Database,
  versionId: string,
): Promise<FormVersionContent | null> {
  return db
    .prepare(
      `SELECT id, form_id, name, description, fields, layout,
              on_submit_tag_id, on_submit_scenario_id,
              on_submit_message_type, on_submit_message_content,
              on_submit_webhook_url, on_submit_webhook_headers,
              on_submit_webhook_fail_message, save_to_metadata
         FROM form_versions WHERE id = ?`,
    )
    .bind(versionId)
    .first<FormVersionContent>();
}

/** 一覧表示用に、版 id の束から中身をまとめて読む。 */
export async function getFormVersionContentsByIds(
  db: D1Database,
  versionIds: string[],
): Promise<Map<string, FormVersionContent>> {
  const unique = [...new Set(versionIds)].filter(Boolean);
  const versions = new Map<string, FormVersionContent>();
  if (unique.length === 0) return versions;
  const result = await db
    .prepare(
      `SELECT id, form_id, name, description, fields, layout,
              on_submit_tag_id, on_submit_scenario_id,
              on_submit_message_type, on_submit_message_content,
              on_submit_webhook_url, on_submit_webhook_headers,
              on_submit_webhook_fail_message, save_to_metadata
         FROM form_versions WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .bind(JSON.stringify(unique))
    .all<FormVersionContent>();
  for (const row of result.results) versions.set(row.id, row);
  return versions;
}

/** 編集中の1行を不変版へ写し、回答URLの参照先を原子的に切り替える。 */
export async function publishFormVersion(
  db: D1Database,
  id: string,
  expectedContentRevision: number,
): Promise<PublishFormVersionResult> {
  const existing = await getFormById(db, id);
  if (!existing) return { kind: 'not_found' };

  const current = existing.current_published_version_id
    ? await db.prepare(
        `SELECT id, form_id, version_number, source_content_revision, published_at
           FROM form_versions WHERE id = ? AND form_id = ?`,
      ).bind(existing.current_published_version_id, id).first<PublishedFormVersion>()
    : null;
  if (current?.source_content_revision === expectedContentRevision) {
    if (!existing.is_active) {
      await db.prepare(
        `UPDATE forms SET is_active = 1, revision = revision + 1, updated_at = ?
          WHERE id = ? AND current_published_version_id = ?`,
      ).bind(jstNow(), id, current.id).run();
    }
    return {
      kind: 'published', version: current, replayed: true,
      form: (await getFormById(db, id))!,
    };
  }
  if (existing.content_revision !== expectedContentRevision) {
    return { kind: 'conflict', form: existing };
  }

  const versionId = crypto.randomUUID();
  const now = jstNow();
  const results = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO form_versions (
         id, form_id, version_number, source_content_revision,
         name, description, fields, layout,
         on_submit_tag_id, on_submit_scenario_id,
         on_submit_message_type, on_submit_message_content,
         on_submit_webhook_url, on_submit_webhook_headers, on_submit_webhook_fail_message,
         save_to_metadata, og_title, og_description, og_image_url,
         status, published_at, created_at
       )
       SELECT ?, f.id,
              COALESCE((SELECT MAX(v.version_number) FROM form_versions v WHERE v.form_id = f.id), 0) + 1,
              f.content_revision,
              f.name, f.description, f.fields, f.layout,
              f.on_submit_tag_id, f.on_submit_scenario_id,
              f.on_submit_message_type, f.on_submit_message_content,
              f.on_submit_webhook_url, f.on_submit_webhook_headers, f.on_submit_webhook_fail_message,
              f.save_to_metadata, f.og_title, f.og_description, f.og_image_url,
              'published', ?, ?
         FROM forms f
        WHERE f.id = ? AND f.status = 'active' AND f.content_revision = ?`,
    ).bind(versionId, now, now, id, expectedContentRevision),
    db.prepare(
      `UPDATE forms
          SET current_published_version_id = ?, is_active = 1,
              revision = revision + 1, updated_at = ?
        WHERE id = ? AND content_revision = ?
          AND EXISTS (
            SELECT 1 FROM form_versions v
             WHERE v.id = ? AND v.form_id = forms.id
               AND v.source_content_revision = forms.content_revision
          )`,
    ).bind(versionId, now, id, expectedContentRevision, versionId),
    db.prepare(`INSERT INTO form_version_common_var_pins(form_version_id,common_var_id,version_id)
      SELECT ?, p.common_var_id, p.version_id FROM form_common_var_pins p
      WHERE p.form_id=? AND EXISTS (SELECT 1 FROM form_versions WHERE id=? AND form_id=?)`)
      .bind(versionId, id, versionId, id),
    ...formMediaUsageStatements(db, id),
  ]);

  if ((results[1]?.meta?.changes ?? 0) === 1) {
    const version = await db.prepare(
      `SELECT id, form_id, version_number, source_content_revision, published_at
         FROM form_versions WHERE id = ?`,
    ).bind(versionId).first<PublishedFormVersion>();
    const form = await getFormById(db, id);
    if (version && form) return { kind: 'published', version, replayed: false, form };
  }

  // 同じ編集版の二重公開は UNIQUE(form_id, source_content_revision) で1版になる。
  const raced = await db.prepare(
    `SELECT v.id, v.form_id, v.version_number, v.source_content_revision, v.published_at
       FROM form_versions v
       JOIN forms f ON f.current_published_version_id = v.id
      WHERE v.form_id = ? AND v.source_content_revision = ?`,
  ).bind(id, expectedContentRevision).first<PublishedFormVersion>();
  const latest = await getFormById(db, id);
  if (raced && latest) {
    return { kind: 'published', version: raced, replayed: true, form: latest };
  }
  return latest ? { kind: 'conflict', form: latest } : { kind: 'not_found' };
}
