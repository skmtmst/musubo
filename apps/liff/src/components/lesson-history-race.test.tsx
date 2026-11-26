// @vitest-environment happy-dom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import LessonHistorySection from './lesson-history-section.js';

const calls = vi.hoisted(() => ({ bookings: vi.fn(), credits: vi.fn() }));
vi.mock('../lib/api.js', () => ({ api: { myEventBookings: calls.bookings, makeupCredits: calls.credits } }));
vi.mock('./makeup-picker.js', () => ({ default: ({ credit }: { credit: { id: string } }) => <p>使える振替: {credit.id}</p> }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('読み直しが成功した後、先の失敗した読み込みの遅い返答で振替を消さない', async () => {
  let resolveOld!: (value: unknown) => void;
  calls.bookings.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ items: [] });
  calls.credits.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
    .mockResolvedValue({ credits: [{ id: '新しい振替', status: 'open', expires_at: '2099-12-31T00:00:00Z' }] });
  render(<LessonHistorySection />);
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }));
  expect(await screen.findByText('使える振替: 新しい振替')).toBeTruthy();
  await act(async () => { resolveOld({ credits: [] }); });
  expect(screen.getByText('使える振替: 新しい振替')).toBeTruthy();
});

it('読み直しが成功した後、先の振替の読み込みが失敗しても新しい表示を保つ', async () => {
  let rejectOld!: (reason: Error) => void;
  calls.bookings.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ items: [] });
  calls.credits.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectOld = reject; }))
    .mockResolvedValue({ credits: [{ id: '新しい振替', status: 'open', expires_at: '2099-12-31T00:00:00Z' }] });
  render(<LessonHistorySection />);
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }));
  expect(await screen.findByText('使える振替: 新しい振替')).toBeTruthy();
  await act(async () => { rejectOld(new Error('遅れて届いた失敗')); });
  expect(screen.getByText('使える振替: 新しい振替')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'もう一度読み込む' })).toBeNull();
});
