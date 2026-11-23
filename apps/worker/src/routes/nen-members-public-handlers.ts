import { jstDate as japanDate, jstDateOffset as japanDateOffset } from '@line-crm/shared';
import { tracedFetch as fetch, logger } from '@line-crm/shared/server';
import { sqlIdSet } from '@line-crm/db/id-queries';
import { inputError } from '../lib/input-errors.js';
import { fail } from '../lib/fail.js';
import { jstNow } from '@line-crm/db';
import type { Env } from '../worker-env.js';
import { currentFriend } from '../services/nen-member-identity.js';
import { imageDimensions, stripImageMetadata } from '../features/media/media-metadata/index.js';
import { runBuiltinScanAndStore } from '../services/file-scan.js';
import { ensureFileScanForUpload } from './file-scan.js';
import { ACTIVITY_LABELS, nenProducts, planForPetRow, refreshStoredFeeding } from '../services/nen-feeding.js';
import { APPETITE_LABELS, STOOL_LABELS, isCareStoolStatus, thirtyDaySummary, type HealthLogRow } from '../services/nen-health-admin.js';
import { petCallName, petGender } from '../services/nen-pet-name.js';
import { toPetAnimalType } from '../lib/nen-pet-species.js';
import { normalizeNenPetBirthday } from '../lib/nen-pet-birthday.js';
import { syncNenHealthTags, syncNenPetTags, syncNenPhotoTags } from '../services/nen-tag-sync.js';
import { buildMembership, accountFeedingProducts, mapPet, feedingProductsView, nenProductsView, CONCERNS, feedingGuide, petFeedingInput, decodeJpegData, pushPetCard, dateOnly, IMAGE_TYPES, detectedImageMime, ensureConsentedPhotoSitePublication, adminAccountScope } from './nen-members-definition.js';
import type { Context } from 'hono';

export const get__api_liff_nen_member_1 = async (c: Context<Env, "/api/liff/nen/member">) => {
  const friend = await currentFriend(c);
  if (!friend) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const [pets, snapshot, photos, photoStats, consultations] = await Promise.all([
    c.env.DB.prepare(`SELECT * FROM nen_pet_profiles WHERE archived_at IS NULL AND friend_id = ? ORDER BY created_at`).bind(friend.id).all<Record<string, unknown>>(),
    c.env.DB.prepare(`SELECT * FROM nen_ec_member_snapshots WHERE friend_id = ?`).bind(friend.id).first<Record<string, unknown>>(),
    c.env.DB.prepare(`SELECT ps.id, ps.pet_id, CASE WHEN EXISTS(SELECT 1 FROM media_file_scans scan WHERE scan.subject_kind='photo' AND scan.subject_id=ps.id AND scan.line_account_id=ps.line_account_id AND scan.status='clean') THEN ps.image_url ELSE NULL END AS image_url, ps.caption, ps.status, ps.awarded_points,
      ps.publication_consent_at, ps.publication_withdrawn_at, ps.public_pet_name,
      ps.created_at, p.name pet_name,
      COALESCE((SELECT pub.status FROM nen_photo_publications pub WHERE pub.photo_id=ps.id AND pub.line_account_id=ps.line_account_id),'unpublished') AS publication_status,
      EXISTS(SELECT 1 FROM nen_photo_publications pub JOIN nen_photo_publication_placements place ON place.publication_id=pub.id AND place.line_account_id=pub.line_account_id
        WHERE pub.photo_id=ps.id AND pub.line_account_id=ps.line_account_id AND pub.status='published' AND place.placement_type='site' AND place.active=1
          AND ps.publication_consent_at IS NOT NULL AND ps.publication_withdrawn_at IS NULL) AS site_published
      FROM nen_photo_submissions ps JOIN nen_pet_profiles p ON p.id = ps.pet_id
      WHERE ps.friend_id = ?
      ORDER BY ps.created_at DESC LIMIT 30`).bind(friend.id).all<Record<string, unknown>>(),
    c.env.DB.prepare(`SELECT COUNT(*) submitted_count,
      SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending_count,
      SUM(CASE WHEN status='adopted' THEN 1 ELSE 0 END) adopted_count,
      SUM(CASE WHEN status='adopted' THEN awarded_points ELSE 0 END) earned_points
      FROM nen_photo_submissions WHERE friend_id = ?`).bind(friend.id).first<Record<string, unknown>>(),
    c.env.DB.prepare(`SELECT id, pet_id, topic, result_text, tag_name, created_at FROM nen_consultation_logs_v2 WHERE friend_id = ? ORDER BY created_at DESC LIMIT 20`).bind(friend.id).all<Record<string, unknown>>(),
  ]);
  const membership = await buildMembership(c.env.DB, friend.line_account_id, snapshot);
  const catalog = await accountFeedingProducts(c, friend);
  const feedingProducts = catalog.products;
  return c.json({ success: true, data: {
    owner: { displayName: friend.display_name, customerId: snapshot?.customer_id || null },
    membership,
    pets: pets.results.map((row) => mapPet(row, feedingProducts, catalog.treatLimitPercent)),
    feedingProducts: feedingProductsView(feedingProducts),
    nenProducts: nenProductsView(feedingProducts),
    treatLimitPercent: catalog.treatLimitPercent,
    activityLabels: ACTIVITY_LABELS,
    commerce: snapshot ? {
      orders: JSON.parse(String(snapshot.orders_json || '[]')),
      subscription: snapshot.subscription_json ? JSON.parse(String(snapshot.subscription_json)) : null,
      purchaseCount: snapshot.purchase_count, purchaseAmount: snapshot.purchase_amount,
      points: snapshot.point_balance, rank: membership.rankName, syncedAt: snapshot.synced_at,
    } : { orders: [], subscription: null, purchaseCount: 0, purchaseAmount: 0, points: 0, rank: '未設定', syncedAt: null },
    photos: photos.results.map((r) => ({
      id: r.id, petId: r.pet_id, petName: r.pet_name, imageUrl: r.image_url,
      caption: r.caption, status: r.status, awardedPoints: r.awarded_points,
      publicationConsent: Boolean(r.publication_consent_at) && !r.publication_withdrawn_at,
      publicationStatus: String(r.publication_status ?? 'unpublished'),
      sitePublished: r.site_published === 1,
      publicPetName: r.public_pet_name === 1,
      createdAt: r.created_at,
    })),
    photoStats: {
      submittedCount: Number(photoStats?.submitted_count || 0),
      pendingCount: Number(photoStats?.pending_count || 0),
      adoptedCount: Number(photoStats?.adopted_count || 0),
      earnedPoints: Number(photoStats?.earned_points || 0),
    },
    consultations: consultations.results,
  } });
};

export const get__api_public_nen_adopted_photos_2 = async (c: Context<Env, "/api/public/nen/adopted-photos">) => {
  const requestedLineAccountId = c.req.query('lineAccountId')?.trim() ?? '';
  const officialAccountBasicId = c.req.query('officialAccountBasicId')?.trim() ?? '';
  if (!requestedLineAccountId && !officialAccountBasicId) {
    return fail(c, 400, 'LINE_ACCOUNT_ID_OR_OFFICIAL_ACCOUNT_BASIC_ID_IS_REQUIRED');
  }

  let lineAccountId = requestedLineAccountId;
  if (officialAccountBasicId) {
    const accounts = await c.env.DB.prepare(
      `SELECT id FROM line_accounts
        WHERE line_basic_id = ? AND is_active = 1 AND archived_at IS NULL
        ORDER BY id LIMIT 2`,
    ).bind(officialAccountBasicId).all<{ id: string }>();
    if (accounts.results.length !== 1) {
      return fail(c, 404, 'LINE_ACCOUNT_NOT_FOUND');
    }
    const resolvedLineAccountId = String(accounts.results[0].id);
    if (lineAccountId && lineAccountId !== resolvedLineAccountId) {
      return c.json({ success: false, error: 'LINE account selectors do not match' }, 400);
    }
    lineAccountId = resolvedLineAccountId;
  }

  const rows = await c.env.DB.prepare(`SELECT ps.id, ps.public_image_url AS image_url, ps.caption, ps.reviewed_at,
      CASE WHEN ps.public_pet_name = 1 THEN p.name ELSE NULL END pet_name
    FROM nen_photo_submissions ps
    JOIN nen_pet_profiles p ON p.id = ps.pet_id
    JOIN friends f ON f.id = ps.friend_id
    WHERE ps.status = 'adopted'
      AND ps.line_account_id = ? AND f.line_account_id = ?
      AND ps.publication_consent_at IS NOT NULL
      AND ps.publication_withdrawn_at IS NULL
      AND ps.public_image_url IS NOT NULL
      AND EXISTS (
        SELECT 1
          FROM nen_photo_publications pub
          JOIN nen_photo_publication_placements placement
            ON placement.publication_id = pub.id
           AND placement.line_account_id = pub.line_account_id
         WHERE pub.photo_id = ps.id
           AND pub.line_account_id = ps.line_account_id
           AND pub.status = 'published'
           AND pub.withdrawn_at IS NULL
           AND placement.placement_type = 'site'
           AND placement.active = 1
           AND placement.removed_at IS NULL
      )
    ORDER BY (SELECT sort_order FROM nen_photo_publications WHERE photo_id=ps.id), ps.reviewed_at DESC, ps.created_at DESC LIMIT 24`)
    .bind(lineAccountId, lineAccountId).all<Record<string, unknown>>();
  const origin = c.req.header('Origin') || '';
  const allowed = new Set(['https://stg.nen-petfood.com', 'https://nen-petfood.com', 'https://www.nen-petfood.com']);
  if (allowed.has(origin)) c.header('Access-Control-Allow-Origin', origin);
  c.header('Vary', 'Origin');
  c.header('Cache-Control', 'public, max-age=60, s-maxage=300');
  return c.json({ success: true, data: rows.results.map((row) => ({
    id: row.id, imageUrl: row.image_url, caption: row.caption, petName: row.pet_name,
  })) });
};

export const get__api_public_nen_gallery_preview_3 = async (c: Context<Env, "/api/public/nen/gallery-preview">) => {
  const baseUrl = c.env.NEN_EC_BASE_URL || 'https://stg.nen-petfood.com';
  try {
    const response = await fetch(new URL('/', baseUrl), {
      headers: { 'User-Agent': 'NEN-Line-Gallery-Sync/1.0' },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!response.ok) throw new Error(`EC gallery returned ${response.status}`);
    const html = await response.text();
    const images: Array<{ imageUrl: string; alt: string }> = [];
    const seen = new Set<string>();
    const pattern = /<img\b[^>]*?src=["']([^"']*\/html\/user_data\/assets\/img\/customer-stories\/[^"']+)["'][^>]*?(?:alt=["']([^"']*)["'])?[^>]*>/giu;
    for (const match of html.matchAll(pattern)) {
      const imageUrl = new URL(match[1], baseUrl).toString();
      if (seen.has(imageUrl)) continue;
      seen.add(imageUrl);
      images.push({ imageUrl, alt: match[2] || 'お客様と然' });
      if (images.length >= 12) break;
    }
    c.header('Cache-Control', 'public, max-age=300, s-maxage=600');
    return c.json({ success: true, data: images });
  } catch (error) {
    logger.error("nen_members.public_nen_gallery_preview_get_failed");
    c.header('Cache-Control', 'public, max-age=30');
    return c.json({ success: true, data: [] });
  }
};

export const post__api_liff_nen_pets_4 = async (c: Context<Env, "/api/liff/nen/pets">) => {
  const friend = await currentFriend(c);
  if (!friend) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  // 「その他」も登録できる。犬・猫専用の目安計算は feedingGuide が
  // 対象外として null を返し、犬の係数で作った数値を保存しない。
  const animalType = body?.animalType === 'cat' || body?.animalType === 'dog' || body?.animalType === 'other' ? body.animalType : '';
  const breed = typeof body?.breed === 'string' ? body.breed.trim().slice(0, 80) : '';
  const weightKg = Number(body?.weightKg);
  // 誕生日は月日だけ（MM-DD）でも登録できる。生まれた年が分からない子も
  // 誕生日配信へ載せるため。年齢は不明のまま出す。
  const birthdayRaw = normalizeNenPetBirthday(body?.birthday);
  const birthday = birthdayRaw === 'invalid' ? null : birthdayRaw;
  const concerns = Array.isArray(body?.concerns) ? body.concerns.filter((v): v is string => typeof v === 'string' && CONCERNS.has(v)).slice(0, 10) : [];
  const gender = petGender(body?.gender);
  // 性別は必須（呼び名「くん」「ちゃん」を決めるため。★37-2-A-2）
  if (!name || name.length > 80 || !animalType || !breed || !birthday || !Number.isFinite(weightKg) || weightKg < 0.2 || weightKg > 150 || gender === 'unknown') {
    return inputError(c, { success: false, error: '入力内容を確認してください' }, 400, ["name","animalType","breed","birthday","weightKg","gender"]);
  }
  const guide = feedingGuide(animalType, weightKg);
  const catalog = await accountFeedingProducts(c, friend);
  const products = catalog.products;
  const feeding = petFeedingInput(body, products);
  const id = crypto.randomUUID();
  const now = jstNow();
  const photoBytes = body?.photoData ? decodeJpegData(body.photoData) : null;
  if (body?.photoData && !photoBytes) return inputError(c, { success: false, error: 'ペット写真を確認してください' }, 400, ["photoData"]);
  const photoKey = photoBytes ? `nen-pet-profiles/${friend.id}/${id}.jpg` : null;
  const imageUrl = photoKey ? `${c.env.WORKER_PUBLIC_URL || new URL(c.req.url).origin}/images/${photoKey}` : null;
  if (photoBytes && photoKey) await c.env.IMAGES.put(photoKey, photoBytes, { httpMetadata: { contentType: 'image/jpeg' }, customMetadata: { friendId: friend.id, petId: id } });
  await c.env.DB.prepare(
    `INSERT INTO nen_pet_profiles
      (id, friend_id, customer_id, name, animal_type, gender, birthday, breed, weight_kg, concerns,
       recommended_daily_grams, recommended_daily_min_grams, recommended_daily_max_grams,
       venison_daily_grams, food_cycle_days, image_r2_key, image_url, created_at, updated_at,
       weight_updated_at, neutered, activity_level, feeding_product_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, friend.id, friend.user_id, name, animalType,
    gender,
    birthday, breed, weightKg, JSON.stringify(concerns), guide?.daily ?? null, guide?.min ?? null, guide?.max ?? null,
    guide?.venison ?? null, guide?.cycleDays ?? null, photoKey, imageUrl, now, now,
    // 登録時に体重を入れているので、測った日＝登録日として記録する。
    now,
    feeding.neutered === undefined || feeding.neutered === null ? null : feeding.neutered ? 1 : 0,
    feeding.activityLevel ?? 'normal',
    feeding.feedingProductId ?? null,
  ).run();
  // NRC／FEDIAF の式で目安を上書き（主食が登録されているときだけグラムが決まる）。
  const plan = planForPetRow({
    id, animal_type: animalType, weight_kg: weightKg, birthday, neutered: feeding.neutered == null ? null : feeding.neutered ? 1 : 0,
    activity_level: feeding.activityLevel ?? 'normal', feeding_product_id: feeding.feedingProductId ?? null,
  }, products, new Date(), catalog.treatLimitPercent);
  await refreshStoredFeeding(c.env.DB, id, plan, now);
  await syncNenPetTags(c.env.DB, friend.id);
  const saved = await c.env.DB.prepare(`SELECT * FROM nen_pet_profiles WHERE archived_at IS NULL AND id = ?`).bind(id).first<Record<string, unknown>>();
  if (saved) c.executionCtx.waitUntil(pushPetCard(c, friend, saved).catch((err: unknown) => logger.error("nen_members.liff_nen_pets_post_failed")));
  return c.json({ success: true, data: mapPet(saved || { id }, products, catalog.treatLimitPercent) }, 201);
};

export const put__api_liff_nen_pets_id_5 = async (c: Context<Env, "/api/liff/nen/pets/:id">) => {
  const friend = await currentFriend(c);
  if (!friend) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const petId = c.req.param('id');
  const current = await c.env.DB.prepare(`SELECT * FROM nen_pet_profiles WHERE archived_at IS NULL AND id = ? AND friend_id = ?`).bind(petId, friend.id).first<Record<string, unknown>>();
  if (!current) return fail(c, 404, 'PET_NOT_FOUND');
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== 'object') return inputError(c, { success: false, error: '入力内容を確認してください' }, 400, []);

  const sets: string[] = [];
  const values: unknown[] = [];
  let weightChanged = false;
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80) return inputError(c, { success: false, error: '名前は1〜80文字で入力してください' }, 400, ["name"]);
    sets.push('name = ?'); values.push(name);
  }
  if (body.breed !== undefined) {
    const breed = typeof body.breed === 'string' ? body.breed.trim().slice(0, 80) : '';
    if (!breed) return inputError(c, { success: false, error: '品種を入力してください' }, 400, ["breed"]);
    sets.push('breed = ?'); values.push(breed);
  }
  if (body.gender !== undefined) {
    sets.push('gender = ?'); values.push(['male', 'female'].includes(String(body.gender)) ? String(body.gender) : 'unknown');
  }
  if (body.birthday !== undefined) {
    // 月日だけ（MM-DD）も受け付ける。年が分からない子も誕生日配信へ載せる。
    const birthday = normalizeNenPetBirthday(body.birthday);
    if (birthday === 'invalid') return inputError(c, { success: false, error: '誕生日を確認してください' }, 400, ["birthday"]);
    sets.push('birthday = ?'); values.push(birthday);
  }
  if (body.weightKg !== undefined) {
    const weightKg = Number(body.weightKg);
    if (!Number.isFinite(weightKg) || weightKg < 0.2 || weightKg > 150) return inputError(c, { success: false, error: '体重は 0.2〜150kg で入力してください' }, 400, ["weightKg"]);
    sets.push('weight_kg = ?'); values.push(Math.round(weightKg * 10) / 10);
    // 体重が変わったときだけ「体重の更新」を動かす。同じ値の再送や
    // 名前だけの編集では日付を維持する。
    const rounded = Math.round(weightKg * 10) / 10;
    if (rounded !== Number(current.weight_kg)) {
      weightChanged = true;
    }
  }
  if (body.concerns !== undefined) {
    const concerns = Array.isArray(body.concerns) ? body.concerns.filter((v): v is string => typeof v === 'string' && CONCERNS.has(v)).slice(0, 10) : [];
    sets.push('concerns = ?'); values.push(JSON.stringify(concerns));
  }
  const catalog = await accountFeedingProducts(c, friend);
  const products = catalog.products;
  const feeding = petFeedingInput(body, products);
  if (body.neutered !== undefined) {
    if (feeding.neutered === undefined) return inputError(c, { success: false, error: '避妊去勢の選択を確認してください' }, 400, ["neutered","activityLevel","feedingProductId"]);
    sets.push('neutered = ?'); values.push(feeding.neutered === null ? null : feeding.neutered ? 1 : 0);
  }
  if (body.activityLevel !== undefined) {
    if (!feeding.activityLevel) return inputError(c, { success: false, error: '活動量の選択を確認してください' }, 400, ["neutered","activityLevel","feedingProductId"]);
    sets.push('activity_level = ?'); values.push(feeding.activityLevel);
  }
  if (body.feedingProductId !== undefined) {
    if (feeding.feedingProductId === undefined) return inputError(c, { success: false, error: '主食の選択を確認してください' }, 400, ["neutered","activityLevel","feedingProductId"]);
    sets.push('feeding_product_id = ?'); values.push(feeding.feedingProductId);
  }
  if (sets.length === 0) return inputError(c, { success: false, error: '変更する項目がありません' }, 400, []);

  const now = jstNow();
  sets.push('updated_at = ?'); values.push(now);
  if (weightChanged) { sets.push('weight_updated_at = ?'); values.push(now); }
  await c.env.DB.prepare(`UPDATE nen_pet_profiles SET ${sets.join(', ')} WHERE id = ? AND friend_id = ?`).bind(...values, petId, friend.id).run();
  // 誕生日が変わったら、古い日付へ予約済みの誕生日クーポン配信を取消し、
  // 次の日次走査で新しい誕生日から組み直させる。すでに発行済みの今年分は残る。
  if (body.birthday !== undefined) {
    const previous = (current.birthday as string | null) ?? null;
    const normalized = normalizeNenPetBirthday(body.birthday);
    if ((normalized === 'invalid' ? null : normalized) !== previous) {
      await c.env.DB.prepare(
        `UPDATE nen_delivery_jobs SET status = 'cancelled', updated_at = ?
         WHERE campaign_key = 'birthday_coupon' AND status = 'pending' AND source_key LIKE ?`,
      ).bind(now, `birthday:${petId}:%`).run();
    }
  }
  const updated = await c.env.DB.prepare(`SELECT * FROM nen_pet_profiles WHERE archived_at IS NULL AND id = ?`).bind(petId).first<Record<string, unknown>>();
  if (!updated) return fail(c, 404, 'PET_NOT_FOUND');
  const plan = planForPetRow({
    id: petId, animal_type: String(updated.animal_type), weight_kg: updated.weight_kg as number | null, birthday: (updated.birthday as string | null) ?? null,
    neutered: updated.neutered as number | null, activity_level: (updated.activity_level as string | null) ?? null,
    feeding_product_id: (updated.feeding_product_id as string | null) ?? null,
  }, products, new Date(), catalog.treatLimitPercent);
  await refreshStoredFeeding(c.env.DB, petId, plan, now);
  await syncNenPetTags(c.env.DB, friend.id);
  const saved = await c.env.DB.prepare(`SELECT * FROM nen_pet_profiles WHERE archived_at IS NULL AND id = ?`).bind(petId).first<Record<string, unknown>>();
  return c.json({ success: true, data: mapPet(saved || updated, products, catalog.treatLimitPercent) });
};

export const post__api_liff_nen_pets_id_photo_6 = async (c: Context<Env, "/api/liff/nen/pets/:id/photo">) => {
  const friend = await currentFriend(c);
  if (!friend) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const pet = await c.env.DB.prepare(`SELECT id, image_r2_key FROM nen_pet_profiles WHERE archived_at IS NULL AND id=? AND friend_id=?`)
    .bind(c.req.param('id'), friend.id).first<{ id: string; image_r2_key: string | null }>();
  if (!pet) return fail(c, 404, 'PET_NOT_FOUND');
  const body = await c.req.json<{ data?: string }>().catch(() => null);
  const bytes = decodeJpegData(body?.data);
  if (!bytes) return inputError(c, { success: false, error: 'ペット写真を確認してください' }, 400, ["data"]);
  const key = `nen-pet-profiles/${friend.id}/${pet.id}-${crypto.randomUUID()}.jpg`;
  // 公開配信される画像なので、撮影場所などの付帯メタデータは外して保存する。
  await c.env.IMAGES.put(key, stripImageMetadata(bytes, 'image/jpeg'), { httpMetadata: { contentType: 'image/jpeg' }, customMetadata: { friendId: friend.id, petId: pet.id } });
  const imageUrl = `${c.env.WORKER_PUBLIC_URL || new URL(c.req.url).origin}/images/${key}`;
  await c.env.DB.prepare(`UPDATE nen_pet_profiles SET image_r2_key=?, image_url=?, updated_at=? WHERE id=? AND friend_id=?`)
    .bind(key, imageUrl, jstNow(), pet.id, friend.id).run();
  await syncNenPetTags(c.env.DB, friend.id);
  if (pet.image_r2_key) c.executionCtx.waitUntil(c.env.IMAGES.delete(pet.image_r2_key).catch(() => undefined));
  return c.json({ success: true, data: { imageUrl } });
};

export const post__api_liff_nen_health_logs_7 = async (c: Context<Env, "/api/liff/nen/health-logs">) => {
  const friend = await currentFriend(c);
  if (!friend) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  const pet = await c.env.DB.prepare(`SELECT id FROM nen_pet_profiles WHERE archived_at IS NULL AND id = ? AND friend_id = ?`).bind(String(body?.petId || ''), friend.id).first();
  if (body?.loggedOn != null && body.loggedOn !== '' && !dateOnly(body.loggedOn)) {
    return inputError(c, { success: false, error: '日付が正しくありません' }, 400, ['loggedOn']);
  }
  const loggedOn = dateOnly(body?.loggedOn) || japanDate();
  const stool = ['normal', 'soft', 'hard', 'diarrhea', 'bloody', 'other'].includes(String(body?.stoolStatus)) ? String(body?.stoolStatus) : '';
  const appetite = ['good', 'normal', 'poor'].includes(String(body?.appetite)) ? String(body?.appetite) : '';
  const skin = ['normal', 'itchy', 'red', 'other'].includes(String(body?.skinStatus)) ? String(body?.skinStatus) : 'normal';
  const tear = ['normal', 'mild', 'concern'].includes(String(body?.tearStainStatus)) ? String(body?.tearStainStatus) : 'normal';
  const weightKg = body?.weightKg == null || body.weightKg === '' ? null : Number(body.weightKg);
  const heartRateBpm = body?.heartRateBpm == null || body.heartRateBpm === '' ? null : Number(body.heartRateBpm);
  const respiratoryRateBpm = body?.respiratoryRateBpm == null || body.respiratoryRateBpm === '' ? null : Number(body.respiratoryRateBpm);
  const invalidVitals = (weightKg != null && (!Number.isFinite(weightKg) || weightKg < 0.2 || weightKg > 150))
    || (heartRateBpm != null && (!Number.isInteger(heartRateBpm) || heartRateBpm < 20 || heartRateBpm > 300))
    || (respiratoryRateBpm != null && (!Number.isInteger(respiratoryRateBpm) || respiratoryRateBpm < 5 || respiratoryRateBpm > 150));
  if (!pet || !stool || !appetite || invalidVitals) return inputError(c, { success: false, error: '入力内容を確認してください' }, 400, ["petId","stoolStatus","appetite","weightKg","heartRateBpm","respiratoryRateBpm"]);
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO nen_health_logs (id, pet_id, friend_id, logged_on, weight_kg, heart_rate_bpm, respiratory_rate_bpm, stool_status, appetite, skin_status, tear_stain_status, note, care_flag, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(pet_id, logged_on) DO UPDATE SET weight_kg=COALESCE(excluded.weight_kg, weight_kg),
       heart_rate_bpm=COALESCE(excluded.heart_rate_bpm, heart_rate_bpm),
       respiratory_rate_bpm=COALESCE(excluded.respiratory_rate_bpm, respiratory_rate_bpm), stool_status=excluded.stool_status,
       appetite=excluded.appetite, skin_status=excluded.skin_status, tear_stain_status=excluded.tear_stain_status, note=excluded.note`,
  ).bind(id, body!.petId, friend.id, loggedOn, weightKg, heartRateBpm, respiratoryRateBpm, stool, appetite, skin, tear, String(body?.note || '').slice(0, 500), jstNow()).run();

  // 日記につけた体重を「今日の目安」に反映する。
  // この記録が体重を持つ記録の中でいちばん新しい日付なら、プロフィールの体重を
  // その値に揃えて給餌目安も計算し直す（過去日の記録で今の体重を戻さない）。
  if (weightKg != null) {
    const newestWeightLog = await c.env.DB.prepare(
      `SELECT MAX(logged_on) AS d FROM nen_health_logs WHERE pet_id = ? AND weight_kg IS NOT NULL`,
    ).bind(body!.petId).first<{ d: string | null }>();
    if (newestWeightLog?.d && loggedOn >= newestWeightLog.d) {
      const [current, catalog] = await Promise.all([
        c.env.DB.prepare(
          `SELECT animal_type, birthday, neutered, activity_level, feeding_product_id FROM nen_pet_profiles WHERE archived_at IS NULL AND id = ?`,
        ).bind(body!.petId).first<Record<string, unknown>>(),
        accountFeedingProducts(c, friend),
      ]);
      const now = jstNow();
      // 「体重の更新」には同期した瞬間ではなく日記の記録日（測った日）を入れる。
      await c.env.DB.prepare(`UPDATE nen_pet_profiles SET weight_kg = ?, weight_updated_at = ?, updated_at = ? WHERE id = ?`).bind(weightKg, loggedOn, now, body!.petId).run();
      if (current) {
        const plan = planForPetRow({
          id: String(body!.petId), animal_type: String(current.animal_type), weight_kg: weightKg,
          birthday: (current.birthday as string | null) ?? null,
          neutered: current.neutered as number | null,
          activity_level: (current.activity_level as string | null) ?? null,
          feeding_product_id: (current.feeding_product_id as string | null) ?? null,
        }, catalog.products, new Date(), catalog.treatLimitPercent);
        await refreshStoredFeeding(c.env.DB, String(body!.petId), plan, now);
      }
    }
  }

  const latest = await c.env.DB.prepare(`SELECT appetite, stool_status FROM nen_health_logs WHERE pet_id = ? ORDER BY logged_on DESC LIMIT 3`).bind(body!.petId).all<{ appetite: string; stool_status: string }>();
  const checks = [
    { type: 'poor_appetite', hit: latest.results.length === 3 && latest.results.every((r) => r.appetite === 'poor') },
    { type: 'abnormal_stool', hit: latest.results.length === 3 && latest.results.every((r) => isCareStoolStatus(r.stool_status)) },
  ];
  for (const check of checks) {
    if (check.hit) {
      await c.env.DB.prepare(
        `INSERT INTO nen_care_flags (id, pet_id, friend_id, flag_type, status, consecutive_days, advice_ready, detected_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', 3, 1, ?, ?)
         ON CONFLICT(pet_id, flag_type) DO UPDATE SET status='active', consecutive_days=3, advice_ready=1, resolved_at=NULL, updated_at=excluded.updated_at`,
      ).bind(crypto.randomUUID(), body!.petId, friend.id, check.type, jstNow(), jstNow()).run();
      await c.env.DB.prepare(`UPDATE nen_health_logs SET care_flag = 1 WHERE pet_id = ? AND logged_on = ?`).bind(body!.petId, loggedOn).run();
    }
  }
  await syncNenHealthTags(c.env.DB, friend.id);
  return c.json({ success: true, data: { careRequired: checks.some((v) => v.hit) } }, 201);
};

export const get__api_liff_nen_health_logs_8 = async (c: Context<Env, "/api/liff/nen/health-logs">) => {
  const friend = await currentFriend(c);
  if (!friend) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const rows = await c.env.DB.prepare(`SELECT * FROM nen_health_logs WHERE friend_id = ? ORDER BY logged_on DESC LIMIT 730`).bind(friend.id).all<Record<string, unknown>>();
  return c.json({ success: true, data: rows.results });
};

export const get__api_liff_nen_health_logs_summary_9 = async (c: Context<Env, "/api/liff/nen/health-logs/summary">) => {
  const friend = await currentFriend(c);
  if (!friend) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const petId = (c.req.query('petId') ?? '').trim();
  const pet = await c.env.DB.prepare(`SELECT id, name, gender, animal_type, breed, birthday, weight_kg FROM nen_pet_profiles WHERE archived_at IS NULL AND id = ? AND friend_id = ?`)
    .bind(petId, friend.id).first<{ id: string; name: string; gender: string | null; animal_type: string; breed: string | null; birthday: string | null; weight_kg: number | null }>();
  if (!pet) return fail(c, 404, 'PET_NOT_FOUND');
  const today = new Date();
  const since = japanDateOffset(-30, today);
  const logs = await c.env.DB.prepare(
    `SELECT pet_id, logged_on, weight_kg, stool_status, appetite, skin_status, tear_stain_status, heart_rate_bpm, respiratory_rate_bpm, note
       FROM nen_health_logs WHERE pet_id = ? AND logged_on >= ? ORDER BY logged_on DESC`,
  ).bind(pet.id, since).all<HealthLogRow>();
  return c.json({ success: true, data: {
    pet: { id: pet.id, name: pet.name, callName: petCallName(pet.name, pet.gender), animalType: toPetAnimalType(pet.animal_type), breed: pet.breed ?? '', birthday: pet.birthday, weightKg: pet.weight_kg },
    owner: { name: friend.display_name ?? '' },
    generatedAt: today.toISOString(),
    summary: thirtyDaySummary(logs.results ?? [], today),
    labels: { stool: STOOL_LABELS, appetite: APPETITE_LABELS },
  } });
};

export const post__api_liff_nen_photos_10 = async (c: Context<Env, "/api/liff/nen/photos">) => {
  const friend = await currentFriend(c);
  if (!friend) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const body = await c.req.json<{ petId?: string; data?: string; mimeType?: string; caption?: string }>().catch(() => null);
  const pet = await c.env.DB.prepare(`SELECT id FROM nen_pet_profiles WHERE archived_at IS NULL AND id = ? AND friend_id = ?`).bind(body?.petId || '', friend.id).first();
  if (!pet || !body?.data || !body.mimeType || !IMAGE_TYPES[body.mimeType]) return inputError(c, { success: false, error: '画像またはペットを確認してください' }, 400, ["petId","data","mimeType"]);
  const raw = body.data.replace(/^data:[^;]+;base64,/, '');
  if (raw.length > 11_200_000) return inputError(c, { success: false, error: '画像は8MB以下にしてください' }, 400, ["data"]);
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0)); } catch { return inputError(c, { success: false, error: '画像を読み込めません' }, 400, []); }
  if (bytes.byteLength > 8 * 1024 * 1024) return inputError(c, { success: false, error: '画像は8MB以下にしてください' }, 400, []);
  if (detectedImageMime(bytes) !== body.mimeType) {
    return inputError(c, { success: false, error: '画像の内容と形式が一致しません' }, 400, ["mimeType"]);
  }
  /*
   * 実寸法をヘッダから測る。申告の mimeType と実体の一致までは
   * 見ているが、寸法までは見ていなかった。読み取れない壊れた画像と、
   * 展開時に過大になる巨大寸法は投稿経路で止める。
   */
  const dimensions = imageDimensions(bytes, body.mimeType);
  if (!dimensions) {
    return inputError(c, { success: false, error: '画像の寸法を確認できませんでした' }, 400, ["mimeType"]);
  }
  if (dimensions.width > 20000 || dimensions.height > 20000) {
    return inputError(c, { success: false, error: '画像の寸法が大きすぎます（20000px以内にしてください）' }, 400, ["mimeType"]);
  }
  const id = crypto.randomUUID();
  /*
   * 重複判定のため、中身の hash を付ける。
   * 完全に同じ写真だけを「重複」とし、似ている写真は自動で却下しない。
   */
  const hashDigest = await crypto.subtle.digest('SHA-256', bytes);
  const contentHash = Array.from(new Uint8Array(hashDigest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  const extension = IMAGE_TYPES[body.mimeType];
  const key = `nen-photo-originals/${friend.id}/${id}.${extension}`;
  const reviewKey = `nen-photo-review/${friend.id}/${id}-v1.${extension}`;
  const metadata = { friendId: friend.id, petId: body.petId || '', photoId: id };
  /*
   * 公開配信される審査用画像は付帯メタデータを外して保存する。
   * 撮影場所・端末情報が /images/* から誰でも取れる状態を止める。
   * 原本は二段階認証つきの取得だけに限る証跡として、そのまま残す。
   */
  const reviewBytes = stripImageMetadata(bytes, body.mimeType);
  await Promise.all([
    c.env.IMAGES.put(key, bytes, { httpMetadata: { contentType: body.mimeType }, customMetadata: metadata }),
    c.env.IMAGES.put(reviewKey, reviewBytes, { httpMetadata: { contentType: body.mimeType }, customMetadata: { ...metadata, derivative: 'review-v1' } }),
  ]);
  const reviewImageUrl = `${c.env.WORKER_PUBLIC_URL || new URL(c.req.url).origin}/images/${reviewKey}`;
  const now = jstNow();
  await c.env.DB.prepare(`INSERT INTO nen_photo_submissions
    (id, friend_id, pet_id, r2_key, image_url, content_type, caption, status,
     created_at, updated_at, line_account_id, review_image_url, public_image_url,
     image_width, image_height, image_byte_size, content_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      id, friend.id, body.petId, key, reviewImageUrl, body.mimeType,
      String(body.caption || '').trim().slice(0, 300), now, now, friend.line_account_id,
      reviewImageUrl, reviewImageUrl, dimensions.width, dimensions.height, bytes.byteLength,
      contentHash,
    ).run();
  // 保存の直後に検査の段を入れる。clean になるまで審査へは流さない。
  // 記録に失敗しても投稿自体は返す（門番は出す前にその場で回す）。
  const photoScan = await ensureFileScanForUpload({
    db: c.env.DB,
    lineAccountId: String(friend.line_account_id),
    subjectKind: 'photo',
    subjectId: id,
    mediaId: null,
    filename: `photo.${extension}`,
    mimeType: body.mimeType,
    sizeBytes: bytes.byteLength,
  }).catch((err) => {
    logger.error("nen_members.liff_nen_photos_post_failed");
    return null;
  });
  if (photoScan) {
    await runBuiltinScanAndStore(c.env.DB, photoScan, bytes, {
      filename: `photo.${extension}`,
      mimeType: body.mimeType,
      sizeBytes: bytes.byteLength,
      width: dimensions.width,
      height: dimensions.height,
    }).catch((err) => logger.error("nen_members.liff_nen_photos_post_failed"));
  }
  await syncNenPhotoTags(c.env.DB, friend.id);
  const scanState = await c.env.DB.prepare("SELECT status FROM media_file_scans WHERE subject_kind='photo' AND subject_id=? AND line_account_id=?").bind(id, friend.line_account_id).first<{status: string}>();
  return c.json({ success: true, data: { id, imageUrl: scanState?.status === 'clean' ? reviewImageUrl : null, scanStatus: scanState?.status ?? 'pending', status: 'pending' } }, 201);
};

export const put__api_liff_nen_photos_id_publication_consent_11 = async (c: Context<Env, "/api/liff/nen/photos/:id/publication-consent">) => {
  const friend = await currentFriend(c);
  if (!friend) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const body = await c.req.json<{
    consent?: boolean;
    consentVersion?: string;
    showPetName?: boolean;
  }>().catch(() => null);
  const consentVersion = typeof body?.consentVersion === 'string'
    ? body.consentVersion.trim().slice(0, 80)
    : '';
  if (typeof body?.consent !== 'boolean' || (body.consent && !consentVersion)) {
    return inputError(c, { success: false, error: '公開同意の内容を確認してください' }, 400, ["consent","consentVersion"]);
  }
  const photo = await c.env.DB.prepare(
    `SELECT id, status FROM nen_photo_submissions WHERE id = ? AND friend_id = ? AND line_account_id = ?`,
  ).bind(c.req.param('id'), friend.id, friend.line_account_id).first<{ id: string; status: string }>();
  if (!photo) return c.json({ success: false, error: 'Not found' }, 404);
  const now = jstNow();
  if (body.consent) {
    if (photo.status === 'adopted') {
      await ensureConsentedPhotoSitePublication(c.env.DB, {
        photoId: photo.id,
        friendId: friend.id,
        lineAccountId: String(friend.line_account_id),
        consentVersion,
        showPetName: body.showPetName === true,
        siteUrl: c.env.NEN_EC_BASE_URL || 'https://nen-petfood.com',
        now,
      });
    } else {
      await c.env.DB.prepare(
        `UPDATE nen_photo_submissions
            SET publication_consent_version = ?, publication_consent_at = ?,
                publication_withdrawn_at = NULL, public_pet_name = ?, updated_at = ?
          WHERE id = ? AND friend_id = ? AND line_account_id = ?`,
      ).bind(
        consentVersion, now, body.showPetName === true ? 1 : 0, now,
        photo.id, friend.id, friend.line_account_id,
      ).run();
    }
  } else {
    await c.env.DB.prepare(
      `UPDATE nen_photo_submissions
          SET publication_withdrawn_at = ?, public_pet_name = 0, updated_at = ?
        WHERE id = ? AND friend_id = ? AND line_account_id = ?`,
    ).bind(now, now, photo.id, friend.id, friend.line_account_id).run();
  }
  return c.json({
    success: true,
    data: { publicationConsent: body.consent, publicPetName: body.consent && body.showPetName === true },
  });
};

export const get__api_nen_members_overview_12 = async (c: Context<Env, "/api/nen-members/overview">) => {
  const { scope, where: accountWhere } = await adminAccountScope(c);
  const countScoped = async (table: string, alias: string, extra = '') =>
    c.env.DB.prepare(
      `SELECT COUNT(*) count FROM ${table} ${alias}
       JOIN friends f ON f.id = ${alias}.friend_id
       WHERE 1 = 1 ${extra} ${accountWhere}`,
    ).bind(...(scope.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : [])).first<{ count: number }>();
  const [pets, logs, care, photos, members, consultations] = await Promise.all([
    countScoped('nen_pet_profiles', 'p'),
    countScoped('nen_health_logs', 'h'),
    countScoped('nen_care_flags', 'cf', `AND cf.status='active'`),
    countScoped('nen_photo_submissions', 'ps', `AND ps.status='pending'`),
    countScoped('nen_ec_member_snapshots', 's'),
    countScoped('nen_consultation_logs_v2', 'cl'),
  ]);
  return c.json({ success: true, data: { pets: pets?.count || 0, healthLogs: logs?.count || 0, activeCare: care?.count || 0, pendingPhotos: photos?.count || 0, members: members?.count || 0, consultations: consultations?.count || 0 } });
};

export const get__api_nen_members_care_flags_13 = async (c: Context<Env, "/api/nen-members/care-flags">) => {
  const { scope, where } = await adminAccountScope(c);
  const rows = await c.env.DB.prepare(`SELECT cf.*, p.name pet_name, f.display_name owner_name FROM nen_care_flags cf JOIN nen_pet_profiles p ON p.id=cf.pet_id JOIN friends f ON f.id=cf.friend_id WHERE 1 = 1 ${where} ORDER BY cf.status='active' DESC, cf.detected_at DESC LIMIT 200`).bind(...(scope.allowedAccountIds.length ? sqlIdSet(scope.allowedAccountIds).binds : [])).all<Record<string, unknown>>();
  return c.json({ success: true, data: rows.results });
};
