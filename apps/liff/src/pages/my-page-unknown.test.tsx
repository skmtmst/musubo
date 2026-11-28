// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MyPage from './my-page.js';
import { api, visitStampsApi } from '../lib/api.js';
import { affiliateSelfApi } from '../lib/affiliate-self-api.js';

vi.mock('../lib/api.js', () => ({ api: { me: vi.fn(), menus: vi.fn(), bookingWaitlists: vi.fn(), entitlements: vi.fn(), liffConfig: vi.fn(), notificationPreferences: vi.fn(), updateNotificationPreference: vi.fn() }, visitStampsApi: { cards: vi.fn() } }));
vi.mock('../lib/affiliate-self-api.js', () => ({ affiliateSelfApi: { rewards: vi.fn() } }));
vi.mock('../lib/liff-runtime.js', () => ({ default: { getProfile: async () => ({ displayName: '見本' }) } }));
vi.mock('../components/liff-look-scope.js', () => ({ default: ({ children }: { children: import('react').ReactNode }) => children }));
vi.mock('../components/ui/liff-header.js', () => ({ default: () => null }));
beforeEach(() => {
  vi.mocked(api.me).mockResolvedValue({ upcoming: [], past: [] });
  vi.mocked(api.bookingWaitlists).mockResolvedValue({ waitlist: [] });
  vi.mocked(api.entitlements).mockResolvedValue([]);
  vi.mocked(api.liffConfig).mockResolvedValue({ success: true, data: { accountId: 'store', accountName: '店', botBasicId: '' } });
  vi.mocked(api.notificationPreferences).mockResolvedValue({ purposeSpecificEnforcement: false, items: [] });
  vi.mocked(visitStampsApi.cards).mockResolvedValue({ success: true, data: [] });
  vi.mocked(affiliateSelfApi.rewards).mockResolvedValue({ rewards: [], availableMiles: 0, balanceSource: 'musubo' });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const mount = () => render(<MemoryRouter><MyPage /></MemoryRouter>);
it('未知のキャンセル待ち状態は待ちなしとせず再読込できる', async () => {
  vi.mocked(api.bookingWaitlists).mockResolvedValueOnce({ waitlist: [{ status: 'unknown' }] } as unknown as Awaited<ReturnType<typeof api.bookingWaitlists>>).mockResolvedValueOnce({ waitlist: [{ status: 'waiting' }] } as unknown as Awaited<ReturnType<typeof api.bookingWaitlists>>);
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /キャンセル待ち.*もう一度読み込む/ }));
  expect(await screen.findByRole('button', { name: /キャンセル待ち.*1 件/ })).toBeTruthy();
});
it('不正なスタンプの個数は表示せず再読込できる', async () => {
  const response = (balance: number) => ({ success: true, data: [{ card: { active: true, settings: { rewards: [] } }, wallet: { balance } }] }) as unknown as Awaited<ReturnType<typeof visitStampsApi.cards>>;
  vi.mocked(visitStampsApi.cards).mockResolvedValueOnce(response(-1)).mockResolvedValueOnce(response(3));
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /スタンプ.*もう一度読み込む/ }));
  expect(await screen.findByRole('button', { name: /スタンプ.*3 個/ })).toBeTruthy();
});
