import { getFormAccountIds, formBelongsToLineAccount, isSecretLikeValue } from '@line-crm/db';
import { resolveMusuboCommonVarsAt } from '../../services/google-common-vars.js';
import { jstDate, type FormLayout, type FormReferenceDefinition, type PublicFormImage, type PublicFormReference, type PublicStoreInformation } from '@line-crm/shared';
import { storePhotoVisibility } from '../booking/booking-photos/index.js';
import { checkMediaGate } from '../../services/file-scan.js';
import { isWebinarSource, privateImageKey, publicImageKey } from '../../services/image-access.js';
import { verifyCallerLineIdentity } from '../../services/liff-auth.js';
import type { Env } from '../../worker-env.js';

type Bindings = Env['Bindings'];
type ImageReference = Extract<FormReferenceDefinition, { kind: 'image' }>;
type ImageVersion = { id: string; r2_key: string; mime_type: string; size_bytes: number; width: number; height: number; etag: string; filename: string };

export function adoptedFormReference(layout: FormLayout, blockId: string): FormReferenceDefinition | undefined {
  const reference = layout.references?.find(item => item.blockId === blockId);
  const owners = [...layout.header, ...layout.sections.flatMap(section => section.blocks)].filter(block => block.id === blockId);
  return reference && owners.length === 1 && owners[0]?.kind === (reference.kind === 'image' ? 'image' : 'text') ? reference : undefined;
}

/** queryのaccount_idや運用者ログインを、お客さまの店の証明にしない。 */
export async function formReferenceAccount(env: Bindings, formId: string, authorization?: string, verifiedAccountId?: string | null): Promise<string | null> {
  let accountId: string | null = verifiedAccountId ?? null;
  if (accountId) {
    if (!await formBelongsToLineAccount(env.DB, formId, accountId)) throw new FormReferenceAccessError();
  } else if (authorization) {
    const identity = await verifyCallerLineIdentity(authorization, env);
    if (!identity?.lineAccountId || !await formBelongsToLineAccount(env.DB, formId, identity.lineAccountId)) {
      throw new FormReferenceAccessError();
    }
    accountId = identity.lineAccountId;
  } else {
    const accounts = await getFormAccountIds(env.DB, formId);
    if (accounts.length === 1) accountId = accounts[0]!;
  }
  if (accountId && !await env.DB.prepare(`SELECT a.id FROM line_accounts a JOIN tenants t ON t.id=a.tenant_id
    WHERE a.id=? AND a.is_active=1 AND a.archived_at IS NULL AND t.status='active'`).bind(accountId).first()) {
    throw new FormReferenceAccessError();
  }
  return accountId;
}
export class FormReferenceAccessError extends Error {
  constructor() { super('form_reference_unavailable'); }
}

/** 固定した画像版だけを読む。親の停止と、選んだ版の隔離は別々に守る。 */
export async function formReferenceImage(env: Bindings, accountId: string, reference: ImageReference): Promise<ImageVersion | null> {
  const row = await env.DB.prepare(`SELECT v.id,v.r2_key,v.mime_type,v.size_bytes,v.width,v.height,v.etag,m.filename
    FROM media m JOIN media_versions v ON v.media_id=m.id
    WHERE m.id=? AND m.line_account_id=? AND m.kind='image' AND m.archived_at IS NULL
      AND (m.usage_expires_at IS NULL OR m.usage_expires_at>=?)
      AND v.version_no=? AND v.published_at IS NOT NULL AND v.scan_status='verified'`)
    .bind(reference.mediaId, accountId, jstDate(new Date()), reference.versionNo).first<ImageVersion>();
  if (!row || !row.etag || !Number.isSafeInteger(row.width) || row.width <= 0 || !Number.isSafeInteger(row.height) || row.height <= 0
    || !/^image\/(?:png|jpeg|gif|webp)$/.test(row.mime_type) || privateImageKey(row.r2_key) || !publicImageKey(row.r2_key)
    || await isWebinarSource(env.DB, row.r2_key)) return null;
  const photos = await env.DB.prepare(`SELECT bs.store_photo_media_id,bs.store_photo_interior_media_id,bs.store_photo_waiting_media_id,s.value
    FROM booking_settings bs LEFT JOIN account_settings s ON s.line_account_id=bs.line_account_id AND s.key='booking.store_photo_visibility'
    WHERE bs.line_account_id=?`).bind(accountId).first<{ store_photo_media_id: string | null; store_photo_interior_media_id: string | null; store_photo_waiting_media_id: string | null; value: string | null }>();
  if (photos) {
    const visibility = storePhotoVisibility(photos.value);
    if ((photos.store_photo_media_id === reference.mediaId && !visibility.exterior)
      || (photos.store_photo_interior_media_id === reference.mediaId && !visibility.interior)
      || (photos.store_photo_waiting_media_id === reference.mediaId && !visibility.waiting)) return null;
  }
  if (!env.IMAGES) return null;
  const gate = await checkMediaGate(env.DB, env.IMAGES, {
    id: reference.mediaId, lineAccountId: accountId, r2Key: row.r2_key, filename: row.filename,
    mimeType: row.mime_type, sizeBytes: row.size_bytes, width: row.width, height: row.height,
  });
  if (!gate.allowed) return null;
  const object = await env.IMAGES.head(row.r2_key);
  return object?.etag === row.etag.replace(/^"|"$/g, '') ? row : null;
}

function publicUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !/[\u0000-\u001f\\]/.test(value);
  } catch { return false; }
}
async function storeInformation(db: D1Database, accountId: string, reference: Extract<FormReferenceDefinition, { kind: 'store_information' }>): Promise<PublicStoreInformation | null> {
  const entries = Object.entries(reference.fields);
  if (!entries.length) return {};
  const resolved = await resolveMusuboCommonVarsAt(db, accountId, entries.map(([, source]) => source.varKey), new Date().toISOString());
  if (!resolved.ok) return null;
  const content: PublicStoreInformation = {};
  for (const [field, source] of entries) {
    const value = resolved.values[source.varKey];
    if (typeof value !== 'string' || value.length > 2000 || isSecretLikeValue(value)) return null;
    if (!value.trim()) continue;
    if (field === 'guideUrl' || field === 'mapUrl') {
      if (!publicUrl(value)) return null;
      content[field] = value;
    } else if (field === 'hours') content.hours = [{ label: '営業時間', text: value }];
    else if (field === 'displayName' || field === 'address' || field === 'phone') content[field] = value;
  }
  return content;
}

export async function resolveFormReferences(input: {
  env: Bindings; formId: string; formVersionId: string | null; layout: FormLayout; accountId: string | null;
  origin: string; reportError: (error: unknown) => unknown;
}): Promise<PublicFormReference[]> {
  const result: PublicFormReference[] = [];
  for (const reference of input.layout.references ?? []) {
    const base = { blockId: reference.blockId, kind: reference.kind };
    if (!adoptedFormReference(input.layout, reference.blockId)) { result.push({ ...base, state: 'unavailable' }); continue; }
    if (!input.accountId) { result.push({ ...base, state: 'context_required' }); continue; }
    try {
      if (reference.kind === 'image') {
        const image = input.formVersionId ? await formReferenceImage(input.env, input.accountId, reference) : null;
        if (!image) { result.push({ ...base, state: 'unavailable' }); continue; }
        const url = new URL(`/api/forms/${encodeURIComponent(input.formId)}/images/${encodeURIComponent(reference.blockId)}`, input.origin);
        url.searchParams.set('formVersionId', input.formVersionId!);
        const content: PublicFormImage = { url: url.toString(), alt: reference.alt, width: image.width, height: image.height, mimeType: image.mime_type, versionId: image.id };
        result.push({ blockId: reference.blockId, kind: 'image', state: 'ready', content });
      } else {
        const content = await storeInformation(input.env.DB, input.accountId, reference);
        result.push(content === null ? { ...base, state: 'unavailable' }
          : Object.keys(content).length ? { blockId: reference.blockId, kind: 'store_information', state: 'ready', content }
          : { ...base, state: 'empty' });
      }
    } catch (error) {
      await input.reportError(error);
      result.push({ ...base, state: 'retryable_error' });
    }
  }
  return result;
}

/** 公開レイアウトに元のID/キーや値の代用を残さない。 */
export function publicReferenceLayout(layout: FormLayout): FormLayout {
  const { references, ...rest } = layout;
  const ids = new Set(references?.map(reference => reference.blockId));
  const clean = (block: FormLayout['header'][number]) => !ids.has(block.id) ? block
    : block.kind === 'image' ? { id: block.id, kind: 'image' as const, mediaUrl: '', alt: block.alt, size: block.size }
    : block.kind === 'text' ? { id: block.id, kind: 'text' as const, text: '' } : block;
  return { ...rest, header: layout.header.map(clean), sections: layout.sections.map(section => ({ ...section, blocks: section.blocks.map(clean) })) };
}

/** 下書きの途中設定は許すが、別店の登録IDは保存しない。 */
export async function validateFormReferences(env: Bindings, accounts: string[], layout: FormLayout, publish: boolean): Promise<boolean> {
  for (const reference of layout.references ?? []) {
    if (reference.kind !== 'image') {
      if (publish) for (const accountId of accounts) {
        if (await storeInformation(env.DB, accountId, reference) === null) return false;
      }
      continue;
    }
    const owner = await env.DB.prepare(`SELECT m.line_account_id FROM media m JOIN media_versions v ON v.media_id=m.id
      WHERE m.id=? AND v.version_no=?`).bind(reference.mediaId, reference.versionNo).first<{ line_account_id: string }>();
    if (!owner || !accounts.includes(owner.line_account_id)) return false;
    if (publish && !await formReferenceImage(env, owner.line_account_id, reference)) return false;
  }
  return true;
}
