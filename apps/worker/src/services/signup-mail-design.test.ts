import { describe, expect, it } from 'vitest';
import { registrationReceiptMailHtml, signupMailHtml } from './signup-mail-design.js';

describe('申込メールのHTML', () => {
  it('受付メールに料金が始まる前の流れを示す', () => {
    const html = registrationReceiptMailHtml();
    expect(html).toContain('今後の流れ');
    expect(html).toContain('初回LINE有効化日から始まります');
    expect(html).not.toContain('いまの操作はここまで');
  });

  it('承認と再送のメールは中央寄せの同じボタンを使い、URLをエスケープする', () => {
    const initial = signupMailHtml('https://admin.example.com/register/complete?token=ab&x=1', false);
    const resent = signupMailHtml('https://admin.example.com/register/complete?token=ab&x=1', true);
    for (const html of [initial, resent]) {
      expect(html).toContain('width:280px');
      expect(html).toContain('text-align:center');
      expect(html).toContain('アカウント作成へ');
      expect(html).toContain('token=ab&amp;x=1');
      expect(html).toContain('送信から24時間有効');
    }
    expect(resent).toContain('以前のリンクは利用できません');
  });
});
