// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserRouter } from 'react-router-dom';

const sdk = vi.hoisted(() => ({
  init: vi.fn(async () => {}), isLoggedIn: () => true, login: vi.fn(), logout: vi.fn(),
  getProfile: async () => ({ userId: 'fixture', displayName: '予約の本人' }),
  getIDToken: () => 'fixture-token', getAccessToken: () => 'fixture-access',
  getDecodedIDToken: () => ({ exp: 4102444800 }), getFriendship: async () => ({ friendFlag: true }),
  isInClient: () => true, closeWindow: vi.fn(),
}));
vi.mock('@line/liff', () => ({ default: sdk }));
const writes: Array<{ path: string; body: Record<string, unknown>; headers: Headers }> = [];
let workerSdk: typeof sdk;
let failHold = true, failConfirm = true, failFormBooking = true, peopleForm = false, dynamicCourse = false, failCourseSubmit = false, courseGone = false;
const startsAt = '2026-10-12T09:00:00.000Z';
const booking = (status = 'pending') => ({ id: 'r1', storeId: 'st', startsAt, endsAt: '2026-10-12T10:30:00.000Z', guestCount: 2, status, version: status === 'pending' ? 1 : 2, holdExpiresAt: status === 'pending' ? '2026-10-12T00:10:00Z' : null, seatType: 'table', note: null, customerPhone: null, courseId: 'c90', courseName: '夕食コース' });
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const layout = { version: 2, header: [], sections: [{ id: 's', name: '来店', blocks: [{ id: 'b', kind: 'input', type: 'booking', name: '予約', label: '来店の予約', required: true, booking: { kind: 'seats', storeId: 'st', menuId: '', courseId: 'c90', daysAhead: 14 } }] }], options: { confirmDialog: { enabled: false } } };

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
  writes.length = 0; failHold = failConfirm = failFormBooking = true; peopleForm = dynamicCourse = failCourseSubmit = courseGone = false;
  sdk.closeWindow.mockClear();
  workerSdk = { ...sdk, getProfile: async () => ({ userId: 'fixture', displayName: 'Workerの本人' }), closeWindow: vi.fn() };
  document.body.innerHTML = '<div id="app"></div>'; vi.stubGlobal('liff', workerSdk);
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, options: RequestInit = {}) => {
    const url = new URL(String(input), window.location.origin), path = url.pathname;
    if (options.method && options.method !== 'GET') writes.push({ path, body: JSON.parse(String(options.body ?? '{}')), headers: new Headers(options.headers) });
    if (path === '/api/liff/config') return reply({ success: true, data: { accountName: '予約店' } });
    if (path === '/api/liff/link') return reply({ success: true, data: { userId: 'friend-fixture' } });
    if (path === '/api/liff/customer-look') return reply({ success: true, data: { settings: { liff_theme: 'night', shop_primary_color: '#885522' }, version: 1 } });
    if (path === '/api/liff/booking/settings') return reply({ liff_theme: 'night', shop_primary_color: '#885522' });
    if (path === '/api/liff/restaurant/link/tok') return reply({ success: true, data: { id: 'st', name: '予約店', timezone: 'Asia/Tokyo' } });
    if (path === '/api/liff/restaurant/courses') return reply({ success: true, timezone: 'Asia/Tokyo', data: courseGone ? [] : [{ id: 'c90', name: '夕食コース', durationMinutes: 90, price: 3000, allergens: [] }] });
    if (path === '/api/liff/restaurant/availability') {
      const date = url.searchParams.get('date')!;
      return reply({ success: true, data: { storeId: 'st', date, guestCount: 2, slots: [{ startsAt: new Date(`${date}T18:00:00+09:00`).toISOString(), endsAt: new Date(`${date}T19:30:00+09:00`).toISOString(), available: true, remainingTables: 2, seatTypes: ['table'] }], cancelDeadlineMinutesBefore: 0, cutoffMinutesBefore: 0 } });
    }
    if (path === '/api/liff/restaurant/holds') return failHold ? reply({ error: 'booking_failed' }, 500) : reply({ success: true, data: booking() }, 201);
    if (path === '/api/liff/restaurant/reservations/r1/confirm') return failConfirm ? reply({ error: 'booking_failed' }, 500) : reply({ success: true, data: booking('confirmed') });
    if (path === '/api/forms/f') {
      const formLayout = structuredClone(layout);
      if (dynamicCourse) { delete (formLayout.sections[0].blocks[0].booking as {courseId?:string}).courseId; formLayout.sections[0].blocks.push({id:'name',kind:'input',type:'text',name:'お名前',label:'お名前',required:true} as never); }
      if (peopleForm) Object.assign(formLayout.sections[0].blocks[0].booking, { kind: 'people', menuId: 'm1', staffId: 's1' });
      return reply({ success: true, data: { id: 'f', name: '来店フォーム', fields: [], layout: formLayout, isActive: true } });
    }
    if (path === '/api/forms/f/opened') return reply({ success: true });
    if (path === '/api/forms/f/submit') { if (failCourseSubmit) { failCourseSubmit=false; courseGone=true; return reply({success:false,code:'restaurant_course_unavailable'},409); } return reply({ success: true, data: { complete: true } }); }
    if (path === '/api/liff/restaurant/form-booking') return failFormBooking ? reply({ error: 'slot_conflict' }, 409) : reply({ success: true, data: booking('confirmed') });
    if (path === '/api/liff/booking/menus') return reply({ menus: [{ id: 'm1', name: '個別相談', duration_minutes: 90 }] });
    if (path === '/api/liff/booking/availability') return reply({ by_staff: [{ staff_id: 's1', display_name: '担当', slots: [{ date: '2026-10-12', start: '18:00', end: '19:30', startUtc: startsAt, remaining: 1 }] }] });
    if (path === '/api/liff/booking/requests') return failFormBooking ? reply({ error: 'request_failed' }, 500) : reply({ booking_id: 'p1', status: 'requested' });
    throw new Error(`Unexpected request: ${path}`);
  }));
});
afterEach(async () => {
  const { unmountRestaurant } = await import('./restaurant-entry.js');
  await act(async () => { unmountRestaurant(); }); cleanup(); vi.unstubAllGlobals(); vi.useRealTimers();
});
async function open(entry: 'apps' | 'worker', query: string) {
  window.history.replaceState({}, '', `/?liffId=fixture&${query}`);
  if (entry === 'worker') await act(async () => { await import('../../worker/src/client/main.js'); });
  else {
    const { initLiff } = await import('./lib/liff-auth.js'); await initLiff();
    const { default: App } = await import('./app.js'); render(<BrowserRouter><App /></BrowserRouter>);
  }
}
for (const entry of ['apps', 'worker'] as const) {
  it(`${entry}の実入口からコース・仮押さえ失敗・同じ操作の再送・確定まで届く`, async () => {
    await open(entry, 'page=restaurant&token=tok');
    fireEvent.click(await screen.findByRole('radio', { name: /18:00 (空きあり|残りわずか)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'この時刻で進む' }));
    fireEvent.click(await screen.findByRole('button', { name: /夕食コース/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'コースを選んで進む' })).toHaveProperty('disabled', false));
    fireEvent.click(screen.getByRole('button', { name: 'コースを選んで進む' }));
    await screen.findByText(/送信できませんでした/);
    failHold = false; fireEvent.click(screen.getByRole('button', { name: 'コースを選んで進む' }));
    await screen.findByText('内容を確かめてください');
    const profileName = entry === 'worker' ? 'Workerの本人' : '予約の本人';
    expect(screen.getByRole('textbox', { name: /お名前/ })).toHaveProperty('value', profileName);
    expect(screen.getByRole('textbox', { name: /お名前/ })).toHaveProperty('required', true);
    const calls = writes.filter(w => w.path.endsWith('/holds'));
    expect(calls).toHaveLength(2); expect(calls[0].body).toEqual(calls[1].body);
    expect(calls[0].body).toMatchObject({ courseId: 'c90', guestCount: 2 });
    expect(calls[0].body).not.toHaveProperty('tableId');
    expect(calls[0].headers.get('Authorization')).toBe('Bearer fixture-token');
    expect(document.querySelector('[data-liff-theme="night"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '予約を確定する' }));
    await screen.findByText(/送信できませんでした/);
    failConfirm = false; fireEvent.click(screen.getByRole('button', { name: '予約を確定する' }));
    await screen.findByText('ご予約を受け付けました');
    const confirms = writes.filter(w => w.path.endsWith('/confirm'));
    expect(confirms).toHaveLength(2); expect(confirms[0].body).toEqual(confirms[1].body);
    expect(confirms[0].body).toMatchObject({ customerName: profileName, expectedFormVersion: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'LINEに戻る' }));
    expect((entry === 'worker' ? workerSdk : sdk).closeWindow).toHaveBeenCalledOnce();
  });
  it(`${entry}のフォーム入口から回答保存後に席予約し、席の失敗だけ同じキーで再試行`, async () => {
    await open(entry, 'page=form&id=f');
    fireEvent.click(await screen.findByRole('radio', { name: '18:00' }));
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    await screen.findByText('予約の確保に失敗しました。回答は保存されています。');
    failFormBooking = false; fireEvent.click(screen.getByRole('button', { name: '予約を取り直す' }));
    await screen.findByText(/次回のご予約.*が決まりました/);
    await waitFor(() => expect(writes.filter(w => w.path.endsWith('/form-booking'))).toHaveLength(2));
    const answers = writes.filter(w => w.path.endsWith('/submit'));
    expect(answers).toHaveLength(1);
    expect((answers[0].body.data as Record<string, unknown>)['予約']).toMatchObject({ kind: 'seats', storeId: 'st', courseId: 'c90' });
    const reserves = writes.filter(w => w.path.endsWith('/form-booking'));
    expect(reserves[0].body).toEqual(reserves[1].body);
    expect(reserves[0].body.submissionKey).toBe(answers[0].headers.get('Idempotency-Key'));
    expect(writes.some(w => w.path === '/api/liff/booking/requests')).toBe(false);
  });
  it(`${entry}のフォームで消えたコースを選び直し、ほかの入力を残して送る`, async () => {
    dynamicCourse=true; failCourseSubmit=true; failFormBooking=false;
    await open(entry, 'page=form&id=f');
    fireEvent.change(await screen.findByRole('textbox',{name:/お名前/}),{target:{value:'人工の名前'}});
    fireEvent.click(await screen.findByRole('radio',{name:/夕食コース/}));
    fireEvent.click(await screen.findByRole('radio',{name:'18:00'}));
    fireEvent.click(screen.getByRole('button',{name:'送信する'}));
    await screen.findByText(/メニューを選び直してください/);
    expect(screen.getByRole('textbox',{name:/お名前/})).toHaveProperty('value','人工の名前');
    await waitFor(()=>expect(screen.queryByRole('radio',{name:/夕食コース/})).toBeNull());
    fireEvent.click(screen.getByRole('radio',{name:/席のみ/}));
    fireEvent.click(await screen.findByRole('radio',{name:'18:00'}));
    fireEvent.click(screen.getByRole('button',{name:'送信する'}));
    await screen.findByText(/次回のご予約/);
    const answers=writes.filter(w=>w.path==='/api/forms/f/submit');
    expect(answers).toHaveLength(2);
    expect(answers[0].headers.get('Idempotency-Key')).not.toBe(answers[1].headers.get('Idempotency-Key'));
    expect((answers[1].body.data as Record<string,unknown>)['お名前']).toBe('人工の名前');
  });
  it(`${entry}の人の予約ブロックは既存の口で担当付き予約を作り、回答を増やさず再試行`, async () => {
    peopleForm = true;
    await open(entry, 'page=form&id=f');
    fireEvent.click(await screen.findByRole('button', { name: '18:00' }));
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    await screen.findByText('予約の確保に失敗しました。回答は保存されています。');
    failFormBooking = false; fireEvent.click(screen.getByRole('button', { name: '予約を取り直す' }));
    await screen.findByText(/次回のご予約.*担当者の確認待ちです/);
    const answers = writes.filter(w => w.path.endsWith('/submit'));
    const reserves = writes.filter(w => w.path === '/api/liff/booking/requests');
    expect(answers).toHaveLength(1); expect(reserves).toHaveLength(2);
    expect(reserves[0].body).toEqual({ menu_id: 'm1', staff_id: 's1', starts_at: startsAt });
    expect(reserves[1].body).toEqual(reserves[0].body);
    expect(reserves[0].headers.get('Idempotency-Key')).toBe(`${answers[0].headers.get('Idempotency-Key')}:booking:b`);
    expect(reserves[1].headers.get('Idempotency-Key')).toBe(reserves[0].headers.get('Idempotency-Key'));
    expect(writes.some(w => w.path === '/api/liff/restaurant/form-booking')).toBe(false);
  });
}
