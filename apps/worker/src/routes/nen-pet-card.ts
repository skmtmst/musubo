import type { Message } from '@line-crm/line-sdk';
import { isFeedingSupportedAnimal, petAnimalTypeLabel, toPetAnimalType } from '../lib/nen-pet-species.js';


export function petCard(pet: Record<string, unknown>): Message {
  // 「その他」は犬へ倒さず「その他」と出す。フード目安の計算は
  // 犬・猫専用なので、対象外の子には数値の代わりにその旨を添える。
  const supported = isFeedingSupportedAnimal(toPetAnimalType(pet.animal_type));
  const guide = `${pet.recommended_daily_min_grams}〜${pet.recommended_daily_max_grams}g/日`;
  const feedingLines = supported
    ? [
        { type: 'text', text: `1日のフード目安：${guide}`, size: 'sm', color: '#334155', wrap: true },
        { type: 'text', text: `鹿肉をトッピングする場合の目安：${pet.venison_daily_grams}g/日まで`, size: 'sm', color: '#334155', wrap: true },
        { type: 'text', text: `1kgのフード：約${pet.food_cycle_days}日分`, size: 'sm', color: '#334155', wrap: true },
      ]
    : [{ type: 'text', text: 'フード目安の自動計算は犬・猫が対象です。かかりつけの獣医師にご相談ください。', size: 'sm', color: '#334155', wrap: true }];
  return {
    type: 'flex', altText: `${pet.name}ちゃんのマイペット登録が完了しました`,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
        { type: 'text', text: 'MY PET CARD', size: 'xs', weight: 'bold', color: '#16815B' },
        { type: 'text', text: `${pet.name}ちゃん`, size: 'xl', weight: 'bold', color: '#123F2B' },
        { type: 'text', text: `${petAnimalTypeLabel(pet.animal_type)}・${pet.breed || '品種未登録'}・${pet.weight_kg}kg`, size: 'sm', color: '#64748B', wrap: true },
        { type: 'separator' },
        ...feedingLines,
        { type: 'text', text: '※年齢・活動量・体調・商品の熱量で変わる一般的な目安です。心配な症状は獣医師へご相談ください。', size: 'xs', color: '#94A3B8', wrap: true },
      ] },
    },
  } as Message;
}
