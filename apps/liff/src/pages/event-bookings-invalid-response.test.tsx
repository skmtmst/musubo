// @vitest-environment happy-dom
import type { ReactNode } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import EventBookings from './event-bookings.js';

const read = vi.hoisted(() => vi.fn());
vi.mock('../lib/api.js', () => ({ api: { myEventBookings: read } }));
vi.mock('../components/liff-look-scope.js', () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock('../components/ui/liff-header.js', () => ({ default: () => null }));
beforeEach(() => read.mockReset());
afterEach(cleanup);
function open() { render(<MemoryRouter><EventBookings /></MemoryRouter>); }

it('一覧の応答が不正なら空として扱わず、読み直せる', async () => {
  read.mockResolvedValueOnce({ items: null }).mockResolvedValueOnce({ items: [] });
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }));
  expect(await screen.findByText('これからのイベントはありません')).toBeTruthy();
});

it('知らない申込状態は内部の文字を見せず、確認できないと伝える', async () => {
  read.mockResolvedValue({ items: [{ id: 'b', event_id: 'e', event_name: '交流会', status: 'new_state', slot_starts_at: '2099-10-20T01:00:00Z', slot_ends_at: '2099-10-20T02:00:00Z' }] });
  open();
  expect(await screen.findByText('状態を確認できません')).toBeTruthy();
  expect(screen.queryByText('new_state')).toBeNull();
});
