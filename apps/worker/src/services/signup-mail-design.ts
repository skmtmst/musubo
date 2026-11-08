import { safeMailUrl } from './musubo-mail-layout.js';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

/** Email-client friendly version of the approved account-creation mail. */
export function signupMailHtml(url: string, resent: boolean): string {
  const href = escapeHtml(safeMailUrl(url));
  const title = resent ? '新しい設定リンクをお送りします' : 'お申し込みが承認されました';
  const intro = resent
    ? 'musuboへのお申し込みは承認済みです。新しいリンクからログイン用アカウントを作成してください。'
    : 'musuboへのお申し込みありがとうございます。ログイン用アカウントを設定すると、料金の確認とLINEの接続に進めます。まずはパスワードを設定してください。';
  const note = resent
    ? 'このリンクは送信から24時間有効です。以前のリンクは利用できません。'
    : '設定リンクは送信から24時間有効です。期限切れの場合は、開いた画面から再送できます。';
  const trialNote = resent
    ? 'アカウント作成だけでは無料体験も請求も始まりません。最初のLINE有効化日から開始します。'
    : '適用される料金と無料期間は、アカウント作成後の料金確認画面でご確認いただけます。';
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f5f7;color:#202428;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Kaku Gothic ProN','Yu Gothic',Meiryo,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f5f7;"><tr><td align="center" style="padding:32px 16px 48px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:100%;max-width:600px;background:#fff;border:1px solid #dfe5e7;border-radius:16px;">
<tr><td style="padding:28px 32px 24px;border-bottom:1px solid #e5eaec;"><span style="display:inline-block;color:#087c43;font-size:34px;font-weight:800;line-height:1;vertical-align:middle;">m</span><span style="display:inline-block;margin-left:12px;color:#173f35;font-size:28px;font-weight:800;line-height:1.2;vertical-align:middle;">musubo</span></td></tr>
<tr><td style="padding:36px 32px 32px;"><p style="margin:0 0 12px;color:#087c43;font-size:14px;font-weight:700;">${resent ? 'アカウント作成のご案内' : 'お申し込みの承認'}</p>
<h1 style="margin:0 0 28px;color:#202428;font-size:26px;line-height:1.45;">${escapeHtml(title)}</h1>
<p style="margin:0 0 16px;color:#435064;font-size:16px;line-height:1.8;">${escapeHtml(intro)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 24px;"><tr><td align="center" bgcolor="#087c43" style="border-radius:9px;"><a href="${href}" style="display:block;box-sizing:border-box;width:280px;max-width:100%;padding:17px 20px;color:#fff;text-decoration:none;text-align:center;font-size:17px;font-weight:700;line-height:1.35;">アカウント作成へ</a></td></tr></table>
<p style="margin:0 0 12px;color:#59687b;font-size:14px;line-height:1.7;">${escapeHtml(note)}</p>
<p style="margin:0 0 20px;color:#59687b;font-size:14px;line-height:1.7;">${escapeHtml(trialNote)}</p>
<p style="margin:0;color:#59687b;font-size:14px;line-height:1.7;">お心当たりがない場合は、このメールを破棄してください。</p></td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid #e5eaec;color:#778698;font-size:12px;">musubo（ムスボ） ・ このメールは送信専用です。</td></tr>
</table></td></tr></table></body></html>`;
}

/** Pen email 01: application receipt with the three steps before account setup. */
export function registrationReceiptMailHtml(): string {
  return [
    '<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>',
    '<body style="margin:0;padding:0;background:#f3f5f7;color:#202428;font-family:-apple-system,BlinkMacSystemFont,Hiragino Kaku Gothic ProN,Yu Gothic,Meiryo,sans-serif;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f3f5f7;"><tr><td align="center" style="padding:32px 16px 48px;">',
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#fff;border:1px solid #dfe5e7;border-radius:16px;">',
    '<tr><td style="padding:28px 32px 24px;border-bottom:1px solid #e5eaec;"><span style="display:inline-block;color:#087c43;font-size:34px;font-weight:800;line-height:1;vertical-align:middle;">m</span><span style="display:inline-block;margin-left:12px;color:#173f35;font-size:28px;font-weight:800;line-height:1.2;vertical-align:middle;">musubo</span></td></tr>',
    '<tr><td style="padding:36px 32px 32px;"><p style="margin:0 0 12px;color:#087c43;font-size:14px;font-weight:700;">お申し込み受付</p>',
    '<h1 style="margin:0 0 28px;color:#202428;font-size:26px;line-height:1.45;">お申し込みを受け付けました</h1>',
    '<p style="margin:0 0 16px;color:#435064;font-size:16px;line-height:1.8;">musuboへのお申し込みありがとうございます。</p>',
    '<p style="margin:0 0 28px;color:#435064;font-size:16px;line-height:1.8;">受付が完了しました。運営で内容を確認し、承認後に「利用開始のご案内」をメールでお送りします。</p>',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef8f1;border-radius:12px;"><tr><td style="padding:24px;">',
    '<p style="margin:0 0 16px;color:#087c43;font-size:17px;font-weight:700;">今後の流れ</p>',
    '<p style="margin:0 0 12px;color:#2c3440;font-size:15px;line-height:1.5;"><strong style="color:#087c43;">01</strong>　<strong>お申し込み内容を確認</strong><br><span style="color:#59687b;font-size:13px;">確認事項がある場合のみ、担当者からご連絡します。</span></p>',
    '<p style="margin:0 0 12px;color:#2c3440;font-size:15px;line-height:1.5;"><strong style="color:#087c43;">02</strong>　<strong>承認のメールをお届け</strong><br><span style="color:#59687b;font-size:13px;">申込時のメールアドレスへ「利用開始のご案内」を送ります。</span></p>',
    '<p style="margin:0;color:#2c3440;font-size:15px;line-height:1.5;"><strong style="color:#087c43;">03</strong>　<strong>メールからアカウント設定</strong><br><span style="color:#59687b;font-size:13px;">パスワードと二段階認証を設定し、料金を確認します。</span></p>',
    '</td></tr></table>',
    '<p style="margin:24px 0 12px;color:#59687b;font-size:14px;line-height:1.7;">この時点で料金は発生しません。無料体験は初回LINE有効化日から始まります。</p>',
    '<p style="margin:0;color:#59687b;font-size:14px;line-height:1.7;">お心当たりがない場合は、このメールを破棄してください。</p></td></tr>',
    '<tr><td style="padding:20px 32px;border-top:1px solid #e5eaec;color:#778698;font-size:12px;">musubo（ムスボ） ・ このメールは送信専用です。</td></tr>',
    '</table></td></tr></table></body></html>',
  ].join('');
}
