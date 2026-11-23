import { describe, expect, it } from 'vitest';
import { restaurantReservationAllergyLabels, validateRestaurantReservationAllergies } from './restaurant-reservation-allergies.js';

describe('予約のアレルギー', () => {
  it('共通候補と予約だけのその他を区別して扱う', () => {
    const result = validateRestaurantReservationAllergies([{ kind: 'option', value: '卵' }, { kind: 'other', value: ' キウイ ' }], ['卵', '乳']);
    expect(result).toEqual({ ok: true, values: [{ kind: 'option', value: '卵' }, { kind: 'other', value: 'キウイ' }] });
    if (result.ok) expect(restaurantReservationAllergyLabels(result.values)).toEqual(['卵', 'その他：キウイ']);
  });
  it('候補外を共通候補として送れず、不正な値や重複を受け付けない', () => {
    for (const input of [[{ kind: 'option', value: 'キウイ' }], [{ kind: 'other', value: ' ' }], [{ kind: 'other', value: 'x' }, { kind: 'other', value: 'x' }], '卵']) {
      expect(validateRestaurantReservationAllergies(input, ['卵'])).toEqual({ ok: false });
    }
  });
  it('長い既存の自由記述だけを、その他として保てる', () => {
    const value = '古'.repeat(201);
    expect(validateRestaurantReservationAllergies([{kind:'other',value}], [], value)).toEqual({ok:true,values:[{kind:'other',value}]});
    expect(validateRestaurantReservationAllergies([{kind:'other',value}], [], '別の記述')).toEqual({ok:false});
    expect(validateRestaurantReservationAllergies([{kind:'other',value}], [], undefined, [value])).toEqual({ok:true,values:[{kind:'other',value}]});
  });
});
