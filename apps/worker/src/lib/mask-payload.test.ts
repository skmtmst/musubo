import { describe, expect, it } from 'vitest';
import { maskInteractionPayload } from './mask-payload.js';

/*
 * やり取りの本文を伏せて返す。伏せ方は `mask-payload.ts` の頭に書いた。
 * ここでは「伏せるものは伏せ、伏せないものは残す」と「元を変えない」を見る。
 */
describe('maskInteractionPayload', () => {
  it('名前・電話・メール・住所・トークンを伏せる', () => {
    const raw = JSON.stringify({
      name: '田中明',
      phone: '090-0000-5678',
      email: 'tanaka@example.com',
      address: '東京都港区1-2-3',
      accessToken: 'secret-abc',
      event: 'order_created',
      count: 3,
    });
    const masked = maskInteractionPayload(raw);
    expect(masked.available).toBe(true);
    expect(masked.body).toEqual({
      name: '***',
      phone: '***',
      email: '***',
      address: '***',
      accessToken: '***',
      event: 'order_created',
      count: 3,
    });
    // 元の文字列は変えない。
    expect(raw).toContain('田中明');
  });

  it('入れ子と配列の中も伏せる', () => {
    const masked = maskInteractionPayload(JSON.stringify({
      customer: { 氏名: '佐藤', 電話番号: '08000002222' },
      items: [{ email: 'a@example.com' }, { note: 'ふつうのメモ' }],
    }));
    expect(masked.body).toEqual({
      customer: { 氏名: '***', 電話番号: '***' },
      items: [{ email: '***' }, { note: 'ふつうのメモ' }],
    });
  });

  it('鍵によらず値の形でも伏せる', () => {
    const masked = maskInteractionPayload(JSON.stringify({
      contact: 'yamada@example.com',
      memo: '折り返し 03-0000-5678 まで',
    }));
    const body = masked.body as Record<string, string>;
    expect(body.contact).toBe('***');
    // 文の中に混ざった番号も置き換える。
    expect(body.memo).toBe('折り返し *** まで');
  });

  it('伏せる鍵の値が文字以外でも伏せる', () => {
    const masked = maskInteractionPayload(JSON.stringify({
      phone: 903334444,
      emailVerified: false,
      retryCount: 3,
      active: true,
    }));
    expect(masked.body).toEqual({
      phone: '***',
      emailVerified: '***',
      retryCount: 3,
      active: true,
    });
  });

  it('文の途中のメール・電話番号を置き換える', () => {
    const masked = maskInteractionPayload(JSON.stringify({
      memo: '連絡先 tanaka@example.com か 090-0000-5678 まで',
    }));
    const body = masked.body as Record<string, string>;
    expect(body.memo).toBe('連絡先 *** か *** まで');
    expect(body.memo).not.toContain('tanaka@example.com');
    expect(body.memo).not.toContain('090-0000-5678');
  });

  it('LINE の userId・IP アドレス・生年月日の鍵を伏せる', () => {
    const masked = maskInteractionPayload(JSON.stringify({
      userId: 'Udeadbeefdeadbeefdeadbeefdeadbeef',
      note: 'Udeadbeefdeadbeefdeadbeefdeadbeef から 192.168.1.10 で受信',
      birthday: '1990-05-21',
      birthplace: '東京',
      orderDate: '2026-10-03',
    }));
    const body = masked.body as Record<string, string>;
    expect(body.userId).toBe('***');
    expect(body.note).toBe('*** から *** で受信');
    expect(body.birthday).toBe('***');
    expect(body.birthplace).toBe('***');
    // 鍵の無い文中の日付は注文日と見分けられないため伏せない。
    expect(body.orderDate).toBe('2026-10-03');
  });

  it('空・JSONでない本文は伏せようがなく null', () => {
    expect(maskInteractionPayload(null)).toEqual({ body: null, available: false });
    expect(maskInteractionPayload('')).toEqual({ body: null, available: false });
    expect(maskInteractionPayload('not json')).toEqual({ body: null, available: false });
    expect(maskInteractionPayload('"ただの文字"')).toEqual({ body: null, available: false });
  });
});
