// @vitest-environment happy-dom
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useUrlStep } from './use-url-step.js';

afterEach(cleanup);
function Steps() {
  const [search, setSearch] = useState('step=menu');
  const [step, setStep] = useUrlStep<'menu' | 'staff'>('menu', { search, write: query => setSearch(query.toString()) });
  return <><p>{`現在：${step}`}</p><button onClick={() => setStep('staff')}>次へ</button>
    <button onClick={() => setSearch('')}>入口へ戻る</button><button onClick={() => setSearch('step=unknown')}>不明な手順へ</button></>;
}
it('指定のない入口へ移動したら最初の手順へ戻る', () => {
  render(<Steps />);
  fireEvent.click(screen.getByRole('button', { name: '次へ' }));
  expect(screen.getByText('現在：staff')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '入口へ戻る' }));
  expect(screen.getByText('現在：menu')).toBeTruthy();
});
it('同じ手順へ続けて進んでも履歴を重ねない', () => {
  const write = vi.fn();
  function Subject() {
    const [, setStep] = useUrlStep<'menu' | 'staff'>('menu', { search: 'step=menu', write });
    return <button onClick={() => setStep('staff')}>次へ</button>;
  }
  render(<Subject />);
  const button = screen.getByRole('button', { name: '次へ' });
  act(() => { fireEvent.click(button); fireEvent.click(button); });
  expect(write).toHaveBeenCalledTimes(1);
});
