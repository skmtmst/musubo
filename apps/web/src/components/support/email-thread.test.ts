import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * メールのスレッドが叩く経路と、worker が受ける経路をそろえる。
 *
 * **これが揃っていなかった。** 画面は POST /status を投げ、worker は PATCH でしか
 * 受けていなかったので、メールの「対応」を変えても何も起きなかった。
 * しかも戻り値を見ていなかったので、失敗も画面に出なかった。
 *
 * 経路と動詞を突き合わせて、同じずれ方を二度としないようにする。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = readFileSync(join(HERE, 'email-thread.tsx'), 'utf8');
const WORKER = readFileSync(
  join(HERE, '..', '..', '..', '..', 'worker', 'src', 'routes', 'support-inbox.ts'),
  'utf8',
);

/** 画面が叩く `/api/support/email/threads/…/<末尾>` と、その動詞。 */
const CALLS: Array<{ tail: string; method: string }> = [
  { tail: 'status', method: 'PATCH' },
  { tail: 'assignee', method: 'PATCH' },
  { tail: 'notes', method: 'PATCH' },
  { tail: 'reply', method: 'POST' },
];

describe('メールのスレッドの経路', () => {
  it.each(CALLS)('画面は $tail を $method で叩く', ({ tail, method }) => {
    // 呼び出しは「操作を始めたスレッド」を変数に固定して送る(INBOX-25)。
    // 変数名は問わず、経路の末尾と動詞だけを突き合わせる。
    const call = new RegExp(
      `threads/\\$\\{encodeURIComponent\\([a-zA-Z]+\\)\\}/${tail}\`[\\s\\S]{0,200}?method: '([A-Z]+)'`,
    );
    const found = CLIENT.match(call);
    expect(found?.[1], `${tail} の呼び出しが見つからない`).toBe(method);
  });

  it.each(CALLS)('worker は $tail を $method で受ける', ({ tail, method }) => {
    const verb = method.toLowerCase();
    // 登録は1行のことも、引数で改行していることもある。どちらも拾う。
    const route = new RegExp(
      `supportInbox\\.${verb}\\(\\s*'/api/support/email/threads/:id/${tail}'`,
    );
    expect(route.test(WORKER), `worker に ${method} /${tail} が無い`).toBe(true);
  });
});

describe('メールの担当', () => {
  it('対応を変えても、既に付いている担当を上書きしない', () => {
    // 上書きすると、対応を変えるたびに担当が勝手に別の人へ移る。
    expect(WORKER).toContain('assigned_staff_id = COALESCE(assigned_staff_id, ?)');
  });
});

describe('LINE のトークとそろえたもの', () => {
  it.each(['対応', '担当', 'テンプレートを選択', '送信の設定'])(
    '%s がメール側にもある',
    (label) => {
      expect(CLIENT).toContain(label);
    },
  );

  it('内部メモは返信欄と別のポップアップで保存できる', () => {
    expect(CLIENT).toContain('<Dialog open={showMemoEditor}');
    expect(CLIENT).toContain('title="内部メモ"');
    expect(CLIENT).toContain('担当者だけに表示され、相手には送信されません。');
  });

});
