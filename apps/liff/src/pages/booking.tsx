import { readCardSetupResume } from '../lib/card-setup-resume.js';
import { formatYen } from '@line-crm/shared';
import { useCustomerWords } from '../components/customer-style-scope.js';
import { useUrlStep } from '../lib/use-url-step.js';
import WaitlistOfferSheet from '../components/waitlist-offer-sheet.js';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import MenuList from '../components/menu-list.js';
import BookingStorePhotos from '../components/booking-store-photos.js';
import RepeatCard from '../components/repeat-card.js';
import StaffList, { nominationFee } from '../components/staff-list.js';
import DateTimePicker, { type SlotPick } from '../components/date-time-picker.js';
import Confirm from '../components/confirm.js';
import BookingPayment from '../components/booking-payment.js';
import Done from '../components/done.js';
import LiffHeader from '../components/ui/liff-header.js';
import LiffLookScope from '../components/liff-look-scope.js';
import Stepper from '../components/ui/Stepper.js';
import BottomBar from '../components/ui/bottom-bar.js';
import Button from '../components/ui/button/index.js';
import { api, type MenuItem, type StaffItem } from '../lib/api.js';
import PartyMenuStep, { PartyStaffStep, PartySummary } from '../components/party-step.js';
import { staffBookingPrice } from '../lib/booking-price.js';
import { slotStartsAtIso } from '../lib/datetime.js';
import { initialParty, partyCapable, totals, type PartyState } from '../lib/party.js';

type Step = 'menu' | 'staff' | 'datetime' | 'confirm' | 'payment' | 'done';


/**
 * ご予約 (★V8・→→/→→)。手順は4つ。
 * 進む操作は下の操作の帯に1つだけ。API・画面の流れ・保存の中身はそのまま。
 * 上の帯は ×・題・店名 (LiffHeader)。手順の印は短い緑の棒 (Stepper)。
 */
export default function Booking() {
  const words = useCustomerWords();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const isPeek = params.get('mode') === 'peek';

  const [cardResume] = useState(() => params.get('card_setup') ? readCardSetupResume() : null);
  const [initialMenuId] = useState(cardResume ? null : params.get('menu_id'));
  const menuTouched = useRef(false);
  const [step, setStep] = useUrlStep<Step>('menu', { search: params.toString(), write: (query, replace) => setParams(query, { replace }) });
  const [menu, setMenu] = useState<MenuItem | null>(cardResume?.menu ?? null);
  const [addonStatus, setAddonStatus] = useState<'idle' | 'loading' | 'failed' | 'ready'>('idle');
  const addonGeneration = useRef(0);
  useEffect(() => () => { addonGeneration.current++; }, []);
  const [staff, setStaff] = useState<StaffItem | null>(cardResume?.staff ?? null);
  /* 同伴・追加メニュー（B5）。メニューが許したときだけ使う。1 人で追加なしなら今までどおり。 */
  const [party, setParty] = useState<PartyState>(() => cardResume?.party ?? initialParty());
  const [changingMenu, setChangingMenu] = useState(false);
  const confirmBack = useRef<(() => void) | null>(null);
  const [slot, setSlot] = useState<SlotPick | null>(cardResume?.slot ?? null);
  const [bookingId, setBookingId] = useState<string | null>(null);
  const [paymentDue, setPaymentDue] = useState(false);
  /* キャンセル料の決まりがオンの店は、確認の段から手順の帯に「お支払い」（カードの登録）を出す（kwC8E）。 */
  const [cardStep, setCardStep] = useState(false);
  const [prepayNotice, setPrepayNotice] = useState<string | null>(null);
  const [doneStatus, setDoneStatus] = useState('requested');
  // 予約のルール「ご利用先が承認してから確定する」。読めなければ承認あり扱い。
  const [autoConfirm, setAutoConfirm] = useState(false);
  const [cancelDeadline, setCancelDeadline] = useState<number | null>(null);
  useEffect(() => { if (cardResume) { loadAddons(cardResume.menu); setStep('confirm'); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!initialMenuId) return;
    let alive = true;
    api.menus().then(({ menus }) => {
      if (!alive || menuTouched.current) return;
      const selected = menus.find(item => item.id === initialMenuId);
      if (selected) { setMenu(selected); loadAddons(selected); setStep('staff'); }
    }).catch(() => { /* 非公開・削除済み・取得失敗は通常の選択へ戻す。 */ });
    return () => { alive = false; };
  }, [initialMenuId]);
  useEffect(() => {
    let alive = true;
    api
      .bookingSettings()
      .then((r) => {
        if (alive) { setAutoConfirm(r.approval_mode === 'automatic'); setCancelDeadline(r.cancel_deadline_minutes_before ?? null); }
      })
      .catch(() => {
        if (alive) setAutoConfirm(false);
      });
    return () => {
      alive = false;
    };
  }, []);
  // 読み込み中・失敗の間は下の帯を出さない (押せないボタンの飾りを置かない)。
  const [stepReady, setStepReady] = useState(false);
  const [emptyDatetime, setEmptyDatetime] = useState(false);
  useEffect(() => {
    setStepReady(false);
  }, [step]);

  function exitPeekToBooking() {
    // peek モードを抜けて通常フローへ。同じ menu/staff/slot を持ち回したまま step を進める。
    const next = new URLSearchParams(params);
    next.delete('mode');
    next.set('step', 'confirm');
    setStep('confirm');
    navigate({ pathname: '/booking', search: next.toString() }, { replace: true });
  }

  /** 追加メニューを確認できるまで予約を進めない。 */
  function loadAddons(m: MenuItem) {
    const generation = ++addonGeneration.current;
    setAddonStatus('loading');
    Promise.resolve().then(() => api.addons(m.id)).then((addons) => {
      if (generation !== addonGeneration.current) return;
      setMenu((cur) => (cur && cur.id === m.id ? { ...cur, addons } : cur));
      setAddonStatus('ready');
    }).catch(() => {
      if (generation === addonGeneration.current) setAddonStatus('failed');
    });
  }

  function pickMenu(m: MenuItem) {
    menuTouched.current = true;
    // 選び直したら後の選択は捨てる (古い担当・日時のまま送らない)。
    if (m.id !== menu?.id) {
      setStaff(null);
      setSlot(null);
      setParty(initialParty());
    }
    setChangingMenu(false);
    setMenu(m);
    loadAddons(m);
  }

  function pickStaff(s: StaffItem) {
    if (s.id !== staff?.id) setSlot(null);
    setStaff(s);
    setParty(current => ({ ...current, members: current.members.map((member, index) => index === 0 ? { ...member, staff: s, designated: s.is_designation_optional !== 1 } : member) }));
  }

  function changeParty(next: PartyState) {
    setParty(next);
    setSlot(null);
  }

  /* 2 人以上・追加メニューあり。確認と送信を組の形にする。 */
  const addonsBlocked = menu !== null && addonStatus !== 'ready';
  const partyActive = party.size > 1 || party.members[0]?.addonIds.length > 0;
  const partyMode = step === 'menu' && !changingMenu && partyCapable(menu);
  const STEPS = [words.bookingContent, words.staff, '日時', '確認'];
  const steps = paymentDue || cardStep ? [...STEPS, 'お支払い'] : STEPS;
  const stepIndex =
    step === 'menu' ? 0 : step === 'staff' ? 1 : step === 'datetime' ? 2 : step === 'payment' ? 4 : 3;
  /**
   * メニュー・担当の読み込み中と失敗の間は、手順の印を出さない
   * (★V8 ・ は上の帯の下がすぐ骨組み・失敗の案内)。
   */
  const waiting = (step === 'menu' || step === 'staff') && !stepReady;

  return (
    <LiffLookScope className="min-h-screen bg-canvas">
      <LiffHeader title={words.bookingTitle} backLabel={step === 'confirm' ? '確かめを閉じて日時に戻る' : '戻る'} onBack={step === 'staff' ? () => setStep('menu') : step === 'datetime' ? () => setStep('staff') : step === 'confirm' ? () => (confirmBack.current ? confirmBack.current() : setStep('datetime')) : undefined} />
      {(params.get('waitlist')||params.get('seat_waitlist'))&&<WaitlistOfferSheet id={params.get('waitlist')||params.get('seat_waitlist')!} seat={!!params.get('seat_waitlist')} decline={params.get('action')==='decline'} onClose={()=>{const next=new URLSearchParams(params);next.delete('waitlist');next.delete('seat_waitlist');next.delete('action');navigate({pathname:'/booking',search:next.toString()},{replace:true});}} />}
      {step !== 'done' && !waiting && !(step === 'datetime' && emptyDatetime) && <Stepper steps={steps} current={stepIndex} />}
      <div className={`mx-auto w-full max-w-md px-4 pt-3 ${waiting ? 'pb-3' : 'pb-40'}`}>
        {/* ★A: ページを移らず、段が替わるたび中身だけ右から移り変わる。 */}
        <div key={step} className="liff-step">
        {addonsBlocked && menu ? (
          <div role="status" className="space-y-3 text-center">
            <p>{addonStatus === 'failed' ? '追加メニューを読み込めませんでした。もう一度お試しください。' : '追加メニューを読み込んでいます…'}</p>
            {addonStatus === 'failed' && <Button variant="secondary" onClick={() => loadAddons(menu)}>もう一度読み込む</Button>}
            <Button variant="text" onClick={() => { addonGeneration.current++; setMenu(null); setAddonStatus('idle'); setParty(initialParty()); setStep('menu'); }}>{`${words.bookingContent}を選び直す`}</Button>
          </div>
        ) : <>
        {step === 'menu' && partyMode && (
          <PartyMenuStep menu={menu!} party={party} onParty={changeParty} onChangeMenu={() => setChangingMenu(true)} />
        )}
        {step === 'menu' && !partyMode && (
          <div data-design-node="IruGD" className="space-y-3.5">
            <RepeatCard
              onRepeat={(m, s) => {
                pickMenu(m);
                pickStaff(s);
                setStep('datetime');
              }}
            />
            <MenuList selectedId={menu?.id ?? null} onSelect={pickMenu} onLoadState={setStepReady} />
            <BookingStorePhotos />
          </div>
        )}
        {step === 'staff' && menu && party.size > 1 && (
          <PartyStaffStep menu={menu} party={party} onParty={changeParty} onLoadState={setStepReady} />
        )}
        {step === 'staff' && menu && party.size === 1 && (
          <div data-design-node="biNP5">
            <StaffList
              key={menu.id}
              menu={menu}
              selectedId={staff?.id ?? null}
              onSelect={pickStaff}
              onLoadState={setStepReady}
            />
          </div>
        )}
        {step === 'datetime' && menu && staff && (
          <DateTimePicker
            key={`${menu.id}-${staff.id}-${party.members[0].addonIds.join(',')}`}
            addonIds={party.members[0].addonIds}
            additionalDurationMinutes={(menu.addons ?? []).filter(a => party.members[0].addonIds.includes(a.id)).reduce((sum, a) => sum + a.duration_minutes, 0)}
            menu={menu}
            staff={staff}
            hint={isPeek ? '空き状況の確認モードです' : undefined}
            selected={slot}
            onSelect={setSlot}
            onConfirm={isPeek ? exitPeekToBooking : () => setStep('confirm')}
            confirmLabel={isPeek ? 'この時間で予約に進む' : undefined}
            onBackToStaff={() => setStep('staff')}
            onEmptyState={setEmptyDatetime}
          />
        )}
        {step === 'confirm' && menu && staff && slot && (
          <Confirm
            menu={menu}
            staff={staff}
            slot={slot}
            cardResume={cardResume && cardResume.menu.id===menu.id && cardResume.staff.id===staff.id && slotStartsAtIso(cardResume.slot)===slotStartsAtIso(slot) && (cardResume.party?.size ?? 1)===party.size ? cardResume : null}
            cardSetupReturned={params.get('card_setup') === 'success' && !!cardResume && cardResume.menu.id===menu.id && cardResume.staff.id===staff.id && slotStartsAtIso(cardResume.slot)===slotStartsAtIso(slot) && (cardResume.party?.size ?? 1)===party.size}
            autoConfirm={autoConfirm}
            cancelDeadlineMinutesBefore={cancelDeadline}
            onPolicyChange={setCardStep}
            onPaymentChange={setPaymentDue}
            onBack={() => { setPaymentDue(false); setStep('datetime'); }}
            onRegisterBack={(fn) => { confirmBack.current = fn; }}
            party={partyActive ? party : undefined}
            onSubmitted={(result) => {
              setBookingId(result.bookingId);
              setDoneStatus(result.status);
              // お支払いありのときだけ支払いの段へ。なしの店では今までどおり完了へ。
              // 前払いのみの案内があるときは完了の段で案内と支払いへのボタンを出す。
              setPaymentDue(Boolean(result.payment));
              setPrepayNotice(result.prepayNotice);
              setStep(result.payment ? 'payment' : 'done');
            }}
          />
        )}
        {step === 'payment' && menu && staff && slot && bookingId && paymentDue && (
          <BookingPayment
            bookingId={bookingId}
            menuName={menu.name}
            initialAmount={partyActive ? totals(party, menu).price : staffBookingPrice(staff)}
            slot={slot}
            durationMinutes={partyActive ? totals(party, menu).minutes : staff.duration_minutes}
          />
        )}
        {step === 'done' && menu && staff && slot && (
          <Done
            menuName={menu.name}
            slot={slot}
            durationMinutes={partyActive ? totals(party, menu).minutes : staff.duration_minutes}
            status={doneStatus}
            bookingId={bookingId}
            prepayNotice={prepayNotice}
          />
        )}
        </>}
        </div>
      </div>
      {!addonsBlocked && step === 'menu' && !partyMode && stepReady && (
        <BottomBar>
          <Button variant="primary" disabled={!menu} onClick={() => setStep('staff')}>
            担当を選ぶ
          </Button>
        </BottomBar>
      )}
      {!addonsBlocked && step === 'menu' && partyMode && menu && (
        <BottomBar>
          <PartySummary party={party} first={menu} />
          <Button variant="primary" onClick={() => setStep('staff')}>
            担当を選ぶ
          </Button>
        </BottomBar>
      )}
      {!addonsBlocked && step === 'staff' && stepReady && (
        <BottomBar>
          {!partyActive && menu && staff && menu.price_mode !== 'inquiry' && menu.base_price > 0 ? (
            <p className="mb-2.5 flex items-baseline gap-2 text-[13px] text-liff-sub" data-booking-total="">
              <span>合計</span>
              <span className="text-[17px] font-bold text-ink">{formatYen(staffBookingPrice(staff))}</span>
              <span className="text-xs">{nominationFee(menu, staff) > 0
                ? `（料金 ${formatYen(staff.price)}・指名料 ${formatYen(nominationFee(menu, staff))}）`
                : `（料金 ${formatYen(staff.price)}・指名料なし）`}</span>
            </p>
          ) : null}
          {partyActive && menu ? <PartySummary party={party} first={menu} withFee /> : null}
          <Button variant="primary" disabled={party.size > 1 ? !party.members[0].staff : !staff} onClick={() => { if (party.size > 1) { const lead = party.members[0].staff; if (lead && lead.id !== staff?.id) { setSlot(null); setStaff(lead); } } setStep('datetime'); }}>
            日時を選ぶ
          </Button>
        </BottomBar>
      )}
    </LiffLookScope>
  );
}
