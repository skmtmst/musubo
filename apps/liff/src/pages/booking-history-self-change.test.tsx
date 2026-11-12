// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BookingHistory from './booking-history.js';
import type { BookingHistoryItem } from '../lib/api.js';

/**
 * 予約の履歴：カードの「日時を変える」「キャンセル」。
 * - 履歴の口が版（lock_version）を返した予約にだけ出す（無いと送れない）
 * - キャンセルは確認してから、版を添えて送り、一覧を読み直す
 * - 日時を変えるは空きから選び、選んだ日時（UTC）と版を添えて送る
 * - 期限切れは人の言葉で出す
 */

vi.mock('../lib/api.js', () => ({
  api: { customerLook: vi.fn().mockResolvedValue({success:true,data:{settings:{liff_theme:"line"}}}),
    me: vi.fn(),
    cancelMyBooking: vi.fn(),
    cancellationQuote: vi.fn(),
    rescheduleMyBooking: vi.fn(),
    availability: vi.fn(),
    liffConfig: vi.fn().mockResolvedValue({ success: true, data: {} }),
    bookingSettings: vi.fn().mockResolvedValue({ liff_date_view: 'list', booking_window_days: 60 }),
  },
}));

vi.mock('../lib/user-message.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/user-message.js')>();
  return { ...actual, logFailure: vi.fn() };
});

const { api } = await import('../lib/api.js');
const me = vi.mocked(api.me);
const cancelMyBooking = vi.mocked(api.cancelMyBooking);
const rescheduleMyBooking = vi.mocked(api.rescheduleMyBooking);
const availability = vi.mocked(api.availability);

function item(over: Partial<BookingHistoryItem> = {}): BookingHistoryItem {
  return {
    id: 'bk-1',
    starts_at: '2099-10-02T04:00:00.000Z',
    status: 'confirmed',
    menu_name: 'トリミング（小型犬）',
    staff_name: '見本',
    profile_image_url: null,
    lock_version: 4,
    menu_id: 'menu-1',
    staff_id: 'staff-1',
    ...over,
  };
}

function setup(upcoming: BookingHistoryItem[]) {
  me.mockResolvedValue({ upcoming, past: [] });
  render(
    <MemoryRouter initialEntries={['/booking/history?liffId=test']}>
      <BookingHistory />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  me.mockReset();
  cancelMyBooking.mockReset();
  rescheduleMyBooking.mockReset();
  availability.mockReset();
  vi.mocked(api.cancellationQuote).mockReset();
});
afterEach(() => cleanup());

it.each(['version_conflict','not_editable','booking_not_found'])('取消の%sでは窓を閉じて一覧を読み直し、古い版で送り直さない',async code=>{
 cancelMyBooking.mockRejectedValueOnce({body:{error:code}});
 setup([item()]);fireEvent.click(await screen.findByRole('button',{name:'キャンセル'}));
 me.mockResolvedValue({upcoming:[],past:[]});fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'キャンセルする'}));
 await vi.waitFor(()=>expect(screen.queryByRole('alertdialog')).toBeNull());
 await vi.waitFor(()=>expect(me).toHaveBeenCalledTimes(2));expect(cancelMyBooking).toHaveBeenCalledTimes(1);expect(api.cancellationQuote).not.toHaveBeenCalled();
});

it('取消料の変更後も窓と予約を残し、最新金額への同意を取り直して送る',async()=>{
 const quote={feeNow:4200,feeNoShow:8400,freeUntil:'2099-10-01T04:00:00Z',text:'決まり',policyAcceptedRequired:true,canCancel:true,lockVersion:4,cancelDeadlineAt:'2099-10-02T04:00:00.000Z'};
 vi.mocked(api.cancellationQuote).mockResolvedValueOnce(quote).mockResolvedValue({...quote,feeNow:8400});
 cancelMyBooking.mockRejectedValueOnce({body:{error:'cancellation_fee_confirmation_required'}}).mockResolvedValue({status:'cancelled',lock_version:5,calendar_sync:'not_applicable',meet_sync:'not_applicable'});
 setup([item({cancellationQuote:quote,cancel_deadline_at:quote.cancelDeadlineAt})]);
 fireEvent.click(await screen.findByRole('button',{name:'キャンセル'}));await screen.findByText('今取り消すとキャンセル料 ¥4,200 が掛かります');
 fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'キャンセルする'}));
 await screen.findByText('今取り消すとキャンセル料 ¥8,400 が掛かります');expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
 expect(cancelMyBooking).toHaveBeenLastCalledWith('bk-1',4,{feeAccepted:true,expectedFeeAmount:4200});
 expect(screen.getByRole('alertdialog').textContent).toContain('最新の金額を確認して、もう一度同意してください');
 fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button',{name:'キャンセルする'}));
 await vi.waitFor(()=>expect(cancelMyBooking).toHaveBeenLastCalledWith('bk-1',4,{feeAccepted:true,expectedFeeAmount:8400}));
});

describe('予約の履歴：本人の日時変更・キャンセル（F-6）', () => {
  it('版を返さない予約には「日時を変える」「キャンセル」を出さず、トークでの連絡を案内する', async () => {
    setup([item({ lock_version: undefined })]);
    await screen.findByText('トリミング（小型犬）');
    expect(screen.queryByRole('button', { name: 'キャンセル' })).toBeNull();
    expect(screen.queryByRole('button', { name: '日時を変える' })).toBeNull();
    expect(screen.getByText('予定の変更・キャンセルは、ご利用先に LINE でご連絡ください。')).toBeTruthy();
  });

  it('キャンセルは確認してから版を添えて送り、一覧を読み直す', async () => {
    cancelMyBooking.mockResolvedValue({ lock_version: 5, status: 'cancelled', calendar_sync: 'not_applicable', meet_sync: 'not_applicable' });
    setup([item()]);
    fireEvent.click(await screen.findByRole('button', { name: 'キャンセル' }));
    expect(await screen.findByText(/トリミング（小型犬）をキャンセルしますか/)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'キャンセルする' }));
    await vi.waitFor(() => expect(cancelMyBooking).toHaveBeenCalledWith('bk-1', 4));
    await vi.waitFor(() => expect(me).toHaveBeenCalledTimes(2));
  });

  it('期限を過ぎたキャンセルは、人の言葉で出す', async () => {
    cancelMyBooking.mockRejectedValue(Object.assign(new Error('API 403'), { status: 403, body: { error: 'self_deadline_passed' } }));
    setup([item()]);
    fireEvent.click(await screen.findByRole('button', { name: 'キャンセル' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'キャンセルする' }));
    expect(await screen.findByText('キャンセルの期限を過ぎています。トークでご連絡ください。')).toBeTruthy();
  });

  it('日時を変えるは空きから選び、選んだ日時（UTC）と版を添えて送る', async () => {
    availability.mockResolvedValue({
      by_staff: [{
        staff_id: 'staff-1',
        display_name: '見本',
        slots: [
          { date: '2099-10-05', start: '10:00', end: '11:00', remaining: 0 },
          { date: '2099-10-06', start: '14:00', end: '15:00', remaining: 2 },
        ],
      }],
    });
    rescheduleMyBooking.mockResolvedValue({ lock_version: 5, status: 'confirmed', calendar_sync: 'not_applicable', meet_sync: 'not_applicable' });
    setup([item()]);
    fireEvent.click(await screen.findByRole('button', { name: '日時を変える' }));
    await vi.waitFor(() => expect(availability).toHaveBeenCalled());
    expect(availability.mock.calls[0][0]).toBe('menu-1');
    expect(availability.mock.calls[0][1]).toBe('staff-1');
    // 埋まった枠は並べない。
    expect(screen.queryByText(/10\/5/)).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /10\/6（火） 14:00/ }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '日時を変える' }));
    await vi.waitFor(() =>
      expect(rescheduleMyBooking).toHaveBeenCalledWith('bk-1', { starts_at: '2099-10-06T05:00:00.000Z', lock_version: 4 }),
    );
  });
});

it('店の期限を過ぎた予約は期限を表示してキャンセルと日時変更を隠す', async () => {
  setup([item({ cancel_deadline_at: '2020-01-01T00:00:00Z' })]);
  await screen.findByText('トリミング（小型犬）');
  expect(screen.getByText(/キャンセル期限：/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'キャンセル' })).toBeNull();
  expect(screen.queryByRole('button', { name: '日時を変える' })).toBeNull();
});

it('確認窓を開いた後に期限を過ぎたら送信を止め、理由を窓の中に出す', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2099-10-01T00:00:00Z'));
  try {
    setup([item({ cancel_deadline_at: '2099-10-01T00:00:01Z' })]);
    fireEvent.click(await screen.findByRole('button', { name: 'キャンセル' }));
    clock.mockReturnValue(Date.parse('2099-10-01T00:00:02Z'));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'キャンセルする' }));
    expect(cancelMyBooking).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('キャンセルの期限を過ぎています');
  } finally { clock.mockRestore(); }
});


it.each(['cancelled', 'completed', 'expired', 'rejected', 'no_show'])('SELL-05: %s の予約は版があっても本人操作を出さない', async (status) => {
  setup([item({ status })]);
  await screen.findByText('トリミング（小型犬）');
  expect(screen.queryByRole('button', { name: 'キャンセル' })).toBeNull();
  expect(screen.queryByRole('button', { name: '日時を変える' })).toBeNull();
});
it.each([{ starts_at: '2020-01-01T00:00:00Z' }, { cancel_deadline_at: 'invalid' }])('SELL-05: 開始後・期限不明は安全側で連絡を案内する', async (over) => {
  setup([item(over)]);
  await screen.findByText('トリミング（小型犬）');
  expect(screen.queryByRole('button', { name: 'キャンセル' })).toBeNull();
  expect(screen.queryByRole('button', { name: '日時を変える' })).toBeNull();
});
it('SELL-05: 本人操作があるときは、この画面で変更・取消できると案内する', async () => {
  setup([item()]);
  expect(await screen.findByText(/期限内の予約は、各予約のボタンから日時の変更・キャンセルができます/)).toBeTruthy();
});
it('別人等で拒否された取消は、成功や一覧の削除にしない', async () => {
  cancelMyBooking.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
  setup([item()]);
  fireEvent.click(await screen.findByRole('button', { name: 'キャンセル' }));
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'キャンセルする' }));
  expect(await screen.findByText(/キャンセルできませんでした/)).toBeTruthy();
  expect(me).toHaveBeenCalledTimes(1);
  expect(screen.getByText('トリミング（小型犬）')).toBeTruthy();
});
