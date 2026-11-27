// @vitest-environment happy-dom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import BookingCancelDeadline from './booking-cancel-deadline.js';
import ProgressBar from './ui/progress-bar.js';

afterEach(cleanup);
it('不正なキャンセル期限は確認不能と知らせ、更新後は日時を示す', () => {
  function View() {
    const [deadline, setDeadline] = useState('invalid');
    return <><BookingCancelDeadline deadline={deadline} /><button onClick={() => setDeadline('2099-10-20T01:00:00Z')}>更新</button></>;
  }
  render(<View />);
  expect(screen.getByText('キャンセル期限を確認できません')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  expect(screen.getByText('キャンセル期限：2099年10月20日 10:00')).toBeTruthy();
});
it('不正な進捗は数値として示さず、更新後は正しい値を示す', () => {
  function View() {
    const [value, setValue] = useState(Number.NaN);
    return <><ProgressBar value={value} label="次のランクまで" /><button onClick={() => setValue(0.6)}>更新</button></>;
  }
  render(<View />);
  expect(screen.getByText('次のランクまでの進み具合を確認できません')).toBeTruthy();
  expect(screen.queryByRole('progressbar')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('60');
});
