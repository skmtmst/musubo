// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import BookingHistory from './booking-history.js';
import { api } from '../lib/api.js';
import { loadPaymentViews } from '../lib/booking-payment-view.js';

vi.mock('../lib/api.js', () => ({ api: { me: vi.fn(), availability: vi.fn(), rescheduleMyBooking: vi.fn() } }));
vi.mock('../lib/booking-payment-view.js', () => ({ loadPaymentViews: vi.fn() }));
vi.mock('../components/history-card.js', () => ({ default: ({ onChange }: { onChange: () => void }) => <li><button onClick={onChange}>日時を変える</button></li> }));
vi.mock('../components/booking-history-cancel-dialog.js', () => ({ default: () => null }));
vi.mock('../components/waitlist-section.js', () => ({ default: () => null }));
vi.mock('../components/lesson-history-section.js', () => ({ default: () => null }));
vi.mock('../components/liff-look-scope.js', () => ({ default: ({ children }: { children: import('react').ReactNode }) => children }));
vi.mock('../components/ui/liff-header.js', () => ({ default: () => null }));
const booking = { id: 'bk', menu_id: 'm', staff_id: 's', menu_name: '相談', staff_name: '担当', profile_image_url: null, starts_at: '2099-10-20T01:00:00Z', status: 'confirmed' as const, lock_version: 1 };
beforeEach(() => {
  vi.mocked(api.me).mockResolvedValue({ upcoming: [booking], past: [] });
  vi.mocked(loadPaymentViews).mockResolvedValue({});
  vi.mocked(api.availability).mockResolvedValue({ by_staff: [{ staff_id: 's', display_name: '担当', slots: [{ date: '2099-10-21', start: '10:00', end: '11:00', remaining: 1 }] }] });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it.each([
  ['invalid_starts_at', '選んだ日時を確認できません。別の日時を選んでください。'],
  ['slot_not_available', '選んだ日時では予約できません。別の日時を選んでください。'],
])('%s の理由を正しく伝え、別の日時を選び直せる', async (code, message) => {
  vi.mocked(api.rescheduleMyBooking).mockRejectedValueOnce({ body: { error: code } });
  render(<MemoryRouter><BookingHistory /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '日時を変える' }));
  fireEvent.click(await screen.findByRole('button', { name: /10\/21/ }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '日時を変える' }));
  expect(await screen.findByText(message)).toBeTruthy();
  expect(screen.getByRole('button', { name: /10\/21/ })).toBeTruthy();
});
