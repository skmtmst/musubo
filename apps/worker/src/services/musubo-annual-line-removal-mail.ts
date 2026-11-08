import { mailJstDate, mailMoney, musuboSimpleMail } from './musubo-mail-layout.js';

interface AnnualLineRemovalBase {
  lineName: string;
  /** This notice covers the Pen branch where two active LINE accounts become one. */
  previousLineCount: 2;
  nextAnnualRenewalAt: string;
  nextAnnualLineChargeYen: number;
  accountUrl: string;
}

export type MusuboAnnualLineRemoval = AnnualLineRemovalBase & ({
  event: 'scheduled';
  endAt: string;
  lastUsableAt: string;
} | {
  event: 'immediate';
  endedAt: string;
  nextMonthlyChargeAt: string;
  nextMonthlyOptionsYen: number;
});

/** Pen's annual 2→1 LINE-removal mails; the next renewal uses the remaining LINE. */
export function musuboAnnualLineRemovalMail(input: MusuboAnnualLineRemoval): { subject: string; html: string; text: string } {
  const lineName = input.lineName.trim();
  if (!lineName || input.previousLineCount !== 2) throw new RangeError('Expected a named LINE and a 2-to-1 removal');
  const nextAnnual = mailMoney(input.nextAnnualLineChargeYen);
  const annualDate = mailJstDate(input.nextAnnualRenewalAt);

  if (input.event === 'scheduled') {
    if (Date.parse(input.endAt) !== Date.parse(input.nextAnnualRenewalAt)
      || Date.parse(input.lastUsableAt) >= Date.parse(input.endAt)) {
      throw new RangeError('Scheduled removal must take effect at the annual renewal');
    }
    return musuboSimpleMail({
      subject: '【musubo】LINEアカウント利用終了予約のご案内',
      eyebrow: '利用終了のご案内', title: `${lineName}の利用終了を予約しました`,
      intro: '利用終了の予約内容をご確認ください。',
      detail: `${lineName}は${mailJstDate(input.lastUsableAt)}まで利用できます。利用終了日は${mailJstDate(input.endAt)}です。`,
      summaryTitle: '予約内容と次のお支払い',
      rows: [
        { label: '利用終了予定', value: mailJstDate(input.endAt) },
        { label: '終了後の有効LINE', value: '2個 → 1個' },
        { label: '次の年次更新', value: `${annualDate}　${nextAnnual}（税込・予定）` },
        { label: '統括機能', value: `${annualDate}から請求対象外` },
      ], buttonLabel: '予約内容を確認', buttonUrl: input.accountUrl,
      notes: ['年次更新前なら、アカウント画面から利用終了予約を取り消せます。',
        'すでにお支払い済みのLINE基本料金の返金はありません。',
        '友だち超過・追加連携枠の料金がある場合は、利用状況に応じて別途計算します。'],
    });
  }

  const monthly = mailMoney(input.nextMonthlyOptionsYen);
  if (Date.parse(input.endedAt) >= Date.parse(input.nextAnnualRenewalAt)
    || Date.parse(input.nextMonthlyChargeAt) <= Date.parse(input.endedAt)) {
    throw new RangeError('Next charge dates must follow immediate removal');
  }
  return musuboSimpleMail({
    subject: '【musubo】LINEアカウント利用終了のご案内',
    eyebrow: '利用終了のご案内', title: `${lineName}の利用を終了しました`,
    intro: '利用終了後の料金をご確認ください。',
    detail: `${mailJstDate(input.endedAt)}に${lineName}の利用を終了しました。以降、このLINEではmusuboの機能を利用できません。`,
    summaryTitle: '終了後のお支払い予定',
    rows: [
      { label: '有効LINE', value: '2個 → 1個' },
      { label: '次の月次請求', value: `${mailJstDate(input.nextMonthlyChargeAt)}　${monthly}（税込・予定）` },
      { label: '次の年次更新', value: `${annualDate}　${nextAnnual}（税込・予定）` },
      { label: '統括機能', value: `${mailJstDate(input.nextMonthlyChargeAt)}から請求対象外` },
    ], buttonLabel: 'アカウントと料金を確認', buttonUrl: input.accountUrl,
    notes: ['年払い済みのLINE基本料金は返金されません。',
      '友だち超過・追加連携枠がある場合は、実際の利用状況に応じて別途計算します。'],
  });
}
