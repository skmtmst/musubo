// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { defaultRestaurantReservationForm } from '@line-crm/shared';
import SeatConfirm from './seat-confirm.js';
afterEach(cleanup);
function props(overrides: Partial<ComponentProps<typeof SeatConfirm>> = {}): ComponentProps<typeof SeatConfirm> {
  return { timeZone:'Asia/Tokyo',storeName:'然 - NEN - 本店',customerName:'予約する方',startsAt:'2099-11-02T10:00:00Z',endsAt:'2099-11-02T12:00:00Z',guestCount:2,cancelDeadlineMinutesBefore:120,seat:'テーブル席',late:'遅れる時はLINEで連絡してください',note:'',phone:'',onNote:vi.fn(),onPhone:vi.fn(),holdExpiresAt:null,holdMinutes:10,reschedule:false,error:null,onBack:vi.fn(),onExpired:vi.fn(),...overrides };
}
function definition(required:boolean) {const form=defaultRestaurantReservationForm();form.fields=form.fields.map(f=>f.id==='phone'?{...f,required}:f);return form;}
describe('最終確認の対象店',()=>{
  it.each([{reschedule:false,required:false},{reschedule:false,required:true},{reschedule:true,required:false},{reschedule:true,required:true}])('店と予約を1つの表で表示する（%j）',scenario=>{
    const view=render(<SeatConfirm {...props({reschedule:scenario.reschedule,definition:definition(scenario.required)})} />);
    expect(screen.getByRole('heading',{name:'内容を確かめてください'})).toBeTruthy();
    const table=view.container.querySelector<HTMLElement>('[data-liff-card]')!;
    expect(within(table).getByText('然 - NEN - 本店')).toBeTruthy();
    expect(table.textContent).toContain('2名');expect(table.textContent).toContain('席のみ');
    expect(view.container.querySelectorAll('[data-liff-card]')).toHaveLength(1);
    if (!scenario.reschedule) expect(screen.getByRole('textbox',{name:/お名前/})).toBeTruthy();
  });
  it('受け取った対象店名が変われば表へ反映する',()=>{const view=render(<SeatConfirm {...props()} />);view.rerender(<SeatConfirm {...props({storeName:'然 - NEN - 海辺店'})} />);expect(screen.getByText('然 - NEN - 海辺店')).toBeTruthy();expect(screen.queryByText('然 - NEN - 本店')).toBeNull();});
  it.each(['','   '])('店名が空なら別の名前や空の行を作らない（%s）',storeName=>{const view=render(<SeatConfirm {...props({storeName})} />);expect(view.container.querySelector('[data-liff-card]')?.textContent).not.toContain('お店');});
});
