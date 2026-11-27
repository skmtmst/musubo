import { useCustomerWords } from '../components/customer-style-scope.js';
import { createClientLogger } from '@line-crm/shared';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, type EventBookingMine, type EventDetail, type EventSlot } from '../lib/api.js';
import {
  formatJstEventAt,
  formatJstEventSpan,
  utcToJstHm,
  utcToJstMd,
  utcToJstWeekday,
} from '../lib/datetime.js';
import { logFailure } from '../lib/user-message.js';
import LoadErrorView from '../components/load-error-view.js';
import LoadingView from '../components/loading-view.js';
import Icon from '../components/ui/icon.js';
import Button from '../components/ui/button/index.js';
import BottomBar from '../components/ui/bottom-bar.js';
import LiffHeader from '../components/ui/liff-header.js';
import LiffLookScope from '../components/liff-look-scope.js';
const clientLogger = createClientLogger('liff');


/**
 * 表示してよいURLか。保存時に弾き切れない古い行もあるため、表示側でも
 * https だけをリンク・画像にする (issue 607 の対応)。http・javascript:・
 * 不正文字列は出さない（Worker側の保存拒否とあわせた二層防御）。
 */
export function isHttpsUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https:\/\//i.test(value.trim());
}

/** 枠の右に出す残席の文言。数は数えられる分だけ、無ければ「—」にしない。 */
function seatLabel(s: EventSlot): string {
  if (s.remaining != null && s.remaining <= 0) return '満席';
  if (s.capacity == null) return '定員なし';
  if (s.remaining != null) return `残り ${s.remaining}`;
  return '受付中';
}

/**
 * 2-a イベントの詳細。時間を選んでから下の操作の帯で進む。
 * API・上限の数え方・失敗の扱いはそのまま。見た目だけ ★管理画面。
 */
export default function Event() {
  const words = useCustomerWords();
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // initLiff は ?liffId=... をクエリから読むので、内部遷移でも保持する。
  // search を維持しないと再読み込みで liffId が失われる。
  const { search } = useLocation();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [slots, setSlots] = useState<EventSlot[]>([]);
  const [myActive, setMyActive] = useState<EventBookingMine[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    async function load() {
      setFailed(false);
      setLoading(true);
      try {
        // GET 系はパブリック（liffId 経由のアカウント解決のみ）。これらは
        // 失敗するとイベント詳細が出せないので全体失敗扱い。
        const [e, s] = await Promise.all([
          api.getEvent(id!),
          api.getEventSlots(id!),
        ]);
        if (cancelled) return;
        if (!e || typeof e.id !== 'string' || e.id !== id || typeof e.name !== 'string' ||
            !s || !Array.isArray(s.items) || !s.items.every(slot => slot &&
              typeof slot.id === 'string' && slot.id.trim() !== '' &&
              typeof slot.starts_at === 'string' && Number.isFinite(Date.parse(slot.starts_at)) &&
              typeof slot.ends_at === 'string' && Number.isFinite(Date.parse(slot.ends_at)))) {
          throw new Error('Invalid event detail response');
        }
        setEvent(e);
        setSlots(s.items);
        setSelectedId(null);

        // 自分の予約数は id_token verify が必要。LIFF が Login Channel に
        // 紐付いてない / login_channel_id 未登録 / friend 未追加など、いろん
        // な要因で 401 になる可能性がある。バッジ表示が落ちるだけなので
        // best-effort にして本画面は描画を続ける。
        try {
          const [upcoming, past] = await Promise.all([
            api.myEventBookings('upcoming'),
            api.myEventBookings('past'),
          ]);
          if (cancelled) return;
          const all = [...upcoming.items, ...past.items];
          setMyActive(
            all.filter(
              (b) => b.event_id === e.id && (b.status === 'requested' || b.status === 'confirmed'),
            ),
          );
        } catch (authErr) {
          // 認証なし → 上限の数えだけ弱くなり、通常表示で続行。
          clientLogger.warn("pages_Event_warn");
        }
      } catch (err) {
        if (!cancelled) {
          logFailure('event-detail', err);
          setFailed(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  if (loading || failed || !event) {
    return (
      <LiffLookScope className="min-h-screen bg-ground">
        <LiffHeader title={words.event} />
        <div className="mx-auto w-full max-w-md space-y-4 px-4 pt-2 pb-10">
          {failed ? (
            <LoadErrorView onRetry={() => setReloadKey((k) => k + 1)} />
          ) : (
            <LoadingView />
          )}
        </div>
      </LiffLookScope>
    );
  }

  const myCount = myActive.length;
  const max = event.max_bookings_per_friend;
  const overLimit = max != null && myCount >= max;
  // 満席でも、このイベントがキャンセル待ちを受けるなら枠は選べる
  // (選んだ満席の枠で申し込むと待ちに入る。サーバも 200 で返す)。
  // 予約上限に達している人は、待ちにも入れないので選べない。
  const waitlistOpen = event.waitlist_enabled === 1;
  const isFull = (s: EventSlot): boolean => s.remaining != null && s.remaining <= 0;
  // 選べる枠が1つも無い (枠自体が無い場合も含む)。表示では空枠を満席と分ける。
  const allFull = !slots.some((s) => !isFull(s));
  const selectedSlot = slots.find((s) => s.id === selectedId) ?? null;
  const selectedFull = selectedSlot != null && isFull(selectedSlot);

  const starts = slots.map((s) => s.starts_at).sort();
  const ends = slots.map((s) => s.ends_at).sort();
  const span = starts.length > 0 ? formatJstEventSpan(starts[0], ends[ends.length - 1]) : null;

  /** 枠がすべて同じ日か。同じ日なら枠には時刻だけを出す。 */
  const oneDay = new Set(slots.map((s) => utcToJstMd(s.starts_at))).size <= 1;
  const limitedSlots = slots.filter((s) => s.capacity != null);
  const caps = limitedSlots.map((s) => s.capacity!);
  const rems = limitedSlots.map((s) => s.remaining).filter((r): r is number => r != null);
  const seats =
    caps.length === 0
      ? '定員なし'
      : rems.length !== limitedSlots.length
        ? `定員 ${caps.reduce((a, b) => a + b, 0)} 席・残席は各時間で確認してください`
        : `残り ${rems.reduce((a, b) => a + b, 0)} 席（定員 ${caps.reduce((a, b) => a + b, 0)}）`;
  const seatSummary = limitedSlots.length > 0 && limitedSlots.length < slots.length
    ? `定員のある時間：${seats}・定員なしの時間もあります` : seats;
  /** 残席を全て数えられるときだけ、残りの行を強調する。 */
  const hasSeats = rems.length === limitedSlots.length && rems.reduce((a, b) => a + b, 0) > 0;

  function goConfirm() {
    if (!selectedId || overLimit) return;
    const next = new URLSearchParams(search);
    next.set('slotId', selectedId);
    navigate({ pathname: `/events/${id}/confirm`, search: next.toString() });
  }

  return (
    <LiffLookScope className="min-h-screen bg-ground" designNode="gVjiC">
      <LiffHeader title={words.event} />
      {/* 板 gVjiC：中身は余白 16・まとまりの間は 14。 */}
      <div className="mx-auto w-full max-w-md space-y-3.5 px-4 pt-4 pb-28">
        {isHttpsUrl(event.image_url) ? (
          <img
            src={event.image_url}
            alt={event.name}
            className="h-40 w-full rounded-xl border border-hairline object-cover"
          />
        ) : (
          <div
            className="flex h-40 w-full items-center justify-center rounded-xl bg-state-mark text-ink-faint"
            aria-hidden="true"
          >
            <Icon name="image" className="h-8 w-8" />
          </div>
        )}
        <h2 className="text-xl font-bold text-ink">{event.name}</h2>
        <div className="space-y-2">
          {span && (
            <p className="flex items-start gap-2 text-[13px] text-ink">
              <Icon name="calendar" className="mt-0.5 h-4 w-4 shrink-0 text-ink-secondary" />
              <span>{span}</span>
            </p>
          )}
          {event.venue_name && (
            <p className="flex items-start gap-2 text-[13px] text-ink">
              <Icon name="map-pin" className="mt-0.5 h-4 w-4 shrink-0 text-ink-secondary" />
              <span className="min-w-0 flex-1 truncate" title={event.venue_name}>
                {event.venue_name}
              </span>
            </p>
          )}
          {slots.length > 0 && <p className="flex items-start gap-2 text-[13px]">
            <Icon name="users" className="mt-0.5 h-4 w-4 shrink-0 text-ink-secondary" />
            <span className={hasSeats ? 'font-bold text-liff-wait-ink' : 'text-ink'}>{seatSummary}</span>
          </p>}
          {event.venue_address && <p className="text-sm text-ink-secondary break-words">{event.venue_address}</p>}
          {isHttpsUrl(event.venue_url) && (
            <a
              href={event.venue_url}
              target="_blank"
              rel="noopener noreferrer"
              className="block truncate text-sm text-info-link underline"
              title={event.venue_url}
            >
              {event.venue_url}
            </a>
          )}
        </div>
        {event.description && (
          <p
            className={`text-xs leading-[18px] whitespace-pre-wrap text-liff-sub ${event.description_centered === 1 ? 'text-center' : ''}`}
          >
            {event.description}
          </p>
        )}

        <div>
          <h3 className="mb-3.5 text-sm font-bold text-ink">時間を選ぶ</h3>
          {slots.length === 0 ? (
            <p className="text-sm text-ink-secondary">現在予約可能な枠はありません。</p>
          ) : (
            <ul className="space-y-2">
              {slots.map((s) => {
                const full = isFull(s);
                const disabled = overLimit || (full && !waitlistOpen);
                const selected = selectedId === s.id;
                // 選んだ時間は薄い緑の地＋濃い文字（主ボタンと同じ緑の塗りにしない）。
                // 満席は押せない灰色の箱。白 (bg-canvas) と重ねると白く見えるので
                // 押せない時は地を1つ (bg-shell-gray) だけにする。
                // 待ちに入る満席の枠は白のまま、黄土色の札で分かるようにする。
                const timeText = `${utcToJstMd(s.starts_at)}(${utcToJstWeekday(s.starts_at)}) ${utcToJstHm(s.starts_at)}〜${utcToJstHm(s.ends_at)}`;
                // 満席で待ちに入る枠の札。数は数えられる分だけ (seatLabel と同じ)。
                const fullLabel = full && !disabled ? '満席・キャンセル待ち' : seatLabel(s);
                return (
                  <li key={s.id}>
                    <Button variant="optionRow" selected={selected} unavailable={disabled} waitlisted={full}
                      type="button"
                      disabled={disabled}
                      aria-pressed={selected}
                      aria-label={full ? `${timeText} 満席` : undefined}
                      onClick={() => setSelectedId(s.id)}
                      title={formatJstEventAt(s.starts_at)}
                    >
                      <span
                        className={`liff-num text-sm font-semibold whitespace-nowrap ${disabled ? 'text-ink-faint' : 'text-ink'}`}
                      >
                        {/* 日付は上の行にあるので、枠が1日だけのときは時刻だけ (板 gVjiC)。 */}
                        {oneDay
                          ? `${utcToJstHm(s.starts_at)}〜${utcToJstHm(s.ends_at)}`
                          : `${utcToJstMd(s.starts_at)}(${utcToJstWeekday(s.starts_at)}) ${utcToJstHm(s.starts_at)}〜${utcToJstHm(s.ends_at)}`}
                      </span>
                      <span
                        className={`shrink-0 text-xs font-semibold whitespace-nowrap ${disabled ? 'text-ink-faint' : full && !disabled ? 'text-liff-wait-ink' : 'text-ink-secondary'}`}
                      >
                        {fullLabel}
                      </span>
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
          {selectedFull && waitlistOpen && (
            <p role="status" className="mt-2 text-xs leading-5 text-ink-secondary">
              {`${utcToJstMd(selectedSlot.starts_at)} ${utcToJstHm(selectedSlot.starts_at)}〜${utcToJstHm(selectedSlot.ends_at)} は満席です。キャンセル待ちで申し込むと、空きが出たらLINEでお知らせします。`}
            </p>
          )}
          {overLimit && (
            <div
              id="event-limit-note"
              role="status"
              className="mt-2 flex gap-2 rounded-lg bg-info-bg p-3 text-xs leading-5 text-ink-secondary"
            >
              <Icon name="info" className="h-4 w-4 shrink-0" />
              <p>この{words.event}への予約上限（{max}）に達しています。</p>
            </div>
          )}
        </div>
      </div>
      <BottomBar>
        <Button
          variant="primary"
          disabled={overLimit || !selectedSlot || (!waitlistOpen && selectedFull)}
          onClick={goConfirm}
          aria-describedby={overLimit ? 'event-limit-note' : undefined}
        >
          {overLimit
            ? '予約上限に達しています'
            : selectedSlot
              ? selectedFull && waitlistOpen
                ? 'キャンセル待ちで申し込む'
                : 'この時間で申し込む'
              : slots.length === 0
                ? '予約可能な枠がありません'
                : allFull
                  ? '満席です'
                  : '時間を選んでください'}
        </Button>
      </BottomBar>
    </LiffLookScope>
  );
}
