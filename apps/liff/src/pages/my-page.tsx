import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { useCustomerWords, useCustomerStyle } from '../components/customer-style-scope.js';
import { PAYMENT_UNKNOWN } from '../lib/customer-words.js';
import PageHeading from '../components/ui/page-heading.js';
import FieldError from '../components/ui/field-error.js';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  api,
  visitStampsApi,
  type BookingEntitlement,
  type BookingHistoryItem,
  type NotificationPreferenceItem,
  type NotificationPreferences,
} from '../lib/api.js';
import { affiliateSelfApi } from '../lib/affiliate-self-api.js';
import { loadPaymentViews, paymentText, type PaymentView } from '../lib/booking-payment-view.js';
import { utcToJstHm, utcToJstMd, utcToJstWeekday } from '../lib/datetime.js';
import liff from '@line/liff';
import liffRuntime from '../lib/liff-runtime.js';
import { logFailure } from '../lib/user-message.js';
import LiffLookScope from '../components/liff-look-scope.js';
import LiffHeader from '../components/ui/liff-header.js';
import LoadErrorView from '../components/load-error-view.js';
import LoadingView from '../components/loading-view.js';
import Card from '../components/ui/card.js';
import Button from '../components/ui/button/index.js';
import Badge from '../components/ui/badge.js';
import { holdDeadlineText } from '../components/unpaid-payment-note.js';
import Icon, { type IconName } from '../components/ui/icon.js';
import { withHonorific } from '@line-crm/shared'

/** 準備中の案内。本物の口が来るまで、入口は置いて押すとこれを出す。 */
const COMING_SOON = '現在準備中です';

/**
 * 一覧の 1 行の状態。
 * - hidden：数の無い物は出さない（キャンセル待ち 0 件・スタンプカードが無い 等）
 * - soon：本物の口がまだ無い（回数券＝組3・クーポン）。押すと準備中の案内
 */
type RowState =
  | { kind: 'loading' }
  | { kind: 'hidden' }
  | { kind: 'error' }
  | { kind: 'soon' }
  | { kind: 'value'; text: string };

const LOADING: RowState = { kind: 'loading' };

/** 未提供と明示された応答だけを準備中にする。通常の取得失敗は再読込へ進める。 */
function isFeatureNotReady(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 501 || (status === 503 && typeof code === 'string'
    && /^[a-z][a-z0-9_]*_storage_not_ready$/.test(code));
}

/** 回数券・月謝の行の数（「残り 9 回」「今月 あと 2 回」）。 */
export function entitlementSummary(items: BookingEntitlement[]): string | null {
  const usable = items.filter((e) => e.usable);
  const first = usable[0] ?? items[0];
  if (!first) return null;
  if (first.kind === 'monthly') return `今月 あと ${first.monthRemaining ?? '—'} 回`;
  return `残り ${first.remaining ?? '—'} 回`;
}

function ymd(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const jst = japanCalendar(d);
  return `${jst.getUTCFullYear()}/${jst.getUTCMonth() + 1}/${jst.getUTCDate()}`;
}

/** 回数券の 1 件の説明（期限・月謝の今月の利用）。 */
export function entitlementDetail(e: BookingEntitlement): string {
  const until = ymd(e.expiresAt);
  const head = e.kind === 'monthly'
    ? `今月 ${e.monthUsed ?? '—'}／${e.monthAllowance ?? e.monthlyLimit ?? '—'} 回 利用`
    : `残り ${e.remaining ?? '—'} 回`;
  const tail = !e.usable ? '（使えません）' : until ? `・${until} まで` : '';
  return `${head}${tail}`;
}

/**
 * LIFF マイページ (★V8・L5g75)。
 * 次の予約（支払いの状態つき）・キャンセル待ち・回数券・スタンプ・マイル・クーポン・お知らせの受け取り。
 * 口が無い物（回数券＝組3、お知らせの受け取り＝組1・組2 の 637、クーポン）は「現在準備中です」で出す。
 */
export default function MyPage() {
  const words = useCustomerWords();
  const style = useCustomerStyle();
  const navigate = useNavigate();
  const { search } = useLocation();
  const go = (pathname: string) => navigate({ pathname, search });

  const [name, setName] = useState<string | null>(null);
  const [history, setHistory] = useState<{ upcoming: BookingHistoryItem[]; hasPast: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [nextPayment, setNextPayment] = useState<PaymentView | null>(null);
  /* これからの予約のうち、未払いのいちばん早い 1 件（・L5g75：上に琥珀の箱で出す）。 */
  const [unpaid, setUnpaid] = useState<{ booking: BookingHistoryItem; payment: PaymentView } | null>(null);
  const [payBusy, setPayBusy] = useState(false);
  const [waitlist, setWaitlist] = useState<RowState>(LOADING);
  const [tickets, setTickets] = useState<RowState>(LOADING);
  const [ticketItems, setTicketItems] = useState<BookingEntitlement[]>([]);
  const [ticketsOpen, setTicketsOpen] = useState(false);
  const [stamps, setStamps] = useState<RowState>(LOADING);
  const [miles, setMiles] = useState<RowState>(LOADING);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<NotificationPreferences | 'soon' | 'failed' | null>(null);
  const [prefBusy, setPrefBusy] = useState(false);
  const [prefError, setPrefError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    liffRuntime.getProfile().then((p) => setName(p.displayName || null)).catch((e) => logFailure('mypage-profile', e));
  }, []);

  useEffect(() => {
    setFailed(false);
    api.me().then((r) => {
      setHistory({ upcoming: r.upcoming, hasPast: r.past.length > 0 });
      const next = r.upcoming[0];
      if (next) void loadPaymentViews(r.upcoming).then((views) => {
        setNextPayment(views[next.id] ?? null);
        const first = r.upcoming.find((b) => views[b.id]?.kind === 'unpaid' && !views[b.id]?.actionRequired);
        setUnpaid(first ? { booking: first, payment: views[first.id]! } : null);
      });
    }).catch((e) => {
      logFailure('mypage-history', e);
      setFailed(true);
    });
  }, [reloadKey]);

  // キャンセル待ち：待っている・空きの知らせが来ている物だけ数える。
  useEffect(() => {
    api.bookingWaitlists().then((r) => {
      if (!Array.isArray(r.waitlist) || r.waitlist.some((w) => !w || !['waiting', 'invited', 'converted', 'cancelled', 'finished'].includes(w.status))) throw new Error('invalid_waitlist');
      const count = r.waitlist.filter((w) => w.status === 'waiting' || w.status === 'invited').length;
      setWaitlist(count > 0 ? { kind: 'value', text: `${count} 件` } : { kind: 'hidden' });
    }).catch((e) => {
      logFailure('mypage-waitlist', e);
      setWaitlist({ kind: 'error' });
    });
  }, [reloadKey]);

  // 回数券・月謝は本人用APIから取得する。未提供・保存先の準備未了が明示されたときだけ準備中。
  useEffect(() => {
    api.entitlements().then((items) => {
      setTicketItems(items);
      const text = entitlementSummary(items);
      setTickets(text ? { kind: 'value', text } : { kind: 'hidden' });
    }).catch((e) => {
      if (isFeatureNotReady(e)) { setTickets({ kind: 'soon' }); return; }
      logFailure('mypage-entitlements', e);
      setTickets({ kind: 'error' });
    });
  }, [reloadKey]);

  // マイル。制度の無い店は出さない。
  useEffect(() => {
    affiliateSelfApi.rewards().then((r) => {
      setMiles({ kind: 'value', text: r.availableMiles == null ? '—' : r.availableMiles.toLocaleString('ja-JP') });
    }).catch((e) => {
      logFailure('mypage-miles', e);
      setMiles({ kind: 'error' });
    });
  }, [reloadKey]);

  // 店（スタンプ・お知らせの受け取りは店ごと）。
  useEffect(() => {
    api.liffConfig().then((r) => setAccountId(r.data?.accountId ?? '')).catch((e) => {
      logFailure('mypage-config', e);
      setAccountId('');
    });
  }, [reloadKey]);

  useEffect(() => {
    if (accountId === null) return;
    if (!accountId) { setStamps({ kind: 'error' }); setPrefs('failed'); return; }
    visitStampsApi.cards(accountId).then((r) => {
      const entry = r.data.find((c) => c.card.active) ?? r.data[0];
      if (!entry) { setStamps({ kind: 'hidden' }); return; }
      const balance = entry.wallet.balance;
      if (!Number.isSafeInteger(balance) || balance < 0 || !Array.isArray(entry.card.settings.rewards) || entry.card.settings.rewards.some((reward) => !Number.isSafeInteger(reward.stamps) || reward.stamps < 1)) throw new Error('invalid_stamps');
      const next = [...entry.card.settings.rewards].map((x) => x.stamps).sort((a, b) => a - b).find((n) => n > balance);
      setStamps({ kind: 'value', text: next ? `あと ${next - balance} 個` : `${balance} 個` });
    }).catch((e) => {
      logFailure('mypage-stamps', e);
      setStamps({ kind: 'error' });
    });
    api.notificationPreferences(accountId).then((r) => {
      // 送る側が目的ごとに止められるまでは「宣伝だけ止める」を出さない（組1 の 16）。
      setPrefs(r.purposeSpecificEnforcement === true ? r : 'soon');
    }).catch((e) => {
      const notReady = isFeatureNotReady(e);
      if (!notReady) logFailure('mypage-notification-preferences', e);
      setPrefs(notReady ? 'soon' : 'failed');
    });
  }, [accountId, reloadKey]);

  async function togglePref(item: NotificationPreferenceItem) {
    if (prefBusy || !accountId || prefs === null || prefs === 'soon' || prefs === 'failed') return;
    const nextEnabled = !(item.enabled ?? false);
    setPrefBusy(true);
    setPrefError(null);
    // 押した手応えを先に出し、失敗したら戻す。
    const before = prefs;
    setPrefs({ ...prefs, items: prefs.items.map((p) => (p.purpose === item.purpose ? { ...p, enabled: nextEnabled } : p)) });
    try {
      const saved = await api.updateNotificationPreference(accountId, item.purpose, nextEnabled, item.version);
      setPrefs(saved.purposeSpecificEnforcement === false ? 'soon' : { ...before, ...saved, purposeSpecificEnforcement: saved.purposeSpecificEnforcement ?? before.purposeSpecificEnforcement });
    } catch (e) {
      logFailure('mypage-notification-update', e);
      setPrefs(before);
      const status = (e as { status?: number }).status;
      setPrefError(status === 409
        ? 'ほかの画面で変わっていました。読み直したので、もう一度お試しください。'
        : '変えられませんでした。電波のよいところで、もう一度お試しください。');
      if (status === 409) setReloadKey((k) => k + 1);
    } finally {
      setPrefBusy(false);
    }
  }

  const next = history?.upcoming[0] ?? null;
  const visiblePrefs = prefs && typeof prefs === 'object'
    ? prefs.items.filter((item) => !(style === 'ec' && !next && item.purpose === 'booking_reminders')) : null;

  /** ［お支払いへ進む］：予約の 5 段目と同じ口（同じ申込は同じページ）。支払いのページは外のブラウザで開く。 */
  async function runPay(booking: BookingHistoryItem) {
    if (payBusy) return;
    if (nextPayment?.actionRequired) { setNotice(PAYMENT_UNKNOWN); return; }
    setPayBusy(true);
    setNotice(null);
    try {
      const res = await api.startBookingPayment(booking.id);
      if (!res.checkoutUrl) { setNotice(PAYMENT_UNKNOWN); return; }
      liff.openWindow({ url: res.checkoutUrl, external: true });
      setNotice('お支払いのページを開きました。終わったらこの画面に戻ると、状態が変わります。');
    } catch (e) {
      logFailure('mypage-pay', e);
      setUnpaid(null);
      setNextPayment((prev) => prev ? { ...prev, actionRequired: true } : null);
      setNotice(PAYMENT_UNKNOWN);
    } finally {
      setPayBusy(false);
    }
  }

  return (
    <LiffLookScope className="min-h-screen bg-canvas">
      <LiffHeader title="マイページ" />
      <div data-design-node="L5g75" className="mx-auto w-full max-w-md space-y-3 px-4 pt-3 pb-10">
        <PageHeading title={name ?? undefined}>{name ? `${withHonorific(name, 'さん', { space: true })}` : 'マイページ'}</PageHeading>
        {failed ? (
          <LoadErrorView note={style === 'ec' ? '情報はなくなっていません。' : '予約はなくなっていません。'} onRetry={() => setReloadKey((k) => k + 1)} />
        ) : !history ? (
          <LoadingView />
        ) : (
          <>
            {unpaid ? <UnpaidCard booking={unpaid.booking} payment={unpaid.payment} busy={payBusy} onPay={() => void runPay(unpaid.booking)} /> : null}
            {next ? (
              <NextBookingCard booking={next} payment={nextPayment} onChange={() => go('/booking/history')} onDetail={() => go('/booking/history')} />
            ) : style !== 'ec' ? (
              <Card className="space-y-3 p-3.5">
                <p className="text-sm text-ink-secondary">次の予約はありません</p>
                {style !== 'lesson' ? <Button variant="compact-secondary" onClick={() => go('/booking')}>予約する</Button> : null}
              </Card>
            ) : null}

            <Card className="py-0.5">
              <ul>
                {style === 'ec' && (history.hasPast || next) ? <MenuRow icon="calendar" label="予約の履歴" state={{ kind: 'value', text: '' }} onPress={() => go('/booking/history')} /> : null}
                {style === 'lesson' ? <MenuRow icon="calendar" label="予約の確認・振替" state={{ kind: 'value', text: '' }} onPress={() => go('/events/me')} /> : null}
                {style !== 'ec' ? <MenuRow icon="hourglass" label="キャンセル待ち" state={waitlist}
                  onPress={() => waitlist.kind === 'error' ? setReloadKey((k) => k + 1) : go('/booking/history')} /> : null}
                {style !== 'ec' ? <MenuRow icon="ticket" label="回数券" state={tickets} expanded={tickets.kind === 'value' ? ticketsOpen : undefined}
                  onPress={() => tickets.kind === 'error' ? setReloadKey((k) => k + 1) : (tickets.kind === 'value' ? setTicketsOpen((v) => !v) : setNotice(`回数券は${COMING_SOON}。`))} /> : null}
                {tickets.kind === 'value' && ticketsOpen && (
                  <li>
                    <ul className="mx-3.5 mb-2 space-y-1.5 rounded-(--liff-radius) bg-liff-off-bg p-3">
                      {ticketItems.map((e) => (
                        <li key={e.id} className="flex min-w-0 flex-col gap-0.5 text-[13px]">
                          <span className="min-w-0 truncate font-semibold text-ink" title={e.name}>{e.name}</span>
                          <span className="min-w-0 truncate text-liff-sub" title={entitlementDetail(e)}>{entitlementDetail(e)}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                )}
                <MenuRow icon="stamp" label="スタンプ" state={stamps} onPress={() => stamps.kind === 'error' ? setReloadKey((k) => k + 1) : go('/visit-stamps')} />
                <MenuRow icon="gem" label="マイル" state={miles} onPress={() => miles.kind === 'error' ? setReloadKey((k) => k + 1) : go('/affiliate')} />
                <MenuRow icon="tag" label="クーポン" state={{ kind: 'soon' }} onPress={() => setNotice(`クーポンの一覧は${COMING_SOON}。`)} />
              </ul>
            </Card>
            {notice && <p role="status" className="text-[13px] leading-5 text-ink-secondary">{notice}</p>}

            {style !== 'ec' || visiblePrefs?.length !== 0 ? <Card className="space-y-2.5 p-3.5">
              <h2 className="text-sm font-bold text-ink">お知らせの受け取り</h2>
              {prefs === null ? (
                <p className="text-[13px] text-liff-sub">読み込んでいます…</p>
              ) : prefs === 'failed' ? (
                <LoadErrorView compact onRetry={() => setReloadKey((k) => k + 1)} />
              ) : prefs === 'soon' ? (
                <p className="text-[13px] leading-5 text-liff-sub">{`お知らせごとの受け取りの設定は${COMING_SOON}。`}</p>
              ) : (
                <ul className="space-y-2">
                  {visiblePrefs?.map((item) => (
                    <PrefRow key={item.purpose} item={item} busy={prefBusy} onToggle={() => void togglePref(item)} />
                  ))}
                </ul>
              )}
              {prefError && <FieldError>{prefError}</FieldError>}
            </Card> : null}
          </>
        )}
      </div>
    </LiffLookScope>
  );
}

function paymentInk(tone: PaymentView['tone']): string {
  return tone === 'confirmed' ? 'text-liff-ok-ink' : tone === 'pending' ? 'text-liff-wait-ink' : tone === 'info' ? 'text-info-link' : 'text-liff-sub';
}

/** 未払いの予約（琥珀の箱・L5g75）。札・日時とメニュー・払う期限・［お支払いへ進む］。 */
function UnpaidCard({ booking, payment, busy, onPay }: { booking: BookingHistoryItem; payment: PaymentView; busy: boolean; onPay: () => void }) {
  const words = useCustomerWords();
  const title = `${utcToJstMd(booking.starts_at)}（${utcToJstWeekday(booking.starts_at)}）${utcToJstHm(booking.starts_at)} ${booking.menu_name}`;
  return (
    <section aria-label="お支払いが済んでいない予約" className="space-y-3 rounded-(--liff-radius-lg) border border-liff-wait-bg bg-liff-wait-bg p-3.5">
      <div className="flex min-w-0 items-center gap-2">
        <Badge tone={payment.tone}>{paymentText(payment, words.payOnsite)}</Badge>
        <p className="min-w-0 truncate text-[14px] font-bold text-ink" title={title}>{title}</p>
      </div>
      {payment.holdUntil ? <p className="text-[12.5px] leading-[19px] text-ink-secondary">{`${holdDeadlineText(payment.holdUntil)}。過ぎると予約は取り消されます。`}</p> : null}
      <Button variant="primary" disabled={busy} onClick={onPay}>お支払いへ進む</Button>
    </section>
  );
}

/** 次の予約（薄い緑の箱）。日付の四角・時刻・メニュー・担当・支払いの状態・2 つのボタン。 */
function NextBookingCard({ booking, payment, onChange, onDetail }: {
  booking: BookingHistoryItem;
  payment: PaymentView | null;
  onChange: () => void;
  onDetail: () => void;
}) {
  const words = useCustomerWords();
  const title = booking.staff_name ? `${booking.menu_name}・${booking.staff_name}` : booking.menu_name;
  const canChange = (booking.status === 'requested' || booking.status === 'confirmed')
    && typeof booking.lock_version === 'number' && Number.isInteger(booking.lock_version) && booking.lock_version >= 0
    && typeof booking.menu_id === 'string' && typeof booking.staff_id === 'string'
    && Date.now() < Date.parse(booking.starts_at)
    && (!booking.cancel_deadline_at || Date.now() <= Date.parse(booking.cancel_deadline_at));
  return (
    <section aria-label="次の予約" className="space-y-3 rounded-(--liff-radius-lg) border border-liff-ok-bg bg-liff-soft p-3.5">
      <div className="flex items-center gap-3">
        <div className="flex h-[52px] w-[52px] shrink-0 flex-col items-center justify-center rounded-(--liff-radius) bg-canvas">
          <span className="liff-num text-[15px] leading-[18px] font-bold whitespace-nowrap text-ink">{utcToJstMd(booking.starts_at)}</span>
          <span className="text-[11px] leading-[14px] text-liff-sub">{utcToJstWeekday(booking.starts_at)}</span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="liff-num text-xs text-liff-sub">{`次の予約 ${utcToJstHm(booking.starts_at)}`}</p>
          <p className="truncate text-[15px] font-bold text-ink" title={title}>{title}</p>
          {payment?.actionRequired ? <p role="status" className="text-xs text-liff-sub">{PAYMENT_UNKNOWN}</p> : payment ? (
            <p className={`liff-num text-xs font-bold ${paymentInk(payment.tone)}`}>{paymentText(payment, words.payOnsite)}</p>
          ) : booking.status === 'requested' ? (
            <p className="text-xs font-bold text-liff-wait-ink">{words.approvalPending}</p>
          ) : null}
        </div>
      </div>
      <div className="flex gap-2">
        {canChange ? <Button variant="secondary" className="flex-1" onClick={onChange}>日時を変える</Button> : null}
        <Button variant="secondary" className="flex-1" onClick={onDetail}>予約の詳細</Button>
      </div>
    </section>
  );
}

function MenuRow({ icon, label, state, onPress, expanded }: {
  icon: IconName;
  label: string;
  state: RowState;
  onPress: () => void;
  expanded?: boolean;
}) {
  if (state.kind === 'hidden') return null;
  const value = state.kind === 'value' ? state.text : state.kind === 'soon' ? '準備中' : state.kind === 'error' ? 'もう一度読み込む' : '…';
  return (
    <li>
      <Button variant="menuRow" onClick={onPress} disabled={state.kind === 'loading'} aria-expanded={expanded}>
        <Icon name={icon} className="h-5 w-5 shrink-0 text-liff-primary" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className={`liff-num shrink-0 whitespace-nowrap text-[13px] ${state.kind === 'soon' ? 'text-liff-idle' : 'text-liff-sub'}`}>{value}</span>
        <Icon name="chevron-right" className="h-4 w-4 shrink-0 text-liff-idle" />
      </Button>
    </li>
  );
}

const PREF_HINT: Record<string, string> = {
  booking_reminders: '前日・当日の連絡は止められません',
  marketing: '新しいサービスやクーポンのお知らせ',
};

/**
 * お知らせの受け取りの 1 行。予約のお知らせは止められない（受け取るの札）。
 * 宣伝・キャンペーンは入り／切り。
 */
function PrefRow({ item, busy, onToggle }: { item: NotificationPreferenceItem; busy: boolean; onToggle: () => void }) {
  const label = item.purpose === 'booking_reminders' ? '予約のお知らせ' : item.purpose === 'marketing' ? 'キャンペーン・宣伝' : item.label;
  const on = item.enabled === true;
  return (
    <li className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-ink">{label}</p>
        <p className="truncate text-[11px] text-liff-sub">{PREF_HINT[item.purpose] ?? ''}</p>
      </div>
      {item.purpose === 'booking_reminders' ? (
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-bold whitespace-nowrap ${item.enabled === false ? 'bg-liff-chip text-liff-sub' : 'bg-liff-ok-bg text-liff-ok-ink'}`}>
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${item.enabled === false ? 'bg-liff-idle' : 'bg-liff-primary'}`} />
          {item.enabled === false ? '止めています' : '受け取る'}
        </span>
      ) : (
        <Button variant="switch" role="switch" aria-checked={on} aria-label={`${label}を受け取る`} disabled={busy} onClick={onToggle} />
      )}
    </li>
  );
}
