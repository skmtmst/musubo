import { mailJstDate, mailMoney, musuboSimpleMail } from './musubo-mail-layout.js';

export type MusuboInvoiceMailEvent = 'failed' | 'day_six' | 'suspended' | 'recovered';

export interface MusuboInvoiceMailInput {
  event: MusuboInvoiceMailEvent;
  amountYen: number;
  invoiceAt: string;
  graceDeadlineAt: string;
  billingUrl: string;
  nextChargeAt?: string;
}

/** Mail 10–13. Delivery recipients and idempotency are handled by the caller. */
export function musuboInvoiceMail(input: MusuboInvoiceMailInput): { subject: string; html: string; text: string } {
  const amount = `${mailMoney(input.amountYen)}（税込）`;
  const invoice = mailJstDate(input.invoiceAt, true);
  const deadline = mailJstDate(input.graceDeadlineAt, true);
  const rows = [
    { label: 'お支払い額', value: amount },
    { label: '請求失敗', value: invoice },
    { label: input.event === 'suspended' ? '一時停止開始' : '対応期限', value: deadline },
  ];

  switch (input.event) {
    case 'failed': return musuboSimpleMail({
      subject: '【musubo】お支払いの確認をお願いします', eyebrow: 'お支払いに対応が必要',
      title: 'お支払いを確認できませんでした', intro: 'musuboをご利用いただきありがとうございます。',
      detail: `${invoice}の請求が完了していません。未払いの場合、${deadline}に利用を一時停止します。`,
      summaryTitle: '未払いの請求', rows, buttonLabel: 'お支払いを完了する', buttonUrl: input.billingUrl,
      notes: ['カードの変更や必要な認証はStripeの画面で行います。', 'お支払いの完了を確認したら、メールと請求画面でお知らせします。'],
    });
    case 'day_six': return musuboSimpleMail({
      subject: '【musubo】明日、利用が一時停止します', eyebrow: 'お支払い期限のご案内',
      title: '明日までにお支払いをお願いします', intro: 'musuboをご利用いただきありがとうございます。',
      detail: `${deadline}までにお支払いが確認できない場合、自動応答・配信などの有料機能が一時停止します。`,
      summaryTitle: '対象の請求と期限', rows, buttonLabel: 'お支払いを完了する', buttonUrl: input.billingUrl,
      notes: ['LINEの接続設定とデータは保持します。', 'お支払いが済んでいる場合は、請求画面で確認状況をご覧ください。'],
    });
    case 'suspended': return musuboSimpleMail({
      subject: '【musubo】利用を一時停止しました', eyebrow: '利用状態のお知らせ',
      title: '利用を一時停止しました', intro: 'musuboをご利用いただきありがとうございます。',
      detail: '未払いのお支払いが確認できなかったため、有料機能を一時停止しました。LINEの接続設定とデータは保持しています。',
      summaryTitle: '未払いの請求', rows, buttonLabel: 'お支払いを完了する', buttonUrl: input.billingUrl,
      notes: ['お支払いを確認したら、同じLINE接続で利用を再開できます。', '停止中に送れなかった予約配信は自動送信しません。'],
    });
    case 'recovered': {
      if (!input.nextChargeAt) throw new RangeError('nextChargeAt is required for recovery mail');
      return musuboSimpleMail({
        subject: '【musubo】お支払いを確認しました', eyebrow: 'お支払い完了',
        title: 'お支払いを確認しました', intro: 'musuboをご利用いただきありがとうございます。',
        detail: '未払い分の決済が完了し、通常の利用状態になりました。LINEの接続と設定は維持されています。',
        summaryTitle: 'お支払い内容', rows: [
          { label: 'お支払い額', value: amount },
          { label: '対象の請求', value: mailJstDate(input.invoiceAt) },
          { label: '次回請求予定', value: mailJstDate(input.nextChargeAt) },
        ], buttonLabel: '請求を確認する', buttonUrl: input.billingUrl,
        notes: ['お支払い履歴と次回の請求予定はmusuboの請求画面から確認できます。', '停止中に送れなかった予約配信がある場合は、再開後に内容をご確認ください。'],
      });
    }
  }
}
