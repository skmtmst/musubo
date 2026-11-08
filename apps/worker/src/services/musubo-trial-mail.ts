import { musuboTrialDates, type MusuboTrialPeriod } from '@line-crm/shared';
import { mailJstDate, mailMoney, musuboSimpleMail } from './musubo-mail-layout.js';

export interface MusuboTrialMailInput {
  event: 'started' | 'ending';
  activatedDateJst: string;
  trialPeriod: MusuboTrialPeriod;
  activeLineCount: number;
  estimatedFirstChargeYen: number;
  lineBasicDiscountPercent: number;
  accountUrl: string;
  billingUrl: string;
}

const localDay = (value: string) => mailJstDate(`${value}T12:00:00+09:00`);

/** Mail 03 and 04. The period and estimate come from the approved condition snapshot. */
export function musuboTrialMail(input: MusuboTrialMailInput): { subject: string; html: string; text: string } {
  const dates = musuboTrialDates(input.activatedDateJst, input.trialPeriod);
  if (!Number.isSafeInteger(input.activeLineCount) || input.activeLineCount < 1) throw new RangeError('activeLineCount must be positive');
  if (!Number.isSafeInteger(input.lineBasicDiscountPercent) || input.lineBasicDiscountPercent < 0 || input.lineBasicDiscountPercent > 100) {
    throw new RangeError('Invalid LINE basic discount');
  }
  const period = `${input.trialPeriod.value}${input.trialPeriod.unit === 'months' ? 'か月' : '日'}`;
  const special = input.lineBasicDiscountPercent > 0;
  const discountNote = special
    ? `LINE基本料金のみ${input.lineBasicDiscountPercent}%オフを反映しています。統括機能・友だち超過料金・追加連携枠は割引対象外です。`
    : '予定額は請求時点の有効LINE数・友だち数・追加連携枠数の利用状況により変わります。';
  if (input.event === 'started') return musuboSimpleMail({
    subject: `【musubo】${input.trialPeriod.unit === 'months' ? `${period}の` : ''}無料体験が始まりました`,
    eyebrow: special ? '特別条件での利用開始' : '利用開始のお知らせ',
    title: `${special ? period : ''}無料体験が始まりました`,
    intro: 'LINE公式アカウントの接続が完了しました。',
    detail: '本日からmusuboをご利用いただけます。適用中の無料期間と初回請求予定をご確認ください。',
    summaryTitle: '利用開始の内容',
    rows: [
      { label: '有効LINE', value: `${input.activeLineCount}個` },
      { label: '無料期間', value: `${localDay(dates.activationDate)}～${localDay(dates.lastFreeDate)}（${period}）` },
      { label: '初回請求予定', value: `${localDay(dates.firstChargeDate)}　${mailMoney(input.estimatedFirstChargeYen)}（税込・予定）` },
    ],
    buttonLabel: 'アカウント一覧を開く', buttonUrl: input.accountUrl,
    notes: ['無料期間中のご請求は¥0です。終了日と予定額は適用中の条件から表示します。',
      special ? discountNote : 'LINEを追加する場合は、接続前に料金の増分を確認できます。'],
  });
  return musuboSimpleMail({
    subject: '【musubo】無料体験終了と初回請求のご案内', eyebrow: '初回請求の事前案内',
    title: special ? `${period}無料体験はまもなく終了します` : '無料体験はまもなく終了します',
    intro: 'musuboのご利用ありがとうございます。',
    detail: '無料期間の終了後は、登録済みのカードへ請求します。請求日と現在の予定額をご確認ください。',
    summaryTitle: '初回請求予定',
    rows: [
      { label: '無料体験終了', value: localDay(dates.lastFreeDate) },
      { label: '初回請求予定', value: localDay(dates.firstChargeDate) },
      { label: '現在の予定額', value: `${mailMoney(input.estimatedFirstChargeYen)}（税込）` },
    ],
    buttonLabel: '請求予定額とカードを確認', buttonUrl: input.billingUrl,
    notes: [discountNote, 'カードを変更する場合は、請求画面からお手続きください。'],
  });
}
