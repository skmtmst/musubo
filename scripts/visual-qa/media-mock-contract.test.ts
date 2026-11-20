/*
 * 登録メディアの画面確認モックが本物と約束違いしていないかの試験。
 *
 * 差し替え用（版追加）の確定が常に `completed` を返すと、詳細の
 * 「新しい版を追加」フローが画面確認で検証不能になる。
 * 本番口は差し替え用に `verified` と targetMediaId を返す。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK_API = readFileSync(join(HERE, 'mock-api.mjs'), 'utf8');

describe('登録メディアの画面確認モック', () => {
  it('差し替え用の確定は本番口と同じ verified を返す', () => {
    const start = MOCK_API.indexOf('/upload-sessions\\/[^/]+\\/complete');
    expect(start >= 0, 'mock に upload-sessions の complete がない').toBe(true);
    const block = MOCK_API.slice(start, start + 1200);
    expect(block).toContain("status: 'verified'");
    expect(block).toContain('targetMediaId');
  });

  it('申告時に受けた targetMediaId を確定時まで覚えておく', () => {
    expect(MOCK_API).toContain('mediaUploadSessionTargets.set');
    expect(MOCK_API).toContain('mediaUploadSessionTargets.get');
  });

  it('新規登録形の確定は従来どおり completed を返す', () => {
    const start = MOCK_API.indexOf('/upload-sessions\\/[^/]+\\/complete');
    const block = MOCK_API.slice(start, start + 1200);
    expect(block).toContain("status: 'completed'");
    expect(block).toContain("mediaId: 'media-uploaded-1'");
  });
});
