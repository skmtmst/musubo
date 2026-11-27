// @vitest-environment happy-dom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { VisitStampCard, VisitStampWallet } from '@line-crm/shared';
import { StampQrCard } from './stamp-qr-result.js';

afterEach(cleanup);
const card = { name: '来店カード', settings: { slotCount: 5, rewards: [] } } as unknown as VisitStampCard;
const wallet = { balance: 2 } as VisitStampWallet;
it('マス数が不正な場合は確認不能とし、更新後は正しい数を表示する', () => {
  function View() {
    const [value, setValue] = useState<VisitStampCard>({ ...card, settings: { ...card.settings, slotCount: -1 } });
    return <><StampQrCard card={value} wallet={wallet} /><button onClick={() => setValue(card)}>更新</button></>;
  }
  render(<View />);
  expect(screen.getByText(/スタンプの数を確認できません/)).toBeTruthy();
  expect(screen.queryByRole('list')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  expect(screen.getByRole('list', { name: '5個中 2個たまっています' })).toBeTruthy();
});
it('残高が不正な場合は確認不能とし、更新後は正しい数を表示する', () => {
  function View() {
    const [value, setValue] = useState({ ...wallet, balance: -1 });
    return <><StampQrCard card={card} wallet={value} /><button onClick={() => setValue(wallet)}>更新</button></>;
  }
  render(<View />);
  expect(screen.getByText(/スタンプの数を確認できません/)).toBeTruthy();
  expect(screen.queryByRole('list')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  expect(screen.getByRole('list', { name: '5個中 2個たまっています' })).toBeTruthy();
});
