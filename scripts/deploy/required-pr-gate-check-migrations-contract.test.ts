import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const gate = readFileSync(join(HERE, '../..', '.github', 'workflows', 'required-pr-gate.yml'), 'utf8');

/**
 * 追加のみ方針の静的検査は必須ゲートで走らせる。
 *
 * 検査本体はあるのにゲートが呼ばないと、赤いまま誰も気づかない
 * ため、呼び出しを外すとこの試験が赤くなる。
 * yml の字面を見るだけの試験で、workflow 自体は実行しない。
 */
describe('必須ゲートは migration 安全検査を呼ぶ(#742)', () => {
  it('既存の Repository and shared checks の中で check-migrations.ts を実行する', () => {
    const start = gate.indexOf('name: Repository and shared checks');
    expect(start).toBeGreaterThanOrEqual(0);
    // 次の job の頭までの区間だけを見る。新規 job へ移してもここは赤のまま。
    const rest = gate.slice(start);
    const nextJob = rest.slice(1).search(/^  [\w-]+:\s*$/m);
    const section = nextJob === -1 ? rest : rest.slice(0, nextJob + 1);
    expect(section).toMatch(/run:\s*pnpm tsx scripts\/check-migrations\.ts/);
  });
});
