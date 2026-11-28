// @vitest-environment happy-dom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, describe, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import StatusView from './status-view.js';
import LoadErrorView from '../load-error-view.js';
import LoadingView from '../loading-view.js';
import HistoryCard from '../history-card.js';
import BookingHistory from '../../pages/booking-history.js';
import Done from '../done.js';
import { api } from '../../lib/api.js';
import { customerWords } from '../../lib/customer-style.js';

vi.mock('@line/liff', () => ({ default: { closeWindow: vi.fn() } }));
vi.mock('../../lib/api.js', () => ({ api: {
  me: vi.fn(), customerLook: vi.fn().mockResolvedValue({ success: true, data: { settings: {} } }),
  liffConfig: vi.fn().mockResolvedValue({ data: {} }),
} }));
vi.mock('../../lib/user-message.js', async original => ({ ...await original<typeof import('../../lib/user-message.js')>(), logFailure: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

const ROOT = join(import.meta.dirname, '../..');
const UI = join(ROOT, 'components', 'ui');

function src(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), 'utf8');
}

function ui(name: string): string {
  return readFileSync(join(UI, name), 'utf8');
}

/** ★V8 の見た目で読む文面。Event 系は別 PR なので外す。 */
const RESERVATION_UI_SOURCES = [
  ui('icon.tsx'),
  ui('Button.tsx'),
  ui('card.tsx'),
  ui('badge.tsx'),
  ui('liff-header.tsx'),
  ui('bottom-bar.tsx'),
  ui('Stepper.tsx'),
  ui('status-view.tsx'),
  ui('confirm-dialog.tsx'),
  src('components', 'loading-view.tsx'),
  src('components', 'load-error-view.tsx'),
  src('components', 'menu-list.tsx'),
  src('components', 'staff-list.tsx'),
  src('components', 'date-time-picker.tsx'),
  src('components', 'confirm.tsx'),
  src('components', 'done.tsx'),
  src('pages', 'booking.tsx'),
  src('pages', 'booking-history.tsx'),
  src('components', 'history-card.tsx'),
  src('pages', 'form.tsx'),
  src('pages', 'affiliate.tsx'),
  src('pages', 'webinar.tsx'),
  src('pages', 'seat', 'seat-reserve.tsx'),
  src('pages', 'seat', 'seat-pick.tsx'),
  src('pages', 'seat', 'seat-confirm.tsx'),
  src('pages', 'seat', 'seat-done.tsx'),
  src('pages', 'seat', 'seat-mine.tsx'),
];

describe('★V8 の色はトークンだけ', () => {
  it('素の Tailwind 色・16進数・青ボタン・LINE の明るい緑のボタン地が無い', () => {
    for (const text of RESERVATION_UI_SOURCES) {
      expect(text).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      for (const banned of [
        'bg-green-',
        'text-green-',
        'bg-blue-',
        'text-blue-',
        'bg-gray-',
        'text-gray-',
        'border-gray-',
        '#06c755',
        '#0b63ce',
      ]) {
        expect(text).not.toContain(banned);
      }
    }
  });

});

it('状態の操作は指定した1つだけ出し、押すと処理を呼ぶ', () => {
  const onClick = vi.fn();
  const view = render(<StatusView icon="check" title="受付済み" action={{ label: '確認する', onClick }} />);
  expect(screen.getAllByRole('button')).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: '確認する' }));
  expect(onClick).toHaveBeenCalledTimes(1);
  view.rerender(<StatusView icon="check" title="受付済み" />);
  expect(screen.queryByRole('button')).toBeNull();
});
it('読込失敗は日本語で伝え、読み直せる', () => {
  const onRetry = vi.fn();
  const view = render(<LoadErrorView onRetry={onRetry} />);
  expect(screen.getByText('読み込めませんでした')).toBeTruthy();
  expect(screen.getAllByRole('button')).toHaveLength(1);
  for (const banned of ['text-red', 'bg-red', 'border-red']) expect(src('components', 'load-error-view.tsx')).not.toContain(banned);
  for (const banned of ['Error', 'API', 'status', '500', 'error code', 'エラーコード']) expect(view.container.textContent).not.toContain(banned);
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }));
  expect(onRetry).toHaveBeenCalledOnce();
});
it('骨組みは300ms待って出し、短い読込では表示しない', async () => {
  vi.useFakeTimers();
  const view = render(<LoadingView />);
  expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
  expect(screen.getByRole('status').children).toHaveLength(0);
  await act(async () => vi.advanceTimersByTime(299));
  expect(screen.getByRole('status').children).toHaveLength(0);
  await act(async () => vi.advanceTimersByTime(1));
  expect(screen.getByRole('status').querySelectorAll('[aria-hidden="true"] > div')).toHaveLength(5);
  view.unmount();
  render(<LoadingView />);
  await act(async () => vi.advanceTimersByTime(100));
  cleanup();
  expect(vi.getTimerCount()).toBe(0);
});
it('札は確認待ち・確定の文字を出す', () => {
  const booking = { id: 'booking', starts_at: '2099-01-01T01:00:00Z', status: 'requested', menu_name: 'メニュー', staff_name: '担当', profile_image_url: null, lock_version: 1, menu_id: 'menu', staff_id: 'staff' };
  expect(renderToStaticMarkup(createElement(HistoryCard, { booking }))).toContain('担当者の確認待ち');
  expect(customerWords(null).approvalPending).toBe('担当者の確認待ち');
  expect(renderToStaticMarkup(createElement(HistoryCard, { booking: { ...booking, status: 'confirmed' } }))).toContain('確定');
});
it('履歴はこれからとこれまでを切り替えて表示する', async () => {
  vi.mocked(api.me).mockResolvedValue({ upcoming: [], past: [{ id: 'past', starts_at: '2020-01-01T01:00:00Z', status: 'confirmed', menu_name: '以前のメニュー', staff_name: '担当', profile_image_url: null, lock_version: 1, menu_id: 'menu', staff_id: 'staff' }] });
  render(<MemoryRouter><BookingHistory /></MemoryRouter>);
  await screen.findByText('これから');
  fireEvent.click(screen.getByRole('tab', { name: 'これまで' }));
  expect(await screen.findByText('以前のメニュー')).toBeTruthy();
  expect(screen.queryByText('過去')).toBeNull();
  expect(screen.queryByText(/これから \(/)).toBeNull();
});
it('履歴の失敗時も予約は残ると伝え、再読込で回復する', async () => {
  vi.mocked(api.me).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ upcoming: [], past: [] });
  render(<MemoryRouter><BookingHistory /></MemoryRouter>);
  expect(await screen.findByText(/予約はなくなっていません。/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }));
  await vi.waitFor(() => expect(api.me).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(screen.queryByText(/予約はなくなっていません。/)).toBeNull());
});
it('受付後はLINEへ戻る操作と履歴を出す', async () => {
  const liff = (await import('@line/liff')).default;
  render(<MemoryRouter><Done slot={{ date: '2099-01-01', start: '10:00' }} menuName="相談" status="confirmed" /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'LINEに戻る' }));
  expect(liff.closeWindow).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: '予約の履歴を見る' })).toBeTruthy();
  expect(screen.getByText('日時').closest('dl')?.querySelector('svg')).toBeNull();
});

it('履歴と完了画面の禁止の見張りを保つ', () => {
  expect(src('pages', 'booking-history.tsx')).not.toContain('過去');
  expect(src('pages', 'booking-history.tsx')).not.toMatch(/これから \(\{/);
  expect(src('components', 'done.tsx')).not.toContain('calendar-days');
});
