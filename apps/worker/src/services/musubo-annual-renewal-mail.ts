import { mailJstDate, mailMoney, musuboSimpleMail } from './musubo-mail-layout.js';

export interface MusuboAnnualRenewalNotice {
  estimatedAt: string;
  renewalAt: string;
  activeLineCountAfterReservations: number;
  annualLineChargeYen: number;
  monthlyOptionsAfterRenewalYen: number;
  /** A scheduled LINE closure already reflected in the estimated renewal amount. */
  endingLine?: { name: string; lastUsableAt: string };
  headquartersEndsAtRenewal: boolean;
  billingUrl: string;
}

/** Pen's 30-day annual renewal notice. All amounts are estimates from the saved contract. */
export function musuboAnnualRenewalMail(input: MusuboAnnualRenewalNotice): { subject: string; html: string; text: string } {
  const estimatedAt = Date.parse(input.estimatedAt);
  const renewalAt = Date.parse(input.renewalAt);
  if (!Number.isFinite(estimatedAt) || !Number.isFinite(renewalAt) || renewalAt <= estimatedAt) {
    throw new RangeError('Renewal must follow the estimate');
  }
  if (!Number.isSafeInteger(input.activeLineCountAfterReservations) || input.activeLineCountAfterReservations < 1) {
    throw new RangeError('At least one LINE must remain for a renewal');
  }
  const annual = mailMoney(input.annualLineChargeYen);
  const options = mailMoney(input.monthlyOptionsAfterRenewalYen);
  const renewalDate = mailJstDate(input.renewalAt);
  const ending = input.endingLine;
  if (ending && (!ending.name.trim() || Date.parse(ending.lastUsableAt) >= renewalAt)) {
    throw new RangeError('Scheduled LINE must end before the renewal');
  }

  return musuboSimpleMail({
    subject: '【musubo】年払い更新日とお支払い予定のご案内',
    eyebrow: '年次更新のご案内', title: '年払いの更新日が近づいています',
    intro: '次の年次更新日とお支払い予定をご確認ください。',
    detail: `年払いプランの次の更新日は${renewalDate}です。現在の利用状況${ending ? 'と終了予約' : ''}を反映したお支払い予定をご確認ください。`,
    summaryTitle: `次の年次更新（${mailJstDate(input.estimatedAt)}時点の予定）`,
    rows: [
      { label: '更新予定日', value: renewalDate },
      { label: '更新後の有効LINE', value: `${input.activeLineCountAfterReservations}個` },
      { label: 'LINE基本料金', value: `${annual}（税込・年払い）` },
      { label: '毎月のオプション料金', value: `${options}（税込・予定）` },
      ...(input.headquartersEndsAtRenewal
        ? [{ label: '統括機能', value: `${renewalDate}から請求対象外` }] : []),
    ], buttonLabel: 'お支払い予定を確認', buttonUrl: input.billingUrl,
    notes: [
      ...(ending ? [`${ending.name.trim()}は${mailJstDate(ending.lastUsableAt)}まで利用でき、${renewalDate}に終了します。`] : []),
      '更新額は更新時点の有効LINE数・友だち数・追加連携枠数で確定します。カードの有効性もご確認ください。',
    ],
  });
}
