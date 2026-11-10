import { mailJstDate, mailMoney, musuboSimpleMail } from './musubo-mail-layout.js';

interface AnnualLineAdditionBase {
  previousLineCount: number;
  activeLineCount: number;
  accountUrl: string;
  /** The company discount, when any, is already included in the amounts below. */
  lineBasicDiscountPercent: number;
}

export type MusuboAnnualLineAddition = AnnualLineAdditionBase & ({
  phase: 'trial';
  firstChargeAt: string;
  firstAnnualLineChargeYen: number;
  firstMonthOptionsYen: number;
} | {
  phase: 'paid';
  paidNowYen: number;
  proratedAnnualLineYen: number;
  firstMonthOptionsYen: number;
  remainingAnnualDays: number;
  annualPeriodDays: number;
  nextMonthlyChargeAt: string;
  nextMonthlyOptionsYen: number;
  nextAnnualRenewalAt: string;
  nextAnnualLineChargeYen: number;
});

function money(value: number, name: string): string {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative whole number`);
  return mailMoney(value);
}

/** Pen's annual LINE-addition notices, with each displayed charge supplied by the billing record. */
export function musuboAnnualAddedLineMail(input: MusuboAnnualLineAddition): { subject: string; html: string; text: string } {
  if (!Number.isSafeInteger(input.previousLineCount) || input.previousLineCount < 1
    || input.activeLineCount !== input.previousLineCount + 1) {
    throw new RangeError('The added LINE must raise the active count by one');
  }
  if (!Number.isSafeInteger(input.lineBasicDiscountPercent)
    || input.lineBasicDiscountPercent < 0 || input.lineBasicDiscountPercent > 100) {
    throw new RangeError('Invalid LINE basic discount');
  }
  const ordinal = input.activeLineCount;
  const discountNote = input.lineBasicDiscountPercent > 0
    ? `${input.lineBasicDiscountPercent}%OFFの特別条件と年払い10%OFFはLINE基本料金だけに適用します。オプション料金は割引対象外です。`
    : '年払い10%OFFはLINE基本料金だけに適用します。オプション料金は月払いです。';

  if (input.phase === 'trial') {
    const annual = money(input.firstAnnualLineChargeYen, 'firstAnnualLineChargeYen');
    const options = money(input.firstMonthOptionsYen, 'firstMonthOptionsYen');
    const total = money(input.firstAnnualLineChargeYen + input.firstMonthOptionsYen, 'firstChargeYen');
    return musuboSimpleMail({
      subject: '【musubo】LINEアカウント追加と初回料金のご案内',
      eyebrow: 'LINE追加のお知らせ', title: `${ordinal}個目のLINEを追加しました`,
      intro: 'LINE公式アカウントの接続が完了しました。',
      detail: `無料期間中に${ordinal}個目のLINEの接続が完了しました。初回のお支払い予定をお知らせします。`,
      summaryTitle: '追加後の料金（年払い・無料期間中）',
      rows: [
        { label: '有効LINE', value: `${input.previousLineCount}個 → ${ordinal}個` },
        { label: '本日の請求', value: '¥0' },
        { label: '初回請求予定', value: `${mailJstDate(input.firstChargeAt)}　${total}（税込・予定）` },
        { label: '初回の内訳', value: `LINE年額 ${annual} ＋ オプション初月 ${options}` },
      ], buttonLabel: 'アカウントと料金を確認', buttonUrl: input.accountUrl,
      notes: ['無料期間の終了日は最初のLINE有効化日から変わりません。', discountNote],
    });
  }

  const prorated = money(input.proratedAnnualLineYen, 'proratedAnnualLineYen');
  const optionsFirst = money(input.firstMonthOptionsYen, 'firstMonthOptionsYen');
  const paidNow = money(input.paidNowYen, 'paidNowYen');
  const monthlyOptions = money(input.nextMonthlyOptionsYen, 'nextMonthlyOptionsYen');
  const annualRenewal = money(input.nextAnnualLineChargeYen, 'nextAnnualLineChargeYen');
  if (input.paidNowYen !== input.proratedAnnualLineYen + input.firstMonthOptionsYen) {
    throw new RangeError('Paid amount must equal the displayed LINE and option charges');
  }
  if (!Number.isSafeInteger(input.annualPeriodDays) || input.annualPeriodDays < 1
    || !Number.isSafeInteger(input.remainingAnnualDays) || input.remainingAnnualDays < 1
    || input.remainingAnnualDays > input.annualPeriodDays) {
    throw new RangeError('Invalid annual proration period');
  }
  return musuboSimpleMail({
    subject: '【musubo】LINEアカウント追加とお支払いのご案内',
    eyebrow: 'LINE追加のお知らせ', title: `${ordinal}個目のLINEを追加しました`,
    intro: 'LINE公式アカウントの接続が完了しました。',
    detail: `年払いの残期間に応じたLINE基本料金とオプション初月分のお支払いを確認し、${ordinal}個目のLINEを有効化しました。`,
    summaryTitle: '追加後の料金（年払い・有料利用中）',
    rows: [
      { label: '有効LINE', value: `${input.previousLineCount}個 → ${ordinal}個` },
      { label: '接続時の請求', value: `${paidNow}（税込）` },
      { label: '次の月次請求', value: `${mailJstDate(input.nextMonthlyChargeAt)}　${monthlyOptions}（税込・予定）` },
      { label: '次の年次更新', value: `${mailJstDate(input.nextAnnualRenewalAt)}　${annualRenewal}（税込・予定）` },
    ], buttonLabel: 'アカウントと料金を確認', buttonUrl: input.accountUrl,
    notes: [
      `接続時の請求内訳：LINE基本料金の残り${input.remainingAnnualDays}日分 ${prorated} ＋ オプション初月 ${optionsFirst}。`,
      `追加年額は残り${input.remainingAnnualDays}日／年間${input.annualPeriodDays}日で按分し、1円未満を切り捨てています。`,
      discountNote,
    ],
  });
}
