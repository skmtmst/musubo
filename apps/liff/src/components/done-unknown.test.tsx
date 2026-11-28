// @vitest-environment happy-dom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import Done from './done.js';

vi.mock('./online-meeting-card.js', () => ({ default: () => null }));
afterEach(cleanup);
const slot = { date: '2099-10-20', start: '10:00' };
it('未知の予約状態を受付成功と断定せず、更新後は確定を表示する', () => {
  function View() {
    const [status, setStatus] = useState('unknown');
    return <MemoryRouter><Done menuName="相談" slot={slot} status={status} /><button onClick={() => setStatus('confirmed')}>更新</button></MemoryRouter>;
  }
  render(<View />);
  expect(screen.getByText('予約の状態を確認できません')).toBeTruthy();
  expect(screen.queryByText('リクエストを受け付けました')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  expect(screen.getByText('予約が確定しました')).toBeTruthy();
});
it('不正な日時は確認不能と表示し、更新後は予約日時を示す', () => {
  function View() {
    const [value, setValue] = useState({ date: 'invalid', start: '10:00' });
    return <MemoryRouter><Done menuName="相談" slot={value} status="confirmed" /><button onClick={() => setValue(slot)}>更新</button></MemoryRouter>;
  }
  render(<View />);
  expect(screen.getByText('予約日時を確認できません')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  expect(screen.getByText(/10月20日.*10:00/)).toBeTruthy();
});
