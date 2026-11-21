// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { FormLayout } from '@line-crm/shared';
import Form from './form.js';
import type { MenuItem } from '../lib/api.js';
import { CustomerStyleContext } from '../components/customer-style-scope.js';

/**
 * 「予約を入れる」ブロック。
 * - メニュー・担当・日にち→時刻の順に空き枠から選ぶ
 * - 回答の送信後に予約の受け口で確保する（未承認で入り、店が承認する）
 * - 予約だけ失敗しても回答は残し、取り直し・選び直しを出す
 */
vi.mock('../lib/api.js', () => ({
  restaurantBookingApi: {mine:vi.fn(),formBooking:vi.fn()},
  api: {
    getForm: vi.fn(),
    getMyLatestFormAnswer: vi.fn(),
    submitForm: vi.fn(),
    uploadFormFile: vi.fn(),
    postalSearch: vi.fn(),
    menus: vi.fn(),
    staffOf: vi.fn(),
    availability: vi.fn(),
    createRequest: vi.fn(),
    liffConfig: vi.fn().mockResolvedValue({ success: true, data: {} }),
  },
}));

vi.mock('@line/liff', () => ({
  default: { closeWindow: vi.fn(), getAccessToken: vi.fn() },
}));

vi.mock('../lib/user-message.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/user-message.js')>();
  return { ...actual, logFailure: vi.fn() };
});

const { api,restaurantBookingApi } = await import('../lib/api.js');
const getForm = vi.mocked(api.getForm);
const submitForm = vi.mocked(api.submitForm);
const menus = vi.mocked(api.menus);
const staffOf = vi.mocked(api.staffOf);
const availability = vi.mocked(api.availability);
const createRequest = vi.mocked(api.createRequest);

function layout(): FormLayout {
  return {
    version: 2,
    header: [],
    sections: [
      {
        id: 's1',
        name: '次回',
        blocks: [
          {
            id: 'b1', kind: 'input', type: 'booking', name: '来店予約',
            label: '次回のご希望の日時を選んでください', required: true,
            booking: { menuId: 'm1', staffId: 's1', daysAhead: 14 },
          },
        ],
      },
    ],
    options: {
      pageTitle: '来店アンケート',
      sectionHeader: 'pageNumber',
      confirmDialog: { enabled: false },
    },
  };
}

function setup(options: { style?: 'consult'; mode?: MenuItem['meeting_mode'];entry?:string } = {}) {
  getForm.mockResolvedValue({
    id: 'f1',
    name: '来店アンケート',
    description: '',
    layout: layout(),
    isActive: true,
  });
  menus.mockResolvedValue({
    menus: [{
      id: 'm1', name: 'トリミング（小型犬）', category_label: null, description: null,
      duration_minutes: 105, buffer_after_minutes: 0, base_price: 0, sort_order: 0,
      meeting_mode: options.mode,
    }],
  });
  // 枠の日は「今日の3日後」にする（選べる期間14日の内側で固定）。
  const day = new Date(Date.now() + 9 * 3600_000 + 3 * 86400_000).toISOString().slice(0, 10);
  availability.mockResolvedValue({
    by_staff: [
      {
        staff_id: 's1',
        display_name: '花子',
        slots: [
          { date: day, start: '10:00', end: '11:45' },
          { date: day, start: '13:00', end: '14:45' },
        ],
      },
    ],
  });
  render(
    <CustomerStyleContext.Provider value={options.style ?? null}><MemoryRouter initialEntries={[options.entry ?? '/forms/f1?liffId=test']}>
      <Routes>
        <Route path="/forms/:id" element={<Form />} />
      </Routes>
    </MemoryRouter></CustomerStyleContext.Provider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  cleanup();
});

describe('予約を入れる', () => {
  it('支払いから戻っても未確定の予約を確定と表示しない',async()=>{
    vi.mocked(restaurantBookingApi.mine).mockResolvedValue({success:true,data:[{id:'r',storeId:'store',paymentRequestId:'pay',paymentStatus:'paid',status:'pending',startsAt:'2099-01-01T10:00:00Z',endsAt:'2099-01-01T11:00:00Z',guestCount:2,version:1,holdExpiresAt:null,note:null,customerPhone:null,seatType:null}]});
    setup({entry:'/forms/f1?liffId=test&storeId=store&payment_request=pay&payment_result=success'});
    expect(await screen.findByText('お支払いと予約の状態を確認しています。しばらくしてから読み直してください。')).toBeTruthy();
    expect(screen.queryByText(/ご予約.*が決まりました/)).toBeNull();
  });
  it('空き枠を選んで送ると回答の後に予約を確保する', async () => {
    setup();
    expect(await screen.findByText('トリミング（小型犬）・105分')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: '13:00' }));
    expect(await screen.findByText(/を選んでいます/)).toBeTruthy();
    submitForm.mockResolvedValue({ status: 200, body: { success: true, data: {} } });
    createRequest.mockResolvedValue({ booking_id: 'bk1', status: 'requested' });
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(await screen.findByText('ご回答ありがとうございました')).toBeTruthy();
    expect(createRequest).toHaveBeenCalledOnce();
    const [body, key] = createRequest.mock.calls[0];
    expect(body.menu_id).toBe('m1');
    expect(body.staff_id).toBe('s1');
    expect(typeof body.starts_at).toBe('string');
    expect(typeof key).toBe('string');
    const sent = submitForm.mock.calls[0][1].data['来店予約'] as Record<string, string>;
    expect(sent.menuId).toBe('m1');
  });

  it('予約だけ失敗しても回答は残し、取り直しを出す', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: '10:00' }));
    submitForm.mockResolvedValue({ status: 200, body: { success: true, data: {} } });
    const err = new Error('API 409') as Error & { status: number; body: unknown };
    err.status = 409;
    err.body = { error: 'slot_not_available' };
    createRequest.mockRejectedValue(err);
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(await screen.findByText('選んだ枠が埋まりました。日時を選び直してください。')).toBeTruthy();
    // 同じキーで取り直す
    createRequest.mockResolvedValue({ booking_id: 'bk1', status: 'requested' });
    fireEvent.click(screen.getByRole('button', { name: '予約を取り直す' }));
    await screen.findByText('ご回答ありがとうございました');
    expect(createRequest).toHaveBeenCalledTimes(2);
    expect(createRequest.mock.calls[0][1]).toBe(createRequest.mock.calls[1][1]);
  });

  it('予約連携のブロックの外枠に板の印（g9osGN）が付いている', async () => {
    setup();
    // メニューの札が出たら枠が描かれている。外枠に印が無いと数に入らない。
    expect(await screen.findByText('トリミング（小型犬）・105分')).toBeTruthy();
    const frame = document.querySelector('[data-design-node="g9osGN"]');
    expect(frame).toBeTruthy();
    expect(frame?.textContent).toContain('トリミング（小型犬）');
  });

  it.each([['standard', 'お店の確認待ち'], ['ec', 'お店の確認待ち'], ['restaurant', 'お店の確認待ち'], ['salon', 'お店の確認待ち'], ['consult', '確認待ち'], ['lesson', '確認待ち']] as const)('%s: 満席の日は押せず、回答後に本人の予約日時と業種の確認待ちを出す', async (style, pending) => {
    getForm.mockResolvedValue({
      id: 'f1', name: '来店アンケート', description: '', layout: layout(), isActive: true,
    });
    menus.mockResolvedValue({
      menus: [{
        id: 'm1', name: 'トリミング（小型犬）', category_label: null, description: null,
        duration_minutes: 105, buffer_after_minutes: 0, base_price: 0, sort_order: 0,
        meeting_mode: style === 'consult' ? 'in_person' : undefined,
      }],
    });
    const at = (n: number) => new Date(Date.now() + 9 * 3600_000 + n * 86400_000).toISOString().slice(0, 10);
    const open = at(3);
    const full = at(4);
    availability.mockResolvedValue({
      by_staff: [{
        staff_id: 's1', display_name: '花子',
        slots: [
          { date: open, start: '13:00', end: '14:45' },
          { date: full, start: '13:00', end: '14:45', remaining: 0, state: 'full' },
        ],
      }],
    });
    render(
      <CustomerStyleContext.Provider value={style}><MemoryRouter initialEntries={['/forms/f1?liffId=test']}>
        <Routes>
          <Route path="/forms/:id" element={<Form />} />
        </Routes>
      </MemoryRouter></CustomerStyleContext.Provider>,
    );
    const fullLabel = `${Number(full.slice(5, 7))}月${Number(full.slice(8, 10))}日 空きなし`;
    const fullDay = (await screen.findByRole('button', { name: fullLabel })) as HTMLButtonElement;
    expect(fullDay.disabled).toBe(true);
    fireEvent.click(await screen.findByRole('button', { name: '13:00' }));
    submitForm.mockResolvedValue({ status: 200, body: { success: true, data: {} } });
    createRequest.mockResolvedValue({ booking_id: 'bk1', status: 'requested' });
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    const md = `${Number(open.slice(5, 7))}月${Number(open.slice(8, 10))}日 13:00`;
    expect(
      await screen.findByText(`次回のご予約（${md}）は${pending}です。決まったらLINEでお知らせします。`),
    ).toBeTruthy();
  });
});

describe('フォームの面談予約', () => {
  it.each(['online', 'in_person'] as const)('会い方 %s を選ぶまで日時を確定せず、回答と同じ予約へ送る', async mode => {
    setup({ style: 'consult', mode: 'customer_choice' });
    const time = await screen.findByRole('button', { name: '13:00' });
    expect((time as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(submitForm).not.toHaveBeenCalled();
    expect(createRequest).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('radio', { name: mode === 'online' ? 'オンライン' : '対面' }));
    fireEvent.click(time);
    submitForm.mockResolvedValue({ status: 200, body: { success: true, data: {} } });
    createRequest.mockResolvedValue({ booking_id: 'bk1', status: 'requested' });
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    await screen.findByText('ご回答ありがとうございました');
    expect(submitForm).toHaveBeenCalledOnce();
    expect(createRequest).toHaveBeenCalledOnce();
    expect(createRequest.mock.calls[0][0]).toMatchObject({ menu_id: 'm1', staff_id: 's1', meeting_mode: mode });
    expect(submitForm.mock.calls[0][1].data['来店予約']).toMatchObject({ menuId: 'm1', staffId: 's1', meetingMode: mode });
  });

  it.each(['online', 'in_person'] as const)('固定の %s は選び直させず、その値で同じ予約を作る', async mode => {
    setup({ style: 'consult', mode });
    await screen.findByText(`会い方：${mode === 'online' ? 'オンライン' : '対面'}`);
    expect(screen.queryByRole('radio')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: '13:00' }));
    submitForm.mockResolvedValue({ status: 200, body: { success: true, data: {} } });
    createRequest.mockResolvedValue({ booking_id: 'bk1', status: 'requested' });
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    await screen.findByText('ご回答ありがとうございました');
    expect(createRequest.mock.calls[0][0].meeting_mode).toBe(mode);
  });

  it('会い方が未取得なら対面で代用せず、回答も予約も送らない', async () => {
    setup({ style: 'consult' });
    await screen.findByText(/会い方を読み込めませんでした/);
    const time = await screen.findByRole('button', { name: '13:00' });
    expect((time as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(time);
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    expect(submitForm).not.toHaveBeenCalled();
    expect(createRequest).not.toHaveBeenCalled();
  });

  it('予約だけ失敗した後も、会い方と同じ冪等キーを保って取り直す', async () => {
    setup({ style: 'consult', mode: 'customer_choice' });
    fireEvent.click(await screen.findByRole('radio', { name: 'オンライン' }));
    fireEvent.click(await screen.findByRole('button', { name: '13:00' }));
    submitForm.mockResolvedValue({ status: 200, body: { success: true, data: {} } });
    createRequest.mockRejectedValueOnce({ status: 409, body: { error: 'slot_not_available' } });
    fireEvent.click(screen.getByRole('button', { name: '送信する' }));
    await screen.findByText('選んだ枠が埋まりました。日時を選び直してください。');
    createRequest.mockResolvedValue({ booking_id: 'bk1', status: 'requested' });
    fireEvent.click(screen.getByRole('button', { name: '予約を取り直す' }));
    await waitFor(() => expect(createRequest).toHaveBeenCalledTimes(2));
    expect(submitForm).toHaveBeenCalledOnce();
    expect(createRequest.mock.calls[0][0].meeting_mode).toBe('online');
    expect(createRequest.mock.calls[1]).toEqual(createRequest.mock.calls[0]);
  });
});

it('XL-01 仲間: 予約付き回答の送信中に前のページへ戻ったら、古い予約応答では完了しない', async()=>{
  const multi=layout();multi.sections.push({id:'s2',name:'確かめる',blocks:[]})
  setup()
  cleanup()
  getForm.mockResolvedValue({id:'f1',name:'人工アンケート',description:'',layout:multi,isActive:true})
  render(<MemoryRouter initialEntries={['/forms/f1']}><Routes><Route path="/forms/:id" element={<Form/>}/></Routes></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button',{name:'13:00'}))
  fireEvent.click(screen.getByRole('button',{name:'次へ'}))
  submitForm.mockResolvedValue({status:200,body:{success:true,data:{}}})
  let resolve!: (value:{booking_id:string;status:string})=>void
  const pending=new Promise<{booking_id:string;status:string}>(r=>{resolve=r})
  createRequest.mockReturnValue(pending)
  fireEvent.click(screen.getByRole('button',{name:'送信する'}))
  await waitFor(()=>expect(createRequest).toHaveBeenCalledOnce())
  fireEvent.click(screen.getByRole('button',{name:'戻る'}))
  await act(async()=>{resolve({booking_id:'old',status:'requested'});await pending})
  expect(screen.queryByText('ご回答ありがとうございました')).toBeNull()
  expect(screen.getByRole('button',{name:'次へ'})).toBeTruthy()
})
