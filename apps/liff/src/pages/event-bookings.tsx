import { useCustomerWords, useCustomerStyle } from '../components/customer-style-scope.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, type EventBookingMine, type EventSlot } from '../lib/api.js';
import { utcToJstHm, utcToJstMd } from '../lib/datetime.js';
import { logFailure } from '../lib/user-message.js';
import LoadErrorView from '../components/load-error-view.js';
import LoadingView from '../components/loading-view.js';
import Card from '../components/ui/card.js';
import Badge from '../components/ui/badge.js';
import Button from '../components/ui/button/index.js';
import ConfirmDialog from '../components/ui/confirm-dialog.js';
import Icon from '../components/ui/icon.js';
import LiffHeader from '../components/ui/liff-header.js';
import LiffLookScope from '../components/liff-look-scope.js';
import StatusView from '../components/ui/status-view.js';

import { statusMeta, canLeaveWaitlist } from './event-bookings-policy.js';
import LessonHistorySection from '../components/lesson-history-section.js';
import AbsenceNotice from '../components/absence-notice.js';
import AbsenceSheet from '../components/absence-sheet.js';

function canCancel(b: EventBookingMine): boolean {
  if (b.status !== 'requested' && b.status !== 'confirmed') return false;
  if (b.cancel_deadline_hours_before == null) return false;
  const deadlineMs = new Date(b.slot_starts_at).getTime() - b.cancel_deadline_hours_before * 3600_000;
  return deadlineMs > Date.now();
}

/** 取消可否の計算には触れず、応答にある期限だけを案内する。 */
function cancellationDeadlineLabel(hours: number | null | undefined): string {
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0) return 'キャンセル期限';
  return hours === 0 ? '開始時刻' : `開始${hours}時間前`;
}

/**
 * 3-b 自分のイベント。「これから／これまで」の切り替え。
 * キャンセルは期限まで。確認の出し方と失敗の文言はそのまま。
 * 見た目だけ ★管理画面 (日付の四角＋名前＋札＋補足)。
 */
/** 変更の断りが確定した応答（同じ受付キーで送り直しても結果は変わらない）。 */
const DECIDED_CHANGE_ERRORS = new Set([
  'slot_full',
  'change_deadline_passed',
  'change_not_allowed',
  'slot_inactive',
  'slot_started',
  'entry_closed',
  'same_slot',
  'over_friend_limit',
  'duplicate_friend_booking',
  'invalid_state',
]);

export default function EventBookings() {
  const words = useCustomerWords();
  const style = useCustomerStyle();
  const [absenceNotice, setAbsenceNotice] = useState<string | null>(null);
  const [absence, setAbsence] = useState<EventBookingMine | null>(null);
  const [lessonRevision, setLessonRevision] = useState(0);
  const [pickingMakeup, setPickingMakeup] = useState(false);
  const navigate = useNavigate();
  // ?liffId=... を引き継ぐ (再読み込みで失わない)。
  const { search } = useLocation();
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [items, setItems] = useState<EventBookingMine[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // 読み込みの失敗と、キャンセル操作の失敗は別に持つ。
  // 混ぜると失敗を「予約0件」と言ってしまう。
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setLoadFailed(false);
    setActionError(null);
    try {
      const res = await api.myEventBookings(tab);
      if (!res || !Array.isArray(res.items)) throw new Error('Invalid event bookings response');
      if (generation === requestGeneration.current) setItems(res.items);
    } catch (e) {
      logFailure('event-bookings', e);
      if (generation === requestGeneration.current) setLoadFailed(true);
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    void refresh();
    return () => { requestGeneration.current++; };
  }, [refresh]);

  // 取り消す予約。開いている間だけ持つ。ブラウザの `confirm` は使わず、
  // 共通の確認窓で聞く (やめるを選ぶとここが空のまま終わる)。
  const [pendingCancel, setPendingCancel] = useState<EventBookingMine | null>(null);

  /**
   * 開催回を変える予約。窓を開けている間だけ持つ。
   * 冪等鍵は窓を開けたときに1つ作り、失敗後の再試行でも使い回す
   * (応答を失った成功を二重にしない)。
   */
  const [pendingChange, setPendingChange] = useState<{
    booking: EventBookingMine;
    slots: EventSlot[] | null;
    slotsFailed: boolean;
    selectedSlotId: string | null;
    idempotencyKey: string;
    changeError: string | null;
  } | null>(null);

  // 自分の予約一覧には枠 ID が無いため、今の時間は開始日時で見分ける。
  function isCurrentSlot(booking: EventBookingMine, slot: EventSlot): boolean {
    return slot.starts_at === booking.slot_starts_at;
  }

  async function openChange(booking: EventBookingMine) {
    if (busy) return;
    setActionError(null);
    setPendingChange({
      booking,
      slots: null,
      slotsFailed: false,
      selectedSlotId: null,
      idempotencyKey: crypto.randomUUID(),
      changeError: null,
    });
    try {
      const res = await api.getEventSlots(booking.event_id);
      setPendingChange((current) => {
        if (!current || current.booking.id !== booking.id) return current;
        const first = res.items.find(
          (s) => !isCurrentSlot(booking, s) && s.remaining !== 0,
        );
        return { ...current, slots: res.items, selectedSlotId: first?.id ?? null };
      });
    } catch (e) {
      logFailure('change-event-booking-slots', e);
      setPendingChange((current) =>
        current && current.booking.id === booking.id ? { ...current, slotsFailed: true } : current,
      );
    }
  }

  async function runChange() {
    const target = pendingChange;
    if (!target || !target.selectedSlotId || busy) return;
    const selected = target.slots?.find((s) => s.id === target.selectedSlotId);
    // 今の時間そのものは選ばせない (API も same_slot で止める)。
    if (!selected || isCurrentSlot(target.booking, selected)) return;
    setBusy(true);
    setActionError(null);
    try {
      await api.changeMyEventBooking(
        target.booking.id,
        target.selectedSlotId,
        target.idempotencyKey,
      );
      setPendingChange(null);
      await refresh();
    } catch (err) {
      logFailure('change-event-booking', err);
      const e = err as { body?: { error?: string } };
      const msg = (() => {
        switch (e.body?.error) {
          case 'slot_full': return '選んだ時間は満席になりました。別の時間を選んでください。';
          case 'change_deadline_passed': return `変更期限を過ぎています。LINE で${words.contact}にご連絡ください。`;
          case 'change_not_allowed': return `この${words.event}は LIFF からの変更に対応していません。LINE で${words.contact}にご連絡ください。`;
          case 'slot_inactive':
          case 'slot_started':
          case 'entry_closed': return '選んだ時間は受付を終えています。別の時間を選んでください。';
          case 'same_slot': return '今と同じ時間です。別の時間を選んでください。';
          case 'over_friend_limit':
          case 'duplicate_friend_booking': return `申込の上限に達しているため変えられません。LINE で${words.contact}にご連絡ください。`;
          case 'invalid_state': return 'この予約は既に変更・キャンセル済みのため変えられません。一覧を開き直してください。';
          case 'send_in_flight_retry': return '送信の直前でした。少し待ってから、もう一度お試しください。';
          default: return '変えられませんでした。時間をおいて、もう一度お試しください。';
        }
      })();
      // 断りが確定した応答（満席・期限切れなど）なら、次の操作は別の受付キーで送る。
      // 同じキーのままだと、別の時間を選んでも前の断りが返ってくる。
      // 通信で結果が分からないときは同じキーのまま（成功の二重を防ぐ）。
      const decided = DECIDED_CHANGE_ERRORS.has(e.body?.error ?? '');
      setPendingChange((current) =>
        current && current.booking.id === target.booking.id
          ? {
              ...current,
              changeError: msg,
              idempotencyKey: decided ? crypto.randomUUID() : current.idempotencyKey,
            }
          : current,
      );
    } finally {
      setBusy(false);
    }
  }

  async function runCancel() {
    const b = pendingCancel;
    if (!b || busy) return;
    setPendingCancel(null);
    setBusy(true);
    setActionError(null);
    try {
      if (canLeaveWaitlist(b)) await api.cancelMyEventWaitlist(b.id);
      else await api.cancelMyEventBooking(b.id);
      await refresh();
    } catch (err) {
      logFailure('cancel-event-booking', err);
      const e = err as { body?: { error?: string } };
      const msg = (() => {
        switch (e.body?.error) {
          case 'cancel_deadline_passed': return 'キャンセル期限を過ぎています。';
          case 'cancel_not_allowed': return `この${words.event}は LIFF からのキャンセルに対応していません。LINE で${words.contact}にご連絡ください。`;
          case 'invalid_state': return 'この予約は既にキャンセル済 / 確定外のためキャンセルできません。';
          default: return canLeaveWaitlist(b) ? 'キャンセル待ちをやめられませんでした。時間をおいて、もう一度お試しください。' : 'キャンセルできませんでした。時間をおいて、もう一度お試しください。';
        }
      })();
      setActionError(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <LiffLookScope className="min-h-screen bg-canvas" designNode="y1bs9A">
      <LiffHeader title={words.myEvents} />
      <div className={`mx-auto flex w-full max-w-md flex-col gap-3.5 p-4 ${pickingMakeup ? 'pb-40' : 'pb-10'}`}>
        <h1 className="text-xl font-bold text-ink">{words.myEvents}</h1>
        <AbsenceNotice message={absenceNotice} />
        {loading ? (
          <LoadingView />
        ) : loadFailed ? (
          <LoadErrorView note="申し込みはなくなっていません。" onRetry={() => void refresh()} />
        ) : (
          <>
            <div
              className="flex rounded-(--liff-radius) bg-liff-chip p-[3px]"
              role="tablist"
              aria-label={`${words.event}の期間`}
            >
              {(
                [
                  { key: 'upcoming', label: 'これから' },
                  { key: 'past', label: 'これまで' },
                ] as const
              ).map((t) => (
                <Button variant="tab" selected={tab === t.key}
                  key={t.key}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.key}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </Button>
              ))}
            </div>
            {actionError && (
              <p role="alert" className="text-sm leading-6 text-danger">
                {actionError}
              </p>
            )}
            {style === 'lesson' && tab === 'upcoming' ? <>
              <Button variant="secondary" onClick={() => navigate({ pathname: '/mypage', search })}>回数券と月謝を見る</Button>
              <LessonHistorySection key={lessonRevision} creditsOnly onPicking={setPickingMakeup} onBookingChanged={() => void refresh()} onLater={() => navigate({ pathname: '/mypage', search })} />
            </> : null}
            {items.length === 0 ? (
              tab === 'upcoming' && pickingMakeup ? null : tab === 'upcoming' ? (
                <StatusView icon="calendar" title={`これからの${words.event}はありません`} />
              ) : (
                <StatusView icon="calendar" title={`これまでの${words.event}はありません`} />
              )
            ) : (
              <ul className="space-y-3.5">
                {items.map((b) => {
                  const baseMeta = Object.hasOwn(statusMeta, b.status) ? statusMeta[b.status] : { text: '状態を確認できません', tone: 'neutral' as const };
                  const lessonStatus: Record<string, string> = { requested: words.approvalPending, confirmed: '確定', attended: '出席', no_show: '欠席', rejected: 'お受けできませんでした' };
                  const meta = canLeaveWaitlist(b) ? { text: 'キャンセル待ち', tone: 'pending' as const }
                    : style === 'lesson' ? { ...baseMeta, text: Object.hasOwn(lessonStatus, b.status) ? lessonStatus[b.status] : baseMeta.text } : baseMeta;
                  return (
                    <li key={b.id}>
                      <Card className="p-3.5">
                        <div className="flex items-center gap-3">
                          <div
                            className="flex w-14 shrink-0 flex-col items-center rounded-(--liff-radius) bg-liff-off-bg py-1.5"
                            aria-label={`${utcToJstMd(b.slot_starts_at)} ${utcToJstHm(b.slot_starts_at)}`}
                          >
                            <span className="liff-num text-[15px] font-bold whitespace-nowrap text-ink">
                              {utcToJstMd(b.slot_starts_at)}
                            </span>
                            <span className="liff-num text-[11px] text-liff-sub">
                              {utcToJstHm(b.slot_starts_at)}
                            </span>
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-bold text-ink" title={b.event_name}>
                              {b.event_name}
                            </div>
                            {b.venue_name && (
                              <div
                                className="mt-[3px] truncate text-[11.5px] text-liff-sub"
                                title={b.venue_name}
                              >
                                {b.venue_name}
                              </div>
                            )}
                            <div className="mt-[3px] flex">
                              <Badge tone={meta.tone}>{canLeaveWaitlist(b) && b.queue_position != null ? `キャンセル待ち ${b.queue_position}番目` : meta.text}</Badge>
                            </div>
                            {/* 板 y1bs9A：変える・キャンセルは文の列の下に小さく並べる。 */}
                            {canCancel(b) && (
                              <div className="flex flex-wrap items-center gap-2 pt-1.5">
                                <Button variant="inline-action"
                                  type="button"
                                  onClick={() => {
                                    void openChange(b);
                                  }}
                                  disabled={busy}
                                >
                                  時間を変える
                                </Button>
                                <Button variant="inline-danger"
                                  type="button"
                                  onClick={() => {
                                    setActionError(null);
                                    setPendingCancel(b);
                                  }}
                                  disabled={busy}
                                >
                                  キャンセルする
                                </Button>
                              </div>
                            )}
                            {canLeaveWaitlist(b) && (
                              <div className="flex flex-wrap items-center gap-2 pt-1.5">
                                <Button variant="inline-danger" disabled={busy} onClick={() => { setActionError(null); setPendingCancel(b); }}>
                                  キャンセル待ちをやめる
                                </Button>
                              </div>
                            )}
                            {style === 'lesson' && tab === 'upcoming' && b.makeup?.enabled
                              && (b.status === 'requested' || b.status === 'confirmed') && Date.parse(b.slot_starts_at) > Date.now()
                              ? <Button variant="inline-action" disabled={busy} onClick={() => { setAbsenceNotice(null); setAbsence(b); }}>欠席する</Button> : null}
                          </div>
                          <Button variant="arrow"
                            type="button"
                            aria-label={`${b.event_name}の${words.event}を見る`}
                            onClick={() =>
                              navigate({ pathname: `/events/${b.event_id}`, search })
                            }
                          >
                            <Icon name="chevron-right" className="h-[18px] w-[18px]" />
                          </Button>
                        </div>
                      </Card>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
      {absence ? <AbsenceSheet booking={absence} onClose={() => setAbsence(null)} onDone={({ reason }) => {
        setAbsence(null); setLessonRevision((n) => n + 1); setAbsenceNotice(reason ?? null); void refresh();
      }} /> : null}
      <ConfirmDialog
        open={pendingCancel !== null}
        designNode="nUYyb"
        title={
          pendingCancel
            ? `${utcToJstMd(pendingCancel.slot_starts_at)} ${utcToJstHm(pendingCancel.slot_starts_at)} の${pendingCancel.event_name}${canLeaveWaitlist(pendingCancel) ? 'のキャンセル待ちをやめますか' : 'をキャンセルしますか'}`
            : ''
        }
        description={pendingCancel && canLeaveWaitlist(pendingCancel) ? 'キャンセル待ちをやめると、空きが出てもLINEのお知らせは届かなくなります。' : `キャンセル待ちの方へ順番に案内されます。${cancellationDeadlineLabel(pendingCancel?.cancel_deadline_hours_before)}になると、ここからは変えられません（${words.contact}へご連絡ください）。`}
        confirmLabel={pendingCancel && canLeaveWaitlist(pendingCancel) ? 'キャンセル待ちをやめる' : 'キャンセルする'}
        cancelLabel="閉じる"
        destructive
        busy={busy}
        onCancel={() => {
          if (!busy) setPendingCancel(null);
        }}
        onConfirm={() => void runCancel()}
      />
      <ConfirmDialog
        open={pendingChange !== null}
        title={pendingChange ? `「${pendingChange.booking.event_name}」の時間を変えますか？` : ''}
        description={
          pendingChange
            ? '新しい時間の席を取れたときだけ、今の予約を取り消します。満席の時間へは変えられません。'
            : ''
        }
        confirmLabel="この時間に変える"
        cancelLabel="閉じる"
        busy={busy}
        error={pendingChange?.changeError ?? undefined}
        onCancel={() => {
          if (!busy) setPendingChange(null);
        }}
        onConfirm={
          pendingChange?.selectedSlotId && !busy ? () => void runChange() : undefined
        }
      >
        {pendingChange && (
          <div className="mt-3">
            {pendingChange.slots === null && !pendingChange.slotsFailed && (
              <p className="text-sm text-ink-secondary">時間を読み込んでいます…</p>
            )}
            {pendingChange.slotsFailed && (
              <div className="space-y-2">
                <p className="text-sm text-ink-secondary">
                  時間を読み込めませんでした。予約はなくなっていません。
                </p>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void openChange(pendingChange.booking)}
                >
                  読み直す
                </Button>
              </div>
            )}
            {pendingChange.slots !== null && (
              <ul className="space-y-2">
                {pendingChange.slots.map((s) => {
                  const current = isCurrentSlot(pendingChange.booking, s);
                  const full = s.remaining === 0;
                  const disabled = current || full || busy;
                  const selected = pendingChange.selectedSlotId === s.id;
                  return (
                    <li key={s.id}>
                      <Button variant="optionRow" selected={selected} unavailable={disabled}
                        type="button"
                        disabled={disabled}
                        aria-pressed={selected}
                        onClick={() =>
                          setPendingChange((prev) =>
                            prev ? { ...prev, selectedSlotId: s.id, changeError: null } : prev,
                          )
                        }
                      >
                        <span
                          className={`liff-num text-sm font-semibold whitespace-nowrap ${disabled ? 'text-ink-faint' : 'text-ink'}`}
                        >
                          {utcToJstMd(s.starts_at)} {utcToJstHm(s.starts_at)}〜
                          {utcToJstHm(s.ends_at)}
                        </span>
                        <span
                          className={`shrink-0 text-xs whitespace-nowrap ${disabled ? 'text-ink-faint' : 'text-ink-secondary'}`}
                        >
                          {current ? '今の時間' : full ? '満席' : '空きあり'}
                        </span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </ConfirmDialog>
    </LiffLookScope>
  );
}
