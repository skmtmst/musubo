import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';

/**
 * 本番の束に偽物が入らないことの見張り。
 *
 * 仕組み: `@line/liff` → 偽物の読み替えは vite.config.ts の alias だけが
 * 行い、alias は VITE_LIFF_QA=1 のときだけ付く。src が偽物を静的に
 * import していたら alias が無くても束に入ってしまうので、ここで禁じる。
 */

const LIFF_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SRC_ROOT = join(LIFF_ROOT, 'src');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(name) && !name.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('qa fake is tree-shaken from production', () => {
  test('src は偽物を静的に import しない', () => {
    const offenders = listSourceFiles(SRC_ROOT).filter((file) =>
      /liff-qa/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  test('alias は VITE_LIFF_QA=1 のときだけ付く', async () => {
    for (const value of [undefined, '0', 'true', '1']) {
      vi.resetModules();
      vi.stubEnv('VITE_LIFF_QA', value);
      const { default: config } = await import('../../vite.config.js');
      expect(config.resolve?.alias ?? {}).toEqual(value === '1'
        ? { '@line/liff': fileURLToPath(new URL('./liff-qa.ts', import.meta.url)) }
        : {});
    }
  });
});
