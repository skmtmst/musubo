// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { restaurantBookingApi, type RestaurantMenuData, type RestaurantMenuItem } from '../../lib/api.js';
import RestaurantMenu from './menu.js';

vi.mock('../../lib/api.js', () => ({
  api: {
    customerLook: vi.fn().mockResolvedValue({ success: true, data: { settings: { liff_theme: 'line' } } }),
    liffConfig: vi.fn().mockResolvedValue({ success: true, data: { accountName: '見本 LINE' } }),
  },
  restaurantBookingApi: { menu: vi.fn() },
}));
vi.mock('../../lib/user-message.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../lib/user-message.js')>(),
  logFailure: vi.fn(),
}));

const menu = {
  storeId: 'restaurant',
  storeName: '見本店',
  bookingUrl: 'https://liff.line.me/demo/?page=restaurant&token=booking',
  items: [],
} satisfies RestaurantMenuData;
const course = {
  id: 'course', kind: 'course', name: '季節のおまかせコース', price: 8800,
  description: '旬の前菜と魚料理', servicePeriods: ['dinner'], durationMinutes: 120,
  photos: Array.from({ length: 5 }, (_, index) => ({ id: `photo-${index + 1}`, url: `https://example.test/photo/${index + 1}`, x: 20, y: 80 })),
} satisfies RestaurantMenuItem;
const dish = {
  id: 'dish', kind: 'a_la_carte', name: '前菜盛り合わせ', price: 1200,
  description: null, servicePeriods: [], durationMinutes: null, photos: [],
} satisfies RestaurantMenuItem;

function open() {
  render(<MemoryRouter initialEntries={['/restaurant/menu?token=example']}><RestaurantMenu /></MemoryRouter>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('料理メニュー LIFF', () => {
  it('店舗の公開コースと単品を切り替え、予約を受け付けているときは予約の入口を表示する', async () => {
    vi.mocked(restaurantBookingApi.menu).mockResolvedValue({ ...menu, items: [course, dish] });
    open();
    expect(await screen.findByRole('heading', { name: course.name })).toBeTruthy();
    expect(restaurantBookingApi.menu).toHaveBeenCalledWith({ token: 'example' });
    expect(screen.getByText('見本店')).toBeTruthy();
    expect(screen.getByText('8,800円')).toBeTruthy();
    expect(screen.getByText('120分・ディナー')).toBeTruthy();
    expect(screen.getByRole('link', { name: '席を予約する' }).getAttribute('href')).toBe(menu.bookingUrl);
    fireEvent.click(screen.getByRole('tab', { name: '単品' }));
    expect(screen.getByRole('heading', { name: dish.name })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /写真を見る/ })).toBeNull();
  });

  it('5枚を登録順に切り替え、失敗した1枚のURLだけを取り直し、閉じると元の操作に戻る', async () => {
    const fresh = course.photos.map((photo) => ({ ...photo, url: `${photo.url}?new=1` }));
    vi.mocked(restaurantBookingApi.menu)
      .mockResolvedValueOnce({ ...menu, items: [course] })
      .mockResolvedValueOnce({ ...menu, items: [{ ...course, photos: [...fresh].reverse() }] });
    open();
    const opener = await screen.findByRole('button', { name: /写真を見る.*5枚/ });
    expect(opener.querySelector('img')?.style.objectPosition).toBe('20% 80%');
    fireEvent.click(opener);
    const dialog = within(screen.getByRole('dialog', { name: course.name }));
    expect(dialog.getByText('1 / 5')).toBeTruthy();
    const mainPhoto = dialog.getByRole('img', { name: /写真 1$/ });
    expect(mainPhoto.getAttribute('src')).toBe(course.photos[0]!.url);
    fireEvent.touchStart(mainPhoto, { touches: [{ clientX: 240, clientY: 100 }] });
    fireEvent.touchEnd(mainPhoto, { changedTouches: [{ clientX: 115, clientY: 102 }] });
    expect(dialog.getByText('2 / 5')).toBeTruthy();
    fireEvent.error(dialog.getByRole('img', { name: /写真 2$/ }));
    const retryButton = dialog.getByRole('button', { name: 'もう一度読み込む' });
    retryButton.focus();
    fireEvent.click(retryButton);
    expect((await dialog.findByRole('img', { name: /写真 2$/ })).getAttribute('src')).toBe(fresh[1]!.url);
    expect(dialog.getByRole('img', { name: /写真 2$/ }).closest('[tabindex]')).toBe(document.activeElement);
    expect(restaurantBookingApi.menu).toHaveBeenCalledTimes(2);
    fireEvent.click(dialog.getByRole('button', { name: '写真 5 を表示' }));
    expect(dialog.getByText('5 / 5')).toBeTruthy();
    const thumbnail = dialog.getByRole('button', { name: '写真 5 を表示' });
    fireEvent.keyDown(thumbnail, { key: 'ArrowLeft' });
    expect(dialog.getByText('4 / 5')).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: '閉じる' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(screen.getByText('8,800円')).toBeTruthy();
  });

  it('再取得時に選択中の写真が減っていても別の写真に切り替えない', async () => {
    vi.mocked(restaurantBookingApi.menu)
      .mockResolvedValueOnce({ ...menu, items: [course] })
      .mockResolvedValueOnce({ ...menu, items: [{ ...course, photos: course.photos.filter((photo) => photo.id !== 'photo-2') }] });
    open();
    fireEvent.click(await screen.findByRole('button', { name: /写真を見る.*5枚/ }));
    const dialog = within(screen.getByRole('dialog', { name: course.name }));
    fireEvent.click(dialog.getByRole('button', { name: '写真 2 を表示' }));
    fireEvent.error(dialog.getByRole('img', { name: /写真 2$/ }));
    const retry = dialog.getByRole('button', { name: 'もう一度読み込む' });
    fireEvent.click(retry);
    await waitFor(() => expect(retry).toHaveProperty('disabled', false));
    expect(dialog.getByText('2 / 5')).toBeTruthy();
    expect(dialog.getByText('写真を読み込めませんでした')).toBeTruthy();
    expect(dialog.queryByRole('img', { name: /写真 2$/ })).toBeNull();
  });

  it('1枚だけのメニューには切替を出さず、予約停止中でも写真を見られる', async () => {
    vi.mocked(restaurantBookingApi.menu).mockResolvedValue({ ...menu, bookingUrl: null, items: [{ ...course, photos: [course.photos[0]!] }] });
    open();
    fireEvent.click(await screen.findByRole('button', { name: /写真を見る$/ }));
    const dialog = within(screen.getByRole('dialog', { name: course.name }));
    expect(dialog.getByRole('img', { name: /写真 1$/ })).toBeTruthy();
    expect(dialog.queryByRole('group', { name: '写真を選ぶ' })).toBeNull();
    expect(screen.queryByRole('link', { name: '席を予約する' })).toBeNull();
  });

  it('通信失敗なら再試行でき、公開メニューがないときは準備中を表示する', async () => {
    vi.mocked(restaurantBookingApi.menu).mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(menu);
    open();
    expect(await screen.findByText('メニューを読み込めませんでした')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }));
    expect(await screen.findByText('メニューは準備中です')).toBeTruthy();
  });
});
