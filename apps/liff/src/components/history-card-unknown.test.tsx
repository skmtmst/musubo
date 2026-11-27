// @vitest-environment happy-dom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { BookingHistoryItem } from '../lib/api.js';
import HistoryCard from './history-card.js';

vi.mock('./online-meeting-card.js', () => ({ default: () => null }));
afterEach(cleanup);
const booking: BookingHistoryItem = { id: 'bk', menu_id: 'menu', staff_id: 'staff', menu_name: '予約メニュー', staff_name: '担当者', profile_image_url: null, starts_at: '2099-10-20T01:00:00Z', status: 'confirmed', lock_version: 1 };
function View({ initial }: { initial: BookingHistoryItem }) {
  const [current, setCurrent] = useState(initial);
  return <><ul><HistoryCard booking={current} /></ul><button onClick={() => setCurrent(booking)}>更新</button></>;
}
it('未知の予約状態をそのまま出さず更新後は確定を表示する', () => {
  render(<View initial={{ ...booking, status: 'unknown' as BookingHistoryItem['status'] }} />);
  expect(screen.getByText('予約状態を確認できません')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  expect(screen.getByText('確定')).toBeTruthy();
});
it('不正な予約日時を確認不能と表示し更新後は正しい日時を表示する', () => {
  render(<View initial={{ ...booking, starts_at: 'invalid' }} />);
  expect(screen.getByText('予約日時を確認できません')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  expect(screen.getByText('10/20')).toBeTruthy();
  expect(screen.getByText('10:00')).toBeTruthy();
});
