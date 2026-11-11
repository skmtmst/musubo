import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ★V8 の板とコードの対応表（docs/v8-board-to-code.md）に書いた画面が、
 * 実際に存在することを確かめる。
 *
 * 対応表は「どの板を見て、どのファイルを直すか」の入口。
 * ここが実装とずれると、次に作業する人が存在しない画面を探すことになる。
 *
 * 2026-10-08: 以前は V2/V4 の旧表を読んでいた。旧表は履歴にだけ残す。
 * 見た目の正本は ★V8 の絵なので、同じ検査を V8 の対応表へ移した。
 *
 * 動的セグメント（`/friends/[id]`）は、この管理画面が静的書き出しなので
 * 書き出せない。対応表に紛れ込むと、それを見た人が `[id]` で作り、
 * route-integrity.test.ts に落とされる。
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const DOC = join(ROOT, 'docs', 'v8-board-to-code.md');
const DESIGN_MAP = join(ROOT, 'scripts', 'visual-qa', 'v8-design-map.json');
const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(SRC, 'app');

interface Row {
  board: string;
  name: string;
  route: string;
  /** 入口と V8 の画面ファイル（`apps/web/src` からの相対）。 */
  files: string[];
}

/** 対応表の行を読む。`| 文書 | 板ID | 板の名前 | 画面のURL | 入口 | V8 の画面ファイル |` */
function readRows(): Row[] {
  const rows: Row[] = [];
  for (const line of readFileSync(DOC, 'utf8').split('\n')) {
    const m = /^\|\s*V8(?:-B)?\s*\|\s*([A-Za-z0-9]+)\s*\|([^|]*)\|\s*([^|]*?)\s*\|([^|]*)\|([^|]*)\|\s*$/.exec(line);
    if (!m) continue;
    const files = [...`${m[4]} ${m[5]}`.matchAll(/`([^`]+)`/g)].map((f) => f[1]);
    rows.push({ board: m[1], name: m[2].trim(), route: m[3], files });
  }
  return rows;
}

/** クエリとハッシュを落として、画面のパスだけにする。 */
function toPath(route: string): string {
  const path = route.split('?')[0].split('#')[0].replace(/\/+$/, '');
  return path === '' ? '/' : path;
}

// 旧対応表は保護文書のため、このレーンでは更新しない。廃止済みの板は
// 現行デザインマップを正本として除外する。
const deletedBoards = new Set(
  (JSON.parse(readFileSync(DESIGN_MAP, 'utf8')) as { deletedBoards: string[] }).deletedBoards,
);
const ROWS = readRows().filter((row) => !deletedBoards.has(row.board));
const ROUTED = ROWS.filter((r) => r.route.startsWith('/'));

describe('★V8 の板とコードの対応表', () => {
  it('行が読める', () => {
    // 表の書式が変わって0件になったら、以下の検査が素通りしてしまう。
    expect(ROWS.length).toBeGreaterThan(300);
    expect(ROUTED.length).toBeGreaterThan(300);
  });

  it('動的セグメントを書いていない', () => {
    // 静的書き出しでは `[id]` を書き出せない。詳細画面は ?id= で表す。
    const dynamic = ROUTED.filter((r) => r.route.includes('[') || r.route.includes(']'));
    expect(
      dynamic.map((r) => `${r.board} ${r.name} → ${r.route}`),
      '動的セグメントのルートがあります。?id= の形にしてください',
    ).toEqual([]);
  });

  it('書いてあるルートの画面がすべて実在する', () => {
    const missing = ROUTED.filter((r) => {
      const path = toPath(r.route);
      const dir = path === '/' ? APP : join(APP, path);
      return !existsSync(join(dir, 'page.tsx'));
    });
    expect(
      missing.map((r) => `${r.board} ${r.name} → ${r.route}`),
      '対応表のルートに画面がありません',
    ).toEqual([]);
  });

  it('書いてある入口・V8 の画面ファイルがすべて実在する', () => {
    const missing = ROWS.flatMap((r) =>
      r.files.filter((file) => !existsSync(join(SRC, file))).map((file) => `${r.board} → ${file}`),
    );
    expect(missing, '対応表のファイルがありません。表を作り直してください').toEqual([]);
  });

  it('板IDが重複していない', () => {
    // 同じ板を2つの行に割り当てていると、どちらを直すべきか分からなくなる。
    const boards = ROWS.map((r) => r.board);
    const duplicated = boards.filter((n, i) => boards.indexOf(n) !== i);
    expect([...new Set(duplicated)]).toEqual([]);
  });
});
