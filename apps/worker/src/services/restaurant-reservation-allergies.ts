import { restaurantReservationAllergyLabels, validateRestaurantReservationAllergies, type RestaurantReservationAllergy } from '@line-crm/shared';
import { accountAllergyOptions } from './allergy-options.js';

export async function validateReservationAllergies(db: D1Database, storeId: string, input: unknown, existingOptions: readonly string[] = [], legacyOther?: string, existingOthers: readonly string[] = []) {
  const store = await db.prepare('SELECT line_account_id FROM rt_stores WHERE id = ?').bind(storeId).first<{line_account_id: string | null}>();
  const options = store?.line_account_id ? (await accountAllergyOptions(db, store.line_account_id)).options : [];
  return validateRestaurantReservationAllergies(input, [...options, ...existingOptions], legacyOther, existingOthers);
}

export function reservationAllergyProjection(row: { allergies_json?: unknown; allergy_note?: unknown }) {
  if (typeof row.allergies_json === 'string') {
    try {
      const parsed: unknown = JSON.parse(row.allergies_json);
      if (Array.isArray(parsed) && parsed.every(value => value && typeof value === 'object' && (value.kind === 'option' || value.kind === 'other') && typeof value.value === 'string')) {
        const allergies = parsed as RestaurantReservationAllergy[];
        return { allergies, allergy_note: restaurantReservationAllergyLabels(allergies).join('、') || null };
      }
    } catch { /* 保存済みの旧値を使う */ }
  }
  return { allergies: null, allergy_note: typeof row.allergy_note === 'string' ? row.allergy_note : null };
}
