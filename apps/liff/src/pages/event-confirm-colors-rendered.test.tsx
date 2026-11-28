import { cleanup, fireEvent, render } from '@testing-library/react';
import { Window } from 'happy-dom';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import EventConfirm from './event-confirm.js';
import Event from './event.js';
import { STYLE_BROWSER_HOOK_TIMEOUT, styleBrowser } from '../test-utils/style-browser.js';

vi.mock('@line/liff', () => ({ default: { closeWindow: vi.fn() } }));
vi.mock('../lib/api.js', () => ({ api: {
  getEvent: vi.fn().mockResolvedValue({ id: 'event', name: '交流会', requires_approval: 1, cancel_deadline_hours_before: 24 }),
  getEventSlots: vi.fn().mockResolvedValue({ items: [{ id: 'slot', event_id: 'event', starts_at: '2099-10-20T01:00:00Z', ends_at: '2099-10-20T02:00:00Z', capacity: 10, is_active: 1, active_count: 0, remaining: 5 }] }),
  customerLook: vi.fn().mockResolvedValue({ success: true, data: { settings: {} } }), liffConfig: vi.fn().mockResolvedValue({ data: {} }),
  createEventBooking: vi.fn(), myEventBookings: vi.fn().mockResolvedValue({ items: [] }), bookingSettings: vi.fn().mockResolvedValue({ liff_date_view: 'list', booking_window_days: 60 }),
} }));

let view: Awaited<ReturnType<typeof styleBrowser>>;
beforeAll(async () => { view = await styleBrowser(); }, STYLE_BROWSER_HOOK_TIMEOUT);
beforeEach(() => {
  const browser = new Window({ url: 'https://example.test/' });
  vi.stubGlobal('window', browser);
  vi.stubGlobal('document', browser.document);
  vi.stubGlobal('HTMLElement', browser.HTMLElement);
  vi.stubGlobal('navigator', browser.navigator);
});

it('イベント名は赤い警告色にせず、時間を選べる', async () => {
  const rendered = render(<MemoryRouter initialEntries={['/events/event']}><Routes><Route path="/events/:id" element={<Event />} /></Routes></MemoryRouter>);
  const slot = await rendered.findByRole('button', { name: /10:00〜11:00/ });
  fireEvent.click(slot);
  expect(rendered.getByRole('button', { name: 'この時間で申し込む' })).toBeTruthy();
  await view.show(rendered.container.innerHTML);
  const color = await view.page.getByRole('heading', { name: '交流会' }).evaluate(el => getComputedStyle(el).color);
  const match = color.match(/^rgb\((\d+), (\d+), (\d+)\)$/);
  expect(match).not.toBeNull();
  const [r, g, b] = match!.slice(1).map(Number);
  expect(r > 100 && r > g * 1.5 && r > b * 1.5).toBe(false);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
afterAll(async () => { await view?.browser.close(); });

it('確認画面の案内と操作は、青や黄色の警告地や別サービスのボタン色にならない', async () => {
  const rendered = render(<MemoryRouter initialEntries={['/events/event/confirm?slotId=slot']}><Routes><Route path="/events/:id/confirm" element={<EventConfirm />} /></Routes></MemoryRouter>);
  const back = await rendered.findByRole('button', { name: '← 戻る' });
  await view.show(rendered.container.innerHTML);
  const note = view.page.getByText(/空きは確保されていません/).locator('..');
  const [r, g, b] = await note.evaluate(el => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.fillStyle = getComputedStyle(el).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  });
  expect([r, g, b]).not.toEqual([233, 241, 255]);
  expect(r > 180 && g > 130 && b < 100).toBe(false);
  const primary = await view.page.getByRole('button', { name: '申し込む' }).evaluate(el => getComputedStyle(el).backgroundColor);
  expect(primary).not.toBe('rgb(6, 199, 85)');
  expect(primary).not.toBe('rgb(11, 99, 206)');
  fireEvent.click(back);
});
