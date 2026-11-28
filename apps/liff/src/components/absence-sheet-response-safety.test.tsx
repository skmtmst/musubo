// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import AbsenceSheet from './absence-sheet.js';
import type { EventBookingMine } from '../lib/api.js';

const send = vi.hoisted(() => vi.fn());
vi.mock('../lib/api.js', () => ({ api: { eventAbsence: send } }));
vi.mock('../lib/user-message.js', async original => ({ ...await original<typeof import('../lib/user-message.js')>(), logFailure: vi.fn() }));
const booking = { id: 'b', event_name: 'クラス', slot_starts_at: '2099-10-20T01:00:00Z' } as EventBookingMine;
beforeEach(() => send.mockReset());
afterEach(cleanup);

it('欠席の送信中は連続して押しても1回だけ送る', async () => {
  let finish!: (value: { credit: null }) => void;
  send.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const done = vi.fn();
  render(<AbsenceSheet booking={booking} onClose={() => {}} onDone={done} />);
  const button = screen.getByRole('button', { name: '欠席する' });
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => finish({ credit: null }));
  expect(done).toHaveBeenCalledTimes(1);
});

it('不正な欠席結果は完了とせず、同じ受付キーで確認し直せる', async () => {
  send.mockResolvedValueOnce({}).mockResolvedValueOnce({ credit: null });
  const done = vi.fn();
  render(<AbsenceSheet booking={booking} onClose={() => {}} onDone={done} />);
  fireEvent.click(screen.getByRole('button', { name: '欠席する' }));
  expect((await screen.findByRole('alert')).textContent).toContain('欠席の結果を確認できませんでした');
  expect(done).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '欠席する' }));
  await vi.waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  expect(send.mock.calls[0][1]).toBe(send.mock.calls[1][1]);
});
