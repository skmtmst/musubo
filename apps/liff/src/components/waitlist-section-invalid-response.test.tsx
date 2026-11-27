// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WaitlistSection from './waitlist-section.js';

const read = vi.hoisted(() => vi.fn());
vi.mock('../lib/api.js', () => ({ api: { bookingWaitlists: read } }));
vi.mock('./waitlist-offer-sheet.js', () => ({ default: () => null }));
vi.mock('../lib/user-message.js', async original => ({ ...await original<typeof import('../lib/user-message.js')>(), logFailure: vi.fn() }));
beforeEach(() => read.mockReset());
afterEach(cleanup);

it.each([
  ['一覧が欠けている', { waitlist: null }],
  ['知らない状態がある', { waitlist: [{ id: 'w', status: 'unknown' }] }],
])('%s場合は待ちなしと表示せず、読み直せる', async (_kind, invalid) => {
  read.mockResolvedValueOnce(invalid).mockResolvedValueOnce({ waitlist: [] });
  render(<WaitlistSection />);
  const retry = await screen.findByRole('button', { name: 'もう一度読み込む' });
  expect(screen.getByText(/キャンセル待ちはなくなっていません。/)).toBeTruthy();
  fireEvent.click(retry);
  await waitFor(() => expect(screen.queryByText('読み込めませんでした')).toBeNull());
  expect(read).toHaveBeenCalledTimes(2);
});
