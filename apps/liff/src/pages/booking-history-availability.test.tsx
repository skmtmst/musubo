// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import BookingHistory from './booking-history.js';
import { api } from '../lib/api.js';
import { loadPaymentViews } from '../lib/booking-payment-view.js';

vi.mock('../lib/api.js', () => ({ api: { me: vi.fn(), availability: vi.fn() } }));
vi.mock('../lib/booking-payment-view.js', () => ({ loadPaymentViews: vi.fn().mockResolvedValue({}) }));
vi.mock('../components/history-card.js', () => ({ default: ({ onChange }: { onChange: () => void }) => <li><button onClick={onChange}>日時を変える</button></li> }));
vi.mock('../components/booking-history-cancel-dialog.js', () => ({ default: () => null }));
vi.mock('../components/waitlist-section.js', () => ({ default: () => null }));
vi.mock('../components/lesson-history-section.js', () => ({ default: () => null }));
vi.mock('../components/liff-look-scope.js', () => ({ default: ({ children }: { children: import('react').ReactNode }) => children }));
vi.mock('../components/ui/liff-header.js', () => ({ default: () => null }));
const booking = { id: 'bk', menu_id: 'm', staff_id: 's', menu_name: '相談', staff_name: '担当', profile_image_url: null, starts_at: '2099-10-20T01:00:00Z', status: 'confirmed' as const, lock_version: 1 };
const result = (date: string) => ({ by_staff: [{ staff_id: 's', display_name: '担当', slots: [{ date, start: '10:00', end: '11:00', remaining: 1 }] }] });
beforeEach(() => { vi.mocked(api.me).mockResolvedValue({ upcoming: [booking], past: [] }); vi.mocked(loadPaymentViews).mockResolvedValue({}); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const mount = () => render(<MemoryRouter><BookingHistory /></MemoryRouter>);
it('不正な空き応答は空きなしとせず読み直せる', async () => {
  vi.mocked(api.availability).mockResolvedValueOnce({} as Awaited<ReturnType<typeof api.availability>>).mockResolvedValueOnce(result('2099-10-21'));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '日時を変える' }));
  fireEvent.click(await screen.findByRole('button', { name: '読み直す' }));
  expect(await screen.findByText(/10\/21/)).toBeTruthy();
});
it('閉じて同じ予約を開き直した後は古い空き応答を表示しない', async () => {
  let resolveOld!: (value: Awaited<ReturnType<typeof api.availability>>) => void;
  vi.mocked(api.availability).mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; })).mockResolvedValueOnce(result('2099-10-22'));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: '日時を変える' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '閉じる' }));
  fireEvent.click(screen.getByRole('button', { name: '日時を変える' }));
  expect(await screen.findByText(/10\/22/)).toBeTruthy();
  await act(async () => resolveOld(result('2099-10-21')));
  expect(screen.queryByText(/10\/21/)).toBeNull();
  expect(screen.getByText(/10\/22/)).toBeTruthy();
});
