import { initialMenuItems } from './style-starter-initial-menu.js';
import { INITIAL_MENUS, initialMenuFormTargets, initialFormKey } from '@line-crm/shared';
import { templateSamples } from './style-template-samples.js';
import { readCatalogDefinition } from './style-starter-catalog-definition.js';

import { type AccountStyle } from '@line-crm/shared';

import {
  StyleError,
  features,
  defaultCards,
  readCards,
} from './style-setup-core.js';
import type { StarterItem, StarterDefinition } from './style-starter-types.js';
export type { StarterItem, StarterDefinition } from './style-starter-types.js';
export const STARTER_ITEM_KINDS = [
  'form',
  'template',
  'rich_menu',
  'automation',
  'reminder',
  'booking_menu',
  'dashboard',
  'friend_add_rule',
  'tag_set',
  'scenario',
] as const;
/** ③分け方の見本。業種ごとに最初に分けたくなる 3 つ。 */
const SAMPLE_TAGS: Record<AccountStyle, string[]> = {
  standard: ['お問い合わせした人', 'お申し込みした人', 'ご案内を希望'],
  ec: ['初めて購入', 'リピーター', 'セールのお知らせ希望'],
  restaurant: ['初来店', '常連', '宴会の相談'],
  salon: ['新規のお客さま', 'リピーター', 'しばらく来ていない'],
  consult: ['資料を見た', '面談済み', '検討中'],
  lesson: ['体験に参加', '入会済み', '振替を希望'],
};
/** ⑤友だち追加から始めるシナリオの見本。ごあいさつ（④）のあとに届く 2 通。 */
const SAMPLE_SCENARIO_STEPS: Record<AccountStyle, [string, string]> = {
  standard: ['友だち追加ありがとうございました。お知らせやお申し込みは、下のメニューからいつでもご確認いただけます。', 'ご不明な点はありませんか。このトークに送っていただければ、担当からお返事します。'],
  ec: ['友だち追加ありがとうございました。人気の商品は、下のメニューの「商品を見る」からご覧いただけます。', 'お買い物で分からないことはありませんか。ご利用ガイドか、このトークでお気軽にお問い合わせください。'],
  restaurant: ['友だち追加ありがとうございました。ご予約は、下のメニューの「予約する」からできます。', '今月のおすすめは、下のメニューの「メニュー」からご覧いただけます。ご来店をお待ちしています。'],
  salon: ['友だち追加ありがとうございました。ご予約は、下のメニューの「予約する」からできます。', 'スタイルのご相談も、このトークで受け付けています。お気軽にお送りください。'],
  consult: ['友だち追加ありがとうございました。面談のご予約は、下のメニューの「面談を予約する」からできます。', '資料やよくある質問は、下のメニューからご覧いただけます。ご質問はこのトークでも受け付けています。'],
  lesson: ['友だち追加ありがとうございました。クラスのご予約は、下のメニューの「クラスを予約する」からできます。', 'スケジュールは、下のメニューからご覧いただけます。体験のご相談もこのトークで受け付けています。'],
};
export function isCustomerUri(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
}
export function standardStarter(style: AccountStyle): StarterDefinition {
  const names: Record<AccountStyle, string> = {
    standard: 'ご案内',
    ec: 'お買い物',
    restaurant: 'お店',
    salon: 'サロン',
    consult: 'ご相談',
    lesson: 'レッスン',
  };
  const welcome = style === 'ec' ? '友だち追加ありがとうございます。商品やご利用ガイドは、下のメニューからご覧いただけます。' : style === 'standard' ? '友だち追加ありがとうございます。お知らせ・お申し込み・お問い合わせは、下のメニューからご確認いただけます。' : style === 'consult' ? '友だち追加ありがとうございます。面談のご予約・資料は、下のメニューからご確認いただけます。' : `こんにちは。${names[style]}へのお問い合わせありがとうございます。ご希望をお知らせください。`;
  return {
    items: [
      {
        key: 'welcome',
        kind: 'template',
        name: `${names[style]}のごあいさつ`,
        text: welcome,
      },
      {
        // 受け皿（経路が分からなかった人）の下書き。公開は友だち追加の画面の確認窓からだけ。
        key: 'friend-add-welcome',
        kind: 'friend_add_rule',
        name: '友だち追加のごあいさつ',
        templateKey: 'welcome',
        text: welcome,
      },
      ...initialMenuItems(style),
      ...(['salon', 'consult'].includes(style)
        ? [
            {
              key: 'booking',
              kind: 'booking_menu' as const,
              feature: 'booking',
              name: `${names[style]}の予約`,
              durationMinutes: 60,
              price: 0,
            },
          ]
        : []),
      ...(style === 'restaurant'
        ? [
            {
              key: 'reminder-thanks',
              kind: 'automation' as const,
              feature: 'reminders',
              name: '来店のお礼',
              text: 'ご来店ありがとうございました。またのお越しをお待ちしています。',
              triggerType: 'restaurant.departed' as const,
            },
          ]
        : []),
      ...(['salon', 'consult', 'lesson'].includes(style)
        ? [
            {
              key: 'reminder-day-before',
              kind: 'reminder' as const,
              feature: 'reminders',
              name: style === 'consult' ? '面談の前日の案内' : style === 'lesson' ? 'クラスの前日の案内' : '前日のリマインド',
              offsetMinutes: -1440,
              offsetDays: -1,
              sendAtTime: '18:00',
              text: style === 'consult' ? '明日の面談についてご案内します。会い方・場所は予約の内容をご確認ください。' : style === 'lesson' ? '明日のクラスについてご案内します。参加方法は申込内容をご確認ください。' : '明日のご予約についてご案内します。お会いできるのを楽しみにしています。',
            },
            {
              key: 'reminder-today',
              kind: 'reminder' as const,
              feature: 'reminders',
              name: '当日のご案内',
              offsetMinutes: -120,
              text: style === 'consult' ? '本日の面談についてご案内します。会い方・場所は予約の内容をご確認ください。' : style === 'lesson' ? '本日のクラスについてご案内します。参加方法は申込内容をご確認ください。' : '本日のご予約についてご案内します。お気をつけてお越しください。',
            },
            {
              key: 'reminder-thanks',
              kind: 'reminder' as const,
              feature: 'reminders',
              name: style === 'consult' ? '面談のお礼' : style === 'lesson' ? '参加のお礼' : '来店のお礼',
              offsetMinutes: 1440,
              offsetDays: 1,
              sendAtTime: '12:00',
              text: style === 'consult' || style === 'lesson' ? '昨日はご参加ありがとうございました。ご質問がありましたら、このトークでお知らせください。' : '昨日はありがとうございました。またのお越しをお待ちしています。',
            },
          ]
        : []),
      {
        // ③の見本。名前だけを持ち、タグは店が［タグにする］を押すまで作らない。
        key: 'segment-tags',
        kind: 'tag_set',
        name: '分け方のタグの見本',
        tags: SAMPLE_TAGS[style].map((name) => ({ name })),
      },
      {
        // ⑤の見本。止めた下書きで入れ、友だち追加の決まりにはつながない。
        key: 'friend-add-scenario',
        kind: 'scenario',
        name: '友だち追加のあとのご案内',
        steps: [
          { delayMinutes: 1440, text: SAMPLE_SCENARIO_STEPS[style][0] },
          { delayMinutes: 2880, text: SAMPLE_SCENARIO_STEPS[style][1] },
        ],
      },
      {
        key: 'dashboard',
        kind: 'dashboard',
        name: 'ダッシュボードの型',
        cards: defaultCards(style),
      },
      ...templateSamples(style).filter(sample => style !== 'consult' || sample.key !== 'day-before').filter(sample => !['standard', 'ec'].includes(style) || (style === 'ec' ? ['new-item', 'purchase-thanks', 'restock', 'inquiry-received'] : ['new-item', 'inquiry-received', 'hours-change', 'birthday']).includes(sample.key)).map((sample) => sample.starterItem),
    ],
  };
}
function isRetiredRestaurantMenuForm(item: StarterItem, style: AccountStyle) {
  return style === 'restaurant' && item.kind === 'form' && item.formTarget === 'menu'
    && item.key === initialFormKey('restaurant', 'menu');
}

export function readDefinition(
  value: unknown,
  style: AccountStyle,
): StarterDefinition {
  if ((value as { mode?: unknown })?.mode === 'catalog') return readCatalogDefinition(value);
  const input = value as StarterDefinition;
  if (!input || !Array.isArray(input.items) || input.items.length > 30)
    throw new StyleError('invalid_starter_set');
  const seen = new Set<string>();
  for (const item of input.items) {
    if (
      !item ||
      typeof item.key !== 'string' ||
      !/^[a-z0-9_-]{1,64}$/.test(item.key) ||
      seen.has(item.key) ||
      !(STARTER_ITEM_KINDS as readonly string[]).includes(item.kind) ||
      typeof item.name !== 'string' ||
      !item.name.trim() ||
      item.name.length > 100 ||
      (item.feature && !Object.hasOwn(features, item.feature)) ||
      (item.text !== undefined &&
        (typeof item.text !== 'string' || item.text.length > 2000)) ||
      (item.durationMinutes !== undefined &&
        (!Number.isInteger(item.durationMinutes) ||
          item.durationMinutes < 5 ||
          item.durationMinutes > 1440)) ||
      (item.price !== undefined &&
        (!Number.isInteger(item.price) || item.price < 0)) ||
      (item.triggerType !== undefined &&
        !['calendar_booked', 'restaurant.departed'].includes(
          item.triggerType,
        )) ||
      (item.offsetDays !== undefined &&
        (!Number.isInteger(item.offsetDays) ||
          Math.abs(item.offsetDays) > 30)) ||
      (item.sendAtTime !== undefined &&
        (typeof item.sendAtTime !== 'string' ||
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(item.sendAtTime))) ||
      (item.offsetMinutes !== undefined &&
        (!Number.isInteger(item.offsetMinutes) ||
          Math.abs(item.offsetMinutes) > 43200)) ||
      (item.sourceId !== undefined && typeof item.sourceId !== 'string')
    )
      throw new StyleError('invalid_starter_set');
    if (
      item.buttons &&
      (!Array.isArray(item.buttons) ||
        item.buttons.length > 6 ||
        item.buttons.some(
          (b) =>
            typeof b.label !== 'string' ||
            b.label.length > 50 ||
            (!Object.hasOwn(features, b.feature) && b.feature !== 'contact') ||
            (b.actionType !== undefined && !['uri', 'message'].includes(b.actionType)) ||
            (b.actionData !== undefined && (typeof b.actionData !== 'string' || b.actionData.length > 2000)) ||
            (b.actionType === 'uri' && !isCustomerUri(b.actionData)),
        ))
    )
      throw new StyleError('invalid_buttons');
    if (item.initialMenu !== undefined && (item.kind !== 'rich_menu' || item.initialMenu !== style
      || item.buttons?.length !== 4 || item.buttons.some((button,index) => { const expected=INITIAL_MENUS[style].buttons[index]!; return button.label!==expected.label || button.feature!==expected.feature || button.target!==expected.target || button.actionType!==undefined || button.actionData!==undefined; })))
      throw new StyleError('invalid_initial_menu');
    if (item.kind === 'form' && (!item.formTarget
      || (!isRetiredRestaurantMenuForm(item, style) && !initialMenuFormTargets(style).includes(item.formTarget))
      || item.key !== initialFormKey(style,item.formTarget) || item.sourceId))
      throw new StyleError('invalid_initial_form');
    if (item.kind !== 'form' && item.formTarget !== undefined) throw new StyleError('invalid_initial_form');
    if (item.cards) readCards(item.cards, style);
    if (
      item.kind === 'friend_add_rule' &&
      (typeof item.text !== 'string' ||
        !item.text.trim() ||
        item.feature !== undefined ||
        item.buttons !== undefined ||
        (item.templateKey !== undefined &&
          !input.items.some(
            (other) => other.key === item.templateKey && other.kind === 'template',
          )))
    )
      throw new StyleError('invalid_starter_set');
    if (
      (item.kind === 'tag_set') !== (item.tags !== undefined) ||
      (item.tags !== undefined &&
        (!Array.isArray(item.tags) ||
          !item.tags.length ||
          item.tags.length > 10 ||
          item.tags.some((t) => !t || typeof t.name !== 'string' || !t.name.trim() || t.name.length > 50) ||
          new Set(item.tags.map((t) => t.name.trim())).size !== item.tags.length))
    )
      throw new StyleError('invalid_starter_set');
    if (
      (item.kind === 'scenario') !== (item.steps !== undefined) ||
      (item.steps !== undefined &&
        (!Array.isArray(item.steps) ||
          !item.steps.length ||
          item.steps.length > 5 ||
          item.steps.some(
            (step) =>
              !step ||
              !Number.isInteger(step.delayMinutes) ||
              step.delayMinutes < 0 ||
              step.delayMinutes > 43200 ||
              typeof step.text !== 'string' ||
              !step.text.trim() ||
              step.text.length > 2000,
          )))
    )
      throw new StyleError('invalid_starter_set');
    if (['tag_set', 'scenario'].includes(item.kind) && (item.feature !== undefined || item.buttons !== undefined))
      throw new StyleError('invalid_starter_set');
    seen.add(item.key);
  }
  const initial=input.items.find(item=>item.initialMenu);
  if(initial && initialMenuFormTargets(style).some(target=>!input.items.some(item=>item.kind==='form'&&item.key===initialFormKey(style,target))))
    throw new StyleError('initial_menu_forms_required');
  if(!initial&&input.items.some(item=>item.kind==='form'))throw new StyleError('initial_menu_required');
  // 受け皿は 1 アカウントに 1 つだけなので、ごあいさつの決まりも 1 つまで。
  if (input.items.filter((i) => i.kind === 'friend_add_rule').length > 1)
    throw new StyleError('invalid_starter_set');
  // タグの見本は 1 組だけ。2 組あると［タグにする］がどちらを指すか決まらない。
  if (input.items.filter((i) => i.kind === 'tag_set').length > 1)
    throw new StyleError('invalid_starter_set');
  if (
    input.items.some(
      (i) =>
        i.kind === 'automation' &&
        (i.triggerType !== 'restaurant.departed' ||
          i.key === 'reminder' ||
          /予約確定/.test(i.name)),
    )
  )
    throw new StyleError('duplicate_confirmation_automation', 422);
  // Older saved sets may contain the retired sample. Existing forms and published URLs remain valid.
  return style === 'restaurant' ? { ...input, items: input.items.filter(item => !isRetiredRestaurantMenuForm(item, style)) } : input;
}
