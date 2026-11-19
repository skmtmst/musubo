import { expect, test, vi } from 'vitest';

const loaded = vi.hoisted(() => [] as string[]);
vi.mock('./embedded.css', () => { loaded.push('embedded'); return {}; });

// 画面本体も共通CSSを読むため、入口自身の指定は salon-entry-wiring で確かめる。
test('席の予約の配備入口は共通CSSと画面を読む', async () => {
  const deployed = await import('../../worker/src/client/restaurant/main.js');
  expect(loaded).toEqual(['embedded']);
  const shared = await import('./restaurant-entry.js');
  expect(deployed.mountRestaurant).toBe(shared.mountRestaurant);
  expect(deployed.unmountRestaurant).toBe(shared.unmountRestaurant);
});
