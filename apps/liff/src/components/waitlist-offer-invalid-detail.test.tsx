// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WaitlistOfferSheet from './waitlist-offer-sheet.js';

const read = vi.hoisted(() => vi.fn());
vi.mock('../lib/api.js', () => ({ api: { bookingWaitlists: read } }));
vi.mock('./booking-payment.js', () => ({ default: () => null }));
const row = { id: 'w', status: 'waiting', starts_at: '2099-10-20T01:00:00Z', hold_expires_at: null, menu_name: 'メニュー', staff_name: '担当' };
beforeEach(() => read.mockReset());
afterEach(cleanup);
it.each([
  ['未知の状態', { ...row, status: 'unknown' }],
  ['不正な日時', { ...row, starts_at: 'invalid' }],
])('%sは終了済みとせず読み直せる', async (_kind, invalid) => {
  read.mockResolvedValueOnce({ waitlist: [invalid] }).mockResolvedValueOnce({ waitlist: [row] });
  render(<WaitlistOfferSheet id="w" onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度' }));
  expect(await screen.findByText('空きの案内を待っています')).toBeTruthy();
});
