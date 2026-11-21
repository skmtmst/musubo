// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import OnlineMeetingCard from './online-meeting-card.js';
import { api } from '../lib/api.js';

/* 予約のあとのオンラインの会議（B7・sjkwK・I5hxa）：確認待ちは URL を出さない。確定は開始 10 分前から終わりまでだけ参加のボタン。 */
vi.mock('../lib/api.js', () => ({ api: { me: vi.fn() } }));
afterEach(cleanup);
const START = Date.parse('2099-01-01T05:00:00.000Z');
function booking(status: string, url: string | null) {
  vi.mocked(api.me).mockResolvedValue({ upcoming: [{ id: 'b1', starts_at: new Date(START).toISOString(), ends_at: new Date(START + 3600000).toISOString(), status, customer_note: null, menu_name: 'オンライン相談', staff_name: '佐々木', profile_image_url: null, meeting_mode: 'online', meeting_url: url, meeting_url_source: url ? 'staff' : null }], past: [] } as never);
}

it('確認待ちは URL もボタンも出さず、確定したら LINE で送ると伝える', async () => {
  booking('requested', null);
  render(<OnlineMeetingCard bookingId="b1" status="requested" now={() => START} />);
  expect(await screen.findByText('予約が確定したら、会議の URL をお送りします。')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '会議に参加する' })).toBeNull();
});

it('確定は開始 10 分前からボタンを出し、それより前は時刻だけ出す', async () => {
  booking('confirmed', 'https://zoom.us/j/1');
  const { unmount } = render(<OnlineMeetingCard bookingId="b1" status="confirmed" now={() => START - 9 * 60000} />);
  expect(await screen.findByRole('button', { name: '会議に参加する' })).toBeTruthy();
  expect(screen.getByText('オンライン（Zoom）')).toBeTruthy();
  unmount();
  render(<OnlineMeetingCard bookingId="b1" status="confirmed" now={() => START - 11 * 60000} />);
  expect(await screen.findByText(/から参加のボタンが出ます/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: '会議に参加する' })).toBeNull();
});

it.each([START - 600001, START + 3600001, NaN])('本人の確定予約でも参加できる時間外 (%s) は開けない', async (at) => {
  booking('confirmed', 'https://meet.google.com/test');
  render(<OnlineMeetingCard bookingId="b1" status="confirmed" now={() => at} />);
  await screen.findByText('オンライン（Google Meet）');
  expect(screen.queryByRole('button', { name: '会議に参加する' })).toBeNull();
});

it.each(['javascript:alert(1)', 'http://meet.google.com/test', 'https://user:pass@example.com/', 'not-url'])('有効でないURL (%s) は参加に使わない', async (url) => {
  booking('confirmed', url);
  render(<OnlineMeetingCard bookingId="b1" status="confirmed" now={() => START} />);
  await screen.findByText(/会議の URL は前日までにお送りします/);
  expect(screen.queryByRole('button', { name: '会議に参加する' })).toBeNull();
});

it('別人の予約が本人の一覧に無ければ、共通URLや他の予約を使わない', async () => {
  booking('confirmed', 'https://meet.google.com/test');
  const view = render(<OnlineMeetingCard bookingId="someone-else" status="confirmed" now={() => START} />);
  await act(async () => {});
  expect(view.container.textContent).toBe('');
  expect(screen.queryByRole('button')).toBeNull();
});

it('本人確認が拒否された場合は参加先を出さない', async () => {
  vi.mocked(api.me).mockRejectedValueOnce(Object.assign(new Error('unauthorized'), { status: 403 }));
  const view = render(<OnlineMeetingCard bookingId="b1" status="confirmed" now={() => START} />);
  await act(async () => {});
  expect(view.container.textContent).toBe('');
});

it('待ちの予約にURLが混ざっていても、確定扱いで開けない', async () => {
  booking('requested', 'https://meet.google.com/test');
  render(<OnlineMeetingCard bookingId="b1" status="confirmed" now={() => START} />);
  await screen.findByText(/予約が確定したら/);
  expect(screen.queryByRole('button')).toBeNull();
});

it('同じ予約IDの会議だけを開く', async () => {
  booking('confirmed', 'https://meet.google.com/test');
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  render(<OnlineMeetingCard bookingId="b1" status="confirmed" now={() => START} />);
  fireEvent.click(await screen.findByRole('button', { name: '会議に参加する' }));
  expect(open).toHaveBeenCalledWith('https://meet.google.com/test', '_blank', 'noopener,noreferrer');
  open.mockRestore();
});

it('確定済みの URL をコピーする', async () => {
  booking('confirmed', 'https://meet.google.com/test');
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  render(<OnlineMeetingCard bookingId="b1" status="confirmed" now={() => START - 6000000} />);
  fireEvent.click(await screen.findByRole('button', { name: 'URLをコピー' }));
  expect(writeText).toHaveBeenCalledWith('https://meet.google.com/test');
  expect(await screen.findByText('URLをコピーしました。')).toBeTruthy();
  vi.unstubAllGlobals();
});
