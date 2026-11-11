/*
 * 運営コンソール（`/ops/*`）の画面確認モックが本物と約束違いしていないかの試験。
 *
 * 偽APIに運営メンバーの判定（`platformAdmin`）が無いと、`/ops` の全ページが
 * ログイン画面になり、撮影が「ログイン画面を撮って通過」になる。
 * 各ページが読む口の見本データも、本物（Worker の `ops*.ts`）の器に合わせる。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK_API = readFileSync(join(HERE, 'mock-api.mjs'), 'utf8');

describe('運営コンソールの画面確認モック', () => {
  it('セッションを運営メンバーとして返す', () => {
    expect(MOCK_API).toContain('platformAdmin: true');
  });

  it('お問い合わせ詳細の見本が HqSupportDetail 型どおりの器を持つ', () => {
    /*
     * 見本が無いと既定の `{items,total,page,limit}` が返り、日時の整形で
     * 落ちて `/hq/support/detail?id=visual-ticket-1` が開けなかった（2026-09-25）。
     */
    // 口は運営チケットと同型の正規表現で受けるため、素のパス文字ではなく正規表現の形で拾う。
    expect(MOCK_API).toContain('/hq\\/support\\/requests\\/');
    const block = MOCK_API.slice(MOCK_API.indexOf('const HQ_SUPPORT_REQUESTS = ['), MOCK_API.indexOf('機能9'));
    expect(block.length).toBeGreaterThan(0);
    expect(block).toContain('visual-ticket-1');
    for (const key of ['kindLabel', 'staffName', 'createdAt', 'stageLabel', 'messages', 'canFollowUp', 'authorKind', 'authorName']) {
      expect(block, `HQ_SUPPORT_DETAIL に ${key} がない`).toContain(key);
    }
    /*
     * 本物と同じく、最初の本文は `messages` に入れない（画面で2回出る）。
     * 統括からの続き（authorKind: 'tenant'）は入れてよいが、最初の本文と同じ文は入れない（絵 `OhguS`、2026-10-06）。
     * 運営の追記の名は `musubo 運営 ／ 名前` の形。
     */
    const firstBody = /subject: 'LINE の Webhook が遅れる', body: '([^']+)'/.exec(block)?.[1];
    expect(firstBody, '最初の本文が読めない').toBeTruthy();
    expect(block.split(`body: '${firstBody}'`).length - 1, '最初の本文が messages にも入っている').toBe(1);
    expect(block).toContain('musubo 運営 ／');
  });

  it('見本データに実在しそうな個人情報を入れない', () => {
    // 運営の見本データ（`OPS_*`）の範囲だけ見る。後ろの既存の器に
    // 昔ながらの `example.com` が残っているが、この試験の対象外。
    const opsBlock = MOCK_API.slice(MOCK_API.indexOf('const OPS_ME'), MOCK_API.indexOf('機能9'));
    expect(opsBlock.length).toBeGreaterThan(0);
    expect(opsBlock).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  });
});
