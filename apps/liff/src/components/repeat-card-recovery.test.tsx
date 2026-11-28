// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RepeatCard from './repeat-card.js';
import type { MenuItem } from '../lib/api.js';

const net = vi.hoisted(() => ({ menus: vi.fn(), lastBooking: vi.fn(), staffOf: vi.fn() }));
vi.mock('../lib/api.js', () => ({ api: net }));
vi.mock('../lib/user-message.js', async original => ({ ...await original<typeof import('../lib/user-message.js')>(), logFailure: vi.fn() }));
const menu = { id: 'm', name: 'メニュー', duration_minutes: 30 } as MenuItem;
const staff = { id: 's', display_name: '担当', profile_image_url: null };
const previous = { available: true, booking: { starts_at: '2099-10-20T01:00:00Z', menu: { id: 'm' }, staff } };
beforeEach(() => { net.menus.mockReset().mockResolvedValue({ menus: [menu] }); net.lastBooking.mockReset().mockResolvedValue(previous); net.staffOf.mockReset().mockResolvedValue({ staff: [staff] }); });
afterEach(cleanup);

it('履歴の読み込みに失敗したら読み直せる', async () => {
  net.lastBooking.mockRejectedValueOnce(new Error('offline'));
  render(<RepeatCard onRepeat={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: '前回の予約を読み直す' }));
  expect(await screen.findByRole('button', { name: '前回と同じで予約する' })).toBeTruthy();
});

it('メニュー一覧が変わったら古い予約を選べなくする', async () => {
  const first = [menu];
  const next: MenuItem[] = [];
  net.lastBooking.mockResolvedValueOnce(previous).mockReturnValueOnce(new Promise(() => {}));
  const view = render(<RepeatCard menus={first} onRepeat={() => {}} />);
  await screen.findByRole('button', { name: '前回と同じで予約する' });
  view.rerender(<RepeatCard menus={next} onRepeat={() => {}} />);
  expect(screen.queryByRole('button', { name: '前回と同じで予約する' })).toBeNull();
});
