// @vitest-environment happy-dom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { RestaurantUnavailableReason } from '@line-crm/shared';
import SeatPick from './seat-pick.js';
import SeatConfirm from './seat-confirm.js';
import { seatText } from '../../lib/seat-reserve.js';

afterEach(cleanup);
it('未知の空きなし理由を不明と示し、更新後は理由を表示する', () => {
  function View() {
    const [reason, setReason] = useState<RestaurantUnavailableReason>('unknown' as RestaurantUnavailableReason);
    return <><SeatPick timeZone="Asia/Tokyo" today="2099-10-20" date="2099-10-20" chips={[{ date: '2099-10-20', top: '今日', bottom: '火' }, { date: '2099-10-21', top: '明日', bottom: '水' }]} days={{ '2099-10-20': [], '2099-10-21': 'closed' }} reasons={{ '2099-10-21': reason }} guestCount={2} startsAt={null} error={null} onGuest={() => {}} onDate={() => {}} onTime={() => {}} onRetry={() => {}} /><button onClick={() => setReason('private_event')}>更新</button></>;
  }
  render(<View />);
  expect(screen.getByText(/理由不明のため選べません/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  expect(screen.getByText(/貸切のため選べません/)).toBeTruthy();
});
it('未知の席の種類をそのまま表示せず、更新後は席を表示する', () => {
  function View() {
    const [kind, setKind] = useState('unknown');
    return <><SeatConfirm timeZone="Asia/Tokyo" storeName="お店" customerName="見本" startsAt="2099-10-20T01:00:00Z" endsAt="2099-10-20T02:00:00Z" guestCount={2} cancelDeadlineMinutesBefore={60} seat={seatText(kind)} late="LINEで連絡" note="" phone="" onNote={() => {}} onPhone={() => {}} holdExpiresAt={null} holdMinutes={10} reschedule={false} error={null} onBack={() => {}} onExpired={() => {}} /><button onClick={() => setKind('table')}>更新</button></>;
  }
  render(<View />);
  expect(screen.getByText(/席の種類を確認できません/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '更新' }));
  expect(screen.getByText('テーブル席（お店で決めます）')).toBeTruthy();
});
