// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Event from './event.js';
import { api } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({ api: {
  getEvent: vi.fn(), getEventSlots: vi.fn(), myEventBookings: vi.fn().mockResolvedValue({ items: [] }),
  customerLook: vi.fn().mockResolvedValue({ success: true, data: { settings: {} } }),
  liffConfig: vi.fn().mockResolvedValue({ data: {} }),
} }));
vi.mock('../lib/user-message.js', async original => ({ ...await original<typeof import('../lib/user-message.js')>(), logFailure: vi.fn() }));
const detail = { id: 'event', name: '見本のイベント', waitlist_enabled: 0 } as Awaited<ReturnType<typeof api.getEvent>>;
const slot = { id: 'slot', starts_at: '2099-10-20T01:00:00Z', ends_at: '2099-10-20T02:00:00Z', capacity: null, remaining: null } as Awaited<ReturnType<typeof api.getEventSlots>>['items'][number];
beforeEach(() => {
  vi.mocked(api.getEvent).mockReset().mockResolvedValue(detail);
  vi.mocked(api.getEventSlots).mockReset().mockResolvedValue({ items: [slot] });
});
afterEach(cleanup);
function open() { render(<MemoryRouter initialEntries={['/events/event']}><Routes><Route path="/events/:id" element={<Event />} /></Routes></MemoryRouter>); }

it('イベント詳細が欠けたら読み込み失敗を示し、読み直せる', async () => {
  vi.mocked(api.getEvent).mockResolvedValueOnce(null as unknown as typeof detail);
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }));
  expect(await screen.findByText('見本のイベント')).toBeTruthy();
});

it('時間の一覧に不正な日時があれば選択を止め、読み直せる', async () => {
  vi.mocked(api.getEventSlots).mockResolvedValueOnce({ items: [{ ...slot, starts_at: 'invalid' }] });
  open();
  const retry = await screen.findByRole('button', { name: 'もう一度読み込む' });
  expect(screen.queryByRole('button', { name: 'この時間で申し込む' })).toBeNull();
  fireEvent.click(retry);
  expect(await screen.findByText('見本のイベント')).toBeTruthy();
  expect(screen.getByRole('button', { name: '時間を選んでください' })).toBeTruthy();
});
