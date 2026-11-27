// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import EventCatalog from './event-catalog.js';
import Event from './event.js';
import EventConfirm from './event-confirm.js';
import EventDone from './event-done.js';

vi.mock('@line/liff', () => ({ default: { closeWindow: vi.fn() } }));
vi.mock('../lib/api.js', () => ({ api: {
  listEvents: vi.fn().mockResolvedValue({ items: [{ id: 'event', name: '交流会', venue_name: '会場', image_url: null, nextStartsAt: '2099-10-20T01:00:00Z' }], nextCursor: null }),
  getEvent: vi.fn().mockResolvedValue({ id: 'event', name: '交流会', venue_name: '会場', venue_url: null, image_url: null, description: null, description_centered: 0, max_bookings_per_friend: null, requires_approval: 1, cancel_deadline_hours_before: 24, waitlist_enabled: 0 }),
  getEventSlots: vi.fn().mockResolvedValue({ items: [{ id: 'slot', event_id: 'event', starts_at: '2099-10-20T01:00:00Z', ends_at: '2099-10-20T02:00:00Z', capacity: 10, is_active: 1, active_count: 0, remaining: 5 }] }),
  myEventBookings: vi.fn().mockResolvedValue({ items: [] }),
  createEventBooking: vi.fn().mockResolvedValue({ id: 'booking', status: 'requested' }),
  customerLook: vi.fn().mockResolvedValue({ success: true, data: { settings: {} } }),
  liffConfig: vi.fn().mockResolvedValue({ success: true, data: {} }),
  bookingSettings: vi.fn().mockResolvedValue({ liff_date_view: 'list', booking_window_days: 60 }),
} }));

afterEach(() => { cleanup(); vi.clearAllMocks(); document.title = ''; });

it('一覧から申し込み完了まで、操作に合わせてLINE上の画面名が切り替わる', async () => {
  render(<MemoryRouter initialEntries={['/events?liffId=account']}><Routes>
    <Route path="/events" element={<EventCatalog />} />
    <Route path="/events/:id" element={<Event />} />
    <Route path="/events/:id/confirm" element={<EventConfirm />} />
    <Route path="/events/:id/done" element={<EventDone />} />
  </Routes></MemoryRouter>);

  const select = await screen.findByRole('button', { name: '日時を選ぶ' });
  expect(document.title).toBe('クラス・スケジュール | musubo');
  fireEvent.click(select);
  fireEvent.click(await screen.findByRole('button', { name: /10:00〜11:00/ }));
  expect(document.title).toBe('イベント | musubo');
  fireEvent.click(screen.getByRole('button', { name: 'この時間で申し込む' }));
  const submit = await screen.findByRole('button', { name: '申し込む' });
  expect(document.title).toBe('申し込みの確認 | musubo');
  fireEvent.click(submit);
  await screen.findByText('受付しました');
  await waitFor(() => expect(document.title).toBe('イベント | musubo'));
});
