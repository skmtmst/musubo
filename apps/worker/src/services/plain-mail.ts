import type { Env } from '../worker-env.js';
import { mailFromName } from './mail-from-name.js';

/**
 * 運用者向けのメールを1通送る。HTMLがある場合も文字版を必ず添える。
 *
 * 送り方は権限者の招待メールと同じ（Xserver の中継か、Xserver の SMTP）。
 * 秘密の値は env から読むだけで、ここには書かない。
 *
 * 差出人の表示名は件名の呼び名から決める（`mail-from-name.ts`）。
 */
export async function sendPlainMail(
  env: Env['Bindings'],
  input: { to: string; subject: string; body: string; html?: string; fromName?: string },
): Promise<void> {
  const from = env.CONTACT_EMAIL || 'contact-shed@nen-petfood.com';
  const message = {
    to: input.to,
    subject: input.subject,
    body: input.body,
    ...(input.html ? { html: input.html } : {}),
    fromName: input.fromName || mailFromName(input.subject),
  };
  if (env.XSERVER_RELAY_URL && env.XSERVER_RELAY_SECRET) {
    const { sendViaXServerRelay } = await import('./support-relay.js');
    await sendViaXServerRelay(env.XSERVER_RELAY_URL, env.XSERVER_RELAY_SECRET, message);
    return;
  }
  const { sendXServerMail } = await import('./xserver-mail.js');
  await sendXServerMail(env, { ...message, from });
}
