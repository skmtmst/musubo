// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import WaitlistOfferSheet from './waitlist-offer-sheet.js';
import { PAYMENT_UNKNOWN } from '../lib/customer-words.js';
const mocks = vi.hoisted(() => ({ bookingWaitlists: vi.fn(), acceptWaitlist: vi.fn(), bookingPaymentStatus: vi.fn() }));
vi.mock('../lib/api.js', () => ({ api: mocks }));
vi.mock('@line/liff', () => ({ default: { closeWindow: vi.fn(), openWindow: vi.fn() } }));
const entry = { id: 'w', staff_id: 's', menu_id: 'm', starts_at: '2099-01-01T03:00:00Z', status: 'invited', hold_expires_at: '2099-01-01T02:00:00Z', hold_minutes: 30, created_at: '2026-11-01', menu_name: 'カット', staff_name: '担当A' };
beforeEach(() => { vi.resetAllMocks(); mocks.bookingWaitlists.mockResolvedValue({ waitlist: [entry] }); mocks.acceptWaitlist.mockResolvedValue({ booking_id: 'b', status: 'requested', payment: { id: 'p', status: 'unpaid' } }); });
afterEach(cleanup);
it.each([
  ['pending', 'お支払いの確認', 1],
  ['expired', 'お支払いが終わりませんでした', 1],
  ['paid', '試験のお支払いを確認しました', 0],
  ['failed', PAYMENT_UNKNOWN, 0],
] as const)('実支払い部品の%s表示にシートの見出しを重ねない', async (status, text, headings) => {
  mocks.bookingPaymentStatus.mockResolvedValue({ payment: { id: 'p', status, amount: 5000, hold_until: '2099-01-01T02:00:00Z' } });
  render(<WaitlistOfferSheet id="w" onClose={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'この枠で予約する' }));
  await screen.findByText(text);
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).queryAllByRole('heading')).toHaveLength(headings);
  expect(within(dialog).queryByRole('heading', { name: '空きが出ました' })).toBeNull();
  expect(mocks.acceptWaitlist).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(mocks.bookingPaymentStatus).toHaveBeenCalledWith('b'));
});
