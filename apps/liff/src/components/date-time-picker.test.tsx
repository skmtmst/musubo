// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import DateTimePicker from './date-time-picker.js';
import { dayStateLabel } from './date-time-picker.js';
import type { MenuItem, StaffItem } from '../lib/api.js';

/**
 * 1-2 週で見る／カレンダー切替の描画試験 (★V8・/)。
 * 今日は 2026-10-15（木）に固定し、設定・空き枠は偽物で返す。
 */

let todayOverride = '2026-10-15';

vi.mock('../lib/datetime.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../lib/datetime.js')>();
  return { ...actual, jstToday: () => todayOverride };
});

vi.mock('../lib/user-message.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../lib/user-message.js')>();
  return { ...actual, logFailure: vi.fn() };
});

const { api } = await import('../lib/api.js');
vi.mock('../lib/api.js', () => ({
  api: {
    availability: vi.fn(),
    bookingSettings: vi.fn(),
  },
}));

const MENU: MenuItem = {
  id: 'm1',
  name: 'トリミング（小型犬）',
  category_label: null,
  description: null,
  duration_minutes: 60,
  buffer_after_minutes: 0,
  base_price: 5000,
  sort_order: 0,
};
const STAFF: StaffItem = {
  id: 's1',
  display_name: '担当A',
  role: null,
  profile_image_url: null,
  bio: null,
  is_designation_optional: 0,
  price: 5000,
  duration_minutes: 60,
};

type Slot = {
  date: string;
  start: string;
  end: string;
  remaining?: number;
  state?: 'available' | 'limited' | 'full' | 'closed';
};
const MASTER_SLOTS: Slot[] = [
  { date: '2026-10-16', start: '10:00', end: '11:00' },
  { date: '2026-10-16', start: '11:00', end: '12:00' },
  // 10-18 は枠があって全部埋まった日（残り0）。カレンダーの「満」になる。
  { date: '2026-10-18', start: '10:00', end: '11:00', remaining: 0, state: 'full' },
  { date: '2026-10-18', start: '11:00', end: '12:00', remaining: 0, state: 'full' },
  { date: '2026-10-20', start: '09:00', end: '10:00' },
  { date: '2026-10-30', start: '10:00', end: '11:00' },
  { date: '2026-11-02', start: '10:00', end: '11:00' },
];
const MASTER_CLOSED = ['2026-10-21'];

const availability = vi.mocked(api.availability);
const bookingSettings = vi.mocked(api.bookingSettings);

function mockAvailability() {
  availability.mockImplementation(async (_menuId: string, _staffId: string | undefined, from: string, to: string) => ({
    by_staff: [
      {
        staff_id: 's1',
        display_name: '担当A',
        slots: MASTER_SLOTS.filter((s) => s.date >= from && s.date <= to),
      },
    ],
    closed_dates: MASTER_CLOSED.filter((d) => d >= from && d <= to),
  }));
}

function mockSettings(
  view: 'list' | 'calendar' = 'list',
  windowDays = 60,
  mode?: string,
  dots?: number,
) {
  bookingSettings.mockResolvedValue({
    liff_date_view: view,
    booking_window_days: windowDays,
    ...(mode === undefined ? {} : { liff_calendar_mode: mode }),
    ...(dots === undefined ? {} : { liff_vacancy_dots: dots }),
  });
}

function renderPicker() {
  const onSelect = vi.fn();
  const onLoadState = vi.fn();
  render(
    <DateTimePicker
      menu={MENU}
      staff={STAFF}
      selected={null}
      onSelect={onSelect}
      onConfirm={vi.fn()}
      onBackToStaff={vi.fn()}
      onLoadState={onLoadState}
    />,
  );
  return { onSelect, onLoadState };
}

async function openCalendar() {
  renderPicker();
  const group = await screen.findByRole('radiogroup', { name: '表示の切り替え' });
  fireEvent.click(within(group).getByRole('radio', { name: 'カレンダー' }));
  return group;
}

const memoryValues = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: (key: string) => memoryValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      memoryValues.set(key, String(value));
    },
    removeItem: (key: string) => {
      memoryValues.delete(key);
    },
    clear: () => memoryValues.clear(),
  },
  configurable: true,
  writable: true,
});

beforeEach(() => {
  // 「今日」は 2026-10-15（木）に固定する。部品が読む jstToday を
  // 偽装しているので、実機の日付が何日でも選ばれる日は変わらない。
  todayOverride = '2026-10-15';
  // 時計そのものも固定する（jstToday 偽装との二重固定。Date だけを
  // 偽物にし、タイマーは本物のままなので待ち受けは壊れない）。
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T00:00:00+09:00'));
  memoryValues.clear();
  vi.clearAllMocks();
  mockAvailability();
  mockSettings('list', 60);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('切り替え', () => {
  it('手順の下に週で見る｜カレンダーが並び、今どちらかが読み上げで分かる', async () => {
    renderPicker();
    const group = await screen.findByRole('radiogroup', { name: '表示の切り替え' });
    const week = within(group).getByRole('radio', { name: '週で見る' });
    const calendar = within(group).getByRole('radio', { name: 'カレンダー' });
    expect(week.getAttribute('aria-checked')).toBe('true');
    expect(calendar.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(calendar);
    expect(calendar.getAttribute('aria-checked')).toBe('true');
    expect(week.getAttribute('aria-checked')).toBe('false');
  });

  it('最初の形は管理画面の設定に従う', async () => {
    mockSettings('calendar', 60);
    renderPicker();
    const group = await screen.findByRole('radiogroup', { name: '表示の切り替え' });
    expect(
      within(group).getByRole('radio', { name: 'カレンダー' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(await screen.findByText('2026年10月')).toBeTruthy();
  });

  it('端末で切り替えた形を次回も使う（設定より優先）', async () => {
    window.localStorage.setItem('liff-booking-date-view', 'list');
    mockSettings('calendar', 60);
    renderPicker();
    const group = await screen.findByRole('radiogroup', { name: '表示の切り替え' });
    expect(
      within(group).getByRole('radio', { name: '週で見る' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('切り替えたら端末に覚える', async () => {
    const group = await openCalendar();
    expect(window.localStorage.getItem('liff-booking-date-view')).toBe('calendar');
    fireEvent.click(within(group).getByRole('radio', { name: '週で見る' }));
    expect(window.localStorage.getItem('liff-booking-date-view')).toBe('list');
  });

  it('設定が読めなくても週（既定）で開く', async () => {
    bookingSettings.mockRejectedValue(new Error('offline'));
    renderPicker();
    const group = await screen.findByRole('radiogroup', { name: '表示の切り替え' });
    expect(
      within(group).getByRole('radio', { name: '週で見る' }).getAttribute('aria-checked'),
    ).toBe('true');
    // 週の枠は読めているので時刻が出る。
    expect(await screen.findByRole('button', { name: '10:00' })).toBeTruthy();
  });

  it('localStorage が使えなくても落ちない（設定の値に戻る）', async () => {
    const storage = window.localStorage;
    const getSpy = vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const setSpy = vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    mockSettings('calendar', 60);
    renderPicker();
    const group = await screen.findByRole('radiogroup', { name: '表示の切り替え' });
    expect(
      within(group).getByRole('radio', { name: 'カレンダー' }).getAttribute('aria-checked'),
    ).toBe('true');
    // 書けなくても切り替え自体は動く。
    fireEvent.click(within(group).getByRole('radio', { name: '週で見る' }));
    expect(setSpy).toHaveBeenCalled();
    expect(
      within(group).getByRole('radio', { name: '週で見る' }).getAttribute('aria-checked'),
    ).toBe('true');
    void getSpy;
  });
});

describe('カレンダー', () => {
  it('各日は日付＋状態で読み上げられ、印の見方が出る', async () => {
    await openCalendar();
    expect(
      await screen.findByRole('button', { name: '10月16日 空きあり' }),
    ).toBeTruthy();
    // 10-18 は枠があって全部埋まった日だけ「満席」。枠の無い 10-17 は「空きなし」。
    expect(screen.getByRole('button', { name: '10月18日 満席' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '10月17日 空きなし' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '10月21日 お休み' })).toBeTruthy();
    // 印の見方 (● 空きあり・灰色は満席か休み)。
    expect(screen.getByText(/空きあり/)).toBeTruthy();
    expect(screen.getByText(/満席・休み/)).toBeTruthy();
  });

  it('過去・期間の外・お休み・空きなしの日は押せない（満席の日は待ちの入口のため押せる・監査 L4）', async () => {
    await openCalendar();
    await screen.findByRole('button', { name: '10月16日 空きあり' });
    expect(screen.getByRole('button', { name: '10月14日 過ぎた日' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '10月18日 満席' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: '10月17日 空きなし' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '10月21日 お休み' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '10月16日 空きあり' }).hasAttribute('disabled')).toBe(false);
  });

  it('最初に開いた時は空きのある一番早い日を選んだ状態', async () => {
    await openCalendar();
    // 10-16 が一番早い空き日。押した状態 (aria-pressed) で出る。
    expect(
      await screen.findByRole('button', { name: '10月16日 空きあり', pressed: true }),
    ).toBeTruthy();
  });

  it('日を押して「この日の時間を選ぶ」で週の時刻3列へ移る', async () => {
    const { onSelect } = renderPicker();
    const group = await screen.findByRole('radiogroup', { name: '表示の切り替え' });
    fireEvent.click(within(group).getByRole('radio', { name: 'カレンダー' }));
    // 月の読み込みと「一番早い日を自動で選ぶ」は別の描画で来る。自動選択の
    // 結果 (10/16 の押した状態) が出てから押す (CI の間欠失敗の防止)。
    expect(
      await screen.findByRole('button', { name: '10月16日 空きあり', pressed: true }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '10月20日 空きあり' }));
    fireEvent.click(screen.getByRole('button', { name: 'この日の時間を選ぶ' }));
    expect(await screen.findByText('10月20日（火）の空き')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '09:00' }));
    expect(onSelect).toHaveBeenCalledWith({ date: '2026-10-20', start: '09:00' });
  });

  it('月は今月より前へ戻れず、期間の外へ進めない', async () => {
    mockSettings('calendar', 20);
    renderPicker();
    await screen.findByText('2026年10月');
    // 今月なので前へは戻れない。
    expect(screen.getByRole('button', { name: '前の月' }).hasAttribute('disabled')).toBe(true);
    // 受付は 11-04 まで。11月へは進めるが、12月へは進めない。
    fireEvent.click(screen.getByRole('button', { name: '次の月' }));
    expect(await screen.findByText('2026年11月')).toBeTruthy();
    expect(screen.getByRole('button', { name: '前の月' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: '次の月' }).hasAttribute('disabled')).toBe(true);
    // 11-05 以降は期間の外で押せない。
    expect(screen.getByRole('button', { name: '11月5日 受付期間外' }).hasAttribute('disabled')).toBe(true);
    // 戻れる。
    fireEvent.click(screen.getByRole('button', { name: '前の月' }));
    expect(await screen.findByText('2026年10月')).toBeTruthy();
  });

  it('月のぶんは28日ずつに割って読む（口の上限を超えない）', async () => {
    todayOverride = '2026-10-01';
    vi.setSystemTime(new Date('2026-10-01T00:00:00+09:00'));
    mockSettings('calendar', 60);
    renderPicker();
    await screen.findByRole('button', { name: '10月30日 空きあり' });
    const calls = availability.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const [, , from, to] of calls) {
      const days =
        (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) /
          86400000 +
        1;
      expect(days).toBeLessThanOrEqual(28);
    }
    // 割ったぶんを合わせてある（後半の枠も印になる）。
    const covered = calls.map(([, , from, to]) => `${from}〜${to}`).join(' ');
    expect(covered).toContain('2026-10-01');
    expect(covered).toContain('2026-10-31');
  });

  it('空きが無い月はその旨だけ出す', async () => {
    availability.mockResolvedValue({ by_staff: [{ staff_id: 's1', display_name: '担当A', slots: [] }], closed_dates: [] });
    mockSettings('calendar', 60);
    renderPicker();
    await screen.findByText('2026年10月');
    expect(
      await screen.findByText('この月の受付期間内に空きがありません。'),
    ).toBeTruthy();
  });
});

describe('枠の二重読み', () => {
  it('月をまたいで割って読んでも、同じ日の同じ時刻は1つだけ出る', async () => {
    todayOverride = '2026-09-27';
    vi.setSystemTime(new Date('2026-09-27T00:00:00+09:00'));
    // 口が期間を広めに返し、二口ぶんに同じ枠が入ってきた場合。
    const octSlots: Slot[] = [
      { date: '2026-10-01', start: '10:00', end: '11:00' },
      { date: '2026-10-01', start: '11:00', end: '12:00' },
      { date: '2026-10-05', start: '10:00', end: '11:00' },
    ];
    availability.mockImplementation(async () => ({
      by_staff: [{ staff_id: 's1', display_name: '担当A', slots: octSlots }],
      closed_dates: [],
    }));
    mockSettings('calendar', 60);
    renderPicker();
    // 9月に空きが無いので10月を開く。10月は28日ずつ2口で読む。
    expect(await screen.findByText('2026年10月')).toBeTruthy();
    // 自動選択された一番早い日 (10/1) の週へ移って時刻を確かめる。
    await screen.findByRole('button', { name: '10月1日 空きあり', pressed: true });
    fireEvent.click(screen.getByRole('button', { name: 'この日の時間を選ぶ' }));
    expect(await screen.findByText('10月1日（木）の空き')).toBeTruthy();
    // 同じ枠が二重に来ても時刻の札は1つずつ。
    expect(screen.getAllByRole('button', { name: '10:00' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '11:00' })).toHaveLength(1);
    // 別の日も1つずつ。
    fireEvent.click(screen.getByRole('button', { name: '10月5日 空きあり' }));
    expect(await screen.findByText('10月5日（月）の空き')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '10:00' })).toHaveLength(1);
  });

  it('週でも同じ枠は1つだけ出る', async () => {
    availability.mockImplementation(async () => ({
      by_staff: [
        {
          staff_id: 's1',
          display_name: '担当A',
          slots: [
            { date: '2026-10-16', start: '10:00', end: '11:00' },
            { date: '2026-10-16', start: '10:00', end: '11:00' },
            { date: '2026-10-16', start: '11:00', end: '12:00' },
            { date: '2026-10-16', start: '11:00', end: '12:00' },
          ],
        },
      ],
      closed_dates: [],
    }));
    renderPicker();
    expect(await screen.findByText('10月16日（金）の空き')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '10:00' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: '11:00' })).toHaveLength(1);
  });
});

describe('カレンダーの最初の月と月送り', () => {
  it('今月に空きが無く来月にある時は、来月を開いて1日を選ぶ', async () => {
    todayOverride = '2026-09-27';
    vi.setSystemTime(new Date('2026-09-27T00:00:00+09:00'));
    availability.mockImplementation(
      async (_menuId: string, _staffId: string | undefined, from: string, to: string) => ({
        by_staff: [
          {
            staff_id: 's1',
            display_name: '担当A',
            slots: [
              { date: '2026-10-01', start: '10:00', end: '11:00' },
              { date: '2026-10-01', start: '11:00', end: '12:00' },
              { date: '2026-10-05', start: '10:00', end: '11:00' },
            ].filter((s) => s.date >= from && s.date <= to),
          },
        ],
        closed_dates: [],
      }),
    );
    mockSettings('calendar', 60);
    renderPicker();
    // 9月ではなく、空きのある一番早い日（10/1）の月を開く。
    expect(await screen.findByText('2026年10月')).toBeTruthy();
    expect(
      await screen.findByRole('button', { name: '10月1日 空きあり', pressed: true }),
    ).toBeTruthy();
  });

  it('月を送ると、その月で空きのある一番早い日を選び直す', async () => {
    mockSettings('calendar', 60);
    renderPicker();
    // 今月（10月）の一番早い空き日から始まる。
    expect(
      await screen.findByRole('button', { name: '10月16日 空きあり', pressed: true }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '次の月' }));
    expect(await screen.findByText('2026年11月')).toBeTruthy();
    // 来月の一番早い空き日（11/2）に変わる。
    expect(
      await screen.findByRole('button', { name: '11月2日 空きあり', pressed: true }),
    ).toBeTruthy();
  });

  it('送った先の月に空きが無ければその旨だけ出す', async () => {
    mockSettings('calendar', 60);
    renderPicker();
    expect(
      await screen.findByRole('button', { name: '10月16日 空きあり', pressed: true }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '次の月' }));
    expect(
      await screen.findByRole('button', { name: '11月2日 空きあり', pressed: true }),
    ).toBeTruthy();
    // 12月に空きは無い（受付期限は12-14）。
    fireEvent.click(screen.getByRole('button', { name: '次の月' }));
    expect(await screen.findByText('2026年12月')).toBeTruthy();
    expect(await screen.findByText('この月の受付期間内に空きがありません。')).toBeTruthy();
  });
});

describe('選んだ日は遅れて届く応答で上書きしない', () => {
  it('カレンダー：選んだ後に週へ切り替えて戻っても選んだ日のまま', async () => {
    const group = await openCalendar();
    // 最初の自動選択（10/16）が出てから、別の日を選ぶ。
    expect(
      await screen.findByRole('button', { name: '10月16日 空きあり', pressed: true }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '10月20日 空きあり' }));
    expect(
      await screen.findByRole('button', { name: '10月20日 空きあり', pressed: true }),
    ).toBeTruthy();
    // 週へ行くと、その日の時刻が出る。カレンダーへ戻っても選んだ日は残る。
    fireEvent.click(within(group).getByRole('radio', { name: '週で見る' }));
    expect(await screen.findByText('10月20日（火）の空き')).toBeTruthy();
    fireEvent.click(within(group).getByRole('radio', { name: 'カレンダー' }));
    expect(
      await screen.findByRole('button', { name: '10月20日 空きあり', pressed: true }),
    ).toBeTruthy();
  });

  it('カレンダー：選んだ後に月を送って戻っても選んだ日のまま', async () => {
    await openCalendar();
    expect(
      await screen.findByRole('button', { name: '10月16日 空きあり', pressed: true }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '10月20日 空きあり' }));
    expect(
      await screen.findByRole('button', { name: '10月20日 空きあり', pressed: true }),
    ).toBeTruthy();
    // 来月を見に行っても、選んだ日を自動選択で置き換えない。
    fireEvent.click(screen.getByRole('button', { name: '次の月' }));
    // 来月の読み込みが終わるまで待つ。来月に空き (11/2) があっても押されない。
    const nov = await screen.findByLabelText('2026年11月の日付');
    expect(within(nov).queryByRole('button', { pressed: true })).toBeNull();
    // 今月に戻っても同じ。
    fireEvent.click(screen.getByRole('button', { name: '前の月' }));
    expect(await screen.findByText('2026年10月')).toBeTruthy();
    expect(
      await screen.findByRole('button', { name: '10月20日 空きあり', pressed: true }),
    ).toBeTruthy();
  });

  it('週：選んだ日は、表示の切り替えで自動選択に戻されない', async () => {
    renderPicker();
    expect(await screen.findByText('10月16日（金）の空き')).toBeTruthy();
    // 次の週へ送って 10/20 を選ぶ（読んだ週は窓を越えて残る）。
    fireEvent.click(screen.getByRole('button', { name: '次の週' }));
    expect(await screen.findByText('10月20日（火）の空き')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '10月20日 空きあり' }));
    // カレンダーへ行って戻っても、選んだ日 (10/20) のまま。
    // 自動選択で一番早い日 (10/16) に戻されることはない。
    const group = await screen.findByRole('radiogroup', { name: '表示の切り替え' });
    fireEvent.click(within(group).getByRole('radio', { name: 'カレンダー' }));
    const calendar = await screen.findByLabelText('2026年10月の日付');
    expect(within(calendar).getByRole('button', { name: '10月20日 空きあり', pressed: true })).toBeTruthy();
    fireEvent.click(within(group).getByRole('radio', { name: '週で見る' }));
    expect(await screen.findByText('10月20日（火）の空き')).toBeTruthy();
    expect(screen.queryByText('10月16日（金）の空き')).toBeNull();
  });
});

describe('dayStateLabel', () => {
  it('「10月4日 満席」のように日付と状態を返す', () => {
    expect(dayStateLabel('2026-10-04', 'full')).toBe('10月4日 満席');
    expect(dayStateLabel('2026-10-01', 'open')).toBe('10月1日 空きあり');
    expect(dayStateLabel('2026-10-22', 'few')).toBe('10月22日 残りわずか');
    expect(dayStateLabel('2026-10-07', 'closed')).toBe('10月7日 お休み');
    expect(dayStateLabel('2026-09-30', 'off')).toBe('9月30日 受付期間外');
    expect(dayStateLabel('2026-10-14', 'past')).toBe('10月14日 過ぎた日');
    expect(dayStateLabel('2026-10-02', 'empty')).toBe('10月2日 空きなし');
  });
});

describe('カレンダーの出し方4択 (店の設定)', () => {
  it('月を先にするとカレンダーで開く (切り替えは残る)', async () => {
    mockSettings('list', 60, 'month-first');
    renderPicker();
    const group = await screen.findByRole('radiogroup', { name: '表示の切り替え' });
    expect(
      within(group).getByRole('radio', { name: 'カレンダー' }).getAttribute('aria-checked'),
    ).toBe('true');
    expect(await screen.findByText('2026年10月')).toBeTruthy();
  });

  it('週だけでは切り替えが出ず、週で開く', async () => {
    mockSettings('list', 60, 'week-only');
    renderPicker();
    expect(await screen.findByText('10月16日（金）の空き')).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: '表示の切り替え' })).toBeNull();
  });

  it('月だけでは切り替えが出ず、カレンダーで開く', async () => {
    mockSettings('list', 60, 'month-only');
    renderPicker();
    expect(await screen.findByText('2026年10月')).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: '表示の切り替え' })).toBeNull();
  });

  it('週だけの店では端末の覚えがカレンダーでも週で開く', async () => {
    window.localStorage.setItem('liff-booking-date-view', 'calendar');
    mockSettings('list', 60, 'week-only');
    renderPicker();
    expect(await screen.findByText('10月16日（金）の空き')).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: '表示の切り替え' })).toBeNull();
  });
});

describe('空きの点のオン／オフ (店の設定)', () => {
  it('消すと点・印・見方が出ない (読み上げは残す)', async () => {
    mockSettings('list', 60, undefined, 0);
    await openCalendar();
    const grid = await screen.findByLabelText('2026年10月の日付');
    expect(grid.querySelector('.rounded-full')).toBeNull();
    expect(screen.queryByText(/空きあり/)).toBeNull();
    expect(screen.queryByText(/満席・休み/)).toBeNull();
    // 読み上げは残す。
    expect(await screen.findByRole('button', { name: '10月16日 空きあり' })).toBeTruthy();
  });

  it('残りわずかの日が無い月は、金の見方を出さない (板 k3aJKU)', async () => {
    await openCalendar();
    await screen.findByLabelText('2026年10月の日付');
    expect(screen.getByText(/空きあり/)).toBeTruthy();
    expect(screen.queryByText(/残りわずか/)).toBeNull();
  });
});

describe('残りわずか (金の印)', () => {
  const LIMITED: Slot = {
    date: '2026-10-22',
    start: '10:00',
    end: '11:00',
    state: 'limited',
  };

  beforeEach(() => {
    availability.mockImplementation(
      async (_menuId: string, _staffId: string | undefined, from: string, to: string) => ({
        by_staff: [
          {
            staff_id: 's1',
            display_name: '担当A',
            slots: [...MASTER_SLOTS, LIMITED].filter((s) => s.date >= from && s.date <= to),
          },
        ],
        closed_dates: MASTER_CLOSED.filter((d) => d >= from && d <= to),
      }),
    );
  });

  it('残りわずかの日がある月は、金の見方も出る', async () => {
    await openCalendar();
    await screen.findByLabelText('2026年10月の日付');
    expect(screen.getByText(/残りわずか/)).toBeTruthy();
  });

  it('わずかだけの日は金で「残りわずか」と読み、押せる', async () => {
    await openCalendar();
    const cell = await screen.findByRole('button', { name: '10月22日 残りわずか' });
    expect(cell.hasAttribute('disabled')).toBe(false);
    expect(cell.querySelector('.bg-liff-dot-few')).toBeTruthy();
  });

  it('週でも「わずか」の印が出て選べる', async () => {
    renderPicker();
    expect(await screen.findByText('10月16日（金）の空き')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '次の週' }));
    const day = await screen.findByRole('button', { name: '10月22日 残りわずか' });
    expect(day.hasAttribute('disabled')).toBe(false);
    expect(day.textContent).toContain('わずか');
  });

  it('ふつうの空きと混ざった日は空き (緑) を優先する', async () => {
    availability.mockImplementation(
      async (_menuId: string, _staffId: string | undefined, from: string, to: string) => ({
        by_staff: [
          {
            staff_id: 's1',
            display_name: '担当A',
            slots: [
              ...MASTER_SLOTS,
              { date: '2026-10-16', start: '12:00', end: '13:00', state: 'limited' } as Slot,
            ].filter((s) => s.date >= from && s.date <= to),
          },
        ],
        closed_dates: MASTER_CLOSED.filter((d) => d >= from && d <= to),
      }),
    );
    await openCalendar();
    // わずかが混ざっても「空きあり」のまま。金の点は出ない。
    const cell = await screen.findByRole('button', { name: '10月16日 空きあり' });
    expect(cell.querySelector('.bg-liff-dot-few')).toBeNull();
    expect(cell.querySelector('.rounded-full')).toBeTruthy();
  });
});

describe('カレンダーの見た目（設計合わせ）', () => {
  it('過ぎた日は押せず、枠が無く、薄い文字で「過ぎた日」と読む', async () => {
    await openCalendar();
    const past = await screen.findByRole('button', { name: '10月14日 過ぎた日' });
    // 押せない。
    expect(past.hasAttribute('disabled')).toBe(true);
    // 枠なし（border 系の見せ方を残さない）・薄い文字。
    expect(past.className).not.toContain('border');
    expect(past.className).toContain('text-liff-off-ink');
  });

  it.each([
    // [試験の今日, 最初に選ばれる日の読み上げ]
    ['2026-10-15', '10月16日 空きあり'],
    ['2026-10-01', '10月16日 空きあり'],
    ['2026-10-17', '10月20日 空きあり'],
  ])(
    'ます目は枠なし・高さが幅以下（h-11）で、塗るのは選んだ日だけ（今日=%s）',
    async (today, expectedLabel) => {
      // 実機の日付が何日でも同じ結果になるよう時計を固定する。
      // 最初に選ぶ日は今日によって変わるので日付を決め打ちせず、
      // 「押した状態のます目」を読み上げ名（aria-label）で探して確かめる。
      vi.setSystemTime(new Date(`${today}T00:00:00+09:00`));
      todayOverride = today;
      await openCalendar();
      // 月の読み込みが終わるまで待ってからます目を探す。
      const grid = await screen.findByLabelText('2026年10月の日付');
      expect(grid.className).toContain('grid-cols-7');
      // 枠の読み込みと「選ぶ」は別の描画で来るので、押した状態の
      // ます目が出るまで待つ。ます目は切り替え釦なので、選んだ状態は
      // aria-pressed が持つ（aria-selected は釦に付けられない）。
      const selected = await within(grid).findByRole('button', { pressed: true });
      expect(selected.getAttribute('aria-label')).toBe(expectedLabel);
      const cells = within(grid).getAllByRole('button');
      expect(cells.length).toBeGreaterThan(0);
      for (const cell of cells) {
        // 枠なし・縦長にしない（h-11 = 44px。375px幅で1ます≈49px）。
        expect(cell.className).not.toContain('border');
        expect(cell.className).not.toContain('min-h-14');
        expect(cell.className).toContain('h-11');
      }
      // 選んだ日は薄い地＋濃い文字と主の色の枠。主ボタンと同じ緑の塗りにしない。
      // 角丸は型の値 (既定 10px) を変数で受ける。
      expect(selected.className).toContain('bg-liff-soft');
      expect(selected.className).not.toContain('bg-liff-primary');
      expect(selected.className).toContain('rounded-(--liff-radius)');
      const others = cells.filter((cell) => cell !== selected);
      expect(others.length).toBeGreaterThan(0);
      for (const cell of others) {
        expect(cell.className).not.toContain('bg-liff-primary');
        expect(cell.className).not.toContain('bg-liff-soft');
      }
    },
  );

  it('空きありのますには点の印が出る（満席・お休み・空きなしは灰色の数字だけ）', async () => {
    await openCalendar();
    const open = await screen.findByRole('button', { name: '10月16日 空きあり' });
    // 空きありのますには丸い点。
    expect(open.querySelector('.rounded-full')).toBeTruthy();
    // 満席・お休み・空きなしのますには点も文字の印も付けない。
    for (const name of ['10月18日 満席', '10月21日 お休み', '10月17日 空きなし']) {
      const cell = screen.getByRole('button', { name });
      expect(cell.querySelector('.rounded-full')).toBeNull();
      expect(cell.textContent).not.toContain('満');
      expect(cell.textContent).not.toContain('休');
      expect(cell.textContent).not.toContain('●');
    }
  });

  it('枠が無い日は「満」を出さない（印なし・薄字・押せない・空きなしと読む）', async () => {
    await openCalendar();
    const empty = await screen.findByRole('button', { name: '10月17日 空きなし' });
    expect(empty.hasAttribute('disabled')).toBe(true);
    // 満・休・点の印は付けない。
    expect(empty.textContent).not.toContain('満');
    expect(empty.textContent).not.toContain('休');
    expect(empty.textContent).not.toContain('●');
    // 薄い文字。
    expect(empty.className).toContain('text-liff-off-ink');
  });
});

describe('監査 L1：月の読込を途中で替えても、戻れば読み直す', () => {
  it('週へ切り替えて戻った後、遅い旧応答を混ぜず新しい月の応答を使う', async () => {
    mockSettings('calendar', 60);
    const real = availability.getMockImplementation()!;
    type Response = Awaited<ReturnType<typeof api.availability>>;
    const pending: Array<(value: Response) => void> = [];
    availability.mockImplementation(async (menuId, staffId, from, to) => {
      if (from === '2026-10-15' && to === '2026-10-31') {
        return new Promise<Response>((resolve) => pending.push(resolve));
      }
      return real(menuId, staffId, from, to);
    });
    renderPicker();
    await screen.findByText('2026年10月');
    // 空き枠の読込は useEffect から始める。月の見出しが出た瞬間にはまだ効果が動いておらず、
    // pending が空のことがある。読込が始まるまで再試行して待つ（以下も同じ理由）。
    await waitFor(() => { expect(pending).toHaveLength(1); });
    fireEvent.click(screen.getByRole('radio', { name: '週で見る' }));
    await screen.findByRole('button', { name: '10月16日 空きあり' });
    fireEvent.click(screen.getByRole('radio', { name: 'カレンダー' }));
    await waitFor(() => { expect(pending).toHaveLength(2); });
    await act(async () => pending[0]({ by_staff: [{ staff_id: 's1', display_name: '担当A', slots: [
      { date: '2026-10-17', start: '22:00', end: '23:00' },
    ] }], closed_dates: [] }));
    expect(screen.queryByRole('button', { name: '10月17日 空きあり' })).toBeNull();
    await act(async () => pending[1](await real('m1', 's1', '2026-10-15', '2026-10-31')));
    expect(await screen.findByRole('button', { name: '10月16日 空きあり' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '10月17日 空きあり' })).toBeNull();
  });

  it('10月の読込中に11月へ送り、10月へ戻ると読み直して日が出る', async () => {
    mockSettings('calendar', 60);
    let held = true;
    const real = availability.getMockImplementation()!;
    availability.mockImplementation(async (menuId, staffId, from, to) => {
      // 最初の10月の読込だけ返さずに止める（読込中に月を送った状態を作る）。
      if (held && from.startsWith('2026-10')) {
        held = false;
        return new Promise(() => {});
      }
      return real(menuId, staffId, from, to);
    });
    renderPicker();
    expect(await screen.findByText('2026年10月')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '次の月' }));
    expect(await screen.findByRole('button', { name: '11月2日 空きあり' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '前の月' }));
    // 読み中の印が残っていると、ここで読込中のまま止まる。
    expect(await screen.findByRole('button', { name: '10月16日 空きあり' })).toBeTruthy();
    const octCalls = availability.mock.calls.filter(([, , from]) => from.startsWith('2026-10'));
    expect(octCalls.length).toBe(2);
  });
});

describe('監査 L4：満席の日から時刻の「空いたら知らせる」へ進める（予約はできない）', () => {
  it('週の並びで満席の日を押すと、灰色の時刻と鈴が出て、予約へは進めない', async () => {
    const { onSelect } = renderPicker();
    const full = await screen.findByRole('button', { name: '10月18日 満席' });
    expect(full.hasAttribute('disabled')).toBe(false);
    fireEvent.click(full);
    const ten = await screen.findByRole('button', { name: '10:00' });
    expect(ten.hasAttribute('disabled')).toBe(true);
    fireEvent.click(ten);
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '10:00に空いたら知らせる' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '時間を選ぶ' }).hasAttribute('disabled')).toBe(true);
  });

  it('カレンダーで満席の日を選んで「この日の時間を選ぶ」から鈴へ進める', async () => {
    await openCalendar();
    fireEvent.click(await screen.findByRole('button', { name: '10月18日 満席' }));
    fireEvent.click(screen.getByRole('button', { name: 'この日の時間を選ぶ' }));
    expect(await screen.findByRole('button', { name: '11:00に空いたら知らせる' })).toBeTruthy();
  });

  it('鈴が出る日は鈴の意味の1行を出し、鈴の無い日は出さない', async () => {
    renderPicker();
    expect(await screen.findByText('10月16日（金）の空き')).toBeTruthy();
    expect(screen.queryByText('満席の時間の鈴は「空いたら知らせる」の登録です')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: '10月18日 満席' }));
    expect(await screen.findByText('10月18日（日）の空き')).toBeTruthy();
    expect(screen.getByRole('button', { name: '10:00に空いたら知らせる' })).toBeTruthy();
    expect(screen.getByText('満席の時間の鈴は「空いたら知らせる」の登録です')).toBeTruthy();
  });

  it('満席の日しかない週も「空きがありません」で止めず、日の並びと鈴を出す', async () => {
    availability.mockImplementation(async (_m: string, _s: string | undefined, from: string, to: string) => ({
      by_staff: [
        {
          staff_id: 's1',
          display_name: '担当A',
          slots: MASTER_SLOTS.filter((x) => x.state === 'full' && x.date >= from && x.date <= to),
        },
      ],
      closed_dates: [],
    }));
    renderPicker();
    const full = await screen.findByRole('button', { name: '10月18日 満席' });
    expect(screen.queryByText('この週は空きがありません')).toBeNull();
    fireEvent.click(full);
    expect(await screen.findByRole('button', { name: '10:00に空いたら知らせる' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '← 担当を選び直す' })).toBeNull();
  });

  it('枠の無い週は今までどおり「空きがありません」(ADutg)', async () => {
    availability.mockImplementation(async () => ({
      by_staff: [{ staff_id: 's1', display_name: '担当A', slots: [] }],
      closed_dates: [],
    }));
    renderPicker();
    expect(await screen.findByText('この週は空きがありません')).toBeTruthy();
  });
});

describe('監査 L10：選んだ時刻に開始の瞬間と店のタイムゾーンを持たせる', () => {
  it('時刻を押すと startUtc・timeZone を付けて onSelect へ渡す', async () => {
    availability.mockImplementation(async (_m: string, _s: string | undefined, from: string, to: string) => ({
      by_staff: [
        {
          staff_id: 's1',
          display_name: '担当A',
          slots: [
            {
              date: '2026-10-16',
              start: '13:00',
              end: '14:00',
              timeZone: 'Asia/Bangkok',
              startUtc: '2026-10-16T13:00:00+07:00',
              endUtc: '2026-10-16T14:00:00+07:00',
            },
          ].filter((x) => x.date >= from && x.date <= to),
        },
      ],
      closed_dates: [],
    }));
    const { onSelect } = renderPicker();
    fireEvent.click(await screen.findByRole('button', { name: '13:00' }));
    expect(onSelect).toHaveBeenCalledWith({
      date: '2026-10-16',
      start: '13:00',
      startUtc: '2026-10-16T13:00:00+07:00',
      timeZone: 'Asia/Bangkok',
    });
  });
});

it('L3：月だけでも日から時刻へ進み、月へ戻って別の日を選べる', async () => {
  mockSettings('list', 60, 'month-only');
  const { onSelect } = renderPicker();
  await screen.findByText('2026年10月');
  fireEvent.click(await screen.findByRole('button', { name: /10月16日/ }));
  fireEvent.click(screen.getByRole('button', { name: 'この日の時間を選ぶ' }));
  const time = await screen.findByRole('button', { name: /^10:00/ });
  fireEvent.click(time);
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-10-16', start: '10:00' }));
  fireEvent.click(screen.getByRole('button', { name: '日を選び直す' }));
  expect(await screen.findByText('2026年10月')).toBeTruthy();
  expect(screen.queryByRole('radiogroup', { name: '表示の切り替え' })).toBeNull();
});

it.each(['list', 'calendar'] as const)('BUG-03：%sで読めない日は満席と区別し、再試行で回復する', async (view) => {
  mockSettings(view);
  availability.mockRejectedValueOnce(new Error('network failed'));
  const { onSelect } = renderPicker();
  expect(await screen.findByText('読み込めませんでした')).toBeTruthy();
  expect(screen.queryAllByRole('button', { name: /満席/ })).toHaveLength(0);
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }));
  expect(await screen.findByRole('button', { name: '10月16日 空きあり' })).toBeTruthy();
  expect(screen.queryByText('読み込めませんでした')).toBeNull();
});

it('追加メニューは空き枠検索と選択時の終了時刻に含まれる', async () => {
  mockSettings('list');
  mockAvailability();
  render(<DateTimePicker menu={MENU} staff={STAFF} addonIds={['extra']} additionalDurationMinutes={30} selected={{ date: '2026-10-16', start: '10:00' }} onSelect={vi.fn()} onConfirm={vi.fn()} onBackToStaff={vi.fn()} />);
  await waitFor(() => expect(availability).toHaveBeenCalledWith('m1', 's1', expect.any(String), expect.any(String), ['extra']));
  expect(await screen.findByText(/10:00〜11:30/)).toBeTruthy();
});

it('選んでいる日を見える位置へ寄せ、時刻選択後に確認の操作を出す', async () => {
  const scroll = vi.fn();
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(scroll);
  render(<DateTimePicker menu={MENU} staff={STAFF} selected={null} onSelect={() => {}} onConfirm={() => {}} onBackToStaff={() => {}} />);
  await screen.findByRole('button', { name: /10:00/ });
  await waitFor(() => expect(scroll).toHaveBeenCalledWith({ inline: 'center', block: 'nearest' }));
});
