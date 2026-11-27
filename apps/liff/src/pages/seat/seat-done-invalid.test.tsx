// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import type { RestaurantCustomerBooking } from '@line-crm/shared';
import SeatDone from './seat-done.js';

const booking = { id: 'b', startsAt: '2099-10-20T01:00:00Z', guestCount: 2, status: 'confirmed' } as RestaurantCustomerBooking;
afterEach(cleanup);
it.each([
  ['知らない状態', { ...booking, status: 'unknown' }],
  ['不正な日時', { ...booking, startsAt: 'invalid' }],
])('%sなら受付の成功を表示せず確認を案内する', (_kind, value) => {
  render(<SeatDone booking={value} storeName="お店" timeZone="Asia/Tokyo" cancelDeadlineMinutesBefore={60} changed={false} />);
  expect(screen.getByText('予約の状態を確認してください')).toBeTruthy();
  expect(screen.queryByText('ご予約を受け付けました')).toBeNull();
});
