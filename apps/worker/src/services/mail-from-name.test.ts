import { beforeEach, describe, expect, it, vi } from 'vitest';

type RelayMessage = { to: string; subject: string; body: string; html?: string; fromName?: string };

// 差出人名は引数として渡るので、引数の型まで書いておく（型検査で中身を確かめるため）。
const sendViaXServerRelay = vi.hoisted(() =>
  vi.fn(async (_relayUrl: string, _secret: string, _input: RelayMessage) => 'message-id'),
);
const sendXServerMail = vi.hoisted(() =>
  vi.fn(async (_env: unknown, _input: RelayMessage & { from: string }) => {}),
);

vi.mock('./support-relay.js', () => ({ sendViaXServerRelay }));
vi.mock('./xserver-mail.js', () => ({ sendXServerMail }));

import type { Env } from '../worker-env.js';
import { mailFromName, MUSUBO_FROM_NAME, NEN_FROM_NAME } from './mail-from-name.js';
import { sendPlainMail } from './plain-mail.js';

/**
 * 共有のメール送信経路でも SaaS とペットフードの差出人名が混ざらないよう、件名に対応した表示名を確かめる。
 */
describe('mailFromName', () => {
  it('件名が【musubo】で始まるメールは musubo から送る', () => {
    expect(mailFromName('【musubo】メールアドレスの確認と本登録')).toBe(MUSUBO_FROM_NAME);
    expect(mailFromName('【musubo】パスワードの再設定')).toBe(MUSUBO_FROM_NAME);
    expect(mailFromName('【musubo運用】お知らせ')).toBe(MUSUBO_FROM_NAME);
  });

  it('然-NEN- の明示的な件名だけ専用の窓口名から送る', () => {
    expect(mailFromName('【然-NEN-】ご注文ありがとうございます')).toBe(NEN_FROM_NAME);
    expect(mailFromName('お問い合わせへの返信')).toBe(MUSUBO_FROM_NAME);
    expect(mailFromName('')).toBe(MUSUBO_FROM_NAME);
  });

  it('表示名に改行は入らない（From ヘッダーを壊さない）', () => {
    for (const name of [MUSUBO_FROM_NAME, NEN_FROM_NAME]) {
      expect(name).not.toMatch(/[\r\n]/);
    }
  });
});

describe('sendPlainMail の差出人名', () => {
  const env = {
    CONTACT_EMAIL: 'contact@example.com',
    XSERVER_RELAY_URL: 'https://example.test/_system/support-mail-relay.php',
    XSERVER_RELAY_SECRET: 'x'.repeat(48),
  } as unknown as Env['Bindings'];

  beforeEach(() => {
    sendViaXServerRelay.mockClear();
    sendXServerMail.mockClear();
  });

  it('中継へ musubo の表示名を渡す', async () => {
    await sendPlainMail(env, { to: 'user@example.test', subject: '【musubo】パスワードの再設定', body: '本文' });
    expect(sendXServerMail).not.toHaveBeenCalled();
    expect(sendViaXServerRelay.mock.calls[0]?.[2]).toMatchObject({
      to: 'user@example.test',
      fromName: MUSUBO_FROM_NAME,
    });
  });

  it('検証環境の中継へHTMLと文字版を両方渡す', async () => {
    await sendPlainMail(env, {
      to: 'user@example.test', subject: '【musubo】管理画面への招待',
      body: '文字版', html: '<p>HTML版</p>',
    });
    expect(sendViaXServerRelay.mock.calls[0]?.[2]).toMatchObject({
      body: '文字版', html: '<p>HTML版</p>', fromName: MUSUBO_FROM_NAME,
    });
  });

  it('然-NEN- 側の件名は窓口名のまま', async () => {
    await sendPlainMail(env, { to: 'user@example.test', subject: '【然-NEN-】お知らせ', body: '本文' });
    expect(sendViaXServerRelay.mock.calls[0]?.[2]).toMatchObject({ fromName: NEN_FROM_NAME });
  });

  it('中継が無い環境では SMTP にも同じ表示名を渡す', async () => {
    const smtpEnv = { CONTACT_EMAIL: 'contact@example.com' } as unknown as Env['Bindings'];
    await sendPlainMail(smtpEnv, { to: 'user@example.test', subject: '【musubo】メールアドレスの確認と本登録', body: '本文' });
    expect(sendViaXServerRelay).not.toHaveBeenCalled();
    expect(sendXServerMail.mock.calls[0]?.[1]).toMatchObject({
      from: 'contact@example.com',
      fromName: MUSUBO_FROM_NAME,
    });
  });

  it('呼び出し側が表示名を指定したときはそれを使う', async () => {
    await sendPlainMail(env, { to: 'user@example.test', subject: '件名', body: '本文', fromName: MUSUBO_FROM_NAME });
    expect(sendViaXServerRelay.mock.calls[0]?.[2]).toMatchObject({ fromName: MUSUBO_FROM_NAME });
  });
});
