import type { Env } from '../worker-env.js';
import { sendPlainMail } from './plain-mail.js';
import { registrationReceiptMailHtml, signupMailHtml } from './signup-mail-design.js';

/**
 * 会員登録・パスワード再設定メールは musubo 名義で送る。本文は URL と有効期限に絞り、パスワードなど不要な秘密を含めない。
 */

export const SIGNUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const PASSWORD_RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * 送信元を本文からも確認できるよう、musubo 名義の署名を末尾に付ける。差出人不明の短文として迷惑メールに分類されるのを避ける。
 */
const MAIL_FOOTER = ['', '---', 'musubo（ムスボ）', 'https://admin.musubo.jp', 'このメールは送信専用です。'];

export async function sendRegistrationReceiptMail(env: Env['Bindings'], input: { email: string; companyName: string }): Promise<void> {
  await sendPlainMail(env, {
    to: input.email,
    subject: '【musubo】お申し込みを受け付けました',
    body: [
      `${input.companyName} 様`, '',
      'musubo へのお申し込みを受け付けました。',
      '受付が完了しました。運営で内容を確認し、承認後に「利用開始のご案内」をメールでお送りします。',
      '',
      '今後の流れ',
      '1. お申し込み内容を確認（確認事項がある場合のみ担当者からご連絡）',
      '2. 承認のメールをお届け',
      '3. メールからアカウント設定と料金確認',
      '',
      'この時点で料金は発生しません。無料体験は初回LINE有効化日から始まります。',
      'お心当たりが無い場合は、このメールを破棄してください。',
      ...MAIL_FOOTER,
    ].join('\n'),
    html: registrationReceiptMailHtml(),
  });
}

export async function sendSignupVerifyMail(env: Env['Bindings'], input: { email: string; completeUrl: string }): Promise<void> {
  await sendPlainMail(env, {
    to: input.email,
    subject: '【musubo】利用開始のご案内',
    body: [
      'musubo へのお申し込みが承認されました。',
      '',
      '次の URL からログイン用アカウントを作成してください。パスワードと二段階認証の設定後、料金確認へ進めます。',
      input.completeUrl,
      '',
      'この URL の有効期限は 24 時間です。期限が過ぎたときは、開いた画面から再送できます。',
      '適用される料金と無料期間は、アカウント作成後の料金確認画面でご確認いただけます。',
      'お心当たりが無い場合は、このメールを破棄してください。登録は行われません。',
      ...MAIL_FOOTER,
    ].join('\n'),
    html: signupMailHtml(input.completeUrl, false),
  });
}

export async function sendSignupResendMail(env: Env['Bindings'], input: { email: string; completeUrl: string }): Promise<void> {
  await sendPlainMail(env, {
    to: input.email,
    subject: '【musubo】アカウント作成のご案内（再送）',
    body: [
      'musubo のアカウント作成リンクを再送します。', '',
      '新しいリンクからパスワードと二段階認証を設定してください。',
      input.completeUrl, '',
      'このリンクは送信から24時間有効です。以前のリンクは利用できません。',
      'アカウント作成だけでは無料体験も請求も始まりません。最初のLINE有効化日から開始します。',
      'お心当たりがない場合は、このメールを破棄してください。',
      ...MAIL_FOOTER,
    ].join('\n'),
    html: signupMailHtml(input.completeUrl, true),
  });
}

export async function sendAlreadyRegisteredMail(env: Env['Bindings'], input: { email: string; loginUrl: string; forgotUrl: string }): Promise<void> {
  await sendPlainMail(env, {
    to: input.email,
    subject: '【musubo】このメールアドレスはすでに登録されています',
    body: [
      'musubo への登録のお申し込みを受け付けましたが、このメールアドレスはすでに登録されています。',
      '',
      'ログインはこちら',
      input.loginUrl,
      '',
      'パスワードを忘れた場合はこちら',
      input.forgotUrl,
      '',
      'お心当たりが無い場合は、このメールを破棄してください。',
      ...MAIL_FOOTER,
    ].join('\n'),
  });
}

export async function sendPasswordResetMail(env: Env['Bindings'], input: { email: string; name: string; resetUrl: string }): Promise<void> {
  await sendPlainMail(env, {
    to: input.email,
    subject: '【musubo】パスワードの再設定',
    body: [
      `${input.name} 様`,
      '',
      '次の URL を開いて、新しいパスワードを設定してください。',
      input.resetUrl,
      '',
      'この URL の有効期限は 1 時間です。設定すると、ほかの端末のログインはすべて解除されます。',
      'お心当たりが無い場合は、このメールを破棄してください。パスワードは変わりません。',
      ...MAIL_FOOTER,
    ].join('\n'),
  });
}
