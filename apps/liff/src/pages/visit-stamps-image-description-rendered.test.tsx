// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import VisitStamps from './visit-stamps.js';

const requests = vi.hoisted(() => ({ cards: vi.fn(), paperRequests: vi.fn(), card: vi.fn(), showReward: vi.fn(), useReward: vi.fn(), requestPaper: vi.fn(), uploadPaperPhoto: vi.fn() }));
vi.mock('@line/liff', () => ({ default: { closeWindow: vi.fn() } }));
vi.mock('../lib/api.js', () => ({
  api: { customerLook: vi.fn().mockResolvedValue({ success: true, data: { settings: {} } }), liffConfig: vi.fn().mockResolvedValue({ success: true, data: { accountId: 'account', accountName: 'お店' } }), bookingSettings: vi.fn().mockResolvedValue({}) },
  visitStampsApi: requests,
}));
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });

it('飾りの背景は読み上げず、選んだ紙カードの写真は名前で確認できる', async () => {
  const card = { id: 'card', name: '来店スタンプ', accountIds: ['account'], active: true, version: 1, expectedVersion: 1, settings: { mode: 'visit', amountUnit: 1000, maxPerVisit: 3, firstVisitBonus: 0, expiryMonths: 6, timezone: 'Asia/Tokyo', multipliers: [], rankMultipliers: [], rewards: [{ id: 'reward', name: '特典', stamps: 5 }], backgroundImageUrl: 'https://example.test/background.png' } };
  const wallet = { cardId: 'card', friendId: 'friend', balance: 1, earnedTotal: 1, expiresAt: null };
  requests.cards.mockResolvedValue({ success: true, data: [{ card, wallet }] });
  requests.paperRequests.mockResolvedValue({ success: true, data: [] });
  const objectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second');
  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const rendered = render(<VisitStamps />);
  const transfer = await screen.findByRole('button', { name: '紙のカードを移す' });
  expect(rendered.container.querySelector('img[src="https://example.test/background.png"]')?.getAttribute('alt')).toBe('');
  fireEvent.click(transfer);
  const input = await screen.findByLabelText('紙のカードの写真');
  fireEvent.change(input, { target: { files: [new File(['first'], 'first.jpg', { type: 'image/jpeg' })] } });
  expect(screen.getByRole('img', { name: '撮った紙のカード' }).getAttribute('src')).toBe('blob:first');
  fireEvent.change(input, { target: { files: [new File(['second'], 'second.jpg', { type: 'image/jpeg' })] } });
  expect(screen.getByRole('img', { name: '撮った紙のカード' }).getAttribute('src')).toBe('blob:second');
  expect(objectUrl).toHaveBeenCalledTimes(2);
  expect(revoke).toHaveBeenCalledWith('blob:first');
  expect(requests.requestPaper).not.toHaveBeenCalled();
});
