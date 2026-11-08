import type { Env } from '../worker-env.js';
import { sendPlainMail as send } from './plain-mail.js';

type Invite = { name: string; email: string; verifyUrl?: string; lineUrl?: string; roleLabel?: '管理者' | '担当者' | '閲覧のみ' };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character] ?? character);
}

function secureUrl(value: string | undefined): string {
  if (!value) throw new Error('STAFF_INVITE_URL_MISSING');
  const url = new URL(value);
  if (url.protocol !== 'https:') throw new Error('STAFF_INVITE_URL_INSECURE');
  return url.toString();
}

export function renderStaffInviteHtml(input: {
  name: string; actionUrl: string; adminUrl: string; step: '01' | '02'; roleLabel?: Invite['roleLabel'];
}): string {
  const isVerify = input.step === '01';
  const title = isVerify ? 'musuboへようこそ' : 'LINE連携を完了しましょう';
  const lead = isVerify
    ? 'musuboの管理画面に招待されました。まずは下のボタンからメールアドレスを確認してください。'
    : 'メールアドレスの確認が完了しました。下のボタンからLINEアカウントを連携すると、musuboにログインできます。';
  const button = isVerify ? 'メールアドレスを確認する' : 'LINE連携を完了する';
  const next = isVerify ? '確認後、LINE連携のご案内をお送りします。' : '今後は連携したLINEアカウントでログインします。';
  const status = isVerify ? `招待された役割　${escapeHtml(input.roleLabel ?? '担当者')}` : 'メールアドレスの確認　完了';
  const expiry = isVerify ? 'この招待は送信から7日間有効です。' : '招待は最初のメール送信から7日間有効です。';
  const logoUrl = new URL('/brand/musubo-color.png', input.adminUrl).toString();
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f7f5;color:#183a31;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7f5;"><tr><td align="center" style="padding:36px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:664px;background:#fff;border-top:5px solid #087a3e;border-radius:16px;">
<tr><td style="padding:36px 44px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="50%"><img src="${escapeHtml(logoUrl)}" width="185" height="55" alt="musubo" style="display:block;width:185px;max-width:100%;height:auto;border:0;"></td><td width="50%" align="right" style="color:#7a8582;font-size:11px;letter-spacing:.12em;">${isVerify ? 'MEMBER INVITATION' : 'LINE CONNECTION'}</td></tr></table></td></tr>
<tr><td style="padding:0 44px;"><div style="border-top:1px solid #e7ece9;"></div></td></tr>
<tr><td style="padding:32px 44px 0;"><span style="color:#087a3e;font-size:12px;font-weight:700;">STEP ${input.step} / 02 &nbsp;・&nbsp; ${isVerify ? 'メールアドレスの確認' : 'LINEアカウントの連携'}</span><h1 style="margin:14px 0 0;color:#17231d;font-size:29px;line-height:1.45;">${title}</h1></td></tr>
<tr><td style="padding:14px 44px 0;color:#25342b;font-size:16px;line-height:1.5;">${escapeHtml(input.name)} 様</td></tr>
<tr><td style="padding:14px 44px 0;color:#3b4841;font-size:15px;line-height:1.8;">${lead}</td></tr>
<tr><td align="center" style="padding:28px 44px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:320px;"><tr><td align="center" bgcolor="#087a3e" style="border-radius:8px;"><a href="${escapeHtml(input.actionUrl)}" style="display:block;padding:15px 10px;color:#fff;background:#087a3e;border-radius:8px;text-decoration:none;font-size:16px;font-weight:700;line-height:1.5;">${button} &nbsp;→</a></td></tr></table></td></tr>
<tr><td align="center" style="padding:14px 44px 0;color:#647169;font-size:13px;line-height:1.5;">${next}</td></tr>
<tr><td style="padding:28px 44px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f8f6;border-radius:10px;"><tr><td style="padding:16px 18px 0;color:#2e4336;font-size:13px;font-weight:700;line-height:1.5;">${status}</td></tr><tr><td style="padding:8px 18px 16px;color:#59675f;font-size:13px;line-height:1.5;">${expiry}</td></tr></table></td></tr>
<tr><td style="padding:30px 44px 0;"><div style="border-top:1px solid #e7ece9;"></div></td></tr>
<tr><td style="padding:22px 44px 0;color:#66736c;font-size:12px;line-height:1.6;">${isVerify ? 'この招待' : 'この操作'}に心当たりがない場合は、メールを破棄してください。</td></tr>
<tr><td style="padding:8px 44px 43px;color:#87928a;font-size:11px;line-height:1.6;">musuboからの自動送信メールです。このメールには返信できません。</td></tr>
</table></td></tr></table></body></html>`;
}

export async function sendStaffInviteEmail(env: Env['Bindings'], input: Invite): Promise<void> {
  const actionUrl = secureUrl(input.verifyUrl);
  const adminUrl = secureUrl(env.ADMIN_PUBLIC_URL || actionUrl);
  await send(env, { to: input.email, subject: '【musubo】管理画面への招待', body: `${input.name} 様\n\n管理画面へ招待されました。次のURLからメールアドレスを確認してください。\n${actionUrl}\n\nこのURLの有効期限は7日間です。`, html: renderStaffInviteHtml({ name: input.name, actionUrl, adminUrl, step: '01', roleLabel: input.roleLabel }) });
}

export async function sendStaffLineLinkEmail(env: Env['Bindings'], input: Invite): Promise<void> {
  const actionUrl = secureUrl(input.lineUrl);
  const adminUrl = secureUrl(env.ADMIN_PUBLIC_URL || actionUrl);
  await send(env, { to: input.email, subject: '【musubo】LINE連携を完了してください', body: `${input.name} 様\n\nメールアドレスの確認が完了しました。次のURLからLINE認証を行うと、管理画面へログインできます。\n${actionUrl}\n\n以後のログインはLINEを使用します。`, html: renderStaffInviteHtml({ name: input.name, actionUrl, adminUrl, step: '02' }) });
}

/*
 * 本人が自分のメールアドレスを変えるときの確認便り。
 *
 * 新しい宛先へ確認リンクを送り、開かれてはじめて変更が確定する。
 * 旧アドレスへは申し込みと完了の知らせを送り、覚えのない変更に
 * 気づけるようにする（乗っ取りの早期発見）。
 */
export async function sendStaffEmailChangeConfirmEmail(
  env: Env['Bindings'],
  input: { name: string; email: string; confirmUrl: string },
): Promise<void> {
  await send(env, {
    to: input.email,
    subject: '【musubo】メールアドレス変更の確認',
    body: `${input.name} 様\n\n管理画面のメールアドレスの変更が申し込まれました。このアドレスへ変更するには、次のURLを開いて確認してください。\n${input.confirmUrl}\n\nこのURLの有効期限は24時間です。覚えのない申し込みのときは、このメールを破棄してください。`,
  });
}

/** 申し込みがあったことを旧アドレスへ知らせる。 */
export async function sendStaffEmailChangeNoticeEmail(
  env: Env['Bindings'],
  input: { name: string; email: string; next: string },
): Promise<void> {
  await send(env, {
    to: input.email,
    subject: '【musubo】メールアドレス変更のお知らせ',
    body: `${input.name} 様\n\n管理画面のメールアドレスを ${input.next} へ変更する申し込みがありました。\n\n覚えのない申し込みのときは、管理者へ連絡してください。`,
  });
}

/** 変更が確定したことを旧アドレスへ知らせる。 */
export async function sendStaffEmailChangeCompletedEmail(
  env: Env['Bindings'],
  input: { name: string; email: string; next: string },
): Promise<void> {
  await send(env, {
    to: input.email,
    subject: '【musubo】メールアドレスを変更しました',
    body: `${input.name} 様\n\n管理画面のメールアドレスを ${input.next} へ変更しました。\n\n覚えのない変更のときは、管理者へ連絡してください。`,
  });
}
