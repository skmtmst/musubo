// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import VisitStampQr from './visit-stamp-qr.js';
import { visitStampsApi } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({
  api: { customerLook: vi.fn().mockResolvedValue({ success: true, data: { settings: {} } }), bookingSettings: vi.fn().mockResolvedValue({}), liffConfig: vi.fn().mockResolvedValue({ data: { accountId: 'account', accountName: '店舗', botBasicId: '@shop' } }) },
  visitStampsApi: { redeemQr: vi.fn() },
}));
vi.mock('@line/liff', () => ({ default: { isInClient: () => true, closeWindow: vi.fn() } }));
beforeEach(() => vi.mocked(visitStampsApi.redeemQr).mockReset());
afterEach(cleanup);

const card = { id: 'card', name: '来店スタンプ', settings: { slotCount: 5, rewards: [{ id: 'reward', name: '特典', stamps: 5 }] } };
const success = { status: 'success', awarded: 1, card, wallet: { balance: 2 }, nextReward: { id: 'reward', name: '特典', stamps: 5 } };
const response = (data: unknown) => ({ data }) as Awaited<ReturnType<typeof visitStampsApi.redeemQr>>;
function open() { render(<MemoryRouter initialEntries={['/visit-stamp-qr?token=qr&accountId=account']}><VisitStampQr /></MemoryRouter>); }

it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '5', null, undefined])('不正な残高 %s では特典を案内せず、読み直して確認できる', async balance => {
  vi.mocked(visitStampsApi.redeemQr).mockResolvedValueOnce(response({ ...success, wallet: { balance }, nextReward: null })).mockResolvedValueOnce(response(success));
  open();
  const retry = await screen.findByRole('button', { name: 'もう一度読み込む' });
  expect(screen.queryByText('特典が使えます')).toBeNull();
  expect(screen.queryByText(/個たまりました/)).toBeNull();
  fireEvent.click(retry);
  expect(await screen.findByText('あと 3 個で 特典')).toBeTruthy();
  expect(vi.mocked(visitStampsApi.redeemQr).mock.calls[1]).toEqual(vi.mocked(visitStampsApi.redeemQr).mock.calls[0]);
});

it('回数制限の応答でも残高が不正なら確認できないと伝える', async () => {
  vi.mocked(visitStampsApi.redeemQr).mockResolvedValueOnce(response({ status: 'limited', card, wallet: { balance: -1 }, retryAt: '2099-10-20T01:00:00Z' }));
  open();
  expect(await screen.findByRole('button', { name: 'もう一度読み込む' })).toBeTruthy();
  expect(screen.queryByText('今日はもう押しました')).toBeNull();
});
