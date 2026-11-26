import {
  listInterpolations,
  TEMPLATE_SAMPLE_VARIABLE_LABELS,
  type AccountStyle,
  type IndustryStyle,
  type StyleTemplateSample,
} from '@line-crm/shared';

import { HQ_AUTHORED_MESSAGE_ID } from './hq-templates/authoring-media.js';

type Sample = [key: string, name: string, text: string];
const common: Sample[] = [
  [
    'reservation-confirmation',
    '予約の確認',
    '{{name}}さん、ご予約ありがとうございます。\n日時：{{var.reservation_datetime}}\nご予約の確認・変更はこちらです。\n{{var.reservation_url}}\n{{account.name}}',
  ],
  [
    'day-before',
    '前日のリマインド',
    '{{name}}さん、明日のご予約のご案内です。\n日時：{{var.reservation_datetime}}\n変更がある場合はこちらからお知らせください。\n{{var.reservation_url}}\n{{account.name}}',
  ],
  [
    'same-day',
    '当日の案内',
    '{{name}}さん、本日はよろしくお願いいたします。\nご予約の日時：{{var.reservation_datetime}}\nお気をつけてお越しください。\n{{account.name}}',
  ],
  [
    'thanks',
    '来店のお礼',
    '{{name}}さん、本日はありがとうございました。\n気になることがありましたら、このトークでお知らせください。\nまたお会いできるのを楽しみにしています。\n{{account.name}}',
  ],
  [
    'review',
    '口コミのお願い',
    '{{name}}さん、ご利用ありがとうございました。\nよろしければ、ご感想をお聞かせください。\n{{var.review_url}}\n{{account.name}}',
  ],
  [
    'waitlist',
    'キャンセル待ちの空きの知らせ',
    '{{name}}さん、お待ちの時間に空きが出ました。\n日時：{{var.reservation_datetime}}\nご希望の場合はこちらからお申し込みください。\n{{var.reservation_url}}\n{{account.name}}',
  ],
  [
    'temporary-closure',
    '臨時休業のお知らせ',
    'いつもありがとうございます。\n{{var.closure_datetime}}は臨時休業いたします。\nご予約済みのお客さまには、個別にご連絡いたします。\n{{account.name}}',
  ],
  [
    'hours-change',
    '営業時間の変更',
    '営業時間変更のお知らせです。\n{{var.business_hours}}\nご不便をおかけしますが、よろしくお願いいたします。\n{{account.name}}',
  ],
  [
    'new-item',
    '新メニュー・新商品',
    '新しいメニュー・商品をご用意しました。\n{{var.new_item}}\n詳しくはこちらをご覧ください。\n{{var.product_url}}\n{{account.name}}',
  ],
  [
    'coupon',
    'クーポンのご案内',
    '{{name}}さんへ、クーポンのご案内です。\n内容と有効期限をご確認のうえ、ご利用ください。\n{{var.coupon_url}}\n{{account.name}}',
  ],
  [
    'birthday',
    '誕生日のお祝い',
    '{{name}}さん、お誕生日おめでとうございます。\n素敵な一年になりますように。\nこれからもよろしくお願いいたします。\n{{account.name}}',
  ],
  [
    'recall',
    'しばらく来ていない人へ',
    '{{name}}さん、お元気ですか。\nまたご都合のよいときにお越しください。\nご予約はこちらからどうぞ。\n{{var.reservation_url}}\n{{account.name}}',
  ],
  [
    'payment',
    '支払いのリンク',
    '{{name}}さん、お支払いのご案内です。\n内容と金額をご確認のうえ、こちらからお手続きください。\n{{var.payment_url}}\n{{account.name}}',
  ],
  [
    'ticket-remaining',
    '回数券の残りわずか',
    '{{name}}さん、ご利用中の回数券の残りが少なくなりました。\n残りの回数と有効期限はマイページでご確認いただけます。\n{{var.mypage_url}}\n{{account.name}}',
  ],
  [
    'inquiry-received',
    'お問い合わせの受け付け',
    '{{name}}さん、お問い合わせありがとうございます。\n内容を確認して、担当者からお返事いたします。\n{{account.name}}',
  ],
];
const industry: Record<IndustryStyle, Sample[]> = {
  restaurant: [
    [
      'course-confirmation',
      'コースの予約確認',
      '{{name}}さん、コースのご予約ありがとうございます。\n日時：{{var.reservation_datetime}}\nコース：{{var.course_name}}\n人数：{{var.guest_count}}名\n{{account.name}}',
    ],
    [
      'seat-ready',
      '席の準備ができました',
      '{{name}}さん、お席の準備ができました。\n受付までお声がけください。\n{{account.name}}',
    ],
    [
      'banquet',
      '宴会の事前確認',
      '{{name}}さん、ご宴会の事前確認です。\n日時：{{var.reservation_datetime}}\n人数：{{var.guest_count}}名\nアレルギーや人数の変更がありましたら、このトークでお知らせください。\n{{account.name}}',
    ],
  ],
  salon: [
    [
      'next-visit',
      '次回の目安のご案内',
      '{{name}}さん、ご来店ありがとうございました。\n次回は{{var.next_visit_date}}頃がおすすめです。\nご都合のよい日時をこちらからお選びください。\n{{var.reservation_url}}\n{{account.name}}',
    ],
    [
      'aftercare',
      '施術後のお手入れ',
      '{{name}}さん、本日はありがとうございました。\nご自宅でのお手入れのご案内です。\n{{var.aftercare}}\n気になることがありましたら、お知らせください。\n{{account.name}}',
    ],
  ],
  consult: [
    [
      'online-url',
      'オンラインのURL',
      '{{name}}さん、オンライン面談のご案内です。\n日時：{{var.reservation_datetime}}\nお時間になりましたら、こちらからお入りください。\n{{var.meet_url}}\n{{account.name}}',
    ],
    [
      'place',
      '持ち物と場所の案内',
      '{{name}}さん、面談のご案内です。\n日時：{{var.reservation_datetime}}\n場所：{{var.meeting_location}}\n持ち物：{{var.bring_items}}\n{{account.name}}',
    ],
    [
      'outcome',
      '結果のご連絡',
      '{{name}}さん、先日はお時間をいただきありがとうございました。\n面談の結果と今後のご案内です。\n{{var.consultation_result}}\nご不明な点は、このトークでお知らせください。\n{{account.name}}',
    ],
  ],
  lesson: [
    [
      'reschedule',
      '振替の案内',
      '{{name}}さん、レッスンの振替のご案内です。\n振替先の日時をご確認ください。\n{{var.reservation_datetime}}\n{{var.reservation_url}}\n{{account.name}}',
    ],
    [
      'monthly-fee',
      '月謝のお知らせ',
      '{{name}}さん、月謝のお支払いのご案内です。\n内容と金額、お支払い期限はこちらからご確認ください。\n{{var.payment_url}}\n{{account.name}}',
    ],
    [
      'trial-thanks',
      '体験のお礼と入会の案内',
      '{{name}}さん、体験にご参加いただきありがとうございました。\n入会のご案内はこちらです。\n{{var.membership_url}}\nご質問は、このトークでお気軽にお知らせください。\n{{account.name}}',
    ],
  ],
};
const ecSamples: Sample[] = [
  ['purchase-thanks', '購入へのお礼', 'ご購入ありがとうございます。ご注文の内容はこちらからご確認いただけます。\n{{var.order_url}}\n{{account.name}}'],
  ['restock', '再入荷のお知らせ', '入荷のお知らせを希望された{{var.product_name}}が再入荷しました。数に限りがあります。\n{{var.product_url}}\n{{account.name}}'],
];


/** 一覧読取やテンプレート作成だけでは配信を予約しない。 */
export function templateSamples(style: AccountStyle): StyleTemplateSample[] {
  const specific = industry[style as IndustryStyle] ?? [];
  const catalog = style === 'ec' ? [...common, ...ecSamples] : common;
  return [
    ...catalog.map((s) => ({ sample: s, category: 'common' as const })),
    ...specific.map((s) => ({ sample: s, category: style as IndustryStyle })),
  ].map(({ sample: [key, originalName, originalText], category }) => {
    const name = style === 'consult' ? originalName.replaceAll('来店', '面談') : style === 'lesson' ? originalName.replaceAll('来店', '参加') : originalName;
    let text = originalText;
    if (style === 'consult') text = text.replaceAll('ご来店', '面談へのご参加').replaceAll('ご予約', '面談のご予約').replaceAll('お気をつけてお越しください。', '会い方・場所は予約の内容をご確認ください。').replaceAll('またご都合のよいときにお越しください。', 'またご都合のよい日時にお申し込みください。');
    if (style === 'lesson') text = text.replaceAll('ご予約', 'クラスのお申し込み').replaceAll('お気をつけてお越しください。', '参加方法は申込内容をご確認ください。');
    return ({
    key,
    name,
    category,
    text,
    placeholders: listInterpolations(text).map((key) => ({
      token: `{{${key}}}`,
      label: TEMPLATE_SAMPLE_VARIABLE_LABELS[key.replace(/^var\./, '')] ?? key,
      requiresConfiguration: key.startsWith('var.'),
    })),
    preparation:
      '送る前に、日時・URLなどの共通情報を今回の相手に合わせて設定してください。予約の情報は自動では入りません。',
    starterItem: {
      key: 'sample-' + key,
      kind: 'template' as const,
      name,
      text,
    },
    hqDefinition: {
      schemaVersion: 1 as const,
      template: {
        id: HQ_AUTHORED_MESSAGE_ID,
        name,
        category: 'general',
        messageType: 'text' as const,
        messageContent: text,
        carouselActionsJson: null,
        carouselTapLimitMode: 'none' as const,
        carouselTapLimitText: null,
        questionJson: null,
        questionStatus: 'draft' as const,
      },
      media: [],
    },
  }); });
}
