import { readApiSource } from '../../apps/web/scripts/test-api-source.mjs'
/*
 * NENコラム下書き作成の形が4者で約束違いしていないかの試験。
 *
 * 本番口(`POST /api/nen-campaigns/columns`)は `data: { id, queued }` を返すが、
 * 画面確認の固定応答(`NEN_COLUMN_CREATE.success.body`)に `queued` がなく、
 * 既存の試験は文字列包含だけで形の不一致を見つけられなかった。
 * 客・本番口・fixture・mock の4者の形をここで突き合わせる。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const root = (...parts: string[]) => join(HERE, '..', '..', ...parts);
const FIXTURES = readFileSync(join(HERE, 'fixtures.mjs'), 'utf8');
const MOCK_API = readFileSync(join(HERE, 'mock-api.mjs'), 'utf8');
const WORKER_ROUTE = readFileSync(root('apps', 'worker', 'src', 'routes', 'nen-campaigns.ts'), 'utf8');
const CLIENT_API = readApiSource(root('apps', 'web', 'src', 'lib', 'api.ts'), 'utf8');

describe('NENコラム下書き作成の形', () => {
  it('本番口は id と queued を201で返す', () => {
    // NEN-06: 下書き作成は配信予約を呼ばないため queued は常に 0。
    expect(WORKER_ROUTE).toContain('data: { id, queued: 0 }');
    expect(WORKER_ROUTE).toContain('{ success: true, data: { id, queued: 0 } }, 201');
  });

  it('客は id と queued の両方を受け取る形', () => {
    const start = CLIENT_API.indexOf('createColumn: (accountId: string');
    expect(start >= 0, '客に createColumn がない').toBe(true);
    const block = CLIENT_API.slice(start, start + 400);
    expect(block).toContain('id: string');
    expect(block).toContain('queued: number');
  });

  it('画面確認の固定応答も id と queued を持つ', () => {
    const start = FIXTURES.indexOf('export const NEN_COLUMN_CREATE');
    expect(start >= 0, 'fixture に NEN_COLUMN_CREATE がない').toBe(true);
    const block = FIXTURES.slice(start, start + 800);
    expect(block).toContain("id: 'nen-column-draft-1'");
    expect(block).toContain('queued:');
  });

  it('画面確認モックは固定応答を201のまま返す', () => {
    const start = MOCK_API.indexOf("url.pathname === '/api/nen-campaigns/columns'");
    expect(start >= 0, 'mock に columns の作成口がない').toBe(true);
    const block = MOCK_API.slice(start, start + 400);
    expect(block).toContain('NEN_COLUMN_CREATE.success.status');
    expect(block).toContain('NEN_COLUMN_CREATE.success.body');
  });
});
