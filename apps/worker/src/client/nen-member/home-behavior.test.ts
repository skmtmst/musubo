// @vitest-environment happy-dom
import { act } from 'react';
import { afterEach, expect, test, vi } from 'vitest';

let unmount: (() => void) | undefined;
afterEach(async () => { await act(async () => unmount?.()); unmount = undefined; vi.unstubAllGlobals(); vi.resetModules(); window.history.replaceState(null, '', '/'); });
const photo = (id: string, status: string) => ({ id, status, imageUrl: 'https://example.test/photo', caption: '', awardedPoints: 5, publicationConsent: false });
async function mount(tab: string, extra: Record<string, unknown> = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState(null, '', `/?tab=${tab}`);
  document.body.innerHTML = '<div id="app"></div>';
  const member = { owner: { displayName: '利用者' }, pets: [], photos: [], photoStats: { submittedCount: 0, pendingCount: 0, adoptedCount: 0, earnedPoints: 0 }, commerce: { orders: [], subscription: null, purchaseAmount: 0, points: 0, rank: '会員' }, ...extra };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: member }))));
  const { mountNenMember } = await import('./main.js');
  await act(async () => { unmount = mountNenMember(document.getElementById('app')!, { liffId: 'fixture', lineUserId: 'friend', idToken: 'fixture' }); });
}
const text = () => document.body.textContent ?? '';

test('ホームの見出しと会員メニューを表示する', async () => {
  await mount('home');
  expect(document.querySelector('h1')?.textContent).toBe('マイページ');
  expect(document.querySelector('header')?.textContent).toContain('然 -NEN-');
  const nav = document.querySelector('nav[aria-label="会員メニュー"]')!;
  for (const label of ['マイペット', '健康日記', '注文・定期']) expect(nav.textContent).toContain(label);
  expect(document.querySelector('.nm-member-header')).toBeNull();
  expect(document.querySelector('header')?.textContent).not.toContain('NEN MEMBERS');
});

test('投稿ごとの審査状態を表示する', async () => {
  await mount('photos', { photos: [photo('1', 'pending'), photo('2', 'adopted'), photo('3', 'rejected')] });
  expect(document.querySelector('[data-design-node="pNuzE"]')).not.toBeNull();
  expect([...document.querySelectorAll('.nm-photo-status')].map(node => node.textContent)).toEqual(['審査中', '採用', '見送り']);
});

test('投稿の同意と特典、空の案内を表示する', async () => {
  await mount('photos', { photos: [photo('1', 'adopted')] });
  for (const label of ['サイトへの掲載に同意する', '同意していない写真は公式サイトに掲載されません', '5マイル付与']) expect(text()).toContain(label);
  expect(text()).not.toContain('5ポイント');
  await act(async () => unmount?.()); unmount = undefined;
  await mount('photos');
  expect(text()).toContain('まだ投稿がありません');
});

test('注文画面の見出しと案内を表示する', async () => {
  await mount('orders');
  expect(document.querySelector('[data-design-node="sBTL8"]')).not.toBeNull();
  expect(document.querySelector('h1')?.textContent).toBe('注文・定期');
  for (const label of ['然 -NEN-', 'お届けと購入履歴をまとめて確認', 'ホームの「最近の注文」から開いた注文も、こちらにまとまっています。']) expect(text()).toContain(label);
});

test('定期便の詳細と空の履歴を表示する', async () => {
  await mount('orders', { commerce: { orders: [], subscription: { id: 'sub', manage_url: 'https://example.test/manage' }, purchaseAmount: 0, points: 0, rank: '会員' } });
  for (const label of ['定期便の契約状況', '現在の状況', '次回お届け', 'お届け周期', '変更・スキップ・解約はこの画面では行いません。お手続きはECのマイページからお願いします。', 'ECのマイページへ', '通常購入の履歴はまだありません']) expect(text()).toContain(label);
  await act(async () => unmount?.()); unmount = undefined;
  await mount('orders');
  expect(text()).toContain('契約中の定期便はありません');
});

test('注文の詳細と再購入へのリンクを表示する', async () => {
  await mount('orders', { commerce: { orders: [{ id: '1', number: 'A1', total: 100, detailUrl: 'https://example.test/order', items: [{ name: '商品', product_url: 'https://example.test/product' }] }], subscription: null, purchaseAmount: 0, points: 0, rank: '会員' } });
  expect(text()).toContain('注文番号 A1');
  for (const label of ['もう一度購入', '注文内容を見る']) expect([...document.querySelectorAll('a')].some(a => a.textContent?.includes(label) && a.href.startsWith('https://example.test/'))).toBe(true);
  expect(document.querySelector('.nm-portal-orders-page')?.textContent).not.toContain('ポイント');
});
