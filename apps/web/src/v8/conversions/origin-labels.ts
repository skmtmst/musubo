/**
 * 起点ごとの名前・対象・金額の説明(R41)。
 *
 * 作成・一覧・詳細・編集で同じものを使う。起点ごとに言葉を書き分けると、
 * タグ起点なのに「注文」「EC連携」と出る取り違えが起きる(R41)。
 * 新しい起点を足すときはここ1か所に足す。
 */

import type { ConversionValueMode } from '@/lib/api'

export interface ConversionOriginInfo {
  /** 起点のキー(event_type)。 */
  key: string;
  /** 短い名前(選択肢・種別の札)。 */
  name: string;
  /** 「何が起きたら数えるか」の1行(一覧・詳細)。 */
  trigger: string;
  /** 対象欄の見出し(作成フォーム)。 */
  targetLabel: string;
  /** 対象の説明(作成フォームの対象欄・詳細の対象行)。 */
  target: string;
  /** 金額の説明(作成フォームの金額欄の補足・詳細の金額行)。 */
  amount: string;
  /** 選べる金額の出し方。注文の金額が無い起点は 'source' を含めない。 */
  valueModes: ConversionValueMode[];
  /** 起点を選んだ直後の金額の出し方。必ず valueModes の中から選ぶ。 */
  defaultValueMode: ConversionValueMode;
}

const ORIGINS: Record<string, ConversionOriginInfo> = {
  ec_order_confirmed: {
    key: 'ec_order_confirmed',
    name: '注文が確定した',
    trigger: 'EC連携の「注文が確定」',
    targetLabel: 'どの注文を数えるか',
    target: 'すべての注文。EC連携で受け取った注文確定を数えます。',
    amount: '注文の金額をそのまま記録します。合計の無い注文は金額なしになります。',
    valueModes: ['source', 'fixed', 'none'],
    defaultValueMode: 'source',
  },
  form_submitted: {
    key: 'form_submitted',
    name: 'フォームが送信された',
    trigger: '回答フォームの送信',
    targetLabel: 'どのフォームを数えるか',
    target: 'すべての回答フォーム。どのフォームの送信でも1件数えます。',
    amount: '起点に金額が無いため、金額は金額なしで記録します。',
    valueModes: ['fixed', 'none'],
    defaultValueMode: 'none',
  },
  reservation_confirmed: {
    key: 'reservation_confirmed',
    name: '予約が確定した',
    trigger: '予約管理の「予約が確定」',
    targetLabel: 'どの予約を数えるか',
    target: '確定したすべての予約。仮の申込は数えません。',
    amount: '起点に金額が無いため、金額は金額なしで記録します。',
    valueModes: ['fixed', 'none'],
    defaultValueMode: 'none',
  },
  url_reach: {
    key: 'url_reach',
    name: 'ページを見た',
    trigger: '指定したページに到達',
    targetLabel: '数えてよいページ',
    target: '指定したページに着いた人を数えます。',
    amount: '起点に金額が無いため、金額は金額なしで記録します。',
    valueModes: ['fixed', 'none'],
    defaultValueMode: 'none',
  },
  webinar_completed: {
    key: 'webinar_completed',
    name: '動画を見終えた',
    trigger: 'ウェビナーの「視聴完了」',
    targetLabel: 'どの動画を数えるか',
    target: '最後まで見たすべての視聴。途中でやめた人は数えません。',
    amount: '起点に金額が無いため、金額は金額なしで記録します。',
    valueModes: ['fixed', 'none'],
    defaultValueMode: 'none',
  },
  tag_added: {
    key: 'tag_added',
    name: 'タグが付いた',
    trigger: '友だちへのタグ付け',
    targetLabel: 'どのタグを数えるか',
    target: 'すべてのタグ。どのタグが付いても1件数えます。',
    amount: '起点に金額が無いため、金額は金額なしで記録します。',
    valueModes: ['fixed', 'none'],
    defaultValueMode: 'none',
  },
  // 過去に作られた行の種別。いまは選べないが、一覧・詳細では今の言葉で出す。
  ec_subscription_confirmed: {
    key: 'ec_subscription_confirmed',
    name: '定期が確定した',
    trigger: 'EC連携の「定期が確定」',
    targetLabel: 'どの定期を数えるか',
    target: 'すべての定期。EC連携で受け取った定期確定を数えます。',
    amount: '定期の金額をそのまま記録します。合計の無い定期は金額なしになります。',
    valueModes: ['source', 'fixed', 'none'],
    defaultValueMode: 'source',
  },
  purchase: {
    key: 'purchase',
    name: '購入',
    trigger: '購入の記録',
    targetLabel: 'どの購入を数えるか',
    target: 'すべての購入。',
    amount: '記録した金額を使います。金額の無い記録は金額なしになります。',
    valueModes: ['source', 'fixed', 'none'],
    defaultValueMode: 'source',
  },
  form_submit: {
    key: 'form_submit',
    name: '申込・登録',
    trigger: '回答フォームの送信',
    targetLabel: 'どのフォームを数えるか',
    target: 'すべての回答フォーム。どのフォームの送信でも1件数えます。',
    amount: '起点に金額が無いため、金額は金額なしで記録します。',
    valueModes: ['fixed', 'none'],
    defaultValueMode: 'none',
  },
  visit: {
    key: 'visit',
    name: '来店・参加',
    trigger: '来店・参加の記録',
    targetLabel: 'どの来店を数えるか',
    target: 'すべての来店・参加。',
    amount: '起点に金額が無いため、金額は金額なしで記録します。',
    valueModes: ['fixed', 'none'],
    defaultValueMode: 'none',
  },
};

const FALLBACK: ConversionOriginInfo = {
  key: '',
  name: 'その他',
  trigger: '接続したシステムから成果の通知を受信',
  targetLabel: '何を数えるか',
  target: '起点の設定を確認してください。',
  amount: '金額の設定を確認してください。',
  // 知らない起点は注文の金額を使わせない。金額がある起点だと分かってから足す。
  valueModes: ['fixed', 'none'],
  defaultValueMode: 'none',
};

/** 起点キーから説明を引く。知らないキーは「その他」で返す(空の表示にしない)。 */
export function originInfoOf(sourceType: string | null | undefined): ConversionOriginInfo {
  if (typeof sourceType !== 'string' || !sourceType.trim()) return FALLBACK;
  return Object.prototype.hasOwnProperty.call(ORIGINS, sourceType)
    ? ORIGINS[sourceType]
    : { ...FALLBACK, key: sourceType };
}
