/*
 * 管理画面が送るヘッダが、CORS で許されているか。
 *
 * 許可一覧に無いヘッダを1つでも付けると、ブラウザは **preflight の段階で**
 * 止める。リクエストはサーバーへ届かないので worker のログにも何も残らず、
 * 画面には「保存できませんでした」とだけ出る。原因の手がかりがどこにも無い。
 *
 * 実際に起きた: 一斉配信の作成が二重送信よけに `Idempotency-Key` を送るのに、
 * 許可一覧へ足し忘れていた。下書き保存・テスト送信・配信予約はすべて
 * この1本の POST を通るので、管理画面から一斉配信を1つも作れなかった。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_REQUEST_HEADERS } from './index.js';

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), '../../web/src');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    // 実行する画面コードを調べる。試験のR2直接PUT用の見本ヘッダは管理APIへ送られない。
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe('CORS の許可ヘッダ', () => {
  const allowed = new Set(ADMIN_REQUEST_HEADERS.map((h) => h.toLowerCase()));

  it('二重送信よけの Idempotency-Key が入っている', () => {
    // 一斉配信の作成（下書き保存・テスト送信・配信予約）が全部これを送る。
    expect(allowed.has('idempotency-key')).toBe(true);
  });

  it('取り消せない操作の合言葉ヘッダが入っている', () => {
    // 一斉配信の送信は `X-Confirm-Irreversible` を送る。
    // 無いと、押しても preflight で止まって理由が出ない。
    expect(allowed.has('x-confirm-irreversible')).toBe(true);
  });

  it('重要操作の再認証ヘッダが入っている', () => {
    expect(allowed.has('x-step-up-token')).toBe(true);
  });

  it('登録メディアの版確認ヘッダが入っている', () => {
    expect(allowed.has('if-match')).toBe(true);
  });

  it('管理画面が実際に送るヘッダが、すべて許されている', () => {
    /*
     * 画面のコードから、リクエストヘッダとして書かれている名前を拾う。
     * 拾い方は素朴（`'X-Foo': ...` の形）だが、書き忘れを捕まえるには足りる。
     * ここが増えたら worker の一覧にも足す、という約束をコードで縛る。
     */
    const found = new Set<string>();
    for (const file of tsFiles(WEB_SRC)) {
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(/['"]([A-Za-z][A-Za-z0-9-]*-[A-Za-z0-9-]+)['"]\s*:/g)) {
        const name = m[1].toLowerCase();
        // ヘッダらしい名前だけを見る。CSS の kebab-case などを避ける。
        if (/^(x-|content-|authorization|idempotency-|accept-|if-)/.test(name)) found.add(name);
      }
    }
    const missing = [...found].filter((h) => !allowed.has(h));
    expect(missing).toEqual([]);
  });
});
