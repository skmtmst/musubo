// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import WaitlistSheet from './waitlist-sheet.js';
import type { MenuItem, StaffItem } from '../lib/api.js';

const net = vi.hoisted(() => ({ waitlistMine: vi.fn(), registerWaitlist: vi.fn(), cancelWaitlist: vi.fn() }));
vi.mock('../lib/api.js', () => ({ api: net }));
vi.mock('../lib/user-message.js', async original => ({ ...await original<typeof import('../lib/user-message.js')>(), logFailure: vi.fn() }));
beforeEach(() => { net.waitlistMine.mockReset(); net.registerWaitlist.mockReset(); });
afterEach(cleanup);
function open() { render(<WaitlistSheet menu={{ id: 'm', name: 'メニュー' } as MenuItem} staff={{ id: 's', display_name: '担当' } as StaffItem} date="2099-10-20" start="10:00" onClose={() => {}} />); }

it('不正な登録状況は未登録と扱わず読み直せる', async () => {
  net.waitlistMine.mockResolvedValueOnce({}).mockResolvedValueOnce({ entry: null });
  open();
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度' }));
  expect(await screen.findByRole('button', { name: '空いたら知らせる' })).toBeTruthy();
  expect(net.registerWaitlist).not.toHaveBeenCalled();
});

it('不正な登録結果は成功と表示せず登録状況を読み直す', async () => {
  net.waitlistMine.mockResolvedValueOnce({ entry: null }).mockResolvedValueOnce({ entry: { id: 'w', status: 'waiting', created_at: 'x' } });
  net.registerWaitlist.mockResolvedValueOnce({ id: '' });
  open();
  fireEvent.click(await screen.findByRole('button', { name: '空いたら知らせる' }));
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度' }));
  expect(await screen.findByText(/登録ずみです/)).toBeTruthy();
  expect(net.registerWaitlist).toHaveBeenCalledTimes(1);
});
