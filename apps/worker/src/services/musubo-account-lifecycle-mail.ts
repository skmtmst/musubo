import { linkedAccountSlots, type LinkedAccountCounts } from '@line-crm/shared';
import { mailJstDate, mailMoney, musuboSimpleMail } from './musubo-mail-layout.js';

const count = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative whole number`);
  return value;
};

/** Mail 05: sent only after the additional LINE is active. */
export function musuboAddedLineMail(input: {
  previousLineCount: number;
  activeLineCount: number;
  trialing: boolean;
  amountPaidNowYen: number;
  nextMonthlyTotalYen: number;
  accountUrl: string;
}): { subject: string; html: string; text: string } {
  if (count(input.previousLineCount, 'previousLineCount') < 1 || input.activeLineCount !== input.previousLineCount + 1) {
    throw new RangeError('The added LINE must raise the active count by one');
  }
  const ordinal = input.activeLineCount;
  return musuboSimpleMail({
    subject: '【musubo】LINEアカウント追加と料金のご案内', eyebrow: 'LINE追加のお知らせ',
    title: `${ordinal}個目のLINEを追加しました`, intro: 'LINE公式アカウントの接続が完了しました。',
    detail: input.trialing
      ? '追加後の有効LINE数と、お支払い予定をお知らせします。接続前に確認した料金と合わせてご確認ください。'
      : `追加分のお支払いを確認し、${ordinal}個目のLINEを有効化しました。今回のお支払いと次回以降の料金をご確認ください。`,
    summaryTitle: '追加後の料金',
    rows: [
      { label: '有効LINE', value: `${input.previousLineCount}個 → ${ordinal}個` },
      { label: input.trialing ? '本日の請求' : '今回の追加分', value: `${mailMoney(input.amountPaidNowYen)}（税込）` },
      { label: '次回から', value: `${mailMoney(input.nextMonthlyTotalYen)}／月（税込・予定）` },
    ], buttonLabel: 'アカウントと料金を確認', buttonUrl: input.accountUrl,
    notes: input.trialing
      ? ['無料体験の終了日は、最初のLINE有効化日から変わりません。', '有料利用中は、接続日からの日割り額と次回以降の料金を表示します。']
      : ['今回分は接続日から次の請求基準日までの残期間で日割り計算しました。', '次回以降の料金は、有効LINE数・友だち数・追加連携枠数の利用状況に応じます。'],
  });
}

/** Mail 19 and 20. The existing active LINE remains available in both states. */
export function musuboPendingLineMail(input: {
  event: 'payment_failed' | 'expired';
  addedLineOrdinal: number;
  activeLineCount: number;
  amountYen: number;
  holdUntil: string;
  actionUrl: string;
}): { subject: string; html: string; text: string } {
  const ordinal = count(input.addedLineOrdinal, 'addedLineOrdinal');
  const active = count(input.activeLineCount, 'activeLineCount');
  if (ordinal < 2 || active < 1) throw new RangeError('Invalid LINE addition counts');
  const failed = input.event === 'payment_failed';
  return musuboSimpleMail({
    subject: failed ? '【musubo】LINE追加のお支払いを確認してください' : '【musubo】LINE追加のお申し込みが期限切れになりました',
    eyebrow: failed ? 'LINE追加のお支払い' : 'LINE追加のお知らせ',
    title: failed ? '追加分のお支払いが完了していません' : 'LINE追加のお申し込みが期限切れです',
    intro: failed ? `${ordinal}個目のLINEの接続情報を確認しました。` : '追加分のお支払いを期限内に確認できませんでした。',
    detail: failed
      ? `追加分の決済が完了していないため、${ordinal}個目のLINEはまだ利用できません。現在お使いのLINEは通常どおり利用できます。`
      : `${ordinal}個目のLINEは有効化されていません。現在お使いのLINEは通常どおり利用できます。`,
    summaryTitle: failed ? '保留中の追加分' : '追加を希望する場合',
    rows: failed ? [
      { label: '追加対象', value: `${ordinal}個目のLINE` },
      { label: '今回のお支払い', value: `${mailMoney(input.amountYen)}（税込）` },
      { label: '保留期限', value: mailJstDate(input.holdUntil, true) },
    ] : [
      { label: '追加対象', value: `${ordinal}個目のLINE` },
      { label: '現在の有効LINE', value: `${active}個` },
      { label: '次のお支払い', value: '最新の料金で再確認' },
    ],
    buttonLabel: failed ? 'お支払いを再試行する' : '料金を再確認する', buttonUrl: input.actionUrl,
    notes: failed
      ? ['カードの更新や必要な本人認証はStripeの画面で行います。', '決済成功を確認してから追加LINEを有効化し、メールでお知らせします。']
      : ['最新の料金を確認・同意してから、必要に応じてカードを更新してください。', '接続情報の有効期限が切れている場合は、LINEの再認証をご案内します。'],
  });
}

/** Mail 15–18. Final LINE closure keeps company login and billing history. */
export function musuboFinalLineMail(input: {
  event: 'scheduled' | 'immediate' | 'resumed' | 'cancelled';
  lineName: string;
  interval: 'month' | 'year';
  actionUrl: string;
  endAt?: string;
  lastUsableAt?: string;
  resumedAt?: string;
  nextChargeAt?: string;
  nextChargeYen?: number;
  amountPaidNowYen?: number;
}): { subject: string; html: string; text: string } {
  const lineName = input.lineName.trim();
  if (!lineName) throw new RangeError('lineName is required');
  if (input.event === 'scheduled') {
    if (!input.endAt || !input.lastUsableAt) throw new RangeError('Scheduled end dates are required');
    return musuboSimpleMail({
      subject: '【musubo】最後のLINEの利用終了予約', eyebrow: '利用終了予約のご案内',
      title: '最後のLINEの利用終了を予約しました',
      intro: '利用できる最終日と、今後のお支払いをご確認ください。',
      detail: `${lineName}は${mailJstDate(input.lastUsableAt)}まで利用できます。${mailJstDate(input.endAt)}からLINEの配信・連携は停止します。`,
      summaryTitle: '予約内容と次の請求',
      rows: [
        { label: '利用できる最終日', value: mailJstDate(input.lastUsableAt) },
        { label: '終了後の有効LINE', value: '1個 → 0個' },
        { label: input.interval === 'year' ? '次の年次更新' : '次の月次請求', value: '¥0（税込）' },
      ], buttonLabel: '終了予約を確認', buttonUrl: input.actionUrl,
      notes: ['未払いの請求がある場合は引き続きお支払いが必要です。', '利用終了前なら、請求画面から終了予約を取り消せます。', 'お支払い済みの料金がある場合、利用終了による返金はありません。'],
    });
  }
  if (input.event === 'immediate') {
    if (!input.endAt) throw new RangeError('endAt is required');
    return musuboSimpleMail({
      subject: '【musubo】LINEの利用終了と今後の請求', eyebrow: '利用終了のご案内',
      title: '最後のLINEの利用を終了しました',
      intro: 'LINEの配信・連携は停止しました。今後の請求をご確認ください。',
      detail: `${mailJstDate(input.endAt)}に${lineName}の利用を終了しました。会社アカウントと請求履歴は引き続き確認できます。`,
      summaryTitle: '終了後のご利用とお支払い',
      rows: [
        { label: '有効LINE', value: '1個 → 0個' },
        { label: '次の月次請求', value: 'LINE関連の請求なし' },
        ...(input.interval === 'year' ? [{ label: '次の年次更新', value: '¥0（税込）' }] : []),
      ], buttonLabel: '請求履歴を確認', buttonUrl: input.actionUrl,
      notes: ['未払いの請求は終了後もお支払いが必要です。', 'お支払い済みの料金がある場合、利用終了による返金はありません。', '再開するときは料金を再確認します。無料体験の再適用はありません。'],
    });
  }
  if (!input.nextChargeAt || input.nextChargeYen === undefined) throw new RangeError('The next charge is required');
  const charge = `${mailJstDate(input.nextChargeAt)}　${mailMoney(input.nextChargeYen)}（税込）`;
  if (input.event === 'cancelled') return musuboSimpleMail({
    subject: '【musubo】LINE利用終了予約の取り消し', eyebrow: '終了予約取り消しのご案内',
    title: 'LINEの利用終了予約を取り消しました',
    intro: `${lineName}は引き続きご利用いただけます。`,
    detail: '利用終了の予約を取り消しました。LINEの配信・連携は停止せず、適用中の料金条件が継続します。',
    summaryTitle: '継続する利用と次のお支払い',
    rows: [
      { label: '有効LINE', value: '1個' },
      { label: '終了予定', value: '取り消し済み' },
      { label: input.interval === 'year' ? '次の年次更新' : '次の月次請求', value: charge },
    ], buttonLabel: '請求予定を確認', buttonUrl: input.actionUrl,
    notes: ['LINEを終了する場合は、請求画面で利用終了日をご確認ください。', '年払い10%OFFはLINE基本料金のみ対象です。'],
  });
  if (!input.resumedAt || input.amountPaidNowYen === undefined) throw new RangeError('Resume payment details are required');
  return musuboSimpleMail({
    subject: '【musubo】LINEの利用を再開しました', eyebrow: '利用再開のお知らせ',
    title: 'LINEの利用を再開しました', intro: 'LINE公式アカウントの接続が完了しました。',
    detail: '同じ会社アカウントでmusuboを再びご利用いただけます。今回の請求と次の更新日をご確認ください。',
    summaryTitle: '再開後の料金',
    rows: [
      { label: '有効LINE', value: '1個' },
      { label: '再開日', value: mailJstDate(input.resumedAt) },
      { label: '本日のLINE基本料金', value: mailMoney(input.amountPaidNowYen) },
      { label: input.interval === 'year' ? '次の年次更新' : '次の月次請求', value: charge },
    ], buttonLabel: 'アカウント一覧を開く', buttonUrl: input.actionUrl,
    notes: ['お支払い済みの期間は二重請求しません。料金は適用中の条件から表示します。', '無料体験の再適用はありません。追加連携などは利用状況に応じて別途計算します。'],
  });
}

/** Mail 21 and 22. The number of slots comes from the larger service count per LINE. */
export function musuboLinkedAccountMail(input: {
  event: 'added' | 'removed';
  lineName: string;
  service: 'googleBusiness' | 'instagram';
  before: LinkedAccountCounts;
  after: LinkedAccountCounts;
  amountPaidNowYen?: number;
  nextMonthlyChargeAt: string;
  linkedAccountSlotYen: number;
  actionUrl: string;
}): { subject: string; html: string; text: string } {
  const added = input.event === 'added';
  const beforeSlots = linkedAccountSlots(input.before);
  const afterSlots = linkedAccountSlots(input.after);
  if ((added && afterSlots !== beforeSlots + 1) || (!added && afterSlots > beforeSlots)) throw new RangeError('Invalid slot direction');
  const chargeReduced = !added && afterSlots < beforeSlots;
  if (added && input.amountPaidNowYen === undefined) throw new RangeError('Paid amount is required for activation mail');
  if (added && (!Number.isSafeInteger(input.amountPaidNowYen) || input.amountPaidNowYen! < 0)) throw new RangeError('Invalid current charge');
  const label = input.service === 'googleBusiness' ? 'Googleマイビジネス' : 'Instagram';
  const beforeCount = input.before[input.service];
  const afterCount = input.after[input.service];
  if (added && afterCount !== beforeCount + 1 || !added && afterCount !== beforeCount - 1) throw new RangeError('The linked service count must change by one');
  const nextMonthly = afterSlots * count(input.linkedAccountSlotYen, 'linkedAccountSlotYen');
  return musuboSimpleMail({
    subject: added ? '【musubo】追加連携先の有効化と料金のご案内' : '【musubo】連携先の解除と料金変更のご案内',
    eyebrow: added ? '連携先追加のお知らせ' : '連携先解除のお知らせ',
    title: added ? `${label}を追加しました` : '連携先を解除しました',
    intro: added ? `${input.lineName}の連携先を追加しました。` : `${input.lineName}の${label}1個の連携を停止しました。`,
    detail: added
      ? input.amountPaidNowYen! > 0
        ? `追加分の決済を確認し、新しい${label}を有効化しました。今回のお支払いと次回の料金をご確認ください。`
        : `新しい${label}を有効化しました。今回のお支払いはありません。次回以降の料金をご確認ください。`
      : chargeReduced
        ? '連携はすでに停止しています。追加枠の料金は、次の月次請求日から減額します。'
        : '連携はすでに停止しています。もう一方のサービスの連携数が追加枠の基準のため、今回の解除では料金は変わりません。',
    summaryTitle: added ? '追加後の連携枠料金' : chargeReduced ? '料金変更の予定' : '解除後の連携枠料金',
    rows: [
      { label, value: `${beforeCount}個 → ${afterCount}個` },
      { label: '追加連携枠', value: `${beforeSlots}枠 → ${afterSlots}枠` },
      { label: added ? '今回のお支払い' : chargeReduced ? '減額開始' : '料金変更',
        value: added ? `${mailMoney(input.amountPaidNowYen!)}（税込）` : chargeReduced ? mailJstDate(input.nextMonthlyChargeAt) : 'なし' },
      { label: added ? '次回から' : chargeReduced ? '減額後の追加枠料金' : '追加枠料金', value: `${mailMoney(nextMonthly)}／月（税込）` },
    ], buttonLabel: '連携先と料金を確認', buttonUrl: input.actionUrl,
    notes: added
      ? [input.amountPaidNowYen! > 0
        ? '追加分は次の月次請求日までの残期間で日割り計算しました。'
        : '今回の請求はありません。次回以降の料金は適用中の利用条件に従います。',
        '年払いでも追加連携枠は月次請求です。LINE基本料金の割引は追加枠に適用しません。']
      : chargeReduced
        ? ['支払済み期間の返金はありません。年払いでも追加枠の料金は月次請求です。', '次の月次請求日までに枠を再利用した場合は、減額予定を再計算します。']
        : ['GoogleマイビジネスとInstagramの多いほうの連携数で追加枠を数えます。', 'ほかの連携先を解除すると、次の月次請求から減額となる場合があります。'],
  });
}
