// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { defaultRestaurantReservationForm,type RestaurantCustomerBooking,type RestaurantCustomerSlot } from '@line-crm/shared';

/**
 * 席の予約の動き。
 * - ① で時刻を選ぶと仮押さえ (店・時刻・人数・受付番号) → ② で返った版を指定して確定 → ③
 * - 届いたか分からない失敗の再試行は同じ受付番号、断られたら新しい番号
 * - 仮押さえの期限切れは確定できない
 * - リンクが無いときは案内を出す
 */

vi.mock('@line/liff', () => ({
  default: { getProfile: vi.fn().mockResolvedValue({ displayName: '見本 143' }), closeWindow: vi.fn() },
}));
vi.mock('../../lib/api.js', () => ({
  api: { customerLook: vi.fn().mockResolvedValue({success:true,data:{settings:{liff_theme:"line"}}}),
    liffConfig: vi.fn().mockResolvedValue({ success: true, data: { accountName: '然 - NEN -' } }),
    bookingSettings: vi.fn().mockResolvedValue({}),
    seatWaitlists: vi.fn().mockResolvedValue({ waitlist: [] }),
    registerSeatWaitlist: vi.fn().mockResolvedValue({ id: "waiting-seat" }),
    cancelSeatWaitlist: vi.fn().mockResolvedValue({ status: "cancelled" }),
  },
  restaurantBookingApi: {
    link: vi.fn(),
    courses: vi.fn().mockResolvedValue({success:true,data:[]}),
    referrals: vi.fn().mockResolvedValue({success:true,data:[]}),
    referral: vi.fn(),
    availability: vi.fn(),
    hold: vi.fn(),
    mine: vi.fn(),
    confirm: vi.fn(),
    cancel: vi.fn(),
    reschedule: vi.fn(),
  },
}));
vi.mock('../../lib/user-message.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/user-message.js')>();
  return { ...actual, logFailure: vi.fn() };
});

const { restaurantBookingApi: seat, api } = await import('../../lib/api.js');
const { default: SeatReserve } = await import('./seat-reserve.js');

function slots(date: string): RestaurantCustomerSlot[] {
  return ['18:00', '19:00', '19:30'].map((hm) => {
    const startsAt = new Date(`${date}T${hm}:00+09:00`).toISOString();
    return {
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + 7200000).toISOString(),
      available: hm !== '19:30',
      remainingTables: hm === '19:30' ? 0 : 3,
      seatTypes: ['table'],
    };
  });
}
function held(over: Partial<RestaurantCustomerBooking> = {}): RestaurantCustomerBooking {
  return {
    id: 'r1',
    storeId: 'st',
    startsAt: new Date('2026-10-07T19:00:00+09:00').toISOString(),
    endsAt: new Date('2026-10-07T21:00:00+09:00').toISOString(),
    guestCount: 2,
    status: 'pending',
    version: 3,
    holdExpiresAt: new Date(Date.now() + 600000).toISOString(),
    note: null,
    customerPhone: null,
    seatType: 'table',
    ...over,
  };
}
function err(status: number, error: string) {
  return Object.assign(new Error(`API ${status}`), { status, body: { success: false, error } });
}

function open(entry = '/restaurant/reserve/tok') {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/restaurant/reserve/:token" element={<SeatReserve />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-07T00:00:00Z'));
  vi.mocked(seat.link).mockResolvedValue({ success: true, data: { id: 'st', name: '然 - NEN - 本店', timezone: 'Asia/Tokyo' } });
  vi.mocked(seat.availability).mockImplementation(async (_s, date, guestCount) => ({
    success: true,
    data: { storeId: 'st', date, guestCount, slots: slots(date), cancelDeadlineMinutesBefore: 120, cutoffMinutesBefore: 60 },
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('席の予約の流れ', () => {
  it('時刻を選ぶと仮押さえし、返った版で確定して受け付けましたへ進む', async () => {
    vi.mocked(seat.hold).mockResolvedValue({ success: true, data: held() });
    vi.mocked(seat.confirm).mockResolvedValue({ success: true, data: held({ status: 'confirmed', version: 4, holdExpiresAt: null }) });
    open();
    fireEvent.click(await screen.findByRole('radio', { name: '19:00 空きあり' }));
    expect(screen.getByRole('radio', { name: '19:30 満席' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'この時刻で進む' }));
    await screen.findByText('ご予約の内容');
    expect(screen.getByText('コース：席のみ（2時間）')).toBeTruthy();
    const body = vi.mocked(seat.hold).mock.calls[0]![0];
    expect(body).toMatchObject({ storeId: 'st', startsAt: new Date('2026-10-07T19:00:00+09:00').toISOString(), guestCount: 2 });
    expect(body.requestId).toMatch(/^[a-zA-Z0-9_-]{8,128}$/);
    expect(screen.getByRole('textbox',{name:/お名前/})).toHaveProperty('value','見本 143');
    expect(screen.getByRole('timer').textContent).toContain('10分 お取りしています');
    fireEvent.click(screen.getByRole('button', { name: '予約を確定する' }));
    await screen.findByText('ご予約を受け付けました');
    expect(seat.confirm).toHaveBeenCalledWith('r1', 3, { note: null, customerPhone: null,customerName:'見本 143',allergyNote:null,expectedFormVersion:0 });
    expect(screen.getByText('確定')).toBeTruthy();
    expect(screen.getByText('2名')).toBeTruthy();
    expect(screen.getByText('然 - NEN - 本店')).toBeTruthy();
    expect(screen.queryByText('お席')).toBeNull();
    expect(screen.queryByText('コース')).toBeNull();
  });

  it('ご要望と電話（任意）を入れて確定の口へ送る。お席・遅れたときの決まり・休みの理由を出す', async () => {
    vi.mocked(seat.availability).mockImplementation(async (_s, date, guestCount) => ({
      success: true,
      data: date === '2026-10-09'
        ? { storeId: 'st', date, guestCount, slots: [], unavailableReason: 'temporary_closed' as const, cancelDeadlineMinutesBefore: 120, cutoffMinutesBefore: 60 }
        : { storeId: 'st', date, guestCount, slots: slots(date), cancelDeadlineMinutesBefore: 120, cutoffMinutesBefore: 60,
          lateArrivalPolicy: { cancelAfterMinutes: 15, message: '15分を過ぎてご連絡がない場合は、取り消しになることがあります' } },
    }));
    vi.mocked(seat.hold).mockResolvedValue({ success: true, data: held() });
    vi.mocked(seat.confirm).mockResolvedValue({ success: true, data: held({ status: 'confirmed', version: 4, holdExpiresAt: null, note: '記念日です', courseName: '記念日のコース' }) });
    open();
    expect(await screen.findByText('10/9（金）は臨時休業のため選べません')).toBeTruthy();
    fireEvent.click(await screen.findByRole('radio', { name: '19:00 空きあり' }));
    fireEvent.click(screen.getByRole('button', { name: 'この時刻で進む' }));
    await screen.findByText('ご予約の内容');
    expect(screen.getByText('テーブル席（お店で決めます）')).toBeTruthy();
    expect(screen.getByText('・15分を過ぎてご連絡がない場合は、取り消しになることがあります')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/ご要望/), { target: { value: '記念日です' } });
    fireEvent.change(screen.getByLabelText('電話番号'), { target: { value: '090ー0000ー2222' } });
    expect(screen.getAllByText('任意')).toHaveLength(3);
    expect(screen.queryByText('ご要望（任意）')).toBeNull();
    expect(screen.getByText('5/200文字')).toBeTruthy();
    expect(screen.getByText('13/50文字')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '予約を確定する' }));
    await screen.findByText('ご予約を受け付けました');
    expect(seat.confirm).toHaveBeenCalledWith('r1', 3, { note: '記念日です', customerPhone: '09000002222',customerName:'見本 143',allergyNote:null,expectedFormVersion:0 });
    expect(screen.getByText('記念日のコース')).toBeTruthy();
    expect(screen.queryByText('お席')).toBeNull();
  });

  it('電話の形が違うときは送らずに理由を出す', async () => {
    vi.mocked(seat.hold).mockResolvedValue({ success: true, data: held() });
    open();
    fireEvent.click(await screen.findByRole('radio', { name: '19:00 空きあり' }));
    fireEvent.click(screen.getByRole('button', { name: 'この時刻で進む' }));
    await screen.findByText('ご予約の内容');
    fireEvent.change(screen.getByLabelText('電話番号'), { target: { value: 'でんわ' } });
    fireEvent.click(screen.getByRole('button', { name: '予約を確定する' }));
    expect(await screen.findByText('電話番号は0から始まる10〜11桁の数字で入れてください。')).toBeTruthy();
    expect(seat.confirm).not.toHaveBeenCalled();
  });

  it('届いたか分からない失敗の再試行は同じ受付番号、断られたら新しい番号', async () => {
    vi.mocked(seat.hold)
      .mockRejectedValueOnce(err(500, 'booking_failed'))
      .mockRejectedValueOnce(err(409, 'slot_conflict'));
    open();
    fireEvent.click(await screen.findByRole('radio', { name: '19:00 空きあり' }));
    fireEvent.click(screen.getByRole('button', { name: 'この時刻で進む' }));
    await screen.findByText(/送信できませんでした/);
    fireEvent.click(screen.getByRole('button', { name: 'この時刻で進む' }));
    await screen.findByText(/ほかの方の予約で埋まりました/);
    const ids = vi.mocked(seat.hold).mock.calls.map((c) => c[0].requestId);
    expect(ids[0]).toBe(ids[1]);
    vi.mocked(seat.hold).mockResolvedValueOnce({ success: true, data: held() });
    fireEvent.click(await screen.findByRole('radio', { name: '18:00 空きあり' }));
    fireEvent.click(screen.getByRole('button', { name: 'この時刻で進む' }));
    await screen.findByText('ご予約の内容');
    expect(vi.mocked(seat.hold).mock.calls[2]![0].requestId).not.toBe(ids[1]);
  });

  it('仮押さえが切れたら確定のボタンを押せない', async () => {
    vi.mocked(seat.hold).mockResolvedValue({ success: true, data: held() });
    vi.mocked(seat.confirm).mockRejectedValue(err(409, 'hold_expired'));
    open();
    fireEvent.click(await screen.findByRole('radio', { name: '19:00 空きあり' }));
    fireEvent.click(screen.getByRole('button', { name: 'この時刻で進む' }));
    fireEvent.click(await screen.findByRole('button', { name: '予約を確定する' }));
    await screen.findAllByText(/お取りしていた時間が過ぎました/);
    expect(screen.getByRole('button', { name: '予約を確定する' })).toHaveProperty('disabled', true);
  });

  it('予約のリンクが無いときは案内を出す', async () => {
    vi.mocked(seat.link).mockRejectedValue(err(404, 'not_found'));
    open();
    await screen.findByText('予約のページが見つかりません');
  });

  it('仮押さえの送信中に時刻を押しても選び直さず、確認は仮押さえした時刻で出す（監査 L6）', async () => {
    let resolveHold: (v: { success: true; data: RestaurantCustomerBooking }) => void = () => {};
    vi.mocked(seat.hold).mockImplementation(() => new Promise((r) => { resolveHold = r; }));
    vi.mocked(seat.confirm).mockResolvedValue({ success: true, data: held({ status: 'confirmed', version: 4, holdExpiresAt: null }) });
    open();
    fireEvent.click(await screen.findByRole('radio', { name: '19:00 空きあり' }));
    fireEvent.click(screen.getByRole('button', { name: 'この時刻で進む' }));
    await screen.findByRole('button', { name: 'お取りしています…' });
    // 送信中に別の時刻を押す。
    fireEvent.click(screen.getByRole('radio', { name: '18:00 空きあり' }));
    expect(screen.getByRole('radio', { name: '19:00 空きあり' }).getAttribute('aria-checked')).toBe('true');
    resolveHold({ success: true, data: held() });
    await screen.findByText('ご予約の内容');
    expect(screen.queryByText(/18:00/)).toBeNull();
    expect(screen.getAllByText(/19:00/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '予約を確定する' }));
    await screen.findByText('ご予約を受け付けました');
    expect(seat.confirm).toHaveBeenCalledWith('r1', 3, { note: null, customerPhone: null,customerName:'見本 143',allergyNote:null,expectedFormVersion:0 });
  });
});

it('XL-01: 席予約の確定中に戻ると古い成功で完了画面へ進まない', async () => {
  vi.mocked(seat.hold).mockResolvedValue({success:true,data:held()});
  let resolve!: (value: {success:true;data:RestaurantCustomerBooking})=>void;
  const pending=new Promise<{success:true;data:RestaurantCustomerBooking}>(r=>{resolve=r;});
  vi.mocked(seat.confirm).mockReturnValue(pending);
  vi.mocked(seat.cancel).mockResolvedValue({success:true,data:held({status:'cancelled'})});
  open();
  fireEvent.click(await screen.findByRole('radio',{name:'19:00 空きあり'}));
  fireEvent.click(screen.getByRole('button',{name:'この時刻で進む'}));
  await screen.findByText('ご予約の内容');
  fireEvent.click(screen.getByRole('button',{name:'予約を確定する'}));
  fireEvent.click(screen.getByRole('button',{name:/時刻を選び直す/}));
  await screen.findByRole('radio',{name:'19:00 空きあり'});
  await act(async()=>{resolve({success:true,data:held({status:'confirmed',holdExpiresAt:null,version:4})});await pending;});
  expect(screen.queryByText('ご予約を受け付けました')).toBeNull();
  expect(screen.getByRole('button',{name:'この時刻で進む'})).toBeTruthy();
});

// 現役 worker の restaurant/main も同じ SeatReserve を読む。
it('E3: 満席の時刻から人数・店を保って待ちに入り、取り消せる', async () => {
  open();
  fireEvent.click(await screen.findByRole('button', { name: '19:30 空いたら知らせる' }));
  fireEvent.click(await screen.findByRole('button', { name: '空いたら知らせる' }));
  await screen.findByText('登録しました。空いたらLINEで知らせます。');
  expect(api.registerSeatWaitlist).toHaveBeenCalledWith({ store_id: 'st', guest_count: 2, starts_at: '2026-10-07T10:30:00.000Z' });
  fireEvent.click(screen.getByRole('button', { name: '取り消す' }));
  await screen.findByText('取り消しました。');
  expect(api.cancelSeatWaitlist).toHaveBeenCalledWith('waiting-seat');
});
it('E3: 休業・貸切・開始1時間前の時刻には席の待ちの入口を出さない', async () => {
  vi.mocked(seat.availability).mockImplementation(async (_s, date, guestCount) => ({ success: true, data: { storeId: 'st', date, guestCount, slots: [
    { ...slots(date)[2]!, unavailableReason: 'private_event' },
    { ...slots(date)[2]!, startsAt: '2026-10-07T00:30:00Z' },
  ], cancelDeadlineMinutesBefore: 120, cutoffMinutesBefore: 60 } }));
  open(); await screen.findByRole('radio', { name: '19:30 貸切' });
  expect(screen.queryByRole('button', { name: /空いたら知らせる/ })).toBeNull();
});
it('押せない「次へ」には理由の1行を出し、時刻を選んだら消す', async () => {
  open();
  await screen.findByRole('radio', { name: '19:00 空きあり' });
  expect(screen.getByRole('button', { name: 'この時刻で進む' })).toHaveProperty('disabled', true);
  expect(screen.getByText('時刻を選んでください')).toBeTruthy();
  fireEvent.click(screen.getByRole('radio', { name: '19:00 空きあり' }));
  await screen.findByRole('radio', { name: '19:00 空きあり' });
  expect(screen.getByRole('button', { name: 'この時刻で進む' })).toHaveProperty('disabled', false);
  expect(screen.queryByText('時刻を選んでください')).toBeNull();
});
it('空きが無い日は「ほかの日を選んでください」の1行を出す', async () => {
  vi.mocked(seat.availability).mockImplementation(async (_s, date, guestCount) => ({
    success: true, data: { storeId: 'st', date, guestCount, slots: slots(date).map((s) => ({ ...s, available: false, remainingTables: 0 })), cancelDeadlineMinutesBefore: 120, cutoffMinutesBefore: 60 },
  }));
  open();
  await screen.findByRole('radio', { name: '19:00 満席' });
  expect(screen.getByRole('button', { name: 'この時刻で進む' })).toHaveProperty('disabled', true);
  expect(screen.getByText('空いている時刻がありません。ほかの日を選んでください')).toBeTruthy();
});

it('店の必須項目と完了文を使い、入力した名前とアレルギーを同じフォームの版で確定する',async()=>{
 const definition=defaultRestaurantReservationForm();definition.title='お席の受付';definition.completionMessage='ご来店をお待ちしています';
 definition.fields=definition.fields.map(field=>field.id==='allergy'?{...field,label:'食べられない物',required:true}:field.id==='phone'?{...field,enabled:false}:field);
 vi.mocked(seat.link).mockResolvedValue({success:true,data:{id:'st',name:'食堂',timezone:'Asia/Tokyo',reservationForm:{version:8,definition}}});
 vi.mocked(seat.hold).mockResolvedValue({success:true,data:held()});vi.mocked(seat.confirm).mockResolvedValue({success:true,data:held({status:'confirmed',version:4})});
 open();fireEvent.click(await screen.findByRole('radio',{name:'19:00 空きあり'}));fireEvent.click(screen.getByRole('button',{name:'この時刻で進む'}));await screen.findByText('ご予約の内容');
 expect(screen.queryByLabelText(/電話番号/)).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'予約を確定する'}));expect(await screen.findByText('食べられない物を入れてください')).toBeTruthy();expect(seat.confirm).not.toHaveBeenCalled();
 fireEvent.change(screen.getByRole('textbox',{name:/お名前/}),{target:{value:'予約する方'}});fireEvent.change(screen.getByRole('textbox',{name:/食べられない物/}),{target:{value:'乳製品'}});
 fireEvent.click(screen.getByRole('button',{name:'予約を確定する'}));await screen.findByText('ご来店をお待ちしています');
 expect(seat.confirm).toHaveBeenCalledWith('r1',3,expect.objectContaining({expectedFormVersion:8,customerName:'予約する方',allergyNote:'乳製品'}));
});
it('フォームが途中で変わったら読み直し、仮押さえと入力を保って新しい版でやり直す',async()=>{
 const definition=defaultRestaurantReservationForm();
 vi.mocked(seat.link).mockResolvedValue({success:true,data:{id:'st',name:'食堂',timezone:'Asia/Tokyo',reservationForm:{version:1,definition}}});
 vi.mocked(seat.hold).mockResolvedValue({success:true,data:held()});
 vi.mocked(seat.confirm).mockRejectedValueOnce(err(409,'reservation_form_changed')).mockResolvedValue({success:true,data:held({status:'confirmed',version:4})});
 open();fireEvent.click(await screen.findByRole('radio',{name:'19:00 空きあり'}));fireEvent.click(screen.getByRole('button',{name:'この時刻で進む'}));await screen.findByText('ご予約の内容');
 fireEvent.change(screen.getByRole('textbox',{name:/お名前/}),{target:{value:'予約する方'}});
 vi.mocked(seat.link).mockResolvedValue({success:true,data:{id:'st',name:'食堂',timezone:'Asia/Tokyo',reservationForm:{version:2,definition}}});
 fireEvent.click(screen.getByRole('button',{name:'予約を確定する'}));await screen.findByText('予約フォームが更新されました。項目を確認して、もう一度予約してください');
 expect(screen.getByRole('textbox',{name:/お名前/})).toHaveProperty('value','予約する方');expect(seat.hold).toHaveBeenCalledTimes(1);
 fireEvent.click(screen.getByRole('button',{name:'予約を確定する'}));await screen.findByText('ご予約を受け付けました');
 expect(vi.mocked(seat.confirm).mock.calls[1]).toEqual(['r1',3,expect.objectContaining({expectedFormVersion:2,customerName:'予約する方'})]);
});


it.each([
  { id: 'store-main', name: '然 - NEN - 本店', referralId: null },
  { id: 'store-east', name: '然 - NEN - 東口店', referralId: 'mock-referral' },
])('リンクの対象店 $name を確認カードに残し、同じ仮押さえを確定する', async store => {
  const definition = defaultRestaurantReservationForm();
  vi.mocked(seat.link).mockResolvedValue({ success: true, data: { id: store.id, name: store.name, timezone: 'Asia/Tokyo', reservationForm: { version: 7, definition } } });
  vi.mocked(seat.hold).mockResolvedValue({ success: true, data: held({ storeId: store.id }) });
  vi.mocked(seat.confirm).mockResolvedValue({ success: true, data: held({ storeId: store.id, status: 'confirmed', version: 4, holdExpiresAt: null }) });
  open(`/restaurant/reserve/tok${store.referralId ? `?referralId=${store.referralId}` : ''}`);
  fireEvent.click(await screen.findByRole('radio', { name: '19:00 空きあり' }));
  fireEvent.click(screen.getByRole('button', { name: 'この時刻で進む' }));
  const heading = await screen.findByRole('heading', { name: 'ご予約の内容' });
  const details = heading.closest('[data-design-node]')!.querySelector('details')!;
  expect(details.open).toBe(true);
  details.open = false;
  fireEvent(details, new Event('toggle'));
  expect(heading.closest('[data-liff-card]')?.textContent).toContain(store.name);
  expect(details.textContent).not.toContain(store.name);
  expect(seat.hold).toHaveBeenCalledWith(expect.objectContaining({ storeId: store.id, startsAt: '2026-10-07T10:00:00.000Z', guestCount: 2 }));
  fireEvent.click(screen.getByRole('button', { name: '予約を確定する' }));
  await screen.findByText('ご予約を受け付けました');
  expect(seat.confirm).toHaveBeenCalledWith('r1', 3, { note: null, customerPhone: null, customerName: '見本 143', allergyNote: null, expectedFormVersion: 7, ...(store.referralId ? { referralId: store.referralId } : {}) });
});

it('変更予約もリンクの店名を折り畳み外に出し、仮押さえなしで同じ予約と版を送る', async () => {
  const original = held({ id: 'booking-east', storeId: 'store-east', startsAt: '2026-10-08T10:00:00.000Z', endsAt: '2026-10-08T12:00:00.000Z', status: 'confirmed', version: 9, holdExpiresAt: null });
  vi.mocked(seat.link).mockResolvedValue({ success: true, data: { id: 'store-east', name: '然 - NEN - 東口店', timezone: 'Asia/Tokyo' } });
  vi.mocked(seat.mine).mockResolvedValue({ success: true, data: [original] });
  vi.mocked(seat.reschedule).mockResolvedValue({ success: true, data: { ...original, version: 10 } });
  open('/restaurant/reserve/tok?view=mine');
  fireEvent.click(await screen.findByRole('button', { name: '日時・人数を変える' }));
  fireEvent.click(await screen.findByRole('radio', { name: '19:00 空きあり' }));
  fireEvent.click(screen.getByRole('button', { name: 'この時刻で進む' }));
  const heading = await screen.findByRole('heading', { name: 'この内容に変更します' });
  expect(heading.closest('[data-design-node]')!.querySelector('details')?.open).toBe(false);
  expect(heading.closest('[data-liff-card]')?.textContent).toContain('然 - NEN - 東口店');
  expect(seat.hold).not.toHaveBeenCalled();
  expect(seat.confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'この内容に変える' }));
  await screen.findByText('ご予約を変更しました');
  expect(seat.reschedule).toHaveBeenCalledWith('booking-east', { expectedVersion: 9, startsAt: '2026-10-08T10:00:00.000Z', guestCount: 2, courseId: null });
});
