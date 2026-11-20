import { expect, test, vi } from 'vitest';

const loaded = vi.hoisted(() => [] as string[]);
vi.mock('./embedded.css', () => { loaded.push('embedded'); return {}; });

test('来店スタンプの配備入口は共通CSSと画面を読む', async () => {
  const deployed = await import('../../worker/src/client/visit-stamps/main.js');
  expect(loaded).toEqual(['embedded']);
  const shared = await import('./visit-stamps-entry.js');
  expect(deployed.mountVisitStamps).toBe(shared.mountVisitStamps);
});
