import { countNenCampaignBodyLength, NEN_PET_NAME_MAX_LENGTH } from '@line-crm/shared';
import { normalizeNenPetBirthday } from '../lib/nen-pet-birthday.js';


// 誕生日の形（YYYY-MM-DD か MM-DD）の判定は lib/nen-pet-birthday.ts の1本。

export function petWriteBody(body: Record<string, unknown> | null):
  { error: string; field?: string } | {
    name: string; animalType: string; gender: string; birthday: string | null;
    breed: string | null; weightKg: number | null;
  } {
  if (!body || typeof body.name !== 'string' || !body.name.trim()) return { error: 'name is required' };
  // ペットの名前はNEN配信の本文へ差し込まれる（{{pet_name}}）。無制限だと
  // 差し込み展開後の本文が際限なく膨らみ、保存時の上限判定の前提が
  // 崩れるため、ここで有限の上限を持たせる。
  if (countNenCampaignBodyLength(body.name.trim()) > NEN_PET_NAME_MAX_LENGTH) {
    return { error: `ペットのお名前は${NEN_PET_NAME_MAX_LENGTH}字以内で入力してください` };
  }
  const birthday = normalizeNenPetBirthday(body.birthday);
  if (birthday === 'invalid') return { error: '誕生日は YYYY-MM-DD か MM-DD で入力してください' };
  const weightKg = body.weightKg === null || body.weightKg === undefined || body.weightKg === ''
    ? null : Number(body.weightKg);
  if (weightKg !== null && (!Number.isFinite(weightKg) || weightKg < 0.1 || weightKg > 200)) {
    return { error: '体重は 0.1〜200kg で入力してください' };
  }
  // 種別は犬・猫・その他の3値。未指定は従来の送信元との互換のため犬を既定にするが、
  // 送られてきた値が範囲外なら犬へ黙って倒さず入力エラーにする
  // （ウサギ等が犬として保存・計算されないようにする）。
  const animalTypeRaw = body.animalType;
  let animalType = 'dog';
  if (animalTypeRaw !== undefined && animalTypeRaw !== null && animalTypeRaw !== '') {
    if (!['dog', 'cat', 'other'].includes(String(animalTypeRaw))) {
      return { error: '種別は 犬・猫・その他 から選んでください' };
    }
    animalType = String(animalTypeRaw);
  }
  return {
    name: body.name.trim(),
    animalType,
    gender: ['male', 'female', 'unknown'].includes(String(body.gender)) ? String(body.gender) : 'unknown',
    birthday,
    breed: typeof body.breed === 'string' && body.breed.trim() ? body.breed.trim().slice(0, 80) : null,
    weightKg,
  };
}


/**
 * PUTの部分更新用。送られた項目だけ検証して返し、欠落項目は呼び出し側で現値を保つ。
 * 検証はDBを読む前に済ませるため、ここは入力だけを見る（無効入力でDBを叩かない）。
 */
export function petPatchBody(body: Record<string, unknown> | null):
  { error: string; field?: string } | {
    name?: string; animalType?: string; gender?: string; birthday?: string | null;
    breed?: string | null; weightKg?: number | null;
  } {
  const patch: {
    name?: string; animalType?: string; gender?: string; birthday?: string | null;
    breed?: string | null; weightKg?: number | null;
  } = {};
  if (!body) return patch;
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) return { error: 'name is required', field: 'name' };
    if (countNenCampaignBodyLength(body.name.trim()) > NEN_PET_NAME_MAX_LENGTH) {
      return { error: `ペットのお名前は${NEN_PET_NAME_MAX_LENGTH}字以内で入力してください`, field: 'name' };
    }
    patch.name = body.name.trim();
  }
  if (body.animalType !== undefined) {
    // 範囲外の種別を犬へ黙って倒さずエラーにする。
    if (!['dog', 'cat', 'other'].includes(String(body.animalType))) {
      return { error: '種別は 犬・猫・その他 から選んでください', field: 'animalType' };
    }
    patch.animalType = String(body.animalType);
  }
  if (body.gender !== undefined) {
    patch.gender = ['male', 'female', 'unknown'].includes(String(body.gender)) ? String(body.gender) : 'unknown';
  }
  if (body.birthday !== undefined) {
    const birthday = normalizeNenPetBirthday(body.birthday);
    if (birthday === 'invalid') return { error: '誕生日は YYYY-MM-DD か MM-DD で入力してください', field: 'birthday' };
    patch.birthday = birthday;
  }
  if (body.breed !== undefined) {
    patch.breed = typeof body.breed === 'string' && body.breed.trim() ? body.breed.trim().slice(0, 80) : null;
  }
  if (body.weightKg !== undefined) {
    const weightKg = body.weightKg === null || body.weightKg === '' ? null : Number(body.weightKg);
    if (weightKg !== null && (!Number.isFinite(weightKg) || weightKg < 0.1 || weightKg > 200)) {
      return { error: '体重は 0.1〜200kg で入力してください', field: 'weightKg' };
    }
    patch.weightKg = weightKg;
  }
  return patch;
}
