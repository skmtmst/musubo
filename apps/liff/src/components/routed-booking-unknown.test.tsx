// @vitest-environment happy-dom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { NoRoutedSlots, RoutedBanner, RoutedConfirm } from './routed-booking.js';
import type { RoutedTarget } from '../lib/api.js';

afterEach(cleanup);
const target: RoutedTarget = { menuId: 'm', menuName: '相談', durationMinutes: 30, price: 0, staffId: null, staffName: null, meetingMode: 'online' };
it('未知の形式を対面と決めつけず、更新後は正しい形式を表示する', () => {
  function View() {
    const [value, setValue] = useState<RoutedTarget>({ ...target, meetingMode: 'unknown' as 'online' });
    return <><RoutedBanner target={value} /><RoutedConfirm target={value} whenText="10時" /><button onClick={() => setValue(target)}>更新</button></>;
  }
  render(<View />);
  expect(screen.getByText(/形式を確認できません/)).toBeTruthy();
  expect(screen.getByText('確認できません')).toBeTruthy();
  expect(screen.queryByText('対面')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  expect(screen.getAllByText(/オンライン（Zoom・Meet）/).length).toBe(2);
});
it('検索した日数を週単位に切り上げず、更新後も正しい日数を表示する', () => {
  function View() {
    const [days, setDays] = useState(8);
    return <><NoRoutedSlots target={target} days={days} /><button onClick={() => setDays(9)}>更新</button></>;
  }
  render(<View />);
  expect(screen.getByText(/今日から 8 日間/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  expect(screen.getByText('ご案内できる日時がありません')).toBeTruthy();
  expect(screen.getByText(/今日から 9 日間/)).toBeTruthy();
});
