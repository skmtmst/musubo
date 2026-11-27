import { liffErrorMessage } from '../lib/api-error.js';

import { TextInput } from '../components/forms/controls.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { visitStampDarkInk } from '@line-crm/shared';
import stampStyles from './visit-stamps.module.css';
import StampConditions from '../components/stamp-conditions.js';
import type { VisitStampCard, VisitStampPaperRequest, VisitStampRedemption, VisitStampReward, VisitStampWallet } from '@line-crm/shared';
import { api, visitStampsApi } from '../lib/api.js';
import { SUBMIT_FAILED_MESSAGE, logFailure } from '../lib/user-message.js';
import LiffHeader from '../components/ui/liff-header.js';
import LiffLookScope from '../components/liff-look-scope.js';
import LoadingView from '../components/loading-view.js';
import LoadErrorView from '../components/load-error-view.js';
import PreparingView from '../components/preparing-view.js';
import BottomBar from '../components/ui/bottom-bar.js';
import Button from '../components/ui/button/index.js';
import Badge from '../components/ui/badge.js';
import Icon from '../components/ui/icon.js';
import { LiffInput } from '../components/forms/controls.js'
import { useUrlStep } from '../lib/use-url-step.js';

/**
 * 来店スタンプ（お客さまの LIFF）。マイルとは別のスタンプカード。
 *  ① スタンプカード→［店員に見せる］② 特典を店員に見せる→ 店員が暗証番号を打つ → 使用済み
 *  ①［紙のカードを移す］→ ③ 紙のカードを移す→ 写真を預けて［申請する］→ お店の確認待ち
 *    確認待ちの申請があるあいだは、③ を開くと確認待ちを出す（同じ紙を二重に送らない）。却下されたら理由を ③ に出す。
 * お客さま本人だけでは使用済みにできない（店員の4桁の暗証番号が要る。店員は暗証番号からサーバが当てる）。使用済み・取消済みの特典はサーバが二度と使わせない。
 * 店舗は /api/liff/config の accountId、本人は LINE の ID トークン（サーバが確かめる）。
 */

type View = 'card' | 'show' | 'used' | 'paper' | 'pending';
type Entry = { card: VisitStampCard; wallet: VisitStampWallet };

/** 使用後にページを開き直しても、受け取った次のカードを表示する。 */
export function currentStampCard(entries: Entry[], wanted: string | null): Entry | null {
  let entry = entries.find(x => x.card.id === wanted) ?? entries[0] ?? null;
  const seen = new Set<string>();
  while (entry && !seen.has(entry.card.id)) {
    seen.add(entry.card.id);
    if (entry.card.settings.completion !== 'next_card') break;
    const next = entries.find(x => x.card.id === entry!.card.settings.nextCardId);
    if (!next) break;
    entry = next;
  }
  return entry;
}

const sorted = (rewards: VisitStampReward[]) => [...rewards].sort((a, b) => a.stamps - b.stamps);
/** マスの数。カードの設定（slotCount）を使い、無い古いカードはいちばん大きい特典の個数。 */
const total = (card: VisitStampCard) => card.settings.slotCount ?? Math.max(0, ...card.settings.rewards.map((r) => r.stamps));
const requestId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `r-${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** 「2026年7月13日」（日本時間）。 */
export function jpDate(iso: string): string {
  const f = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric' });
  return f.format(new Date(iso));
}
/** 「2026年1月13日 18:53」・「1月13日 18:52」（日本時間）。 */
export function jpDateTime(date: Date, withYear = true): string {
  const f = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', ...(withYear ? { year: 'numeric' } : {}), month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return f.format(date).replace(/\s+/, ' ');
}

/** カードの状態の見せ方（いま使える特典・次の目標）。試験は VisitStamps.test.tsx。 */
export function cardState(card: VisitStampCard, balance: number) {
  const rewards = sorted(card.settings.rewards);
  const usable = rewards.filter((r) => r.stamps <= balance);
  const next = rewards.find((r) => r.stamps > balance) ?? null;
  return { rewards, usable, best: usable[usable.length - 1] ?? null, next };
}

/** 店のエラー文（サーバの日本語の理由）があればそれ、無ければ汎用の文。英語・コードは出さない。 */
function reasonOf(err: unknown): string {
  const body = (err as { body?: { error?: unknown } })?.body;
  return liffErrorMessage(body, SUBMIT_FAILED_MESSAGE);
}

function Slots({ card, balance }: { card: VisitStampCard; balance: number }) {
  const count = total(card);
  const rewardAt = new Map(card.settings.rewards.map((r) => [r.stamps, r]));
  return (
    <div className={stampStyles.slots} role="list" aria-label={`${count}個中 ${Math.min(balance, count)}個 たまっています`}>
      {Array.from({ length: count }, (_, i) => {
        const n = i + 1;
        const done = n <= balance;
        const reward = rewardAt.get(n);
        return (
          <span
            key={n}
            role="listitem"
            aria-label={done ? `${n}個目 済み` : reward ? `${n}個目 ${reward.name}` : `${n}個目`}
            className={`${stampStyles.slot} ${reward ? stampStyles.reward : ''} ${done ? stampStyles.done : ''}`}
          >
            {done ? <Icon name="check" className="h-6 w-6" /> : reward ? (
              <>
                <Icon name="gift" className="h-4 w-4" />
                <span className="text-[9px] leading-[14px] font-semibold">{`${n}個`}</span>
              </>
            ) : <span className="liff-num text-[13px] leading-5">{n}</span>}
          </span>
        );
      })}
    </div>
  );
}

function InfoRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="flex w-full flex-col gap-2 rounded-xl bg-liff-off-bg p-4">
      {rows.map(([k, v]) => (
        <div key={k} className="flex gap-3">
          <dt className="w-14 shrink-0 text-[13px] leading-5 text-liff-sub">{k}</dt>
          <dd className="min-w-0 flex-1 text-[13px] leading-5 font-medium text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function TextButton({ icon, children, onClick }: { icon?: 'camera'; children: string; onClick: () => void }) {
  return (
    <Button variant="text" className="mx-auto" type="button" onClick={onClick}>
      {icon ? <Icon name={icon} className="h-4 w-4" /> : null}
      {children}
    </Button>
  );
}

export default function VisitStamps() {
  const [accountId, setAccountId] = useState('');
  const [shopName, setShopName] = useState('');
  const [entry, setEntry] = useState<Entry | null>(null);
  const [state, setState] = useState<'loading' | 'error' | 'empty' | 'ready'>('loading');
  const [view, setView] = useUrlStep<View>('card');
  const [picked, setPicked] = useState<string>('');
  const [redemption, setRedemption] = useState<(VisitStampRedemption & { shownAt: Date }) | null>(null);
  const [used, setUsed] = useState<{ at: Date; balance: number; staffName: string } | null>(null);
  /* 自分の紙のカードの申請（確認待ち・承認・却下と理由）。 */
  const [requestsFailed, setRequestsFailed] = useState(false);
  const requestsGeneration = useRef(0);
  const [requests, setRequests] = useState<VisitStampPaperRequest[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    try {
      const config = await api.liffConfig();
      const account = config.data.accountId;
      setAccountId(account); setShopName(config.data.accountName ?? '');
      const list = await visitStampsApi.cards(account);
      if (!Array.isArray(list?.data) || !list.data.every(item => item?.card && item.wallet &&
        typeof item.card.id === 'string' && typeof item.card.name === 'string' &&
        item.card.settings && Array.isArray(item.card.settings.rewards) &&
        typeof item.wallet.balance === 'number' && Number.isFinite(item.wallet.balance))) {
        throw new Error('Invalid stamp cards response');
      }
      const wanted = new URLSearchParams(window.location.search).get('card');
      const found = currentStampCard(list.data, wanted);
      setEntry(found);
      setState(found ? 'ready' : 'empty');
    } catch (e) {
      logFailure('visit-stamps', e);
      setState('error');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const loadRequests = useCallback(async () => {
    if (!accountId || !entry) return;
    const generation = ++requestsGeneration.current;
    setRequests(null); setRequestsFailed(false);
    try { const response = await visitStampsApi.paperRequests(accountId, entry.card.id); if (!Array.isArray(response?.data)) throw new Error('Invalid paper requests response'); if (generation === requestsGeneration.current) setRequests(response.data); }
    catch (e) { logFailure('visit-stamps-paper-requests', e); if (generation === requestsGeneration.current) setRequestsFailed(true); }
  }, [accountId, entry]);
  useEffect(() => { void loadRequests(); return () => { requestsGeneration.current++; }; }, [loadRequests]);

  const info = useMemo(() => (entry ? cardState(entry.card, entry.wallet.balance) : null), [entry]);
  const chosen = info?.usable.find((r) => r.id === picked) ?? info?.best ?? null;
  const offerRequest = useRef(requestId());

  async function show() {
    if (!entry || !chosen) return;
    setBusy(true); setError('');
    try {
      const res = await visitStampsApi.showReward(accountId, entry.card.id, chosen.id, offerRequest.current);
      setRedemption({ ...res.data, shownAt: new Date() });
      setView('show');
    } catch (e) {
      logFailure('visit-stamps-show', e);
      setError(reasonOf(e));
    } finally { setBusy(false); }
  }

  if (state === 'loading') return <LiffLookScope appearance="stamp" className="min-h-screen bg-canvas"><LiffHeader title="来店スタンプ" /><LoadingView /></LiffLookScope>;
  if (state === 'error') return <LiffLookScope appearance="stamp" className="min-h-screen bg-canvas"><LiffHeader title="来店スタンプ" /><LoadErrorView note="スタンプはなくなっていません。" onRetry={() => void load()} /></LiffLookScope>;
  /*  追記：お店がまだカード（決まり）を入れていないときは、リッチメニューから押されても準備中の画面（K9HMJp）。 */
  if (state === 'empty' || !entry || !info) {
    return (
      <LiffLookScope appearance="stamp" className="min-h-screen bg-canvas">
        <PreparingView title="来店スタンプ" feature="来店スタンプ" />
      </LiffLookScope>
    );
  }

  const { card, wallet } = entry;
  const count = total(card);

  if (view === 'show' && redemption) {
    return (
      <ShowReward
        redemption={redemption}
        shopName={shopName}
        onBack={() => { setView('card'); offerRequest.current = requestId(); }}
        onUse={async (pin) => {
          const result = await visitStampsApi.useReward(accountId, redemption.id, pin);
          offerRequest.current = requestId();
          const fresh = await visitStampsApi.card(accountId, result.data.nextCardId ?? card.id).catch(() => null);
          const balance = fresh?.data.wallet.balance ?? Math.max(0, wallet.balance - redemption.stamps);
          if (fresh) setEntry({ card: fresh.data.card, wallet: fresh.data.wallet });
          setUsed({ at: new Date(), balance, staffName: result.data.staffName });
          setView('used');
        }}
      />
    );
  }

  if (view === 'used' && redemption && used) {
    const next = cardState(card, used.balance).next;
    return (
      <LiffLookScope appearance="stamp" className="min-h-screen bg-canvas" designNode="xe8ga">
        <LiffHeader title="特典を使う" />
        <div className="mx-auto flex w-full max-w-md flex-col gap-4 p-5 pb-40">
          <div className="flex flex-col items-center gap-2.5 px-4 pt-12 pb-6 text-center">
            <span className="flex h-18 w-18 items-center justify-center rounded-full bg-liff-ok-bg text-liff-primary" aria-hidden="true"><Icon name="check" className="h-9 w-9" /></span>
            <h1 className="text-2xl leading-9 font-bold text-ink">使用済み</h1>
            <p className="text-base leading-6 font-semibold text-ink">{redemption.rewardName}</p>
          </div>
          <InfoRows rows={[
            ['日時', jpDateTime(used.at)],
            ['店舗', shopName || '—'],
            ['担当', used.staffName || '店員'],
            ['カード', `残り ${used.balance}個${next ? `（次は${next.name}）` : ''}`],
          ]} />
        </div>
        <BottomBar appearance="stamp">
          <Button variant="secondary" className="min-h-12" onClick={() => { setView('card'); setRedemption(null); setUsed(null); setPicked(''); }}>カードに戻る</Button>
        </BottomBar>
      </LiffLookScope>
    );
  }

  if (view === 'paper' || view === 'pending') {
    if (requestsFailed || requests === null) return <LiffLookScope appearance="stamp" className="min-h-screen bg-canvas"><LiffHeader title="紙のカードを移す" />{requestsFailed ? <LoadErrorView note="申請はなくなっていません。" onRetry={() => void loadRequests()} /> : <LoadingView />}<BottomBar appearance="stamp"><Button variant="secondary" onClick={() => setView('card')}>カードに戻る</Button></BottomBar></LiffLookScope>;
    return (
      <PaperCard
        accountId={accountId}
        cardId={card.id}
        requests={requests}
        onSent={() => { setView('pending'); void loadRequests(); }}
        onBack={() => setView('card')}
      />
    );
  }

  return (
    <LiffLookScope appearance="stamp" className="min-h-screen bg-canvas" designNode="jQRsr">
      <LiffHeader title="来店スタンプ" />
      <div className="mx-auto flex w-full max-w-md flex-col gap-4 p-5 pb-44">
        <section className={stampStyles.card} aria-label={card.name} style={card.settings.backgroundColor ? { backgroundColor: card.settings.backgroundColor, color: visitStampDarkInk(card.settings.backgroundColor) ? 'var(--color-ink)' : 'var(--color-canvas)' } : undefined}>
          {card.settings.backgroundImageUrl ? <img className={stampStyles.background} src={card.settings.backgroundImageUrl} alt="" /> : null}
          <div className={stampStyles.content}>
          <div className={stampStyles.title} style={card.settings.backgroundImageUrl ? { backgroundColor: card.settings.backgroundColor ?? 'var(--color-canvas)' } : undefined}>
            <h1 className="min-w-0 flex-1 truncate text-sm leading-[21px] font-semibold">{card.name}</h1>
            <span className={`${stampStyles.balance} liff-num text-sm leading-[21px] font-bold`} style={card.settings.backgroundColor ? { color: 'inherit' } : undefined}>{`${Math.min(wallet.balance, count)} / ${count}`}</span>
          </div>
          <Slots card={card} balance={wallet.balance} />
          {card.settings.instructions ? <p className={stampStyles.instructions} style={card.settings.backgroundImageUrl ? { backgroundColor: card.settings.backgroundColor ?? 'var(--color-canvas)' } : undefined}>{card.settings.instructions}</p> : null}
          <p className={stampStyles.expiry} style={card.settings.backgroundImageUrl ? { backgroundColor: card.settings.backgroundColor ?? 'var(--color-canvas)' } : undefined}>
            {wallet.expiresAt
              ? `期限：${jpDate(wallet.expiresAt)}${card.settings.expiryMonths ? `（${card.settings.expiryBasis === 'first_visit' ? '最初' : '最後'}の来店から ${card.settings.expiryMonths}か月）` : ''}`
              : card.settings.expiryBasis !== 'none' && card.settings.expiryMonths ? `期限：${card.settings.expiryBasis === 'first_visit' ? '最初' : '最後'}の来店から ${card.settings.expiryMonths}か月` : '期限はありません'}
          </p>
          </div>
        </section>

        {info.best ? (
          <section className="flex flex-col gap-2.5 rounded-2xl bg-liff-ok-bg p-4 outline-[1.5px] outline-liff-primary" aria-label="使える特典">
            <p className="flex items-center gap-2 text-sm leading-[21px] font-semibold text-liff-primary"><Icon name="gift" className="h-4 w-4" />使える特典があります</p>
            <p className="text-base leading-6 font-semibold text-ink">{chosen ? `${chosen.name}（${chosen.stamps}個の特典）` : ''}</p>
          </section>
        ) : null}

        <h2 className="text-[15px] leading-[23px] font-semibold text-ink">
          {info.next ? `あと ${info.next.stamps - wallet.balance}個で${info.next.name}` : 'すべての特典が使えます'}
        </h2>
        <ul className="flex flex-col gap-1.5" aria-label="特典の一覧">
          {info.rewards.map((r) => {
            const ok = r.stamps <= wallet.balance;
            const selected = chosen?.id === r.id;
            return (
              <li key={r.id}>
                <Button variant={info.usable.length > 1 ? 'stamp-choice' : 'stamp-reward'} selected={selected}
                  type="button"
                  disabled={!ok}
                  onClick={() => setPicked(r.id)}
                  aria-pressed={ok ? selected : undefined}
                >
                  <span className="w-10 shrink-0 text-[13px] leading-5 font-semibold text-ink">{`${r.stamps}個`}</span>
                  <span className="min-w-0 flex-1 truncate text-sm leading-[21px] text-ink">{r.name}</span>
                  <span className="text-[13px] leading-5 text-liff-sub">{ok ? '使えます' : `あと ${r.stamps - wallet.balance}個`}</span>
                </Button>
              </li>
            );
          })}
        </ul>
        <StampConditions settings={card.settings} />
        {error ? <p role="alert" className="text-[13px] leading-5 text-danger">{error}</p> : null}
      </div>
      <BottomBar appearance="stamp">
        {info.best ? (
          <Button variant="stamp-primary" disabled={busy} onClick={() => void show()}><Icon name="gift" className="h-4 w-4" />店員に見せる</Button>
        ) : null}
        <TextButton icon="camera" onClick={() => setView('paper')}>紙のカードを移す</TextButton>
      </BottomBar>
    </LiffLookScope>
  );
}

/** ② 特典を店員に見せる。暗証番号は店員が打つ。お客さま本人では使用済みにできない。 */
function ShowReward({ redemption, shopName, onBack, onUse }: {
  redemption: VisitStampRedemption & { shownAt: Date };
  shopName: string;
  onBack: () => void;
  onUse: (pin: string) => Promise<void>;
}) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const shortShop = shopName.split(/\s*-\s*/).pop() || shopName;

  async function submit() {
    if (pin.length !== 4) { setError('店員の暗証番号を4桁で入れてください。'); input.current?.focus(); return; }
    setBusy(true); setError('');
    try {
      // 店員は選ばない。暗証番号だけで、サーバがこの店の店員を当てる（当たらない・重なるときは断る）。
      await onUse(pin);
    } catch (e) {
      logFailure('visit-stamps-use', e);
      setError(reasonOf(e));
      setPin('');
    } finally { setBusy(false); }
  }

  return (
    <LiffLookScope appearance="stamp" className="min-h-screen bg-canvas" designNode="V2HU7">
      <LiffHeader title="特典を使う" />
      <div className="mx-auto flex w-full max-w-md flex-col gap-4 p-5 pb-44">
        <section className="flex flex-col items-center gap-2 rounded-2xl bg-liff-ok-bg px-4 py-7 text-center outline-[1.5px] outline-liff-primary" aria-label="見せる特典">
          <Icon name="gift" className="h-8 w-8 text-liff-primary" />
          <p className="text-[30px] leading-[45px] font-bold text-ink">{redemption.rewardName}</p>
          <p className="text-[13px] leading-5 text-liff-sub">{`来店スタンプ ${redemption.stamps}個の特典`}</p>
          <p className="text-[13px] leading-5 text-liff-sub">{`${jpDateTime(redemption.shownAt, false)}${shortShop ? `・${shortShop}` : ''}`}</p>
        </section>
        <p className="flex items-center gap-2 rounded-(--liff-radius) bg-liff-note px-3 py-2.5 text-[13px] leading-5 text-ink">
          <Icon name="info" className="h-4 w-4 shrink-0 text-liff-sat" />
          この画面を店員に見せてください。店員が押すと使用済みになります。
        </p>
        <div className="flex flex-col gap-2.5 border-t border-liff-line pt-4">
          <p className="flex items-center gap-1.5 text-[13px] leading-5 font-semibold text-liff-sub"><Icon name="lock" className="h-4 w-4" />店員の操作</p>
          <label className="relative flex w-fit flex-col gap-1.5">
            <span className="text-[13px] leading-5 font-medium text-ink">店員の暗証番号（4桁）</span>
            <span className="flex gap-2" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className={`flex h-12 w-12 items-center justify-center rounded-xl bg-liff-chip liff-num text-xl leading-6 font-medium text-ink ${i === pin.length ? 'outline-[1.5px] outline-liff-primary' : 'outline outline-liff-line-strong'}`}>
                  {i < pin.length ? '●' : i === pin.length ? <span className="h-6 w-0.5 rounded-xs bg-ink" /> : ''}
                </span>
              ))}
            </span>
            <TextInput appearance="pin"
              ref={input}
              aria-label="店員の暗証番号（4桁）"
              inputMode="numeric"
              autoComplete="off"
              type="password"
              maxLength={4}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
            />
          </label>
          <p className="text-xs leading-[18px] text-liff-sub">お客さまご自身では使用済みにできません</p>
          {error ? <p role="alert" className="text-[13px] leading-5 text-danger">{error}</p> : null}
        </div>
      </div>
      <BottomBar appearance="stamp">
        <Button variant="stamp-primary" disabled={busy} onClick={() => void submit()}><Icon name="check" className="h-4 w-4" />使用済みにする</Button>
        <TextButton onClick={onBack}>戻る</TextButton>
      </BottomBar>
    </LiffLookScope>
  );
}

/** 申請の新しい順の先頭（確認待ちがあればそれ）。 */
export function latestRequest(requests: VisitStampPaperRequest[] | null): VisitStampPaperRequest | null {
  const list = [...(requests ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return list.find((r) => r.status === 'pending') ?? list[0] ?? null;
}

/** 申請日時（サーバの UTC。タイムゾーンの無い形も UTC として読む）。 */
function requestDate(value: string): Date {
  return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
}

/**
 * ③ 紙のカードを移す。写真を預け（本人だけが読める置き場）、押してある数と一緒に申請する。お店が確かめてから足す。
 * 確認待ちの申請があるあいだは、確認待ちを出す。却下された申請があれば、その理由を上に出す。
 */
function PaperCard({ accountId, cardId, requests, onSent, onBack }: { accountId: string; cardId: string; requests: VisitStampPaperRequest[] | null; onSent: () => void; onBack: () => void }) {
  const [photo, setPhoto] = useState<{ file: File; url: string } | null>(null);
  const [stamps, setStamps] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sentAt, setSentAt] = useState<Date | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.url); }, [photo]);
  const latest = latestRequest(requests);
  const pending = latest?.status === 'pending' ? latest : null;

  if (sentAt || pending) {
    const shownStamps = pending ? pending.stamps : stamps;
    const shownAt = pending ? requestDate(pending.createdAt) : sentAt;
    return (
      <LiffLookScope appearance="stamp" className="min-h-screen bg-canvas" designNode="etLd8">
        <LiffHeader title="紙のカードを移す" />
        <div className="mx-auto flex w-full max-w-md flex-col gap-4 p-5 pb-40">
          <div className="flex flex-col items-center gap-2.5 px-4 pt-12 pb-6 text-center">
            <span className="flex h-18 w-18 items-center justify-center rounded-full bg-liff-wait-bg text-ink" aria-hidden="true"><Icon name="hourglass" className="h-9 w-9" /></span>
            <h1 className="text-2xl leading-9 font-bold text-ink">お店の確認待ち</h1>
            <Badge tone="pending" withDot>確認待ち</Badge>
            <p className="w-full text-sm leading-[21px] text-liff-sub">確認できたらカードに足して、LINE でお知らせします。</p>
          </div>
          <InfoRows rows={[['押印数', `${shownStamps} 個`], ['申請日', shownAt ? jpDateTime(shownAt) : '—'], ['写真', '1枚']]} />
        </div>
        <BottomBar appearance="stamp">
          <Button variant="secondary" className="min-h-12" onClick={onBack}>カードに戻る</Button>
        </BottomBar>
      </LiffLookScope>
    );
  }

  async function submit() {
    if (!photo) { setError('紙のカードの写真を撮ってください。'); return; }
    setBusy(true); setError('');
    try {
      const check = paperPhotoProblem(photo.file);
      if (check) { setError(check); return; }
      const uploaded = await visitStampsApi.uploadPaperPhoto(accountId, cardId, photo.file);
      await visitStampsApi.requestPaper(accountId, cardId, { photoUrl: uploaded.data.photoUrl, stamps });
      setSentAt(new Date());
      onSent();
    } catch (e) {
      logFailure('visit-stamps-paper', e);
      setError(reasonOf(e));
    } finally { setBusy(false); }
  }

  return (
    <LiffLookScope appearance="stamp" className="min-h-screen bg-canvas" designNode="h2HKh">
      <LiffHeader title="紙のカードを移す" />
      <div className="mx-auto flex w-full max-w-md flex-col gap-4 p-5 pb-36">
        <p className="text-sm leading-[21px] text-liff-sub">お手持ちの紙のスタンプカードを、LINE のカードに移せます。お店が確認してから足します。</p>
        {latest?.status === 'rejected' ? (
          <p role="status" className="rounded-(--liff-radius) bg-liff-note px-3 py-2.5 text-[13px] leading-5 text-ink">
            {`前の申請（${latest.stamps}個）は、お店が確認できませんでした${latest.reason ? `：${latest.reason}` : ''}。写真を撮り直して、もう一度申請できます。`}
          </p>
        ) : null}
        <div className="flex flex-col gap-2">
          <h2 className="text-sm leading-[21px] font-semibold text-ink">① 紙のカードの写真</h2>
          <div className="flex h-[190px] w-full flex-col items-center justify-center gap-1.5 overflow-hidden rounded-xl bg-liff-off-bg outline outline-liff-line">
            {photo ? <img src={photo.url} alt="撮った紙のカード" className="h-full w-full object-contain" /> : (
              <>
                <Icon name="image" className="h-6 w-6 text-liff-sub" />
                <span className="text-xs leading-[18px] text-liff-sub">紙のカード（表）</span>
              </>
            )}
          </div>
          <TextInput appearance="hidden" ref={fileRef} type="file" accept="image/*" capture="environment" aria-label="紙のカードの写真"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) { if (photo) URL.revokeObjectURL(photo.url); setPhoto({ file: f, url: URL.createObjectURL(f) }); setError(''); } e.target.value = ''; }} />
          {/* 絵の「撮り直す」は高さ36の枠のボタン（副ボタン 44 より低い）。 */}
          <Button variant="compact-secondary" type="button" onClick={() => fileRef.current?.click()}>
            <Icon name="camera" className="h-4 w-4" />{photo ? '撮り直す' : '写真を撮る'}
          </Button>
        </div>
        <div className="flex flex-col gap-2">
          <h2 className="text-sm leading-[21px] font-semibold text-ink">② 押してある数</h2>
          <div className="flex items-center gap-3">
            <Button variant="counter" type="button" aria-label="1個へらす" disabled={stamps <= 1} onClick={() => setStamps((n) => Math.max(1, n - 1))}><Icon name="minus" className="h-4 w-4" /></Button>
            <span className="liff-num text-xl leading-[30px] font-bold text-ink" aria-live="polite">{`${stamps} 個`}</span>
            <Button variant="counter" type="button" aria-label="1個ふやす" disabled={stamps >= 100} onClick={() => setStamps((n) => Math.min(100, n + 1))}><Icon name="plus" className="h-4 w-4" /></Button>
          </div>
        </div>
        {error ? <p role="alert" className="text-[13px] leading-5 text-danger">{error}</p> : null}
      </div>
      <BottomBar appearance="stamp">
        <Button variant="stamp-primary" disabled={busy} onClick={() => void submit()}><Icon name="send" className="h-4 w-4" />申請する</Button>
      </BottomBar>
    </LiffLookScope>
  );
}

/** 預ける前の確かめ（サーバと同じ境目：JPEG・PNG・WebP、5MB まで）。問題が無ければ空文字。 */
export function paperPhotoProblem(file: Pick<File, 'type' | 'size'>): string {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return '写真は JPEG・PNG・WebP で撮ってください。';
  if (file.size > 5 * 1024 * 1024) return '写真が大きすぎます（5MB まで）。もう一度撮ってください。';
  return '';
}
