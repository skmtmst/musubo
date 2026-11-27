import { useCustomerWords } from '../components/customer-style-scope.js';
import { useRequestGeneration } from '../lib/use-request-generation.js';
import { TextInput, TextArea, ChoiceInput, FieldLabel, FieldCount, FormChoiceRow } from '../components/forms/controls.js';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, type EventDetail, type EventSlot } from '../lib/api.js';
import { formatJstDeadline, formatJstEventSpan } from '../lib/datetime.js';
import { logFailure } from '../lib/user-message.js';
import LoadErrorView from '../components/load-error-view.js';
import LoadingView from '../components/loading-view.js';
import Icon from '../components/ui/icon.js';
import Button from '../components/ui/button/index.js';
import BottomBar from '../components/ui/bottom-bar.js';
import PrivacyNote from '../components/ui/privacy-note.js';
import LiffHeader from '../components/ui/liff-header.js';
import LiffLookScope from '../components/liff-look-scope.js';
import { LiffInput, LiffTextArea } from '../components/forms/controls.js'

function nanoid(): string {
  return crypto.randomUUID();
}

/**
 * 2-b 申し込みの確認。送る中身のカード＋案内の帯＋備考。
 * 進む操作 (申し込む) は下の操作の帯にだけ置く。
 * 質問・備考・冪等キー・送信の失敗の扱いはそのまま。見た目だけ ★管理画面。
 *
 * 満席で待ちに入ったとき Worker は 200 で {waitlisted: true} を返す。
 * そのときは 2-d (キャンセル待ちに入りました) へ進む。
 */
export default function EventConfirm() {
  const words = useCustomerWords();
  const { id } = useParams<{ id: string }>();
  const [search] = useSearchParams();
  const slotId = search.get('slotId') ?? '';
  const navigate = useNavigate();
  // ?liffId=... を引き継ぐ (再読み込みで失わない)。
  const { search: locationSearch } = useLocation();

  const [event, setEvent] = useState<EventDetail | null>(null);
  const [slot, setSlot] = useState<EventSlot | null>(null);
  const [availabilityReadKey, setAvailabilityReadKey] = useState<string | null>(null);
  const [note, setNote] = useState('');
  // カスタム質問への回答。質問id → 文字列、複数選択は文字列配列。
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  // 読み込みの失敗と送信の失敗は別に持つ。送信の失敗は入力を消さずその場に出す。
  const [loadFailed, setLoadFailed] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [slotMissing, setSlotMissing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Stable Idempotency-Key — regenerate would defeat the purpose if user
  // taps twice. One key per Confirm-screen mount.
  const idemKey = useMemo(() => nanoid(), []);

  useEffect(() => {
    if (!id || !slotId) return;
    let cancelled = false;
    setAvailabilityReadKey(null);
    async function load() {
      setLoadFailed(false);
      setSubmitError(null);
      setSlotMissing(false);
      try {
        const [e, s] = await Promise.all([api.getEvent(id!), api.getEventSlots(id!)]);
        if (cancelled) return;
        setEvent(e);
        const found = s.items.find((x) => x.id === slotId);
        if (!found) {
          // 枠が消えた / 満員でフィルタアウト / 開始済 → 詳細画面に戻す。
          // null のまま放置すると無限ローディングになる。
          setSlotMissing(true);
          return;
        }
        setSlot(found);
        setAvailabilityReadKey(JSON.stringify([id, slotId, reloadKey]));
      } catch (err) {
        if (!cancelled) {
          logFailure('event-confirm', err);
          setLoadFailed(true);
        }
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [id, slotId, reloadKey]);

  function goDone(query: string) {
    const keep = new URLSearchParams(locationSearch);
    const next = new URLSearchParams(query);
    for (const [k, v] of keep) {
      if (k !== 'slotId' && !next.has(k)) next.set(k, v);
    }
    navigate({ pathname: `/events/${id}/done`, search: next.toString() });
  }

  const request = useRequestGeneration(JSON.stringify([id, slotId]));

  async function submit() {
    if (!id || !slotId) return;
    if (note.length > 5000) {
      setSubmitError('備考は5000字以内で入力してください');
      return;
    }
    // 必須質問の未回答を送信前に止める。サーバ側でも同じ検査をしている。
    const missing = (event?.questions ?? []).find((q) => {
      if (!q.required) return false;
      const a = answers[q.id];
      return a == null || (typeof a === 'string' ? a.trim() === '' : a.length === 0);
    });
    if (missing) {
      setSubmitError(`「${missing.label}」が未回答です`);
      return;
    }
    if (submitting) return;
    const generation = request.begin();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const hasAnswers = Object.keys(answers).length > 0;
      const res = await api.createEventBooking(
        id,
        { slot_id: slotId, customer_note: note || null, ...(hasAnswers ? { answers } : {}) },
        idemKey,
      );
      if (!request.isCurrent(generation)) return;
      const startsAt = `startsAt=${encodeURIComponent(slot?.starts_at ?? '')}`;
      if (res && 'waitlisted' in res && res.waitlisted === true && typeof res.slot_id === 'string' && res.slot_id === slotId) {
        // 完了画面で自分の待ち (順番・やめる) を探すため、待ちに入った枠を渡す。
        goDone(`status=waitlisted&waitSlot=${encodeURIComponent(res.slot_id)}&${startsAt}`);
        return;
      }
      if (res && 'id' in res && typeof res.id === 'string' && res.id.trim() && (res.status === 'confirmed' || res.status === 'requested')) {
        goDone(`bookingId=${encodeURIComponent(res.id)}&status=${res.status}&${startsAt}`);
        return;
      }
      setSubmitError(`申し込みの結果を確認できませんでした。${words.myEvents}でも状態を確認してください。`);
    } catch (err) {
      if (!request.isCurrent(generation)) return;
      logFailure('create-event-booking', err);
      const e = err as { status?: number; body?: { error?: string } };
      const code = e.body?.error;
      const msg = (() => {
        switch (code) {
          case 'slot_full': return 'すでに満員になりました。別の日時をお選びください。';
          case 'over_friend_limit': return `この${words.event}への予約上限に達しています。`;
          case 'duplicate_friend_booking': return `この時間はすでに申し込み済みです。${words.myEvents}で確認してください。`;
          case 'entry_closed': return `申込期限を過ぎています。別の${words.event}をお探しください。`;
          case 'slot_started': return 'この枠は既に開始されています。';
          case 'slot_inactive': return 'この枠は受付を締め切りました。';
          case 'event_unpublished': return `この${words.event}は現在受付を停止しています。`;
          case 'unauthorized':
          case 'friend_not_found':
            return 'LINE 認証に失敗しました。一度 LINE のトークルームに戻り、友だち追加が完了していることを確認してから再度お試しください。';
          case 'missing_required_answers': return '未回答の必須項目があります。入力してからもう一度お試しください。';
          case 'idempotent_in_progress': return '前回のリクエストを処理中です。少しお待ちください。';
          default: return '予約を送れませんでした。時間をおいて、もう一度お試しください。';
        }
      })();
      setSubmitError(msg);
    } finally {
      if (request.isCurrent(generation)) setSubmitting(false);
    }
  }

  function back() {
    request.invalidate();
    setSubmitting(false);
    navigate(-1);
  }

  if (loadFailed || slotMissing || !event || !slot) {
    return (
      <LiffLookScope className="min-h-screen bg-ground">
        <LiffHeader title="申し込みの確認" />
        <div className="mx-auto w-full max-w-md space-y-4 px-4 pt-2 pb-10">
          {loadFailed ? (
            <LoadErrorView onRetry={() => setReloadKey((k) => k + 1)} />
          ) : slotMissing ? (
            <div className="space-y-4 text-center">
              <p className="pt-8 text-sm leading-6 text-ink-secondary">
                選択した枠は受付終了しました。別の日時をお選びください。
              </p>
              <Button variant="primary" onClick={() => navigate({ pathname: `/events/${id}`, search: locationSearch })}>
                {`${words.event}ページに戻る`}
              </Button>
            </div>
          ) : (
            <LoadingView />
          )}
        </div>
      </LiffLookScope>
    );
  }

  const availabilityChecked = availabilityReadKey === JSON.stringify([id, slotId, reloadKey]);
  const availability = availabilityChecked ? availabilityText(event, slot) : '確認しています';
  const availabilityNote = '空きは確保されていません。受付結果は送信時の空き状況で決まります。'
    + (event.waitlist_enabled === 1 ? 'キャンセル待ちになる場合があります。' : '');

  // 期限があれば日時で出す（板 「キャンセルは 10月10日 18:00 まで。」）。無ければ「自分のイベント」へ案内する。
  const cancelText = event.cancel_deadline_hours_before != null
    ? `キャンセルは ${formatJstDeadline(slot.starts_at, event.cancel_deadline_hours_before)} まで。`
    : `キャンセルは期限まで「${words.myEvents}」からできます（期限は${words.event}ごとに違います）。`;
  const infoText = event.requires_approval === 1
    ? `受付後、${words.contact}の確認をお待ちください。${cancelText}`
    : cancelText;

  return (
    <LiffLookScope className="min-h-screen bg-canvas" designNode="EscPA">
      <LiffHeader title="申し込みの確認" />
      {/* 板 EscPA：中身は上下左右 16・間 14。並びは 内容の箱 → 質問 → 備考 → 注意 → プライバシーの一行。 */}
      <div className="mx-auto w-full max-w-md space-y-3.5 px-4 pt-4 pb-28">
        <h1 className="text-xl font-bold text-ink">内容を確かめてください</h1>
        <dl data-liff-card className="divide-y divide-liff-divider rounded-(--liff-radius-lg) bg-canvas px-3.5 py-1 outline outline-1 -outline-offset-1 outline-liff-line">
          <Row label={words.event} value={event.name} />
          <Row label="日時" value={formatJstEventSpan(slot.starts_at, slot.ends_at)} />
          {event.venue_name && <Row label="場所" value={event.venue_name} />}
          {event.venue_address && <Row label="住所" value={event.venue_address} />}
          <Row label="枠全体の空き（確認時点）" value={availability} stacked />
        </dl>


        {(event.questions ?? []).length > 0 && (
          <div className="space-y-4">
            {(event.questions ?? []).map((q) => {
              const value = answers[q.id];
              return (
                <div key={q.id}>
                  <FieldLabel id={`eq-label-${q.id}`} htmlFor={q.type === 'text' || q.type === 'textarea' ? `eq-${q.id}` : undefined} required={q.required}>
                    {q.label}
                  </FieldLabel>
                  {q.type === 'text' && (
                    <TextInput
                      id={`eq-${q.id}`} type="text"
                      aria-labelledby={`eq-label-${q.id}`}
                      value={typeof value === 'string' ? value : ''}
                      onChange={(e) => setAnswers((cur) => ({ ...cur, [q.id]: e.target.value }))}
                    />
                  )}
                  {q.type === 'textarea' && (
                    <TextArea
                      id={`eq-${q.id}`} aria-labelledby={`eq-label-${q.id}`}
                      value={typeof value === 'string' ? value : ''}
                      onChange={(e) => setAnswers((cur) => ({ ...cur, [q.id]: e.target.value }))}
                      rows={3}
                    />
                  )}
                  {q.type === 'radio' && (
                    <div className="space-y-1" role="radiogroup" aria-labelledby={`eq-label-${q.id}`}>
                      {(q.options ?? []).map((opt) => (
                        <FormChoiceRow key={opt} selected={value === opt}>
                          <ChoiceInput
                            type="radio"
                            name={`eq-${q.id}`}
                            checked={value === opt}
                            onChange={() => setAnswers((cur) => ({ ...cur, [q.id]: opt }))}
                          />
                          {opt}
                        </FormChoiceRow>
                      ))}
                    </div>
                  )}
                  {q.type === 'checkbox' && (
                    <div className="space-y-1" role="group" aria-labelledby={`eq-label-${q.id}`}>
                      {(q.options ?? []).map((opt) => {
                        const chosen = Array.isArray(value) ? value : [];
                        const checked = chosen.includes(opt);
                        return (
                          <FormChoiceRow key={opt} selected={checked}>
                            <ChoiceInput
                              type="checkbox"
                              checked={checked}
                              onChange={() =>
                                setAnswers((cur) => ({
                                  ...cur,
                                  [q.id]: checked ? chosen.filter((x) => x !== opt) : [...chosen, opt],
                                }))
                              }
                            />
                            {opt}
                          </FormChoiceRow>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="space-y-2">
          <FieldLabel htmlFor="event-note">備考</FieldLabel>
          <TextArea
            appearance="event" id="event-note" value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            maxLength={5000}
            placeholder="質問や伝えたいことがあれば"
          />
          <FieldCount value={note} max={5000} />
        </div>

        {submitError && (
          <p role="alert" className="text-sm leading-6 text-danger">
            {submitError}
          </p>
        )}
        <div className="flex gap-2 rounded-(--liff-radius) bg-liff-note p-3 text-xs leading-[18px] text-ink">
          <Icon name="info" tone="booking-info" className="h-4 w-4 shrink-0" />
          <p>{availabilityNote}<br />{infoText}</p>
        </div>
        <PrivacyNote />
      </div>
      <BottomBar>
        <Button variant="primary" onClick={submit} disabled={submitting}>
          {submitting ? '送信中…' : '申し込む'}
        </Button>
        <Button variant="text"
          type="button"
          onClick={back}
        >
          ← 戻る
        </Button>
      </BottomBar>
    </LiffLookScope>
  );
}

/** 確認の1行。板  は 1行 40 (線を含む)・鍵と値は上ぞろえ (予約の確認と同じ)。 */
function Row({ label, value, stacked = false }: { label: string; value: string; stacked?: boolean }) {
  return (
    <div className={stacked ? "flex flex-col items-start gap-1 py-2.5" : "flex h-10 items-start gap-2 py-2.5"}>
      <dt className={stacked ? "text-xs text-liff-sub" : "w-18 shrink-0 text-xs text-liff-sub"}>{label}</dt>
      <dd className={stacked ? "w-full min-w-0 truncate text-sm font-semibold text-ink" : "min-w-0 flex-1 truncate text-sm font-semibold text-ink"} title={value}>
        {value}
      </dd>
    </div>
  );
}


/** 確認GETで分かる枠全体の値だけを示し、参加方法別の受付結果は保証しない。 */
function availabilityText(event: EventDetail, slot: EventSlot): string {
  if (slot.capacity === null) return '枠全体の定員なし';
  if (!Number.isSafeInteger(slot.capacity) || slot.capacity < 0
    || slot.remaining === null || !Number.isSafeInteger(slot.remaining)
    || slot.remaining < 0 || slot.remaining > slot.capacity) return '確認できません';
  if (slot.remaining === 0) return event.waitlist_enabled === 1 ? '満席・キャンセル待ちの受付あり' : '満席';
  return `残り ${slot.remaining} 席`;
}
