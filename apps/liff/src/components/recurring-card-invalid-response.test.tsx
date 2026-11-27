// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RecurringCard from './recurring-card.js';
import type { MenuItem, StaffItem } from '../lib/api.js';

const read = vi.hoisted(() => vi.fn());
vi.mock('../lib/api.js', () => ({ api: { seriesPreview: read } }));
vi.mock('../lib/user-message.js', async original => ({ ...await original<typeof import('../lib/user-message.js')>(), logFailure: vi.fn() }));
const menu = { id: 'm', recurring: { enabled: true, max_count: 4 } } as MenuItem;
const staff = { id: 's' } as StaffItem;
beforeEach(() => read.mockReset());
afterEach(cleanup);
it.each([
  ['一覧がない', { occurrences: null }],
  ['日時が不正', { occurrences: [{ index: 0, starts_at: 'invalid', available: true, alternatives: [] }] }],
])('%s場合は空きを確認できず、再確認できる', async (_kind, invalid) => {
  read.mockResolvedValueOnce(invalid).mockResolvedValueOnce({ occurrences: [{ index: 0, starts_at: '2099-10-20T01:00:00Z', available: true, alternatives: [] }] });
  const onChange = vi.fn();
  render(<RecurringCard menu={menu} staff={staff} startsAt="2099-10-20T01:00:00Z" onChange={onChange} />);
  fireEvent.click(screen.getByRole('switch', { name: '毎週この時間で続ける' }));
  const retry = await screen.findByRole('button', { name: 'もう一度' });
  expect(onChange).toHaveBeenLastCalledWith('checking');
  fireEvent.click(retry);
  expect(await screen.findByText(/1 回すべて予約します/)).toBeTruthy();
});
