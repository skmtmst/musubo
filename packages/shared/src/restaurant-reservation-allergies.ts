export type RestaurantReservationAllergy =
  | { kind: 'option'; value: string }
  | { kind: 'other'; value: string };

export function validateRestaurantReservationAllergies(raw: unknown, options: readonly string[], legacyOther?: string, existingOthers: readonly string[] = []):
  { ok: true; values: RestaurantReservationAllergy[] } | { ok: false } {
  if (!Array.isArray(raw) || raw.length > 32) return { ok: false };
  const values: RestaurantReservationAllergy[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false };
    const { kind, value } = item as Record<string, unknown>;
    if ((kind !== 'option' && kind !== 'other') || typeof value !== 'string') return { ok: false };
    const clean = value.trim();
    if (!clean || (clean.length > 100 && !(kind === 'other' && (clean === legacyOther || existingOthers.includes(clean)))) || (kind === 'option' && !options.includes(clean))) return { ok: false };
    const key = JSON.stringify([kind, clean]);
    if (seen.has(key)) return { ok: false };
    seen.add(key);
    values.push({ kind, value: clean });
  }
  return { ok: true, values };
}

export function restaurantReservationAllergyLabels(values: readonly RestaurantReservationAllergy[]): string[] {
  return values.map(({ kind, value }) => kind === 'other' ? `その他：${value}` : value);
}
