// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import LessonHistorySection from './lesson-history-section.js';

const net = vi.hoisted(() => ({ myEventBookings: vi.fn(), makeupCredits: vi.fn() }));
vi.mock('../lib/api.js', () => ({ api: net }));
vi.mock('./makeup-picker.js', () => ({ default: () => null }));
vi.mock('./absence-sheet.js', () => ({ default: () => null, mdHm: () => '' }));
beforeEach(() => { net.myEventBookings.mockReset(); net.makeupCredits.mockReset().mockResolvedValue({ credits: [] }); });
afterEach(cleanup);
it('過去の履歴が不正なら読み直せる', async () => {
  net.myEventBookings.mockImplementation(async (tab: string) => tab === 'past' && net.myEventBookings.mock.calls.filter(c => c[0] === 'past').length === 1 ? { items: null } : { items: [] });
  render(<LessonHistorySection />);
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }));
  await waitFor(() => expect(screen.queryByText('読み込めませんでした')).toBeNull());
  expect(net.myEventBookings.mock.calls.filter(c => c[0] === 'past')).toHaveLength(2);
});
it('知らない振替の状態は履歴なしとせず読み直せる', async () => {
  net.myEventBookings.mockResolvedValue({ items: [] });
  net.makeupCredits.mockResolvedValueOnce({ credits: [{ id: 'c', status: 'unknown' }] }).mockResolvedValueOnce({ credits: [] });
  render(<LessonHistorySection />);
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }));
  await waitFor(() => expect(screen.queryByText('読み込めませんでした')).toBeNull());
  expect(net.makeupCredits).toHaveBeenCalledTimes(2);
});
