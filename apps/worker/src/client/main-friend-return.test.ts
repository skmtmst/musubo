// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const opened = vi.hoisted(() => ({ salon: vi.fn(), stamps: vi.fn(), coupon: vi.fn(), restaurant: vi.fn(), event: vi.fn(), webinar: vi.fn(), research: vi.fn(), affiliate: vi.fn(), member: vi.fn(), book: vi.fn(), form: vi.fn() }));
vi.mock('./salon-booking/main.js', () => ({ mountSalonBooking: opened.salon }));
vi.mock('./visit-stamps/main.js', () => ({ mountVisitStamps: opened.stamps }));
vi.mock('./entry-route-coupon/main.js', () => ({ mountEntryRouteCoupon: opened.coupon }));
vi.mock('./restaurant/main.js', () => ({ mountRestaurant: opened.restaurant }));
vi.mock('./event-booking/main.js', () => ({ mountEventBooking: opened.event }));
vi.mock('./webinar/main.js', () => ({ mountWebinar: opened.webinar }));
vi.mock('../../../liff/src/research-entry.js', () => ({ mountResearch: opened.research }));
vi.mock('./affiliate/main.js', () => ({ mountAffiliate: opened.affiliate }));
vi.mock('./nen-member/main.js', () => ({ mountNenMember: opened.member }));
vi.mock('./booking.js', () => ({ initBooking: opened.book }));
vi.mock('./form.js', () => ({ initForm: opened.form }));

beforeEach(() => {
  vi.resetModules();
  Object.values(opened).forEach(fn => fn.mockClear());
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal('liff', {
    init: vi.fn().mockResolvedValue(undefined), isLoggedIn: () => true, isInClient: () => true,
    getProfile: vi.fn().mockResolvedValue({ userId: 'friend', displayName: 'お客さま' }),
    getIDToken: () => 'token', getAccessToken: () => 'access',
    getFriendship: vi.fn().mockResolvedValue({ friendFlag: false }), login: vi.fn(),
  });
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(new Response(JSON.stringify(
    url.startsWith('/api/liff/config') ? { success: true, data: {} } : { success: true, data: { userId: 'uuid' } },
  )))));
});
afterEach(() => { vi.unstubAllGlobals(); window.history.replaceState(null, '', '/'); });

test.each([
  ['salon-book&view=history&menu_id=m1', 'salon'],
  ['visit-stamps&card=card1&qr=qr1', 'stamps'],
  ['restaurant&token=seat1', 'restaurant'],
  ['restaurant-menu&token=seat1', 'restaurant'],
  ['event&id=event1&eventWaitlistToken=offer1', 'event'],
  ['event-me&tab=past', 'event'],
  ['webinar&slug=seminar1', 'webinar'],
  ['research&researchId=r1', 'research'],
  ['affiliate&crossAccountToken=cross1', 'affiliate'],
  ['nen-member&view=diary', 'member'],
  ['unused&couponRef=coupon1&ref=qr', 'coupon'],
] as const)('UI-02: 友だち追加後に %s と引数を保ち、1回だけ元の入口を開く', async (query, target) => {
  const original = `/?liffId=store1&page=${query}`;
  window.history.replaceState(null, '', original);
  await import('./main.js');
  await vi.waitFor(() => expect(document.getElementById('addFriendBtn')).toBeTruthy());
  expect(opened[target]).not.toHaveBeenCalled();
  vi.mocked((globalThis as unknown as { liff: { getFriendship: ReturnType<typeof vi.fn> } }).liff.getFriendship).mockResolvedValue({ friendFlag: true });
  document.dispatchEvent(new Event('visibilitychange'));
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(opened[target]).toHaveBeenCalledTimes(1));
  expect(window.location.pathname + window.location.search).toBe(original);
  if (query.startsWith('restaurant-menu')) expect(opened.restaurant.mock.calls[0]?.[2]).toBe('restaurant-menu');
  expect(document.body.textContent).not.toContain('登録完了');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(opened[target]).toHaveBeenCalledTimes(1);
});

test.each([['book&connectionId=calendar1', 'book'], ['form&id=form1', 'form']] as const)(
  'UI-02: 追加ゲートを持たない %s も指定した入口と引数で開く', async (query, target) => {
    window.history.replaceState(null, '', `/?liffId=store1&page=${query}`);
    await import('./main.js');
    await vi.waitFor(() => expect(opened[target]).toHaveBeenCalledTimes(1));
    expect(window.location.search).toContain(query);
  },
);

test.each(['/booking?waitlist=person1', '/booking?seat_waitlist=seat1&action=decline', '/booking/history'])('E3: 実際に案内する%sが現役の予約入口に届く', async path => {
  window.history.replaceState(null, '', `${path}${path.includes('?') ? '&' : '?'}liffId=store1`);
  vi.mocked((globalThis as unknown as { liff: { getFriendship: ReturnType<typeof vi.fn> } }).liff.getFriendship).mockResolvedValue({ friendFlag: true });
  await import('./main.js');
  await vi.waitFor(() => expect(opened.salon).toHaveBeenCalledTimes(1));
  expect(document.body.textContent).not.toContain('登録完了');
});

test.each(['/booking?waitlist=person1', '/booking?seat_waitlist=seat1&action=decline', '/booking/history'])('E3: SDKがliff.stateに包んだ%sからも本物のmainが予約を開く', async path => {
  window.history.replaceState(null, '', `/?liffId=store1&liff.state=${encodeURIComponent(path)}`);
  vi.mocked((globalThis as unknown as { liff: { getFriendship: ReturnType<typeof vi.fn> } }).liff.getFriendship).mockResolvedValue({ friendFlag: true });
  await import('./main.js');
  await vi.waitFor(() => expect(opened.salon).toHaveBeenCalledTimes(1));
  expect(window.location.pathname).toBe(path.split('?')[0]);
});
