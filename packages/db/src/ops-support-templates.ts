import { jstNow, toJstString } from './utils.js';

const FOLDER_PREFIX = 'ops.support.reply.folder:';
const TEMPLATE_PREFIX = 'ops.support.reply.template:';

export const DEFAULT_SUPPORT_TEMPLATE_FOLDERS = [
  { id: 'contracts', name: '契約・解約' },
  { id: 'usage', name: '使い方・操作' },
  { id: 'billing', name: '請求・支払い' },
  { id: 'line', name: 'LINE連携・配信' },
  { id: 'incident', name: '不具合・障害' },
  { id: 'other', name: 'その他' },
] as const;

export type SupportTemplateFolder = { id: string; name: string };
export type SupportReplyTemplate = { id: string; folderId: string; title: string; body: string; createdAt: string; updatedAt: string; archivedAt?: string };
export type SupportTemplateMutation =
  | { status: 'ok'; template: SupportReplyTemplate }
  | { status: 'missing' }
  | { status: 'conflict' }
  | { status: 'folder_missing' };

function parseRow<T>(raw: string): T | null {
  try { return JSON.parse(raw) as T; } catch { return null; }
}

export async function listSupportTemplateCatalog(db: D1Database): Promise<{ folders: SupportTemplateFolder[]; templates: SupportReplyTemplate[] }> {
  const [folderRows, templateRows] = await Promise.all([
    db.prepare('SELECT value FROM platform_settings WHERE key LIKE ? ORDER BY updated_at ASC').bind(`${FOLDER_PREFIX}%`).all<{ value: string }>(),
    db.prepare('SELECT value FROM platform_settings WHERE key LIKE ? ORDER BY updated_at DESC').bind(`${TEMPLATE_PREFIX}%`).all<{ value: string }>(),
  ]);
  const folders: SupportTemplateFolder[] = [...DEFAULT_SUPPORT_TEMPLATE_FOLDERS];
  for (const row of folderRows.results ?? []) {
    const folder = parseRow<SupportTemplateFolder>(row.value);
    if (folder && typeof folder.id === 'string' && typeof folder.name === 'string') folders.push(folder);
  }
  const folderIds = new Set(folders.map((folder) => folder.id));
  const templates: SupportReplyTemplate[] = [];
  for (const row of templateRows.results ?? []) {
    const template = parseRow<SupportReplyTemplate>(row.value);
    if (template && typeof template.id === 'string' && typeof template.title === 'string' && typeof template.body === 'string' && !template.archivedAt && folderIds.has(template.folderId)) templates.push(template);
  }
  return { folders, templates };
}

export async function createSupportTemplateFolder(db: D1Database, name: string, staffId: string): Promise<SupportTemplateFolder | null> {
  const catalog = await listSupportTemplateCatalog(db);
  const normalized = name.normalize('NFKC').toLocaleLowerCase('ja-JP');
  if (catalog.folders.some((folder) => folder.name.normalize('NFKC').toLocaleLowerCase('ja-JP') === normalized)) return null;
  const folder: SupportTemplateFolder = { id: `custom:${encodeURIComponent(normalized)}`, name };
  const result = await db.prepare('INSERT OR IGNORE INTO platform_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)')
    .bind(`${FOLDER_PREFIX}${folder.id}`, JSON.stringify(folder), staffId, jstNow()).run();
  return result.meta.changes === 1 ? folder : null;
}

export async function createSupportReplyTemplate(db: D1Database, input: { folderId: string; title: string; body: string }, staffId: string): Promise<SupportReplyTemplate | null> {
  const catalog = await listSupportTemplateCatalog(db);
  if (!catalog.folders.some((folder) => folder.id === input.folderId)) return null;
  const now = jstNow();
  const template: SupportReplyTemplate = { id: crypto.randomUUID(), ...input, createdAt: now, updatedAt: now };
  await db.prepare('INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)')
    .bind(`${TEMPLATE_PREFIX}${template.id}`, JSON.stringify(template), staffId, now).run();
  return template;
}

export async function updateSupportReplyTemplate(
  db: D1Database,
  id: string,
  input: { folderId: string; title: string; body: string; expectedUpdatedAt: string },
  staffId: string,
): Promise<SupportTemplateMutation> {
  const key = `${TEMPLATE_PREFIX}${id}`;
  const row = await db.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(key).first<{ value: string }>();
  if (!row) return { status: 'missing' };
  const current = parseRow<SupportReplyTemplate>(row.value);
  if (!current || current.id !== id || current.archivedAt) return { status: 'missing' };
  if (current.updatedAt !== input.expectedUpdatedAt) return { status: 'conflict' };
  const catalog = await listSupportTemplateCatalog(db);
  if (!catalog.folders.some((folder) => folder.id === input.folderId)) return { status: 'folder_missing' };
  const nextTimestamp = toJstString(new Date(Math.max(Date.now(), new Date(current.updatedAt).getTime() + 1)));
  const template: SupportReplyTemplate = {
    ...current, folderId: input.folderId, title: input.title, body: input.body, updatedAt: nextTimestamp,
  };
  const result = await db.prepare('UPDATE platform_settings SET value = ?, updated_by = ?, updated_at = ? WHERE key = ? AND value = ?')
    .bind(JSON.stringify(template), staffId, template.updatedAt, key, row.value).run();
  return result.meta.changes === 1 ? { status: 'ok', template } : { status: 'conflict' };
}

export async function deleteSupportReplyTemplate(
  db: D1Database,
  id: string,
  expectedUpdatedAt: string,
  staffId: string,
): Promise<'deleted' | 'missing' | 'conflict'> {
  const key = `${TEMPLATE_PREFIX}${id}`;
  const row = await db.prepare('SELECT value FROM platform_settings WHERE key = ?').bind(key).first<{ value: string }>();
  if (!row) return 'missing';
  const current = parseRow<SupportReplyTemplate>(row.value);
  if (!current || current.id !== id || current.archivedAt) return 'missing';
  if (current.updatedAt !== expectedUpdatedAt) return 'conflict';
  const archivedAt = toJstString(new Date(Math.max(Date.now(), new Date(current.updatedAt).getTime() + 1)));
  const archived: SupportReplyTemplate = { ...current, archivedAt, updatedAt: archivedAt };
  const result = await db.prepare('UPDATE platform_settings SET value = ?, updated_by = ?, updated_at = ? WHERE key = ? AND value = ?')
    .bind(JSON.stringify(archived), staffId, archivedAt, key, row.value).run();
  return result.meta.changes === 1 ? 'deleted' : 'conflict';
}
