// @vitest-environment happy-dom
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactNode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import EventBookings from './event-bookings.js';

const calls = vi.hoisted(() => ({ read: vi.fn(), cancel: vi.fn(), leave: vi.fn() }));
vi.mock('../lib/api.js', () => ({ api: { myEventBookings: calls.read, cancelMyEventBooking: calls.cancel, cancelMyEventWaitlist: calls.leave } }));
vi.mock('../components/liff-look-scope.js', () => ({ default: ({ children }: { children: ReactNode }) => children }));
vi.mock('../components/ui/liff-header.js', () => ({ default: () => null }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

/**
 * イベント予約の取り消し確認を、ブラウザの `confirm` から
 * LIFF 共通の確認窓 (`ui/ConfirmDialog`) へ移した契約。
 *
 * 動き・送る中身は変えない。閉じるを選ぶと何も起きず、
 * 取り消すを選ぶと今までどおり取り消しが動く。
 * 題と注意書きは V8 の板  の形（日時の題・待ちへの案内・前日の締め切り）。
 */

const root = join(import.meta.dirname, '..');
const dialog = readFileSync(join(import.meta.dirname, '../components/ui/confirm-dialog.tsx'), 'utf8');

/** 注意書きの中の字に当てないため、コメントを外す。 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.tsx') || full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const BROWSER_DIALOG =
  /(?:^|[^.\w])(confirm|alert|prompt)\(|\b(?:window|globalThis|self)\.(confirm|alert|prompt)\(/;

describe('LIFF にブラウザの確認窓を残さない', () => {
  it('confirm・alert・prompt の呼び出しが無い', () => {
    const offenders = walk(join(root))
      .filter((f) => !f.includes('.test.'))
      .filter((f) => BROWSER_DIALOG.test(code(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(root.length + 1))
      .sort();
    expect(offenders, 'LIFF 共通の確認窓を使う').toEqual([]);
  });
});

describe('イベント予約の取り消し確認', () => {
  it('題は日時＋行事の問いかけで、閉じると送らず、取り消しを確認して予約IDだけ送る', async () => {
    const booking = { id: 'booking-confirm', event_id: 'event-confirm', source: 'booking', status: 'confirmed', event_name: '撮影会', slot_starts_at: '2099-10-20T10:00:00Z', slot_ends_at: '2099-10-20T11:00:00Z', cancel_deadline_hours_before: 24 };
    calls.read.mockResolvedValue({ items: [booking] });
    calls.cancel.mockResolvedValue({ ok: true });
    render(createElement(MemoryRouter, null, createElement(EventBookings)));
    const detail=await screen.findByRole('button',{name:'撮影会のイベントを見る'});
    expect(detail.classList.contains('liff-hit')).toBe(true);
    fireEvent.click(await screen.findByRole('button', { name: 'キャンセルする' }));
    const confirmation = screen.getByRole('alertdialog');
    expect(confirmation.getAttribute('data-design-node')).toBe('nUYyb');
    expect(confirmation.getAttribute('aria-label')).toBe('10/20 19:00 の撮影会をキャンセルしますか');
    expect(within(confirmation).getByText('10/20 19:00 の撮影会をキャンセルしますか')).toBeTruthy();
    expect(within(confirmation).getByText(/キャンセル待ちの方へ順番に案内されます/)).toBeTruthy();
    expect(within(confirmation).getByText(/開始24時間前になると、ここからは変えられません/)).toBeTruthy();
    expect(within(confirmation).getByRole('button', { name: 'キャンセルする' })).toBeTruthy();
    fireEvent.click(within(confirmation).getByRole('button', { name: '閉じる' }));
    expect(calls.cancel).not.toHaveBeenCalled();
    expect(calls.leave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'キャンセルする' }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'キャンセルする' }));
    await waitFor(() => expect(calls.cancel).toHaveBeenCalledWith('booking-confirm'));
    expect(calls.cancel).toHaveBeenCalledTimes(1);
    expect(calls.leave).not.toHaveBeenCalled();
  });



});

describe('LIFF 共通の確認窓の形', () => {


  it('素の Tailwind 色・16進数を使わない', () => {
    expect(dialog).not.toMatch(/#[0-9a-fA-F]{3,8}/);
    for (const banned of [
      'bg-green-',
      'text-green-',
      'bg-blue-',
      'text-blue-',
      'bg-gray-',
      'text-gray-',
      'bg-red-',
      'text-red-',
      'border-gray-',
      'bg-black/',
    ]) {
      expect(dialog).not.toContain(banned);
    }
  });
});

it.each([
  ['cancel_deadline_passed', 'キャンセル期限を過ぎています。'],
  ['cancel_not_allowed', 'このイベントは LIFF からのキャンセルに対応していません。LINE でご利用先にご連絡ください。'],
  ['invalid_state', 'この予約は既にキャンセル済 / 確定外のためキャンセルできません。'],
  ['unknown', 'キャンセルできませんでした。時間をおいて、もう一度お試しください。'],
])('取消失敗%sは予約を残して理由を伝える', async (error, message) => {
  calls.read.mockResolvedValue({ items: [{ id: 'booking', event_id: 'event', source: 'booking', status: 'confirmed', event_name: '交流会', slot_starts_at: '2099-10-20T01:00:00Z', slot_ends_at: '2099-10-20T02:00:00Z', cancel_deadline_hours_before: 24 }] });
  calls.cancel.mockRejectedValue({ body: { error } });
  render(createElement(MemoryRouter, null, createElement(EventBookings)));
  fireEvent.click(await screen.findByRole('button', { name: 'キャンセルする' }));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'キャンセルする' }));
  expect(await screen.findByText(message)).toBeTruthy();
  expect(calls.cancel).toHaveBeenCalledExactlyOnceWith('booking');
  expect(calls.read).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: '交流会のイベントを見る' })).toBeTruthy();
});

it('申し込み済みと承認待ちを文字で示し、これまでへ切り替えて読み直す', async () => {
  const booking = { id: 'booking', event_id: 'event', source: 'booking', status: 'confirmed', event_name: '交流会', slot_starts_at: '2099-10-20T01:00:00Z', slot_ends_at: '2099-10-20T02:00:00Z' };
  calls.read.mockImplementation(async tab => ({ items: tab === 'upcoming' ? [booking, { ...booking, id: 'pending', event_name: '相談会', status: 'requested' }] : [{ ...booking, event_name: '前の交流会' }] }));
  render(createElement(MemoryRouter, null, createElement(EventBookings)));
  expect(await screen.findByText('申し込み済み')).toBeTruthy();
  expect(screen.getByText('承認待ち')).toBeTruthy();
  fireEvent.click(screen.getByRole('tab', { name: 'これまで' }));
  expect(await screen.findByText('前の交流会')).toBeTruthy();
  expect(calls.read).toHaveBeenLastCalledWith('past');
  expect(screen.queryByText('相談会')).toBeNull();
});
