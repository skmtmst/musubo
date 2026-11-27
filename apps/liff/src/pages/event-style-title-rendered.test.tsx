// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { CustomerStyleContext } from '../components/customer-style-scope.js';
import EventDone from './event-done.js';
import EventBookings from './event-bookings.js';

vi.mock('@line/liff', () => ({ default: { closeWindow: vi.fn() } }));
vi.mock('../lib/api.js', () => ({ api: {
  getEvent: vi.fn().mockResolvedValue({ id: 'event', name: '交流会' }),
  myEventBookings: vi.fn().mockResolvedValue({ items: [] }),
  customerLook: vi.fn().mockResolvedValue({ success: true, data: { settings: {} } }),
  liffConfig: vi.fn().mockResolvedValue({ data: {} }),
} }));
afterEach(() => { cleanup(); vi.clearAllMocks(); document.title = ''; });

it.each([
  ['standard', 'イベント', '自分のイベント'],
  ['lesson', 'クラス', '自分のクラス'],
] as const)('%s の受付結果から履歴へ移ると業種に合う画面名を示す', async (style, eventTitle, historyTitle) => {
  render(<CustomerStyleContext.Provider value={style}><MemoryRouter initialEntries={['/events/event/done?status=confirmed']}><Routes>
    <Route path="/events/:id/done" element={<EventDone />} />
    <Route path="/events/me" element={<EventBookings />} />
  </Routes></MemoryRouter></CustomerStyleContext.Provider>);
  const history = await screen.findByRole('button', { name: `${historyTitle}を見る` });
  expect(document.title).toBe(`${eventTitle} | musubo`);
  fireEvent.click(history);
  await screen.findByRole('tab', { name: 'これまで' });
  await waitFor(() => expect(document.title).toBe(`${historyTitle} | musubo`));
});
