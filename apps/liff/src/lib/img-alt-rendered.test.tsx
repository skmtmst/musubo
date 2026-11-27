// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import StorePhotos from '../components/booking-store-photos.js';
import MenuList from '../components/menu-list.js';
import StaffList from '../components/staff-list.js';
import RepeatCard from '../components/repeat-card.js';
import type { MenuItem, StaffItem } from './api.js';

const net = vi.hoisted(() => ({ storePhotos: vi.fn(), menus: vi.fn(), staffOf: vi.fn(), lastBooking: vi.fn() }));
vi.mock('./api.js', () => ({ api: net }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const menu: MenuItem = { id: 'menu', name: '相談', category_label: null, description: null, duration_minutes: 30, buffer_after_minutes: 0, base_price: 0, sort_order: 0, photo_url: '/menu.png' };
const staff: StaffItem = { id: 'staff', display_name: '担当', role: null, profile_image_url: '/staff.png', bio: null, is_designation_optional: 0, price: 0, duration_minutes: 30 };

it('店の写真と拡大写真は、何の写真かを読み上げられる', async () => {
  net.storePhotos.mockResolvedValue([{ slot: 'exterior', url: '/store.png' }]);
  render(<StorePhotos />);
  expect(await screen.findByRole('img', { name: 'お店の外観' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '外観の写真を大きく見る' }));
  const dialog = screen.getByRole('dialog', { name: 'お店の外観' });
  expect(within(dialog).getByRole('img', { name: 'お店の外観（拡大）' })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: '閉じる' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('メニューの飾り写真は説明を重複して読まず、メニューを選べる', async () => {
  net.menus.mockResolvedValue({ menus: [menu] });
  const choose = vi.fn();
  render(<MenuList selectedId={null} onSelect={choose} />);
  const button = await screen.findByRole('button', { name: /相談/ });
  expect(button.querySelector('img')?.getAttribute('alt')).toBe('');
  fireEvent.click(button);
  expect(choose).toHaveBeenCalledWith(menu);
});

it('担当の飾り写真は説明を重複して読まず、担当を選べる', async () => {
  net.staffOf.mockResolvedValue({ staff: [staff] });
  const choose = vi.fn();
  render(<StaffList menu={menu} selectedId={null} onSelect={choose} />);
  const button = await screen.findByRole('button', { name: /担当/ });
  expect(button.querySelector('img')?.getAttribute('alt')).toBe('');
  fireEvent.click(button);
  expect(choose).toHaveBeenCalledWith(staff);
});

it('前回予約の飾り写真は説明を重複して読まず、同じ予約を選べる', async () => {
  net.lastBooking.mockResolvedValue({ available: true, booking: { id: 'booking', starts_at: '2026-09-20T05:00:00Z', status: 'completed', menu: { id: menu.id, name: menu.name }, staff: { id: staff.id, display_name: staff.display_name, profile_image_url: staff.profile_image_url } } });
  net.staffOf.mockResolvedValue({ staff: [staff] });
  const choose = vi.fn();
  render(<RepeatCard menus={[menu]} onRepeat={choose} />);
  const button = await screen.findByRole('button', { name: '前回と同じで予約する' });
  expect(button.querySelector('img')?.getAttribute('alt')).toBe('');
  fireEvent.click(button);
  expect(choose).toHaveBeenCalledWith(menu, staff);
});
