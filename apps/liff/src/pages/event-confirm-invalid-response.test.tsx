// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import EventConfirm from './event-confirm.js';
import { api } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({ api: {
  getEvent: vi.fn(), getEventSlots: vi.fn(), createEventBooking: vi.fn(),
  customerLook: vi.fn().mockResolvedValue({ success: true, data: { settings: {} } }),
  liffConfig: vi.fn().mockResolvedValue({ data: {} }),
} }));
vi.mock('../lib/user-message.js', async original => ({ ...await original<typeof import('../lib/user-message.js')>(), logFailure: vi.fn() }));
beforeEach(() => {
  vi.mocked(api.getEvent).mockReset().mockResolvedValue({ id: 'event', name: '交流会', requires_approval: 0, cancel_deadline_hours_before: 24 } as Awaited<ReturnType<typeof api.getEvent>>);
  vi.mocked(api.getEventSlots).mockReset().mockResolvedValue({ items: [{ id: 'slot', starts_at: '2099-10-20T01:00:00Z', ends_at: '2099-10-20T02:00:00Z' }] } as Awaited<ReturnType<typeof api.getEventSlots>>);
  vi.mocked(api.createEventBooking).mockReset();
});
afterEach(cleanup);
function open() { render(<MemoryRouter initialEntries={['/events/event/confirm?slotId=slot']}><Routes>
  <Route path="/events/:id/confirm" element={<EventConfirm />} /><Route path="/events/:id/done" element={<p>完了画面</p>} />
</Routes></MemoryRouter>); }

it.each([
  ['予約', { id: 'booking', status: 'unknown' }],
  ['キャンセル待ち', { waitlisted: true, slot_id: 'other' }],
])('%sの不正な応答は完了と表示せず、同じ受付キーで確認し直せる', async (_kind, invalid) => {
  vi.mocked(api.createEventBooking).mockResolvedValueOnce(invalid as Awaited<ReturnType<typeof api.createEventBooking>>)
    .mockResolvedValueOnce({ id: 'booking', status: 'confirmed' });
  open();
  fireEvent.click(await screen.findByRole('button', { name: '申し込む' }));
  expect(await screen.findByText(/申し込みの結果を確認できませんでした/)).toBeTruthy();
  expect(screen.queryByText('完了画面')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '申し込む' }));
  expect(await screen.findByText('完了画面')).toBeTruthy();
  expect(vi.mocked(api.createEventBooking).mock.calls[0][2]).toBe(vi.mocked(api.createEventBooking).mock.calls[1][2]);
});
