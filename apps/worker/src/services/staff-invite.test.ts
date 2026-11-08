import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker-env.js';

/*
 *。招待メールが伝える有効期限を、実際に送る本文で確かめる。
 *
 * 期限そのものは staff.ts の INVITE_TTL_MS が決める。本文がそれと食い違うと、
 * 受け取った人は「切れた」と思って捨てる/切れていないと思って放置する。
 * どちらも招待が完了しない。本文の数字を見張る。
 */
const relay = vi.hoisted(() => ({ sendXServerMail: vi.fn() }));
vi.mock('./xserver-mail.js', () => relay);

const { sendStaffInviteEmail, sendStaffLineLinkEmail } = await import('./staff-invite.js');

function env(): Env['Bindings'] {
  return { CONTACT_EMAIL: 'contact@example.test' } as Env['Bindings'];
}

beforeEach(() => {
  relay.sendXServerMail.mockReset();
  relay.sendXServerMail.mockResolvedValue(undefined);
});

describe('招待メールの有効期限の案内', () => {
  it('7日と伝える(48時間とは書かない)', async () => {
    await sendStaffInviteEmail(env(), {
      name: '招待された人', email: 'invitee@example.test',
      verifyUrl: 'https://admin.example.test/staff/invite#invite=token',
    });
    const body = relay.sendXServerMail.mock.calls[0][1].body as string;
    expect(body).toContain('7日間');
    expect(body).not.toContain('48時間');
    expect(body).toContain('https://admin.example.test/staff/invite#invite=token');
  });

  it('HTMLには公式ロゴと確認ボタンを表示し、テキスト版にリンクを残す', async () => {
    await sendStaffInviteEmail({ ...env(), ADMIN_PUBLIC_URL: 'https://stg-admin.musubo.jp' }, {
      name: '<テスト&様>', email: 'invitee@example.test',
      verifyUrl: 'https://stg-admin.musubo.jp/staff/invite#invite=a&b',
      roleLabel: '閲覧のみ',
    });
    const mail = relay.sendXServerMail.mock.calls[0][1];
    expect(mail.html).toContain('https://stg-admin.musubo.jp/brand/musubo-color.png');
    expect(mail.html).toContain('href="https://stg-admin.musubo.jp/staff/invite#invite=a&amp;b"');
    expect(mail.html).toContain('メールアドレスを確認する');
    expect(mail.html).toContain('招待された役割　閲覧のみ');
    expect(mail.html).toContain('&lt;テスト&amp;様&gt;');
    expect(mail.html).not.toContain('<テスト&様>');
    expect(mail.body).toContain('https://stg-admin.musubo.jp/staff/invite#invite=a&b');
  });

  it('LINE連携メールも専用ボタンで案内する', async () => {
    await sendStaffLineLinkEmail({ ...env(), ADMIN_PUBLIC_URL: 'https://stg-admin.musubo.jp' }, {
      name: 'テスト', email: 'invitee@example.test',
      lineUrl: 'https://stg-api.musubo.jp/api/auth/line?invite=token',
    });
    const mail = relay.sendXServerMail.mock.calls[0][1];
    expect(mail.html).toContain('LINE連携を完了する');
    expect(mail.html).toContain('href="https://stg-api.musubo.jp/api/auth/line?invite=token"');
    expect(mail.html).toContain('https://stg-admin.musubo.jp/brand/musubo-color.png');
  });

  it('ローカル開発のHTTPは使え、外部HTTPリンクは送信前に拒否する', async () => {
    await sendStaffInviteEmail(env(), {
      name: 'テスト', email: 'invitee@example.test',
      verifyUrl: 'http://localhost:3000/staff/invite#invite=token',
    });
    expect(relay.sendXServerMail.mock.calls[0][1].html).toContain('http://localhost:3000/staff/invite#invite=token');
    relay.sendXServerMail.mockClear();
    await expect(sendStaffInviteEmail(env(), {
      name: 'テスト', email: 'invitee@example.test',
      verifyUrl: 'http://example.test/staff/invite#invite=token',
    })).rejects.toThrow('STAFF_INVITE_URL_INSECURE');
    expect(relay.sendXServerMail).not.toHaveBeenCalled();
  });
});
