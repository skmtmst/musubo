/*
 * 機能設定の画面確認モックが本物と約束違いしていないかの試験。
 *
 * mock が版（`version`）を返さないと、画面の `expectedVersion` 付き
 * 一括保存の欠落に目視確認で気づけない。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK_API = readFileSync(join(HERE, 'mock-api.mjs'), 'utf8');

describe('機能設定の画面確認モック', () => {
  it('本物と同じく版を返す', () => {
    const start = MOCK_API.indexOf("'/api/settings/features'");
    expect(start >= 0, 'mock に /api/settings/features がない').toBe(true);
    const block = MOCK_API.slice(start, start + 600);
    expect(block).toMatch(/version:\s*1/);
  });
});
