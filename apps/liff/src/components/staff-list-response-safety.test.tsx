// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import StaffList from './staff-list.js';
import type { MenuItem, StaffItem } from '../lib/api.js';

const read = vi.hoisted(() => vi.fn());
vi.mock('../lib/api.js', () => ({ api: { staffOf: read } }));
vi.mock('../lib/user-message.js', async original => ({ ...await original<typeof import('../lib/user-message.js')>(), logFailure: vi.fn() }));
const menu = (id: string) => ({ id, name: id, duration_minutes: 60, base_price: 0 } as MenuItem);
const staff = (id: string) => ({ id, display_name: id, is_designation_optional: 0, price: 0 } as StaffItem);
beforeEach(() => read.mockReset());
afterEach(cleanup);

it('担当者の一覧が不正なら読み直せる', async () => {
  read.mockResolvedValueOnce({ staff: null }).mockResolvedValueOnce({ staff: [staff('担当A')] });
  render(<StaffList menu={menu('a')} selectedId={null} onSelect={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'もう一度読み込む' }));
  expect(await screen.findByText('担当A')).toBeTruthy();
});

it('メニュー変更後に古い応答が届いても新しい担当者を保つ', async () => {
  let finish!: (value: { staff: StaffItem[] }) => void;
  read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce({ staff: [staff('新しい担当')] });
  const view = render(<StaffList menu={menu('a')} selectedId={null} onSelect={() => {}} />);
  view.rerender(<StaffList menu={menu('b')} selectedId={null} onSelect={() => {}} />);
  expect(await screen.findByText('新しい担当')).toBeTruthy();
  await act(async () => finish({ staff: [staff('古い担当')] }));
  expect(screen.queryByText('古い担当')).toBeNull();
  expect(screen.getByText('新しい担当')).toBeTruthy();
});
