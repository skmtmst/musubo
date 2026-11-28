// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import SeatWaitlistSheet from './seat-waitlist-sheet.js';

const net = vi.hoisted(() => ({ seatWaitlists: vi.fn(), registerSeatWaitlist: vi.fn(), cancelSeatWaitlist: vi.fn() }));
vi.mock('../lib/api.js', () => ({ api: net }));
beforeEach(() => { net.seatWaitlists.mockReset(); net.registerSeatWaitlist.mockReset(); });
afterEach(cleanup);
function open() { render(<SeatWaitlistSheet storeId="store" storeName="お店" startsAt="2099-10-20T01:00:00Z" guestCount={2} onClose={() => {}} />); }

it('未知の待ち状態は未登録と扱わず、読み直せる', async () => {
  net.seatWaitlists.mockResolvedValueOnce({ waitlist: [{ status: 'unknown' }] }).mockResolvedValueOnce({ waitlist: [] });
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度' }));
  expect(await screen.findByText('満席の時刻に登録すると、空いたらLINEで知らせます。')).toBeTruthy();
  expect(net.registerSeatWaitlist).not.toHaveBeenCalled();
});

it('不正な登録結果は成功と表示せず、一覧を読み直して確認する', async () => {
  net.seatWaitlists.mockResolvedValueOnce({ waitlist: [] }).mockResolvedValueOnce({ waitlist: [{ id: 'w', store_id: 'store', starts_at: '2099-10-20T01:00:00Z', guest_count: 2, status: 'waiting' }] });
  net.registerSeatWaitlist.mockResolvedValueOnce({ id: '' });
  open();
  fireEvent.click(await screen.findByRole('button', { name: '空いたら知らせる' }));
  const retry = await screen.findByRole('button', { name: 'もう一度' });
  expect(screen.queryByText('登録しました。空いたらLINEで知らせます。')).toBeNull();
  fireEvent.click(retry);
  expect(await screen.findByText('登録ずみです。空いたらLINEで知らせます。')).toBeTruthy();
  expect(net.registerSeatWaitlist).toHaveBeenCalledTimes(1);
});
