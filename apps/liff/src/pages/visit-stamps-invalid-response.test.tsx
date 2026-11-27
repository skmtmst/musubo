// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import VisitStamps from './visit-stamps.js';

const fx = vi.hoisted(() => ({ cards: vi.fn(), paperRequests: vi.fn() }));
vi.mock('../lib/api.js', () => ({
  api: { customerLook: vi.fn().mockResolvedValue({ success: true, data: { settings: {} } }), liffConfig: vi.fn().mockResolvedValue({ data: { accountId: 'acc', accountName: '店舗' } }) },
  visitStampsApi: fx,
}));
vi.mock('@line/liff', () => ({ default: { closeWindow: vi.fn() } }));
const card = { id: 'card', name: '来店カード', settings: { mode: 'visit', amountUnit: 1000, maxPerVisit: 3, firstVisitBonus: 0, expiryMonths: 6, timezone: 'Asia/Tokyo', multipliers: [], rankMultipliers: [], rewards: [{ id: 'r', name: '特典', stamps: 5 }] } };
const valid = { data: [{ card, wallet: { balance: 2 } }] };
beforeEach(() => { fx.cards.mockReset().mockResolvedValue(valid); fx.paperRequests.mockReset().mockResolvedValue({ data: [] }); });
afterEach(cleanup);

it('壊れたカード情報は読み込み失敗を示し、読み直せる', async () => {
  fx.cards.mockResolvedValueOnce({ data: [{ card, wallet: null }] });
  render(<VisitStamps />);
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }));
  expect(await screen.findByText('来店カード')).toBeTruthy();
});

it('不正な申請履歴は入力画面を開かず、読み直せる', async () => {
  fx.paperRequests.mockResolvedValueOnce({ data: null });
  render(<VisitStamps />);
  fireEvent.click(await screen.findByRole('button', { name: '紙のカードを移す' }));
  const retry = await screen.findByRole('button', { name: 'もう一度読み込む' });
  expect(screen.queryByRole('button', { name: '申請する' })).toBeNull();
  fireEvent.click(retry);
  expect(await screen.findByRole('button', { name: '申請する' })).toBeTruthy();
});
