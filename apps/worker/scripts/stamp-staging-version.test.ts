import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { stampStagingVersion } from './stamp-staging-version.js';

const roots: string[] = [];
afterEach(() => { roots.forEach(root => rmSync(root, { recursive: true, force: true })); vi.unstubAllEnvs(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'staging-metadata-'));
  roots.push(root);
  mkdirSync(join(root, 'apps/worker/src'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"version":"0.24.0"}');
  writeFileSync(join(root, 'apps/worker/src/release-version.ts'), readFileSync(new URL('../src/release-version.ts', import.meta.url)));
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
  return root;
}
it('config replayはworkflowのSHAでなく配備元のHEADを埋め、実在しないhashを作らない', async () => {
  const root = fixture();
  const sha = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  vi.stubEnv('GITHUB_SHA', 'f'.repeat(40));
  const path = join(root, 'apps/worker/src/release-version.ts');
  const original = await import(/* @vite-ignore */ pathToFileURL(path).href + '?before');
  expect(stampStagingVersion(root, '2026-10-10T00:00:00Z')).toEqual({ version: '0.24.0', commit: sha, releasedAt: '2026-10-10T00:00:00Z' });
  const output = await import(/* @vite-ignore */ pathToFileURL(path).href + '?after');
  expect(output.GIT_COMMIT).toBe(sha);
  expect(output.BUNDLE_VERSION).toBe('0.24.0');
  expect(output.RELEASED_AT).toBe('2026-10-10T00:00:00Z');
  const hashes = (module: Record<string, unknown>) => Object.fromEntries(Object.entries(module).filter(([key]) => key.endsWith('_HASH')));
  expect(hashes(output)).toEqual(hashes(original));
});
it('SHAを確認できない場合は埋め込みを止める', () => {
  const root = fixture();
  rmSync(join(root, '.git'), { recursive: true, force: true });
  expect(() => stampStagingVersion(root)).toThrow();
});
it('版の値が不正なら元の定数を変更しない', () => {
  const root = fixture();
  const path = join(root, 'apps/worker/src/release-version.ts');
  const original = readFileSync(path, 'utf8');
  writeFileSync(join(root, 'package.json'), '{"version":"unknown"}');
  expect(() => stampStagingVersion(root)).toThrow('版を確認できません');
  expect(readFileSync(path, 'utf8')).toBe(original);
});
