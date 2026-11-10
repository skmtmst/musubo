/** Shared, email-client-friendly layout for the approved musubo transactional mails. */
export function escapeMailHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

export function safeMailUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new RangeError('Email link must be HTTPS');
  return url.toString();
}

export function mailJstDate(iso: string, time = false): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) throw new RangeError('Invalid email date');
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric',
    ...(time ? { hour: '2-digit', minute: '2-digit', hour12: false } : {}),
  }).format(parsed);
}

export const mailMoney = (yen: number): string => {
  if (!Number.isSafeInteger(yen) || yen < 0) throw new RangeError('Email amount must be a nonnegative whole number');
  return `¥${new Intl.NumberFormat('ja-JP').format(yen)}`;
};

export function musuboMailShell(content: string): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f5f7;color:#202428;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Kaku Gothic ProN','Yu Gothic',Meiryo,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f5f7;"><tr><td align="center" style="padding:32px 16px 48px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#fff;border:1px solid #dfe5e7;border-radius:16px;">
<tr><td style="padding:28px 32px 24px;border-bottom:1px solid #e5eaec;"><span style="display:inline-block;color:#087c43;font-size:34px;font-weight:800;line-height:1;vertical-align:middle;">m</span><span style="display:inline-block;margin-left:12px;color:#173f35;font-size:28px;font-weight:800;line-height:1.2;vertical-align:middle;">musubo</span></td></tr>
<tr><td style="padding:36px 32px 32px;">${content}</td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid #e5eaec;color:#778698;font-size:12px;">musubo（ムスボ） ・ このメールは送信専用です。</td></tr>
</table></td></tr></table></body></html>`;
}

export function musuboMailButton(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:26px auto;"><tr><td align="center" bgcolor="#087c43" style="border-radius:9px;"><a href="${escapeMailHtml(safeMailUrl(url))}" style="display:block;box-sizing:border-box;width:280px;max-width:100%;padding:17px 20px;color:#fff;text-decoration:none;text-align:center;font-size:17px;font-weight:700;line-height:1.35;">${escapeMailHtml(label)}</a></td></tr></table>`;
}

export interface MusuboMailSummaryRow { label: string; value: string }

export function musuboMailSummary(title: string, rows: readonly MusuboMailSummaryRow[]): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef8f1;border-radius:11px;"><tr><td style="padding:22px;">
<p style="margin:0 0 12px;color:#087c43;font-size:16px;font-weight:700;">${escapeMailHtml(title)}</p>
${rows.map((row) => `<p style="margin:0 0 8px;color:#435064;font-size:14px;line-height:1.65;">${escapeMailHtml(row.label)}：<strong style="color:#202428;">${escapeMailHtml(row.value)}</strong></p>`).join('')}
</td></tr></table>`;
}

export interface MusuboSimpleMailContent {
  subject: string;
  eyebrow: string;
  title: string;
  intro: string;
  detail: string;
  summaryTitle: string;
  rows: readonly MusuboMailSummaryRow[];
  buttonLabel: string;
  buttonUrl: string;
  notes: readonly string[];
}

export function musuboSimpleMail(content: MusuboSimpleMailContent): { subject: string; html: string; text: string } {
  const html = musuboMailShell(`<p style="margin:0 0 12px;color:#087c43;font-size:14px;font-weight:700;">${escapeMailHtml(content.eyebrow)}</p>
<h1 style="margin:0 0 26px;font-size:26px;line-height:1.45;">${escapeMailHtml(content.title)}</h1>
<p style="margin:0 0 15px;color:#425364;font-size:16px;line-height:1.7;">${escapeMailHtml(content.intro)}</p>
<p style="margin:0 0 25px;color:#425364;font-size:16px;line-height:1.7;">${escapeMailHtml(content.detail)}</p>
${musuboMailSummary(content.summaryTitle, content.rows)}
${musuboMailButton(content.buttonUrl, content.buttonLabel)}
${content.notes.map((note) => `<p style="margin:0 0 12px;color:#59687b;font-size:14px;line-height:1.7;">${escapeMailHtml(note)}</p>`).join('')}`);
  const text = [content.title, '', content.intro, content.detail, '', content.summaryTitle,
    ...content.rows.map((row) => `${row.label}：${row.value}`), '', content.buttonLabel, safeMailUrl(content.buttonUrl),
    '', ...content.notes, '', 'musubo（ムスボ）', 'このメールは送信専用です。'].join('\n');
  return { subject: content.subject, html, text };
}
