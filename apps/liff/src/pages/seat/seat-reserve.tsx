import { defaultRestaurantReservationForm,restaurantReservationAnswerError } from '@line-crm/shared';
import { useRequestGeneration } from '../../lib/use-request-generation.js';
import { FieldError } from '../../components/forms/controls.js';
import CourseChoice from '../../components/course-choice.js';
import Card from '../../components/ui/card.js';
import Badge from '../../components/ui/badge.js';
import { useUrlStep } from '../../lib/use-url-step.js';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import liff from '../../lib/liff-runtime.js';
import type { RestaurantCustomerBooking, RestaurantLateArrivalPolicy, RestaurantUnavailableReason } from '@line-crm/shared';
import LiffHeader from '../../components/ui/liff-header.js';
import LiffLookScope from '../../components/liff-look-scope.js';
import Stepper from '../../components/ui/Stepper.js';
import BottomBar from '../../components/ui/bottom-bar.js';
import Button from '../../components/ui/button/index.js';
import Icon from '../../components/ui/icon.js';
import ConfirmDialog from '../../components/ui/confirm-dialog.js';
import LoadingView from '../../components/loading-view.js';
import LoadErrorView from '../../components/load-error-view.js';
import StatusView from '../../components/ui/status-view.js';
import { restaurantBookingApi } from '../../lib/api.js';
import { logFailure } from '../../lib/user-message.js';
import {
  addDays,
  dayChips,
  dayReason,
  hasOpenSlot,
  lateRule,
  longDate,
  newRequestId,
  normalizePhone,
  noteProblem,
  phoneProblem,
  seatText,
  seatErrorMessage,
  upcomingBookings,
  zonedParts,
  zonedToday,
  type DayChip,
} from '../../lib/seat-reserve.js';
import SeatWaitlistSheet from '../../components/seat-waitlist-sheet.js';
import SeatPick, { type DaySlots } from './seat-pick.js';
import SeatConfirm from './seat-confirm.js';
import SeatDone from './seat-done.js';
import SeatMine from './seat-mine.js';
import RestaurantMenu from '../restaurant-menu/menu.js';

import type { View, Course, Store } from './seat-reserve-types.js';

const STEPS = ['人数・日時・コース', '確認'];
const DEFAULT_GUESTS = 2;

/**
 * 飲食店の席の予約 (★V8 sAnyy)。入口は ?page=restaurant&token=...。
 * token は管理画面の「LINE 予約の URL」から店を決める。?view=mine で変更・取り消しから開く。
 * 流れ：① 人数と日時 → 仮押さえ → ② 確認 (残り時間) → 確定 → ③ 受け付けました。
 * 変更は ① で選び直して ② で「この内容に変える」(仮押さえなし・版を指定)。
 */
export default function SeatReserve() {
  const route = useParams();
  const [params, setParams] = useSearchParams();
  const legacy = window.location.pathname.match(/\/restaurant\/reserve\/([^/]+)$/)?.[1];
  let legacyToken='';try{legacyToken=legacy ? decodeURIComponent(legacy):'';}catch{}
  const token = route.token ?? params.get('token') ?? legacyToken;
  const initialGuests=Number(params.get('guestCount'));
  const defaultGuests=Number.isInteger(initialGuests)&&initialGuests>=1&&initialGuests<=100 ? initialGuests:DEFAULT_GUESTS;
  const [courses,setCourses] = useState<Course[]>([]);
  const [courseId,setCourseId] = useState<string|null>(null);
  const courseRef = useRef<string|null>(null);
  const [referrals,setReferrals] = useState<import('@line-crm/shared').RestaurantReferralCandidate[]>([]);
  const [referralLoaded,setReferralLoaded] = useState(false);
  const [referralError,setReferralError] = useState(false);
  const busyRef = useRef(false);
  const showMine = params.get('view') === 'mine';
  const [store, setStore] = useState<Store | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'missing' | 'ready'>('loading');
  const [view, setView] = useUrlStep<View>(params.get('view') === 'mine' ? 'mine' : 'pick', { search: params.toString(), write: (query, replace) => setParams(query, { replace }) });
  const [today, setToday] = useState('');
  const [chips, setChips] = useState<DayChip[]>([]);
  const [days, setDays] = useState<Record<string, DaySlots>>({});
  /* 空きが無い日の理由と、店の遅れたときの決まり（空きの口が返す）。 */
  const [reasons, setReasons] = useState<Record<string, RestaurantUnavailableReason | undefined>>({});
  const [late, setLate] = useState<RestaurantLateArrivalPolicy | null>(null);
  /* ご要望・電話（任意）。確定の口へ送る。 */
  const [note, setNote] = useState('');
  const [phone, setPhone] = useState('');
  const [allergy,setAllergy]=useState('');
  const [guestCount, setGuestCount] = useState(defaultGuests);
  const [date, setDate] = useState('');
  const [startsAt, setStartsAt] = useState<string | null>(null);
  const [cancelMinutes, setCancelMinutes] = useState<number | null>(null);
  const [hold, setHold] = useState<RestaurantCustomerBooking | null>(null);
  const [holdMinutes, setHoldMinutes] = useState(0);
  const [expired, setExpired] = useState(false);
  const [target, setTarget] = useState<RestaurantCustomerBooking | null>(null);
  const [result, setResult] = useState<{ booking: RestaurantCustomerBooking; changed: boolean } | null>(null);
  const [mine, setMine] = useState<RestaurantCustomerBooking[]>([]);
  const [cancelling, setCancelling] = useState<RestaurantCustomerBooking | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [customerName, setCustomerName] = useState('LINEのお客さま');
  const [showMenu, setShowMenu] = useState(false);
  const menuButton = useRef<HTMLButtonElement | null>(null);
  const menuOrigin = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (menuOrigin.current === null) return;
    if (showMenu) {
      window.scrollTo(0, 0);
      return;
    }
    window.scrollTo(0, menuOrigin.current);
    menuOrigin.current = null;
    menuButton.current?.focus({ preventScroll: true });
  }, [showMenu]);

  // 再実行だけ同じ受付番号を使う。選び直したら新しくする。
  const requestId = useRef<string | null>(null);
  const generation = useRef(0);

  const requestContext = JSON.stringify([token, store?.id, view, target?.id, date, guestCount, startsAt, courseId]);
  const mutation = useRequestGeneration(requestContext);
  useLayoutEffect(() => { busyRef.current = false; setBusy(false); }, [requestContext]);

  const [waitlistSlot, setWaitlistSlot] = useState<{ startsAt: string; guestCount: number } | null>(null);
  const currentSlots=Array.isArray(days[date]) ? days[date] as import('@line-crm/shared').RestaurantCustomerSlot[] : null;
  const fullStartsAt=currentSlots?.find(s=>!s.available)?.startsAt;
  const canRefer=!!currentSlots && (!!fullStartsAt || !hasOpenSlot(currentSlots));
  useEffect(()=>{
    if(!store || !canRefer){setReferrals([]);setReferralLoaded(false);return;}
    let live=true;setReferralLoaded(false);setReferralError(false);
    restaurantBookingApi.referrals(store.id,date,guestCount,fullStartsAt,courseId).then(r=>{if(live){setReferrals(r.data);setReferralLoaded(true);}}).catch(()=>{if(live)setReferralError(true);});
    return()=>{live=false;};
  },[store?.id,date,guestCount,courseId,fullStartsAt,canRefer]);

  const fetchDay = useCallback(
    async (s: Store, d: string, guests: number, gen: number) => {
      setDays((prev) => ({ ...prev, [d]: 'loading' }));
      try {
        const r = await restaurantBookingApi.availability(s.id, d, guests, courseRef.current);
        if (gen !== generation.current) return;
        setCancelMinutes(r.data.cancelDeadlineMinutesBefore);
        setLate(r.data.lateArrivalPolicy ?? null);
        setReasons((prev) => ({ ...prev, [d]: hasOpenSlot(r.data.slots) ? undefined : dayReason(r.data.slots, r.data.unavailableReason) }));
        setDays((prev) => ({ ...prev, [d]: r.data.slots }));
      } catch (e) {
        if (gen !== generation.current) return;
        const status = (e as { status?: number }).status;
        // 400 は予約できる日の外・営業時間が無い日。休みと同じに扱う。
        if (status !== 400) logFailure('seat-availability', e);
        setDays((prev) => ({ ...prev, [d]: status === 400 ? 'closed' : 'error' }));
      }
    },
    [],
  );

  const loadDays = useCallback(
    (s: Store, list: string[], guests: number) => {
      const gen = ++generation.current;
      setDays({});
      return Promise.all(list.map((d) => fetchDay(s, d, guests, gen)));
    },
    [fetchDay],
  );

  const loadMine = useCallback(async (s: Store) => {
    const r = await restaurantBookingApi.mine(s.id);
    setMine(upcomingBookings(r.data));
  }, []);

  const load = useCallback(async () => {
    setLoadState('loading');
    try {
      const link = await restaurantBookingApi.link(token);
      const s = link.data;
      const t = zonedToday(s.timezone);
      const c = dayChips(t);
      const cset = await restaurantBookingApi.courses(s.id);
      setCourses(cset.data);
      setStore(s);
      setToday(t);
      setChips(c);
      const requested=params.get('date');
      const selected=requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) && requested>=t ? requested:t;
      setDate(selected);
      await loadDays(s, [...c.map((x) => x.date), addDays(t, c.length),selected], defaultGuests);
      if (showMine) await loadMine(s);
      setLoadState('ready');
    } catch (e) {
      logFailure('seat-link', e);
      setLoadState((e as { status?: number }).status === 404 ? 'missing' : 'error');
    }
  }, [token, loadDays, loadMine, showMine]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    liff
      .getProfile()
      .then((p) => p.displayName && setCustomerName(p.displayName))
      .catch((e) => logFailure('seat-profile', e));
  }, []);

  // 最初の日に空きが無ければ、空きのある最初の札の日を選んでおく。
  useEffect(() => {
    if (!chips.length || startsAt) return;
    const cur = days[date];
    if (Array.isArray(cur) && cur.some((x) => x.available)) return;
    if (chips.some((c) => days[c.date] === undefined || days[c.date] === 'loading')) return;
    const first = chips.find((c) => {
      const v = days[c.date];
      return Array.isArray(v) && v.some((x) => x.available);
    });
    if (first && first.date !== date && chips.some((c) => c.date === date)) setDate(first.date);
  }, [chips, days, date, startsAt]);

  // 仮押さえの送信中は選び直させない（表示は B・確定は A の食い違いを作らない）。
  function pickGuests(n: number) {
    if (!store || busy || n === guestCount) return;
    setGuestCount(n);
    setReferrals([]);setReferralLoaded(false);
    setStartsAt(null);
    setError(null);
    requestId.current = null;
    const list = [...chips.map((x) => x.date), addDays(today, chips.length)];
    if (!list.includes(date)) list.push(date);
    void loadDays(store, list, n);
  }

  function pickDate(d: string) {
    if (!store || busy) return;
    setDate(d);
    setReferrals([]);setReferralLoaded(false);
    setStartsAt(null);
    setError(null);
    requestId.current = null;
    if (days[d] === undefined || days[d] === 'error') void fetchDay(store, d, guestCount, generation.current);
  }

  function pickTime(s: string) {
    if (busy) return;
    setStartsAt(s);
    setError(null);
    requestId.current = null;
  }

  const slot = (() => {
    const v = days[date];
    return Array.isArray(v) ? v.find((x) => x.startsAt === startsAt) ?? null : null;
  })();

  async function proceed() {
    if (!store || !slot || busyRef.current) return;
    const requestGeneration = mutation.begin();
    busyRef.current=true;
    setError(null);
    if (target) {
      setView('confirm');
      busyRef.current=false;
      return;
    }
    setBusy(true);
    requestId.current ??= newRequestId();
    try {
      const r = await restaurantBookingApi.hold({
        storeId: store.id,
        startsAt: slot.startsAt,
        guestCount,
        requestId: requestId.current,
        courseId,
      });
      if (!mutation.isCurrent(requestGeneration)) return;
      setHold(r.data);
      setHoldMinutes(
        r.data.holdExpiresAt ? Math.max(1, Math.round((Date.parse(r.data.holdExpiresAt) - Date.now()) / 60000)) : 0,
      );
      setExpired(false);
      setView('confirm');
    } catch (e) {
      if (!mutation.isCurrent(requestGeneration)) return;
      logFailure('seat-hold', e);
      setError(seatErrorMessage(e));
      // 届いたか分からない失敗 (通信・500) は、次の押下で同じ受付番号を送って二重にしない。
      // 断られた (409 など) ときだけ新しい番号にする。
      const status = (e as { status?: number }).status;
      if (status !== undefined && status < 500) requestId.current = null;
      if ((e as { body?: { error?: string } }).body?.error === 'slot_conflict') {
        setStartsAt(null);
        void fetchDay(store, date, guestCount, generation.current);
      }
    } finally {
      if (!mutation.isCurrent(requestGeneration)) return;
      busyRef.current=false;
      setBusy(false);
    }
  }

  async function finish() {
    if (!store || busyRef.current) return;
    const problem = target ? '' : restaurantReservationAnswerError(store.reservationForm?.definition??defaultRestaurantReservationForm(),{customerName,customerPhone:phone,allergyNote:allergy,note}) || noteProblem(note) || phoneProblem(phone);
    if (problem) {
      setError(problem);
      return;
    }
    const requestGeneration = mutation.begin();
    busyRef.current=true;
    setBusy(true);
    setError(null);
    try {
      const r = target
        ? await restaurantBookingApi.reschedule(target.id, {
            expectedVersion: target.version,
            startsAt: slot!.startsAt,
            guestCount,
            courseId,
          })
        : await restaurantBookingApi.confirm(hold!.id, hold!.version, {
            note: note.trim() || null,
            customerPhone: normalizePhone(phone) || null,
            customerName:customerName.trim(),allergyNote:allergy.trim()||null,expectedFormVersion:store.reservationForm?.version??0,
            ...(params.get('referralId') ? {referralId:params.get('referralId')!} : {}),
          });
      if (!mutation.isCurrent(requestGeneration)) return;
      setResult({ booking: r.data, changed: !!target });
      setHold(null);
      setTarget(null);
      requestId.current = null;
      setView('done');
    } catch (e) {
      if (!mutation.isCurrent(requestGeneration)) return;
      logFailure(target ? 'seat-reschedule' : 'seat-confirm', e);
      setError(seatErrorMessage(e));
      if((e as {body?:{error?:string}}).body?.error==='reservation_form_changed'){
        try{const fresh=await restaurantBookingApi.link(token);if(mutation.isCurrent(requestGeneration))setStore(fresh.data);}catch{setError('予約フォームを読み直せませんでした。通信を確認して、もう一度お試しください');}
      }
      if ((e as { body?: { error?: string } }).body?.error === 'hold_expired') setExpired(true);
    } finally {
      if (!mutation.isCurrent(requestGeneration)) return;
      busyRef.current=false;
      setBusy(false);
    }
  }

  function backToPick() {
    mutation.invalidate();
    busyRef.current = false;
    setBusy(false);
    // 仮押さえは返す (ほかのお客さまが選べるように)。失敗しても期限で外れるので止めない。
    if (hold && !expired) {
      restaurantBookingApi.cancel(hold.id, hold.version).catch((e) => logFailure('seat-release', e));
    }
    setHold(null);
    setExpired(false);
    setError(null);
    requestId.current = null;
    if (store) void fetchDay(store, date, guestCount, generation.current);
    setView('pick');
  }

  async function openMine() {
    if (!store) return;
    setError(null);
    setView('mine');
    try {
      await loadMine(store);
    } catch (e) {
      logFailure('seat-mine', e);
      setError('ご予約を読み込めませんでした。電波のよいところで、もう一度お試しください。');
    }
  }

  function startChange(b: RestaurantCustomerBooking) {
    if (!store) return;
    const d = zonedParts(b.startsAt, store.timezone).date;
    setTarget(b);
    courseRef.current=b.courseId ?? null;
    setCourseId(courseRef.current);
    setGuestCount(b.guestCount);
    setDate(d);
    setStartsAt(null);
    setError(null);
    const list = [...chips.map((x) => x.date), addDays(today, chips.length)];
    if (!list.includes(d)) list.push(d);
    void loadDays(store, list, b.guestCount);
    setView('pick');
  }

  async function doCancel() {
    if (!store || !cancelling) return;
    setBusy(true);
    setError(null);
    try {
      await restaurantBookingApi.cancel(cancelling.id, cancelling.version);
      setCancelling(null);
      await loadMine(store);
    } catch (e) {
      logFailure('seat-cancel', e);
      setError(seatErrorMessage(e));
    } finally {
      busyRef.current=false;
      setBusy(false);
    }
  }

  function newBooking() {
    courseRef.current=null;
    setCourseId(null);
    setNote('');
    setPhone('');
    setAllergy('');
    setTarget(null);
    setResult(null);
    setStartsAt(null);
    setError(null);
    setView('pick');
  }

  if (loadState === 'loading') return (
    <LiffLookScope className="restaurant-fusion min-h-screen bg-canvas">
      <LiffHeader title={store?.reservationForm?.definition.title??'ご予約'} />
      <div className="mx-auto w-full max-w-md px-4 pt-3"><LoadingView /></div>
    </LiffLookScope>
  );
  if (loadState === 'missing')
    return (
      <LiffLookScope className="restaurant-fusion min-h-screen bg-canvas">
        <LiffHeader title={store?.reservationForm?.definition.title??'ご予約'} />
        <div className="mx-auto w-full max-w-md px-4 pt-3">
          <StatusView
            icon="calendar-x"
            title="予約のページが見つかりません"
            body="お店から届いたリンクを、もう一度開いてください。"
          />
        </div>
      </LiffLookScope>
    );
  if (loadState === 'error' || !store)
    return (
      <LiffLookScope className="restaurant-fusion min-h-screen bg-canvas">
        <LiffHeader title={store?.reservationForm?.definition.title??'ご予約'} />
        <div className="mx-auto w-full max-w-md px-4 pt-3">
          <LoadErrorView note="ご予約はなくなっていません。" onRetry={() => void load()} />
        </div>
      </LiffLookScope>
    );

  if (showMenu && view === 'pick') {
    return <RestaurantMenu storeId={store.id} onBack={() => setShowMenu(false)} />;
  }

  const minutes = cancelMinutes ?? 0;
  return (
    <LiffLookScope className={`${view==='pick'||view==='confirm'?'restaurant-fusion ':''}min-h-screen bg-canvas`}>
      <LiffHeader title={view==='confirm'?'確認':store.reservationForm?.definition.title??'ご予約'} />
      <div className={`mx-auto w-full max-w-md ${view==='done'?'px-6 pt-0':`px-4 ${view==='pick'||view==='confirm'?'pt-4':'pt-3'}`}`}>
      {(view === 'pick' || view === 'confirm') && (
        <Stepper appearance="restaurant" steps={STEPS} current={view === 'pick' ? 0 : STEPS.length - 1} />
      )}
        <div key={view} className={`liff-step ${view==='pick'||view==='confirm'?'mt-3 space-y-3 pb-28':''}`}>
          {view === 'pick' && (
            <>
            <SeatPick
              guestLabel={store.reservationForm?.definition.fields.find(field=>field.id==='guestCount')?.label}
              dateLabel={store.reservationForm?.definition.fields.find(field=>field.id==='dateTime')?.label}
              timeZone={store.timezone}
              today={today}
              chips={chips}
              days={days}
              reasons={reasons}
              guestCount={guestCount}
              date={date}
              startsAt={startsAt}
              error={error}
              onGuest={pickGuests}
              onDate={pickDate}
              onTime={pickTime}
              onRetry={() => void fetchDay(store, date, guestCount, generation.current)}
            />
            {currentSlots?.filter(s => !s.available && (!s.unavailableReason || s.unavailableReason === 'full') && !reasons[date]?.includes('closed') && reasons[date] !== 'private_event' && Date.parse(s.startsAt) > Date.now() + 3600000).map(s => <Button key={s.startsAt} variant="notify-text" aria-label={`${zonedParts(s.startsAt, store.timezone).hm} 空いたら知らせる`} onClick={() => setWaitlistSlot({ startsAt: s.startsAt, guestCount })}>{zonedParts(s.startsAt, store.timezone).hm} 空いたら知らせる</Button>)}
            {waitlistSlot && <SeatWaitlistSheet storeId={store.id} storeName={store.name} startsAt={waitlistSlot.startsAt} guestCount={waitlistSlot.guestCount} onClose={() => setWaitlistSlot(null)} />}
            {canRefer && <section className="space-y-3" aria-label="系列店の案内">
              {referrals.length>0 && <h2 className="text-[13px] leading-5 font-bold text-ink">近くの系列店なら空いています</h2>}
              {referralError && <><FieldError tone="inherit">空きを読み込めませんでした。</FieldError><Button variant="restaurant-control" disabled={busy} onClick={async()=>{
                setBusy(true);setReferralError(false);
                try{setReferrals((await restaurantBookingApi.referrals(store.id,date,guestCount,fullStartsAt,courseId)).data);setReferralLoaded(true);}catch{setReferralError(true);}finally{setBusy(false);}
              }}>もう一度読み込む</Button></>}
              {referralLoaded && !referrals.length && <p className="text-xs leading-[18px] text-liff-sub">案内できるお店の空きがありません。ほかの日を選んでください。</p>}
              {referrals.map(r=><Card key={r.storeId} className="space-y-4 p-6">
                <div className="space-y-0.5"><h3 className="truncate text-[15px] leading-[23px] font-bold text-ink" title={r.storeName}>{r.storeName}</h3><p className="text-xs leading-[18px] text-liff-sub">{r.distanceKm.toFixed(1)}km</p></div>
                <div className="space-y-2.5">
                  <Badge tone="confirmed" size="md">{`${zonedParts(r.startsAt,store.timezone).hm} 空きあり`}</Badge>
                  <div><Button variant="restaurant-control" disabled={busy} onClick={async()=>{
                    if(busyRef.current)return;busyRef.current=true;setBusy(true);setReferralError(false);
                    try {const next=await restaurantBookingApi.referral({storeId:store.id,targetStoreId:r.storeId,date,startsAt:r.startsAt,guestCount,courseId});window.location.assign(next.data.bookingUrl);}
                    catch{setReferralError(true);}finally{busyRef.current=false;setBusy(false);}
                  }}><Icon name="arrow-right" className="h-4 w-4 shrink-0" />この店で予約する</Button></div>
                </div>
              </Card>)}
            </section>}
            {<CourseChoice compact courses={courses} value={courseId} disabled={busy} onChange={id=>{
              setReferrals([]);setReferralLoaded(false);
              courseRef.current=id; setCourseId(id); setStartsAt(null); requestId.current=null;
              void loadDays(store,[...chips.map(c=>c.date),date],guestCount);
            }} />}

            <div className="flex justify-end">
              <Button ref={menuButton} variant="text-action"
                disabled={busy} onClick={() => {
                  menuOrigin.current = window.scrollY;
                  setShowMenu(true);
                }}>
                <Icon name="utensils" className="h-4 w-4" />メニューを見る
              </Button>
            </div>

            </>
          )}
          {view === 'confirm' && slot && (
            <SeatConfirm
                timeZone={store.timezone}
                storeName={store.name}
                courseName={courses.find(c=>c.id===courseId)?.name ?? hold?.courseName ?? null}
                customerName={target?.customerName??customerName}
                definition={store.reservationForm?.definition}
                onName={setCustomerName}
                allergy={target?.allergyNote??allergy}
                onAllergy={setAllergy}
                // 確認は仮押さえした中身で出す（確定はこの仮押さえを送る）。
                startsAt={!target && hold ? hold.startsAt : slot.startsAt}
                endsAt={!target && hold ? hold.endsAt : slot.endsAt}
                guestCount={!target && hold ? hold.guestCount : guestCount}
                cancelDeadlineMinutesBefore={minutes}
                seat={seatText(target ? target.seatType : hold?.seatType, slot.seatTypes)}
                late={lateRule(late)}
                note={target ? (target.note ?? '') : note}
                phone={target ? (target.customerPhone ?? '') : phone}
                onNote={setNote}
                onPhone={setPhone}
                holdExpiresAt={target ? null : (hold?.holdExpiresAt ?? null)}
                holdMinutes={holdMinutes}
                reschedule={!!target}
                error={error}
                onBack={backToPick}
                onExpired={() => setExpired(true)}
              />
          )}
          {view === 'done' && result && (
            <SeatDone
              booking={result.booking} storeName={store.name}
              timeZone={store.timezone}
              cancelDeadlineMinutesBefore={minutes}
              changed={result.changed}
              completionMessage={store.reservationForm?.definition.completionMessage}
            />
          )}
          {view === 'mine' && (
            <SeatMine
              rows={mine}
              timeZone={store.timezone}
              cancelDeadlineMinutesBefore={minutes}
              error={error}
              onChange={startChange}
              onCancel={(b) => {
                setError(null);
                setCancelling(b);
              }}
            />
          )}
        </div>
      </div>

      {view === 'pick' && (
        <BottomBar appearance="restaurant">
          {!slot && !busy && Array.isArray(currentSlots) ? (
            <p role="status" className="text-center text-xs leading-[18px] text-liff-sub">
              {hasOpenSlot(currentSlots) ? '時刻を選んでください' : '空いている時刻がありません。ほかの日を選んでください'}
            </p>
          ) : null}
          <Button variant="restaurant-primary" aria-label={busy ? 'お取りしています…' : 'この時刻で進む'} disabled={!slot || busy} onClick={() => void proceed()}>
            {busy ? 'お取りしています…' : '次へ'}
          </Button>
          {target && (
            <Button variant="text"
              type="button"
              onClick={() => void openMine()}
            >
              キャンセル
            </Button>
          )}
        </BottomBar>
      )}
      {view === 'confirm' && (
        <BottomBar appearance="restaurant">
          <Button variant="restaurant-primary" aria-label={target ? 'この内容に変える' : '予約を確定する'} disabled={busy || expired} onClick={() => void finish()}>
            {busy ? '送信中…' : target ? 'この内容に変える' : '予約する'}
          </Button>
        </BottomBar>
      )}
      {view === 'done' && (
        <BottomBar appearance="form">
          <Button variant="primary" onClick={() => liff.closeWindow()}>
            LINEに戻る
          </Button>
          <Button variant="secondary" onClick={() => void openMine()}>
            予約を変える・取り消す
          </Button>
        </BottomBar>
      )}
      {view === 'mine' && (
        <BottomBar>
          <Button variant="primary" onClick={() => liff.closeWindow()}>
            LINEに戻る
          </Button>
          <Button variant="secondary" onClick={newBooking}>
            新しく予約する
          </Button>
        </BottomBar>
      )}

      <ConfirmDialog
        open={!!cancelling}
        title="ご予約を取り消しますか"
        description={
          cancelling
            ? (() => {
                const p = zonedParts(cancelling.startsAt, store.timezone);
                return `${longDate(p.date)}${p.hm}〜・${cancelling.guestCount}名のご予約を取り消します。元に戻せません。`;
              })()
            : ''
        }
        confirmLabel="取り消す"
        cancelLabel="閉じる"
        destructive
        busy={busy}
        error={cancelling ? (error ?? undefined) : undefined}
        onConfirm={() => void doCancel()}
        onCancel={() => {
          setCancelling(null);
          setError(null);
        }}
      />
    </LiffLookScope>
  );
}
