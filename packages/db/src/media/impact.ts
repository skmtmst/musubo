import type { MediaDeleteImpact, MediaDeleteImpactReference, MediaDeleteImpactReferenceKind, MediaReplacementBlocker, MediaReplacementImpact, MediaReplacementReference } from '@line-crm/shared';
import { type MediaUsage, type NamedReference, type MediaDeleteImpactSnapshot, type MediaReplacementPlan } from './types.js';
import { isMissingTableError, getMediaById } from './definitions.js';
import { type Media } from './primitives.js';


/**
 * 使用箇所。
 *
 * 削除する前に「5か所で使われています」と出すための表。
 * 対応済みの保存経路では本文と同じ原子処理で更新し、走査は旧データや
 * 一時的な欠損を補修する安全網としてだけ残す。
 */
export async function getMediaUsages(db: D1Database, mediaId: string): Promise<MediaUsage[]> {
  const result = await db
    .prepare(`SELECT * FROM media_usages WHERE media_id = ? ORDER BY ref_kind ASC, ref_id ASC`)
    .bind(mediaId)
    .all<MediaUsage>();
  return result.results;
}

export async function countMediaUsages(db: D1Database, mediaId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS c FROM media_usages WHERE media_id = ?`)
    .bind(mediaId)
    .first<{ c: number }>();
  return Number(row?.c ?? 0);
}

export function belongsToAccount(row: NamedReference, lineAccountId: string): boolean {
  if (row.account_id === lineAccountId) return true;
  if (!row.account_ids) return false;
  try {
    const ids = JSON.parse(row.account_ids) as unknown;
    return Array.isArray(ids) && ids.includes(lineAccountId);
  } catch {
    // 壊れたJSONを「このアカウントのもの」と推測して見せない。
    return false;
  }
}

export function accountIdsOf(row: NamedReference): string[] {
  const result = new Set<string>();
  if (row.account_id) result.add(row.account_id);
  if (!row.account_ids) return [...result];
  try {
    const ids = JSON.parse(row.account_ids) as unknown;
    if (Array.isArray(ids)) {
      for (const value of ids) if (typeof value === 'string') result.add(value);
    }
  } catch {
    // 壊れたJSONはaccount_idだけを残す。describe側で正本不明として止める。
  }
  return [...result];
}

export async function describeMediaUsage(
  db: D1Database,
  usage: MediaUsage,
  lineAccountId: string,
): Promise<MediaDeleteImpactReference> {
  try {
    return await describeMediaUsageInner(db, usage, lineAccountId);
  } catch (err) {
    // 表そのものが無い読み口は、その参照だけ「未確認」に倒す。全体を
    // 503にすると、どの画像でも取得が失敗する。参照自体は落とさず
    // 残すため、削除は止まったままになる。
    if (!isMissingTableError(err)) throw err;
    return {
      kind: usage.ref_kind as MediaDeleteImpactReferenceKind,
      name: null,
      href: null,
      state: 'unavailable',
      scannedAt: usage.scanned_at,
    };
  }
}

export async function describeMediaUsageInner(
  db: D1Database,
  usage: MediaUsage,
  lineAccountId: string,
): Promise<MediaDeleteImpactReference> {
  let row: NamedReference | null = null;
  let href: string | null = null;

  switch (usage.ref_kind as MediaDeleteImpactReferenceKind) {
    case 'form':
      row = await db.prepare(`SELECT f.name,? AS account_id FROM forms f JOIN form_accounts fa ON fa.form_id=f.id
        WHERE f.id=? AND fa.line_account_id=?`).bind(lineAccountId, usage.ref_id, lineAccountId).first<NamedReference>();
      href = `/form-submissions/edit?id=${encodeURIComponent(usage.ref_id)}`;
      break;
    case 'template':
      row = await db.prepare(
        `SELECT name, line_account_id AS account_id, NULL AS asset_kind FROM templates WHERE id = ?
         UNION ALL SELECT name, line_account_id AS account_id, kind AS asset_kind
           FROM broadcast_message_assets WHERE id = ?`,
      ).bind(usage.ref_id, usage.ref_id).first<NamedReference>();
      if (row && belongsToAccount(row, lineAccountId)) {
        href = row.asset_kind === 'card_message'
          ? `/templates/carousel/edit?id=${encodeURIComponent(usage.ref_id)}`
          : `/templates/edit?${row.asset_kind ? `kind=${encodeURIComponent(row.asset_kind)}&` : ''}id=${encodeURIComponent(usage.ref_id)}`;
      }
      break;
    case 'broadcast':
      row = await db.prepare(
        `SELECT title AS name, line_account_id AS account_id, account_ids
           FROM broadcasts WHERE id = ?`,
      ).bind(usage.ref_id).first<NamedReference>();
      if (row && belongsToAccount(row, lineAccountId)) {
        href = `/broadcasts/detail?id=${encodeURIComponent(usage.ref_id)}`;
      }
      break;
    case 'rich_menu':
      row = await db.prepare(
        `SELECT g.name || '・' || p.name AS name, g.account_id AS account_id,
                g.id AS owner_id
           FROM rich_menu_pages p
           JOIN rich_menu_groups g ON g.id = p.group_id
          WHERE p.id = ?`,
      ).bind(usage.ref_id).first<NamedReference>();
      if (row && row.owner_id && belongsToAccount(row, lineAccountId)) {
        href = `/rich-menus/edit?id=${encodeURIComponent(row.owner_id)}`;
      }
      break;
    case 'scenario_step':
      row = await db.prepare(
        `SELECT s.name || '・' || (ss.step_order + 1) || '通目' AS name,
                s.line_account_id AS account_id, s.id AS owner_id
           FROM scenario_steps ss
           JOIN scenarios s ON s.id = ss.scenario_id
          WHERE ss.id = ?`,
      ).bind(usage.ref_id).first<NamedReference>();
      if (row && row.owner_id && belongsToAccount(row, lineAccountId)) {
        href = `/scenarios/detail?id=${encodeURIComponent(row.owner_id)}`;
      }
      break;
    case 'nen_column':
      row = await db.prepare(
        `SELECT title AS name, line_account_id AS account_id FROM nen_columns WHERE id = ?`,
      ).bind(usage.ref_id).first<NamedReference>();
      if (row && belongsToAccount(row, lineAccountId)) href = '/nen-campaigns?tab=columns';
      break;
    case 'event':
      row = await db.prepare(
        `SELECT name, line_account_id AS account_id, account_ids FROM events WHERE id = ?`,
      ).bind(usage.ref_id).first<NamedReference>();
      if (row && belongsToAccount(row, lineAccountId)) {
        href = `/events/edit?id=${encodeURIComponent(usage.ref_id)}`;
      }
      break;
    case 'webinar':
      row = await db.prepare(
        `SELECT title AS name, account_id FROM webinars WHERE id = ?`,
      ).bind(usage.ref_id).first<NamedReference>();
      if (row && belongsToAccount(row, lineAccountId)) {
        href = `/webinars/edit?id=${encodeURIComponent(usage.ref_id)}`;
      }
      break;
    case 'booking_menu':
      row = await db.prepare('SELECT name,line_account_id AS account_id FROM menus WHERE id=? AND deleted_at IS NULL')
        .bind(usage.ref_id).first<NamedReference>();
      href = '/booking/menus?tab=photos';
      break;
    case 'booking_staff':
      row = await db.prepare('SELECT display_name AS name,line_account_id AS account_id FROM staff WHERE id=? AND deleted_at IS NULL')
        .bind(usage.ref_id).first<NamedReference>();
      href = '/booking/menus?tab=photos';
      break;
    case 'booking_settings':
      row = await db.prepare(`SELECT la.name,bs.line_account_id AS account_id FROM booking_settings bs
        JOIN line_accounts la ON la.id=bs.line_account_id WHERE bs.id=?`).bind(usage.ref_id).first<NamedReference>();
      href = '/booking/menus?tab=photos';
      break;
    default:
      // DBのCHECKに無い値も、詳細不明の参照として削除を止める。
      break;
  }

  const available = row !== null && belongsToAccount(row, lineAccountId);
  return {
    kind: usage.ref_kind as MediaDeleteImpactReferenceKind,
    name: available ? row?.name ?? null : null,
    href: available ? href : null,
    state: available ? 'available' : 'unavailable',
    scannedAt: usage.scanned_at,
  };
}

/** 飲食のメニューは専用列を正本として直接照合する。別アカウントの名称を伏せる。 */
async function restaurantMenuReferences(db: D1Database, mediaId: string, lineAccountId: string, checkedAt: string): Promise<MediaDeleteImpactReference[]> {
  const rows = await db.prepare(`SELECT m.id, m.name, s.line_account_id FROM rt_menu_items m
    JOIN rt_stores s ON s.id = m.store_id WHERE m.image_media_id = ? OR EXISTS (
      SELECT 1 FROM json_each(m.photo_gallery_json) photo WHERE json_extract(photo.value, '$.mediaId') = ?
    )`).bind(mediaId, mediaId)
    .all<{id:string; name:string; line_account_id:string|null}>();
  return rows.results.map(row => ({ kind:'restaurant_menu', name:row.line_account_id === lineAccountId ? row.name : null,
    href:row.line_account_id === lineAccountId ? `/restaurant-test/menu/edit?id=${encodeURIComponent(row.id)}` : null,
    state:row.line_account_id === lineAccountId ? 'available' : 'unavailable', scannedAt:checkedAt }));
}

/**
 * 登録メディアを消す直前の影響。
 *
 * `media_usages` を件数だけでなく現在の各台帳へ照合する。参照先が消えていたり
 * 別アカウントだったりして名前を安全に返せない場合も、その参照自体は落とさず
 * unavailable として削除を止める。
 */
export async function getMediaDeleteImpactSnapshot(
  db: D1Database,
  mediaId: string,
  lineAccountId: string,
  checkedAt: string,
): Promise<MediaDeleteImpactSnapshot | null> {
  const media = await getMediaById(db, mediaId, lineAccountId);
  if (!media) return null;

  const usages = await getMediaUsages(db, mediaId);
  const references = await Promise.all(
    usages.map((usage) => describeMediaUsage(db, usage, lineAccountId)),
  );
  references.push(...await restaurantMenuReferences(db, mediaId, lineAccountId, checkedAt));
  const lastScannedAt = references.reduce<string | null>(
    (latest, reference) => latest === null || reference.scannedAt > latest
      ? reference.scannedAt
      : latest,
    null,
  );

  return {
    usages,
    impact: {
      media: {
        id: media.id,
        filename: media.filename,
        kind: media.kind as MediaDeleteImpact['media']['kind'],
      },
      usageCount: references.length,
      references,
      checkedAt,
      lastScannedAt,
      // 台帳の読み切りはここで確定する。走査の読み残し（表が無い読み口）は
      // 呼び出し側（Workerの口）が走査結果から判定して上書きする。
      verified: true,
      canDelete: references.length === 0,
      recommendedAction: references.length === 0 ? 'delete' : 'review_references',
    },
  };
}

/** 既存の削除口用。参照IDが必要な画面は snapshot 版を使う。 */
export async function getMediaDeleteImpact(
  db: D1Database,
  mediaId: string,
  lineAccountId: string,
  checkedAt: string,
): Promise<MediaDeleteImpact | null> {
  return (await getMediaDeleteImpactSnapshot(db, mediaId, lineAccountId, checkedAt))?.impact ?? null;
}

export async function describeMediaReplacementUsage(
  db: D1Database,
  usage: MediaUsage,
  lineAccountId: string,
): Promise<MediaReplacementReference> {
  const described = await describeMediaUsage(db, usage, lineAccountId);
  if (described.state === 'unavailable') {
    return {
      ...described,
      replaceable: false,
      blocker: 'unavailable_reference',
      reason: '使用先の正本を確認できないため、一括では差し替えられません。',
    };
  }
  if (usage.ref_kind === 'template') {
    const asset = await db.prepare(
      'SELECT id FROM broadcast_message_assets WHERE id = ? AND line_account_id = ?',
    ).bind(usage.ref_id, lineAccountId).first();
    if (asset) return {
      ...described,
      replaceable: false,
      blocker: 'unsupported_reference',
      reason: 'この種類のテンプレートは編集画面で画像を変更してください。',
    };
  }
  if (usage.ref_kind === 'form') {
    return { ...described, replaceable: false, blocker: 'unsupported_reference', reason: 'フォームの画像はフォームを編集して再公開してください。公開中の版は書き換えません。' };
  }
  if (usage.ref_kind === 'booking_menu' || usage.ref_kind === 'booking_staff' || usage.ref_kind === 'booking_settings') {
    return { ...described, replaceable: false, blocker: 'unsupported_reference', reason: '予約の写真は予約設定の「写真」から替えてください。' };
  }
  if (usage.ref_kind === 'webinar') {
    return {
      ...described,
      replaceable: false,
      blocker: 'unsupported_reference',
      reason: 'ウェビナー動画は配信用の一式を持つため、このファイルだけを差し替えられません。',
    };
  }
  if (usage.ref_kind === 'broadcast' || usage.ref_kind === 'event') {
    const table = usage.ref_kind === 'broadcast' ? 'broadcasts' : 'events';
    const row = await db.prepare(
      `SELECT line_account_id AS account_id, account_ids, '' AS name FROM ${table} WHERE id = ?`,
    ).bind(usage.ref_id).first<NamedReference>();
    const accounts = row ? accountIdsOf(row) : [];
    if (accounts.some((id) => id !== lineAccountId)) {
      return {
        ...described,
        replaceable: false,
        blocker: 'shared_reference',
        reason: '複数のLINEアカウントで共有しているため、この画面からは差し替えません。',
      };
    }
  }
  return { ...described, replaceable: true, blocker: null, reason: null };
}

/**
 * 使用中メディアを別の登録メディアへ差し替える前の計画。
 *
 * source / replacement は同じLINEアカウントで引く。参照不明・共有参照・
 * ウェビナー動画を含む場合でも、全部替わったと誤認させないよう
 * 「置換できる箇所だけ」を選べるようにする。
 * そのため影響には、差し替えられない使用先の件数と種類別内訳も載せる。
 * `canReplace` は全件一括、`canPartiallyReplace` は部分実行の可否。
 * 差し替え元と先の組み合わせ自体が不正な場合（同一・種類違い）は
 * 部分実行も認めない。
 */
export async function getMediaReplacementPlan(
  db: D1Database,
  input: {
    sourceId: string;
    replacementId: string;
    lineAccountId: string;
    checkedAt: string;
  },
): Promise<MediaReplacementPlan | null> {
  const [source, replacement] = await Promise.all([
    getMediaById(db, input.sourceId, input.lineAccountId),
    getMediaById(db, input.replacementId, input.lineAccountId),
  ]);
  if (!source || !replacement) return null;

  const usages = await getMediaUsages(db, source.id);
  const references = await Promise.all(
    usages.map((usage) => describeMediaReplacementUsage(db, usage, input.lineAccountId)),
  );
  const menuReferences = await restaurantMenuReferences(db, source.id, input.lineAccountId, input.checkedAt);
  references.push(...menuReferences.map(reference => ({ ...reference, replaceable:false, blocker:'unsupported_reference' as const, reason:'飲食メニューの編集画面で画像を変更してください。' })));
  const blockers = new Set<MediaReplacementBlocker>();
  if (source.id === replacement.id) blockers.add('same_media');
  if (source.kind !== replacement.kind) blockers.add('different_kind');
  for (const reference of references) if (reference.blocker) blockers.add(reference.blocker);

  const replaceableCount = references.filter((reference) => reference.replaceable).length;
  const blockedByKind: Partial<Record<MediaDeleteImpactReferenceKind, number>> = {};
  for (const reference of references) {
    if (reference.replaceable) continue;
    blockedByKind[reference.kind] = (blockedByKind[reference.kind] ?? 0) + 1;
  }
  const mediaPairBlocked = blockers.has('same_media') || blockers.has('different_kind');

  const mediaSummary = (media: Media): MediaReplacementImpact['source'] => ({
    id: media.id,
    filename: media.filename,
    kind: media.kind as MediaReplacementImpact['source']['kind'],
  });
  return {
    source,
    replacement,
    usages,
    impact: {
      source: mediaSummary(source),
      replacement: mediaSummary(replacement),
      usageCount: references.length,
      replaceableCount,
      blockedCount: references.length - replaceableCount,
      blockedByKind,
      references,
      blockers: [...blockers],
      canReplace: blockers.size === 0,
      canPartiallyReplace: !mediaPairBlocked && menuReferences.length === 0 && replaceableCount > 0,
      checkedAt: input.checkedAt,
    },
  };
}
