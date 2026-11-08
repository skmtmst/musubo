import { musuboIndividualQuotePrice, type MusuboIndividualQuote } from '@line-crm/shared';

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character] ?? character);
const money = (yen: number) => `¥${new Intl.NumberFormat('ja-JP').format(yen)}`;
const dateJst = (iso: string) => new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(iso));

function safeUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new RangeError('Email link must be HTTP or HTTPS');
  return url.toString();
}

function shell(content: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f5f7;color:#202428;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Kaku Gothic ProN','Yu Gothic',Meiryo,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f5f7;"><tr><td align="center" style="padding:32px 16px 48px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#fff;border:1px solid #dfe5e7;border-radius:16px;">
<tr><td style="padding:28px 32px 24px;border-bottom:1px solid #e5eaec;"><span style="display:inline-block;color:#087c43;font-size:34px;font-weight:800;line-height:1;vertical-align:middle;">m</span><span style="display:inline-block;margin-left:12px;color:#173f35;font-size:28px;font-weight:800;line-height:1.2;vertical-align:middle;">musubo</span></td></tr>
<tr><td style="padding:36px 32px 32px;">${content}</td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid #e5eaec;color:#778698;font-size:12px;">musubo（ムスボ） ・ このメールは送信専用です。</td></tr>
</table></td></tr></table></body></html>`;
}

function button(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:26px auto;"><tr><td align="center" bgcolor="#087c43" style="border-radius:9px;"><a href="${escapeHtml(safeUrl(url))}" style="display:block;box-sizing:border-box;width:280px;max-width:100%;padding:17px 20px;color:#fff;text-decoration:none;text-align:center;font-size:17px;font-weight:700;line-height:1.35;">${escapeHtml(label)}</a></td></tr></table>`;
}

export function individualQuoteMail(input: {
  quote: MusuboIndividualQuote;
  reviewUrl: string;
  kind: 'issued' | 'reissued';
}): { subject: string; text: string; html: string } {
  const { quote, kind } = input;
  if (quote.acceptedAt !== null || quote.supersededAt !== null) throw new RangeError('Only a current unaccepted quote may be mailed');
  const price = musuboIndividualQuotePrice(quote);
  const reissued = kind === 'reissued';
  const title = reissued ? '新しいお見積もりをご用意しました' : 'お見積もりをご用意しました';
  const subject = reissued ? '【musubo】個別見積もり再発行のご案内' : '【musubo】個別見積もりのご案内';
  const intro = reissued
    ? '以前の見積もりは期限切れとなりました。新しい料金と有効期限をご確認のうえ、改めて同意してください。'
    : 'ご利用予定に合わせた料金をご用意しました。ログインして内容をご確認のうえ、同意してカード登録へお進みください。';
  const amount = quote.interval === 'month'
    ? `${money(price.plannedMonthlyTotalYen!)}／月（税込）`
    : `${money(price.finalAnnualLineChargeYen!)}／年（税込）`;
  const options = quote.interval === 'year'
    ? `オプション料金 ${money(price.optionsMonthlyYen)}／月は毎月別に請求します。` : '';
  const trial = `${quote.trialPeriod.value}${quote.trialPeriod.unit === 'months' ? 'か月' : '日'}無料`;
  const expiry = dateJst(quote.expiresAt);
  const note = reissued
    ? `新見積もり ${quote.quoteNumber} の有効期限：${expiry}。旧リンクからは同意できません。`
    : `見積もり有効期限：${expiry}。期限後は再発行を依頼できます。`;
  const trialNote = reissued
    ? '同意後は単価と適用条件が確定します。請求額は実際の連携数で決まります。カード登録は見積もり期限後も進められます。'
    : `カード登録だけでは請求も無料期間も始まりません。最初のLINE有効化日から${trial}です。`;
  const summary = `LINE ${quote.plannedLineCount}個 ＋ 追加連携${price.linkedSlots}枠`;
  const html = shell(`<p style="margin:0 0 12px;color:#087c43;font-size:14px;font-weight:700;">${reissued ? '個別見積もりの再発行' : '個別見積もりのご案内'}</p>
<h1 style="margin:0 0 26px;font-size:26px;line-height:1.45;">${escapeHtml(title)}</h1>
<p style="margin:0 0 15px;color:#425364;font-size:16px;line-height:1.7;">musuboをご利用いただき、ありがとうございます。</p>
<p style="margin:0 0 25px;color:#425364;font-size:16px;line-height:1.7;">${escapeHtml(intro)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef8f1;border-radius:11px;"><tr><td style="padding:22px;">
<p style="margin:0 0 8px;color:#425364;font-size:14px;">ご利用予定がすべて有効になった場合</p>
<p style="margin:0 0 8px;color:#087c43;font-size:25px;font-weight:800;">${escapeHtml(amount)}</p>
<p style="margin:0;color:#526476;font-size:13px;line-height:1.6;">${escapeHtml(summary)}${options ? `<br>${escapeHtml(options)}` : ''}</p>
</td></tr></table>${button(input.reviewUrl, 'お見積もりを確認する')}
<p style="margin:0 0 12px;color:#59687b;font-size:14px;line-height:1.7;">${escapeHtml(note)}</p>
<p style="margin:0;color:#59687b;font-size:14px;line-height:1.7;">${escapeHtml(trialNote)}</p>`);
  const text = [title, '', 'musuboをご利用いただき、ありがとうございます。', intro, '',
    'ご利用予定がすべて有効になった場合', amount, summary, options, '',
    'お見積もりを確認する', safeUrl(input.reviewUrl), '', note, trialNote,
    '', 'musubo（ムスボ）', 'このメールは送信専用です。'].filter(Boolean).join('\n');
  return { subject, text, html };
}

export function quoteReissueRequestReceiptMail(input: { quoteNumber: string }): { subject: string; text: string; html: string } {
  if (!input.quoteNumber.trim()) throw new RangeError('Quote number is required');
  const subject = '【musubo】見積もり再発行のご依頼を受け付けました';
  const title = '再発行のご依頼を受け付けました';
  const intro = `見積もり ${input.quoteNumber} の再発行依頼を受け付けました。担当者が料金を確認し、新しい見積もりをメールでお送りします。`;
  const steps = [
    ['料金条件を確認', '既存の問い合わせ窓口で、ご利用予定と料金を確認します。'],
    ['新しい見積もりを送信', '新しい見積もり番号と有効期限をメールでお知らせします。'],
    ['新しい内容を確認', '料金に同意した後、カード登録とLINE接続に進めます。'],
  ];
  const html = shell(`<p style="margin:0 0 12px;color:#087c43;font-size:14px;font-weight:700;">見積もり再発行依頼の受付</p>
<h1 style="margin:0 0 26px;font-size:26px;line-height:1.45;">${title}</h1>
<p style="margin:0 0 16px;color:#425364;font-size:16px;line-height:1.7;">musuboをご利用いただき、ありがとうございます。</p>
<p style="margin:0 0 25px;color:#425364;font-size:16px;line-height:1.7;">${escapeHtml(intro)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef8f1;border-radius:11px;"><tr><td style="padding:22px;">
<p style="margin:0 0 16px;color:#087c43;font-size:17px;font-weight:700;">今後の流れ</p>
${steps.map(([heading, detail], index) => `<p style="margin:0 0 15px;color:#202428;font-size:14px;line-height:1.6;"><strong style="color:#087c43;">0${index + 1}</strong>　<strong>${escapeHtml(heading)}</strong><br><span style="color:#59687b;">${escapeHtml(detail)}</span></p>`).join('')}
</td></tr></table>
<p style="margin:22px 0 12px;color:#59687b;font-size:14px;line-height:1.7;">この依頼だけで新たな請求は発生しません。</p>
<p style="margin:0;color:#59687b;font-size:14px;line-height:1.7;">同じ内容の依頼を繰り返す必要はありません。</p>`);
  const text = [title, '', 'musuboをご利用いただき、ありがとうございます。', intro, '', '今後の流れ',
    ...steps.map(([heading, detail], index) => `0${index + 1} ${heading}：${detail}`),
    '', 'この依頼だけで新たな請求は発生しません。', '同じ内容の依頼を繰り返す必要はありません。',
    '', 'musubo（ムスボ）', 'このメールは送信専用です。'].join('\n');
  return { subject, text, html };
}

/** Pen mail 06: receipt for an eleven-or-more LINE or linked-account inquiry. */
export function musuboQuoteInquiryReceiptMail(): { subject: string; text: string; html: string } {
  const subject = '【musubo】お見積もりのお問い合わせを受け付けました';
  const title = 'お問い合わせを受け付けました';
  const intro = 'musuboへお問い合わせいただき、ありがとうございます。';
  const detail = 'ご利用予定を確認し、担当者から料金と利用開始までの手順をメールでご案内します。';
  const steps = [
    ['ご利用予定を確認', 'LINE数、友だち数、Googleマイビジネス数とInstagram数を確認します。'],
    ['個別料金をご案内', 'ご利用条件とお支払い予定料金をメールでお送りします。'],
    ['同意後に利用開始の準備', '内容をご確認いただいてからカード登録とLINE接続へ進みます。'],
  ];
  const html = shell(`<p style="margin:0 0 12px;color:#087c43;font-size:14px;font-weight:700;">お見積もり受付</p>
<h1 style="margin:0 0 26px;font-size:26px;line-height:1.45;">${title}</h1>
<p style="margin:0 0 15px;color:#425364;font-size:16px;line-height:1.7;">${intro}</p>
<p style="margin:0 0 25px;color:#425364;font-size:16px;line-height:1.7;">${detail}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef8f1;border-radius:11px;"><tr><td style="padding:22px;">
<p style="margin:0 0 16px;color:#087c43;font-size:17px;font-weight:700;">今後のご案内</p>
${steps.map(([heading, explanation], index) => `<p style="margin:0 0 16px;color:#202428;font-size:14px;line-height:1.6;"><strong style="color:#087c43;">0${index + 1}</strong>　<strong>${heading}</strong><br><span style="color:#59687b;">${explanation}</span></p>`).join('')}
</td></tr></table>
<p style="margin:22px 0 12px;color:#59687b;font-size:14px;line-height:1.7;">この時点でカード登録やお支払いは必要ありません。</p>
<p style="margin:0;color:#59687b;font-size:14px;line-height:1.7;">お心当たりがない場合は、このメールを破棄してください。</p>`);
  const text = [title, '', intro, detail, '', '今後のご案内',
    ...steps.map(([heading, explanation], index) => `0${index + 1} ${heading}：${explanation}`),
    '', 'この時点でカード登録やお支払いは必要ありません。',
    'お心当たりがない場合は、このメールを破棄してください。',
    '', 'musubo（ムスボ）', 'このメールは送信専用です。'].join('\n');
  return { subject, text, html };
}
