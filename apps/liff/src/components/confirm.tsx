import { clearCardSetupResume, saveCardSetupResume, type CardSetupResume } from '../lib/card-setup-resume.js';
import { useCustomerWords, useCustomerStyle } from './customer-style-scope.js';
import PaymentPreparingNote from './payment-preparing-note.js';
import { useEffect,useState } from 'react';
import { api,type BookingEntitlement,type CreateBookingResponse,type MenuItem,type StaffItem } from '../lib/api.js';
import { bookingPriceText, staffBookingPrice } from '../lib/booking-price.js';
import { useRef } from 'react';
import { type BookingCancellationPreview } from '../lib/api.js';
import CancellationPolicy from './cancellation-policy.js';
import { addMinutesHm, formatJpLong, slotStartsAtIso } from '../lib/datetime.js';
import { logFailure } from '../lib/user-message.js';

import { isNotReadyYet } from '../lib/not-ready.js';
import { useRequestGeneration } from '../lib/use-request-generation.js';
import { useWideViewport } from '../lib/use-wide-viewport.js';

import BookingIntake from './booking-intake.js';
import type { SlotPick } from './date-time-picker.js';
import PreparingOverlay from './preparing-overlay.js';
import RecurringCard, { type RecurrenceValue } from './recurring-card.js';
import { menuLine, personShort, totals, yen, type PartyState } from '../lib/party.js';
import BottomBar from './ui/bottom-bar.js';
import Button from './ui/button/index.js';
import Icon from './ui/icon.js';
import PrivacyNote from './ui/privacy-note.js';
import MeetingModeChoices from './meeting-mode-choices.js';
import { ChoiceInput, FormChoiceRow } from './forms/controls.js';

/**
 * 1-d 内容の確認 (★V8・)。送った中身のカード＋ご要望＋案内の帯。
 * 進む操作 (この内容で予約をリクエスト) は下の操作の帯にだけ置く。
 * 送信の失敗は入力を消さず、その場で理由を出す (動きはそのまま)。
 */
export default function Confirm({
  menu,
  staff,
  slot,
  autoConfirm,
  party,
  cancelDeadlineMinutesBefore = null,
  onPolicyChange,
  onPaymentChange,
  onBack,
  onRegisterBack,
  onSubmitted,
  cardResume,
  cardSetupReturned = false,
}: {
  cardResume?: CardSetupResume | null;
  cardSetupReturned?: boolean;
  menu: MenuItem;
  staff: StaffItem;
  slot: SlotPick;
  /** 予約のルールが承認なし確定のとき真。未承認の案内を出さない。 */
  autoConfirm: boolean;
  /** 2 人以上・追加メニューのとき（B5）。人ごとの行と合計を出し、組で送る。 */
  party?: PartyState;
  cancelDeadlineMinutesBefore?: number | null;
  /** キャンセル料の決まりがオンか（手順の帯に「お支払い」を足す）。 */
  onPolicyChange?: (enabled: boolean) => void;
  /** 本人が選んだ先払いだけ、既存の「お支払い」の手順を出す。 */
  onPaymentChange?: (online: boolean) => void;
  /** 日時の段へ戻る。戻るボタンは頭の「‹」にだけある（この画面には置かない）。 */
  onBack?: () => void;
  /** 頭の「‹」から呼べるよう、戻る処理を親へ渡す。 */
  onRegisterBack?: (back: (() => void) | null) => void;
  /** 予約ができたら予約ID・状態・支払い(お支払いありのときだけ付く)を渡す。前払いのみの案内も付く。 */
  onSubmitted: (result: {
    bookingId: string;
    status: string;
    payment: CreateBookingResponse['payment'];
    prepayNotice: string | null;
  }) => void;
}) {
  const words = useCustomerWords();
  const style = useCustomerStyle();
  const [chosenMode, setChosenMode] = useState<'online' | 'in_person' | null>(cardResume?.meetingMode ?? null);
  const meetingMode = menu.meeting_mode === 'customer_choice' ? chosenMode
    : menu.meeting_mode === 'online' || menu.meeting_mode === 'in_person' ? menu.meeting_mode : null;
  const missingMeetingMode = (style === 'consult' || menu.meeting_mode === 'customer_choice') && !meetingMode;
  // 414 幅の板（）は板 ID だけを替える。中身は同じ。
  const wide = useWideViewport();
  const deadline = menu.cancel_deadline_hours_before == null ? cancelDeadlineMinutesBefore : menu.cancel_deadline_hours_before * 60;
  const [note, setNote] = useState(cardResume?.note ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idemKey, setIdemKey] = useState(() => cardResume?.bookingKey ?? crypto.randomUUID());
  const [setupKey, setSetupKey] = useState(() => cardResume?.setupKey ?? crypto.randomUUID());
  const [returned, setReturned] = useState(cardSetupReturned);
  /* 見積もりを読めたときだけ予約を送る。失敗を「決まりなし」に読み替えない。 */
  const [policy, setPolicy] = useState<BookingCancellationPreview | null>(null);
  const [policyState, setPolicyState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [policyRetry, setPolicyRetry] = useState(0);
  const [policyKey, setPolicyKey] = useState('');
  const [paymentOptions, setPaymentOptions] = useState<BookingCancellationPreview['payment']>();
  const [paymentChoice, setPaymentChoice] = useState<{ key: string; method: 'onsite' | 'online' } | null>(null);
  const [accepted, setAccepted] = useState(false);
  const startsAt = slotStartsAtIso(slot);
  const currentPolicyKey = JSON.stringify([menu.id, staff.id, startsAt]);
  const policyReady = policyState === 'ready' && policyKey === currentPolicyKey;
  useEffect(() => {
    let alive = true;
    setPolicyState('loading'); setPolicy(null); setPaymentOptions(undefined); setAccepted(false);
    void Promise.resolve().then(() => api.cancellationPreview({ menuId: menu.id, staffId: staff.id, startsAt })).then((data) => {
      if (!alive) return;
      setPolicy(data && data.enabled ? data : null);
      setPaymentOptions(data?.payment);
      setPolicyKey(currentPolicyKey); setPolicyState('ready');
      onPolicyChange?.(Boolean(data && data.enabled));
    }).catch((e) => {
      if (!alive) return;
      logFailure('cancellation-preview', e);
      setPolicyState('error');
    });
    return () => { alive = false; };
  }, [menu.id, staff.id, startsAt, currentPolicyKey, onPolicyChange, policyRetry]);

  /* 続けて予約（B4）・2 人以上の組（B5）：口がまだ無い間は、送らずに「現在準備中です」を出す。 */
  const [recurrence, setRecurrence] = useState<RecurrenceValue>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  /* 使う回数券・月謝（組3）。口が無い間は 'soon'＝準備中の 1 行だけ出す。使えるものが無ければ段ごと出さない。 */
  const [entitlements, setEntitlements] = useState<BookingEntitlement[] | 'soon' | null>(null);
  const [entitlementError, setEntitlementError] = useState<string | null>(null);
  const [entitlementId, setEntitlementId] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.resolve().then(() => api.entitlements({ menuId: menu.id, startsAt: slotStartsAtIso(slot) })).then((items) => {
      if (alive) setEntitlements(items.filter((e) => e.usable));
    }).catch((e) => {
      if (!alive) return;
      if (isNotReadyYet(e)) { setEntitlements('soon'); return; }
      logFailure('confirm-entitlements', e);
      setEntitlementError('使える回数券を読み込めませんでした。前の画面へ戻り、もう一度お試しください。');
      setEntitlements([]);
    });
    return () => { alive = false; };
  }, [menu.id, slot]);
  const chosenEntitlement = Array.isArray(entitlements) ? entitlements.find((e) => e.id === entitlementId) ?? null : null;

  const paymentMode = paymentOptions?.mode ?? menu.payment_mode ?? 'none';
  const paymentMethod = chosenEntitlement ? null : paymentMode === 'customer_choice'
    ? paymentChoice?.key === currentPolicyKey && paymentOptions?.allowedMethods.includes(paymentChoice.method) ? paymentChoice.method : null
    : paymentMode === 'online' || paymentMode === 'onsite' ? paymentMode : null;
  const missingPaymentOptions = paymentMode === 'customer_choice' && !paymentOptions;
  const missingPaymentChoice = !chosenEntitlement && paymentMode === 'customer_choice' && (!paymentMethod || missingPaymentOptions);
  const onlinePayment = paymentMethod === 'online' && (party ? totals(party, menu).price : staffBookingPrice(staff)) > 0;
  const immediateConfirmation = autoConfirm && !onlinePayment && !missingPaymentChoice;
  useEffect(() => { onPaymentChange?.(onlinePayment); }, [onlinePayment, onPaymentChange]);

  const request = useRequestGeneration(JSON.stringify([menu.id, staff.id, slot.date, slot.start, meetingMode, paymentMethod, chosenEntitlement?.id]));
  /* 戻る（頭の「‹」から呼ぶ）：送りかけの返事は受け取らず、日時の段へ戻る。 */
  function back() {
    request.invalidate();
    setSubmitting(false);
    onBack?.();
  }
  const backRef = useRef(back);
  backRef.current = back;
  useEffect(() => { onRegisterBack?.(() => backRef.current()); return () => onRegisterBack?.(null); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  async function handleSubmit() {
    if (recurrence === 'checking' || submitting || !policyReady || missingMeetingMode || missingPaymentChoice || (policy !== null && !accepted)) return;
    if (party && party.size > 1) { setPreparing('2 人以上でのご予約'); return; }
    if (recurrence) { setPreparing('毎週の続けての予約'); return; }
    const generation = request.begin();
    setSubmitting(true);
    setError(null);
    try {
      /* キャンセル料がオンの店：カードを登録（試験モード）してから、確かめた決まりの版と一緒に送る。登録がまだなら登録の画面へ。 */
      let consent: { policyAccepted: true; policyVersion: number; setupIntentId?: string } | null = null;
      if (policy) {
        consent = { policyAccepted: true, policyVersion: policy.version };
        if (policy.cardRequired !== false) {
          const setup = await api.cancellationSetup({menuId:menu.id,staffId:staff.id,startsAt,partySize:party?.size ?? 1}, setupKey);
          if (!request.isCurrent(generation)) return;
          if (setup.status !== 'ready') {
            if (returned) { setError('カードの登録を確認しています。しばらくしてからもう一度お試しください。'); return; }
            saveCardSetupResume({menu,staff,slot,party,note,meetingMode,setupKey,bookingKey:idemKey});
            window.location.assign(setup.url);
            return;
          }
          consent.setupIntentId = setup.setupIntentId;
        }
      }
      const created = await api.createRequest(
        {
          menu_id: menu.id,
          staff_id: staff.id,
          // 空き枠が返した開始の瞬間を送る（店が日本時間以外でもずれない）。
          starts_at: startsAt,
          customer_note: note || undefined,
          ...(meetingMode ? { meeting_mode: meetingMode } : {}),
          ...(consent ?? {}),
          ...(party && party.members[0].addonIds.length ? { addonIds: party.members[0].addonIds } : {}),
          ...(chosenEntitlement ? { entitlement_id: chosenEntitlement.id } : {}),
          ...(!chosenEntitlement && paymentMode === 'customer_choice' && paymentMethod ? { payment_method: paymentMethod } : {}),
        },
        idemKey,
      );
      if (!request.isCurrent(generation)) return;
      if (created.payment_required && !created.payment?.id) {
        setError('予約できませんでした。もう一度お試しください');
        return;
      }
      clearCardSetupResume();
      onSubmitted({
        bookingId: created.booking_id,
        status: created.status,
        payment: created.payment ?? null,
        // 本人が方法を選ぶ受付では、前払い限定の理由を完了画面にも表示しない。
        prepayNotice: paymentMode === 'customer_choice' ? null : created.prepayNotice ?? null,
      });
    } catch (e) {
      if (!request.isCurrent(generation)) return;
      logFailure('create-request', e);
      const err = e as { status?: number; code?: string; body?: { error?: string; code?: string } };
      if (err.status === 409 && err.body?.error === 'policy_changed') {
        setAccepted(false);
        setPolicyState('loading');
        setPolicyRetry((n) => n + 1);
        setError('キャンセル料の決まりが変わりました。もう一度確かめてから予約してください。');
      } else if (err.status === 409 && (err.body?.error === 'stripe_checkout_expired' || err.body?.error === 'idempotency_conflict')) {
        clearCardSetupResume(); setSetupKey(crypto.randomUUID()); setIdemKey(crypto.randomUUID()); setReturned(false);
        setError('登録の期限が切れたか、予約内容が変わりました。もう一度カードを登録してください。');
      } else if (err.status === 409 && err.body?.error === 'stripe_result_unknown') {
        setError('カード登録の結果を確認できません。重複を防ぐため、担当者へご連絡ください。');
      } else if (err.status === 409 && err.body?.error === 'card_not_registered') {
        setError('カードの登録が済んでいません。もう一度押して、カードを登録してください。');
      } else if (err.status === 409 && err.body?.error === 'payment_not_connected') {
        setError('いまはカードの登録は準備中です。トークで担当者へご連絡ください。');
      } else if (err.status === 409 && err.body?.error === 'slot_conflict') {

        setError('この時間枠は他の方の予約と重なりました。日時を選び直してください。');
      } else if (err.status === 400 && (err.code ?? err.body?.code ?? err.body?.error) === 'payment_method_not_allowed') {
        setPolicyState('loading'); setPolicyRetry((n) => n + 1); setPaymentChoice(null);
        setError('お支払い方法が変わりました。もう一度確かめてから予約してください。');
      } else {
        setError('予約できませんでした。もう一度お試しください');
      }
    } finally {
      if (request.isCurrent(generation)) setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3.5" data-design-node={wide ? 'uZqMA' : 'gLReL'}>
      <h2 className="text-xl font-bold text-ink">内容を確かめてください</h2>
      {menu.meeting_mode === 'customer_choice' ? <MeetingModeChoices name="meeting-mode" meetingMode={meetingMode} disabled={submitting} onChange={setChosenMode} /> : style === 'consult' && !meetingMode ? <p role="alert" className="text-[13px] leading-6 text-danger">会い方を読み込めませんでした。前の画面へ戻り、もう一度お試しください。</p> : null}
      <dl data-liff-card className="divide-y divide-liff-divider rounded-(--liff-radius-lg) bg-canvas px-3.5 py-1 outline outline-1 -outline-offset-1 outline-liff-line">
        {party ? totals(party, menu).rows.map((r) => <Row alignEnd={policy !== null} key={r.index} label={personShort(r.index)} value={`${menuLine(r.menu, r.member)}・${r.member.designated ? (r.index === 0 ? (r.member.staff ?? staff) : r.member.staff)?.display_name ?? '指名なし' : '指名なし'}`} />) : <Row alignEnd={policy !== null} label={words.bookingContent} value={menu.name} />}
        <Row
          alignEnd={policy !== null}
          label="日時"
          value={`${formatJpLong(slot.date)}${slot.start}〜${addMinutesHm(slot.start, party ? totals(party, menu).minutes : staff.duration_minutes)}`}
        />
        {party ? null : <Row alignEnd={policy !== null} label={words.staff} value={staff.display_name} />}
        {meetingMode && (style === 'consult' || menu.meeting_mode === 'customer_choice' || meetingMode === 'online') ? <Row alignEnd={policy !== null} label="会い方" value={meetingMode === 'online' ? 'オンライン' : '対面'} /> : null}
        <Row
          alignEnd={policy !== null}
          label="料金"
          value={chosenEntitlement ? `${chosenEntitlement.name}を使う` : party ? `${yen(totals(party, menu).price)}（目安）` : policy || paymentMode === 'online' || paymentMode === 'customer_choice' ? bookingPriceText(staffBookingPrice(staff), staff.price_mode ?? menu.price_mode) : `${bookingPriceText(staffBookingPrice(staff), staff.price_mode ?? menu.price_mode)}（目安・当日払う）`}
        />
        {policy?.deposit ? (
          <>
            <Row alignEnd={policy !== null} label="試験のお支払い（デポジット）" value={yen(policy.deposit.amount)} wideLabel />
            <Row alignEnd={policy !== null} label={words.payOnsite} value={yen(Math.max(0, policy.price - policy.deposit.amount))} />
          </>
        ) : null}
      </dl>
      {paymentMode === 'customer_choice' && !chosenEntitlement ? (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-bold text-ink">お支払い方法</legend>
          {policyReady && paymentOptions ? paymentOptions.allowedMethods.map(method => <FormChoiceRow key={method} selected={paymentMethod === method}>
            <ChoiceInput type="radio" name="payment-method" value={method} checked={paymentMethod === method} required disabled={submitting}
              onChange={() => setPaymentChoice({ key: currentPolicyKey, method })} />
            {method === 'online' ? 'オンラインで先に払う' : 'お店で払う'}
          </FormChoiceRow>) : null}
          {policyReady && missingPaymentOptions ? <p role="alert" className="text-[13px] leading-6 text-danger">
            お支払い方法を読み込めませんでした。<Button variant="link" onClick={() => { setPolicyState('loading'); setPolicyRetry(n => n + 1); }}>もう一度</Button>
          </p> : null}
        </fieldset>
      ) : null}
      {menu.recurring?.enabled && !party ? <RecurringCard menu={menu} staff={staff} startsAt={slotStartsAtIso(slot)} onChange={setRecurrence} /> : null}
      {preparing ? <PreparingOverlay title="ご予約" feature={preparing} /> : null}
      {entitlementError ? <p role="status" className="text-[13px] leading-6 text-danger">{entitlementError}</p> : null}
      {entitlements === 'soon' ? (
        <p className="flex items-center gap-2 text-xs text-liff-sub">
          <Icon name="ticket" className="h-4 w-4 shrink-0" />
          回数券を使う予約は現在準備中です
        </p>
      ) : Array.isArray(entitlements) && entitlements.length > 0 ? (
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-bold text-ink">回数券を使う</legend>
          {[null, ...entitlements].map((e) => {
            const selected = (e?.id ?? null) === entitlementId;
            return (
              <Button key={e?.id ?? 'none'} variant="optionRow" selected={selected} aria-pressed={selected}
                disabled={submitting} onClick={() => setEntitlementId(e?.id ?? null)}>
                <span className="min-w-0 truncate text-sm font-semibold text-ink">
                  {e ? e.name : '使わない'}
                </span>
                {e && (
                  <span className="shrink-0 text-xs whitespace-nowrap text-ink-secondary">
                    {e.kind === 'monthly' ? `今月 あと ${e.monthRemaining ?? '—'} 回` : `残り ${e.remaining ?? '—'} 回`}
                  </span>
                )}
              </Button>
            );
          })}
        </fieldset>
      ) : null}
      <BookingIntake question={menu.intake_question} value={note} onChange={setNote} />
      {error && (
        <p role="alert" className="text-[13px] leading-6 text-danger">
          {error}
        </p>
      )}
      {policyState === 'error' ? (
        <p role="alert" className="text-[13px] leading-6 text-danger">
          キャンセル料の決まりを読み込めませんでした。
          <Button variant="link" onClick={() => { setPolicyState('loading'); setPolicyRetry((n) => n + 1); }}>もう一度</Button>
        </p>
      ) : !policyReady ? <p role="status" aria-busy="true" className="text-[13px] leading-6 text-liff-sub">キャンセル料の決まりを確かめています…</p> : null}
      {policy ? <CancellationPolicy preview={policy} accepted={accepted} onAcceptedChange={setAccepted} /> : null}
      {policy ? null : (
      <div className="flex gap-2 rounded-(--liff-radius) bg-liff-note p-3 text-xs leading-[18px] text-ink">
        <Icon name="info" tone="booking-info" className="h-4 w-4 shrink-0" />
        <p>
          {immediateConfirmation
            ? '送るとその場で確定します。確定のお知らせをLINEで送ります。'
            : `まだ確定ではありません。${words.contact}が確かめたら、LINEでお知らせします。`}
          {deadline != null ? `キャンセルは開始の${deadline % 60 === 0 ? `${deadline / 60}時間` : `${deadline}分`}前まで。` : 'キャンセル期限は予約の履歴で確認してください。'}
        </p>
      </div>
      )}
      <PrivacyNote />
      <div className="pb-40" aria-hidden="true" />
      <BottomBar>
        {(policy && (policy.cardRequired !== false || (policy.deposit?.amount ?? 0) > 0)) || onlinePayment ? <PaymentPreparingNote /> : null}
        <Button variant="primary" onClick={handleSubmit} disabled={recurrence === 'checking' || submitting || !policyReady || missingMeetingMode || missingPaymentChoice || (policy !== null && !accepted)}>
          {submitting ? '送信中…'
            : policy?.deposit ? `${yen(policy.deposit.amount)}の試験で予約する`
              : policy && policy.cardRequired !== false ? '試験のカードを登録して予約する'
                : recurrence === 'checking' ? '空きを確認してください' : recurrence ? `${recurrence.made} 回分を予約する` : immediateConfirmation ? 'この内容で予約を確定する' : 'この内容で予約をリクエストする'}
        </Button>
      </BottomBar>
    </div>
  );
}

/** 確認の1行。板  は 1行 40 (線を含む)・鍵と値は上ぞろえ。 */
function Row({ label, value, wideLabel = false, alignEnd = false }: { label: string; value: string; wideLabel?: boolean; alignEnd?: boolean }) {
  return (
    <div className="flex h-10 items-start gap-2 py-2.5">
      <dt className={`${wideLabel ? 'whitespace-nowrap' : 'w-18'} shrink-0 text-xs text-liff-sub`}>{label}</dt>
      <dd className={`min-w-0 flex-1 truncate text-sm font-semibold text-ink${alignEnd ? ' text-right' : ''}`} title={value}>
        {value}
      </dd>
    </div>
  );
}
