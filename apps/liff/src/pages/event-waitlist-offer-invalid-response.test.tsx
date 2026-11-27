// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import EventWaitlistOffer from './event-waitlist-offer.js';
import { api } from '../lib/api.js';

vi.mock('../lib/api.js', () => ({ api: {
  eventWaitlistOffer: vi.fn(), acceptEventWaitlistOffer: vi.fn(),
  customerLook: vi.fn().mockResolvedValue({ success: true, data: { settings: {} } }),
  liffConfig: vi.fn().mockResolvedValue({ data: {} }),
} }));
vi.mock('@line/liff', () => ({ default: { closeWindow: vi.fn() } }));
vi.mock('../lib/user-message.js', async original => ({ ...await original<typeof import('../lib/user-message.js')>(), logFailure: vi.fn() }));
const detail = { success: true as const, data: { waitlistId: 'w', eventId: 'e', slotId: 's', partySize: 2, status: 'offered' as const, expiresAt: '2030-11-01T01:00:00Z', eventName: '見本のイベント', startsAt: '2030-11-20T01:00:00Z', endsAt: '2030-11-20T02:00:00Z', venueName: null, remainingSeconds: 3600, canAccept: true } };
beforeEach(() => { vi.mocked(api.eventWaitlistOffer).mockReset(); vi.mocked(api.acceptEventWaitlistOffer).mockReset(); });
afterEach(cleanup);
function open() { render(<MemoryRouter><EventWaitlistOffer token="offer" /></MemoryRouter>); }

it('案内の日時が不正なら確定操作を出さず、読み直せる', async () => {
  vi.mocked(api.eventWaitlistOffer).mockResolvedValueOnce({ ...detail, data: { ...detail.data, startsAt: 'invalid' } }).mockResolvedValueOnce(detail);
  open();
  const retry = await screen.findByRole('button', { name: 'もう一度読み込む' });
  expect(screen.queryByRole('button', { name: 'この席を取る' })).toBeNull();
  fireEvent.click(retry);
  expect(await screen.findByRole('button', { name: 'この席を取る' })).toBeTruthy();
});

it('不正な確定応答は成功と表示せず、もう一度確認できる', async () => {
  vi.mocked(api.eventWaitlistOffer).mockResolvedValue(detail);
  vi.mocked(api.acceptEventWaitlistOffer).mockResolvedValueOnce({ success: true, data: { bookingId: '', status: 'confirmed', alreadyConfirmed: false } })
    .mockResolvedValueOnce({ success: true, data: { bookingId: 'b', status: 'confirmed', alreadyConfirmed: true } });
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'この席を取る' }));
  const retry = await screen.findByRole('button', { name: 'もう一度試す' });
  expect(screen.queryByText('予約が確定しました')).toBeNull();
  fireEvent.click(retry);
  expect(await screen.findByText('予約が確定しました')).toBeTruthy();
});
