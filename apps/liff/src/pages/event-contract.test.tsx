// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import EventConfirm from './event-confirm.js';
import Event from './event.js';
import EventDone from './event-done.js';
import EventBookings from './event-bookings.js';
import { api } from '../lib/api.js';

vi.mock('@line/liff', () => ({ default: { closeWindow: vi.fn() } }));
vi.mock('../lib/api.js', () => ({ api: {
  getEvent: vi.fn(), getEventSlots: vi.fn(), createEventBooking: vi.fn(), myEventBookings: vi.fn(), bookingSettings: vi.fn().mockResolvedValue({ liff_date_view: 'list', booking_window_days: 60 }),
  customerLook: vi.fn().mockResolvedValue({ success: true, data: { settings: {} } }), liffConfig: vi.fn().mockResolvedValue({ data: {} }),
} }));
vi.mock('../lib/user-message.js', async original => ({ ...await original<typeof import('../lib/user-message.js')>(), logFailure: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const detail = { id: 'event', name: '交流会', requires_approval: 1, cancel_deadline_hours_before: 24 };
const slot = { id: 'slot', starts_at: '2099-10-20T01:00:00Z', ends_at: '2099-10-20T02:00:00Z' };
beforeEach(() => {
  vi.mocked(api.getEvent).mockResolvedValue(detail as Awaited<ReturnType<typeof api.getEvent>>);
  vi.mocked(api.getEventSlots).mockResolvedValue({ items: [slot] } as Awaited<ReturnType<typeof api.getEventSlots>>);
});
function Destination() { const location = useLocation(); return <p data-testid="destination">{location.pathname + location.search}</p>; }
function open() {
  render(<MemoryRouter initialEntries={['/events/event/confirm?slotId=slot&liffId=account']}><Routes>
    <Route path="/events/:id/confirm" element={<EventConfirm />} />
    <Route path="/events/:id/done" element={<Destination />} />
  </Routes></MemoryRouter>);
}

it.each([false, true])('申込結果の待ち=%sに従う行き先へ、同じ枠とアカウントを引き継ぐ', async waitlisted => {
  vi.mocked(api.createEventBooking).mockResolvedValue(waitlisted ? { waitlisted: true, slot_id: 'slot' } : { id: 'booking', status: 'requested' } as Awaited<ReturnType<typeof api.createEventBooking>>);
  open();
  await screen.findByRole('button', { name: '申し込む' });
  expect(screen.getByText(/受付後、ご利用先の確認をお待ちください。キャンセルは/).textContent).toContain('10月19日 10:00');
  expect(screen.getAllByRole('button', { name: '申し込む' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '申し込む' }));
  const target = new URL((await screen.findByTestId('destination')).textContent!, 'https://example.test');
  expect(target.pathname).toBe('/events/event/done');
  expect(target.searchParams.get('status')).toBe(waitlisted ? 'waitlisted' : 'requested');
  expect(target.searchParams.get('liffId')).toBe('account');
  expect(target.searchParams.get('waitSlot')).toBe(waitlisted ? 'slot' : null);
  expect(api.createEventBooking).toHaveBeenCalledWith('event', { slot_id: 'slot', customer_note: null }, expect.any(String));
});

it('読込中と失敗時は申込を隠し、読み直して回復する', async () => {
  vi.mocked(api.getEvent).mockRejectedValueOnce(new Error('offline'));
  open();
  expect(screen.queryByRole('button', { name: '申し込む' })).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }));
  expect(await screen.findByRole('button', { name: '申し込む' })).toBeTruthy();
});

it('送信中は連打できず、失敗しても備考を残し同じ鍵で再試行する', async () => {
  let reject!: (error: unknown) => void;
  vi.mocked(api.createEventBooking).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockResolvedValueOnce({ id: 'booking', status: 'confirmed' });
  open();
  fireEvent.change(await screen.findByRole('textbox', { name: '備考' }), { target: { value: '連絡事項' } });
  const send = screen.getByRole('button', { name: '申し込む' });
  fireEvent.click(send); fireEvent.click(send);
  expect(api.createEventBooking).toHaveBeenCalledTimes(1);
  expect((send as HTMLButtonElement).disabled).toBe(true);
  reject({ body: { error: 'slot_full' } });
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByDisplayValue('連絡事項')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '申し込む' }));
  await waitFor(() => expect(api.createEventBooking).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.createEventBooking).mock.calls[0][2]).toBe(vi.mocked(api.createEventBooking).mock.calls[1][2]);
});

it('時間を選んだだけでは移動せず、確認を押してから選んだ時間へ進む', async () => {
  vi.mocked(api.getEventSlots).mockResolvedValue({ items: [{ ...slot, event_id: 'event', capacity: 10, is_active: 1, active_count: 0, remaining: 5 }] } as Awaited<ReturnType<typeof api.getEventSlots>>);
  vi.mocked(api.myEventBookings).mockResolvedValue({ items: [] });
  render(<MemoryRouter initialEntries={['/events/event?liffId=account']}><Routes>
    <Route path="/events/:id" element={<Event />} /><Route path="/events/:id/confirm" element={<Destination />} />
  </Routes></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: /10:00〜11:00/ }));
  expect(screen.queryByTestId('destination')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'この時間で申し込む' }));
  const target = new URL((await screen.findByTestId('destination')).textContent!, 'https://example.test');
  expect(target.searchParams.get('slotId')).toBe('slot');
  expect(target.searchParams.get('liffId')).toBe('account');
});

it('確認画面は申し込みと戻るを区別し、戻るだけでは送信しない', async () => {
  open();
  await screen.findByRole('button', { name: '申し込む' });
  expect(screen.queryByText('予約をリクエスト')).toBeNull();
  expect(screen.queryByRole('button', { name: /^戻る$/ })).toBeNull();
  expect(document.body.textContent).not.toMatch(/[📍📅⏳✅]/u);
  fireEvent.click(screen.getByRole('button', { name: '← 戻る' }));
  expect(api.createEventBooking).not.toHaveBeenCalled();
});

it('イベントの履歴はこれまでを選んで読み直し、過去という見出しを出さない', async () => {
  vi.mocked(api.myEventBookings).mockResolvedValue({ items: [] });
  render(<MemoryRouter><EventBookings /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('tab', { name: 'これまで' }));
  await waitFor(() => expect(api.myEventBookings).toHaveBeenLastCalledWith('past'));
  expect(screen.queryByText('過去')).toBeNull();
});

it('受付後は詳細の読込を待たず結果を示す', async () => {
  vi.mocked(api.getEvent).mockImplementation(() => new Promise(() => {}));
  render(<MemoryRouter initialEntries={['/events/event/done?status=requested']}><Routes><Route path="/events/:id/done" element={<EventDone />} /></Routes></MemoryRouter>);
  expect(screen.getByText('受付しました')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByRole('button', { name: 'LINEに戻る' })).toBeTruthy();
});
