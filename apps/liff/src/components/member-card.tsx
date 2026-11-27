import { useEffect, useState } from 'react';
import liff from '@line/liff';
import Card from './ui/card.js';
import ProgressBar from './ui/progress-bar.js';
import Button from './ui/button/index.js';

/*
 * 会員証の段（G5-3 板 I2pkdP）。マイル・紹介の画面の上に、今のランク・次の段まで・下がる予定を出す。
 * 受け口は GET /api/liff/member-card（本人の LINE ID token）。ランクを動かしていない店・まだ段が無い人は null で、何も出さない。
 * 会員番号と特典の 1 行は、この受け口がまだ返さないので出さない。
 */
const BASE = import.meta.env.VITE_API_BASE ?? '';

export interface MemberCardData {
  name: string;
  since: string;
  downgradeDueAt: string | null;
  next: { name: string; remaining: number; metric: 'visits' | 'amount' | 'miles'; progress: number } | null;
  /** 会員番号と特典の行（受け口が返す）。値が無いときは出さない。 */
  memberNumber?: string | null;
  benefits?: string[];
}

const UNIT = { visits: '回の利用', amount: '円の購入', miles: 'マイル' } as const;
const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

export async function fetchMemberCard(): Promise<MemberCardData | null> {
  const idToken = liff.getIDToken();
  if (!idToken) throw new Error('LINEで開き直してください');
  const url = new URL(`${BASE}/api/liff/member-card`, window.location.origin);
  url.searchParams.set('liffId', liff.id ?? '');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` }, cache: 'no-store', referrerPolicy: 'no-referrer', redirect: 'error' });
  if (!response.ok) throw new Error('member-card');
  const body = (await response.json()) as { success: boolean; data: MemberCardData | null };
  if (!body || body.success !== true || body.data === undefined) throw new Error('member-card');
  return body.data;
}

export function MemberCardView({ card }: { card: MemberCardData }) {
  const unit = card.next && Object.hasOwn(UNIT, card.next.metric) ? UNIT[card.next.metric] : null;
  const goal = card.next && !unit ? '次のランクの条件を確認できません' : card.next && card.next.remaining > 0 ? `${card.next.name}まで あと ${card.next.remaining.toLocaleString()} ${unit}` : card.next ? `${card.next.name}の条件を満たしています` : '最上位のランクです';
  return <section aria-label="会員証" className="space-y-3">
    <div data-liff-card className="flex flex-col gap-2.5 rounded-(--liff-radius-lg) bg-liff-member-card p-4 text-white">
      <div className="flex items-center justify-between text-xs text-liff-deep-sub"><span>会員証</span>{card.memberNumber ? <span>{`No. ${card.memberNumber}`}</span> : null}</div>
      <p className="text-[28px] leading-9 font-bold">{card.name}</p>
      {card.next && typeof card.next.progress === 'number' ? <ProgressBar value={card.next.progress} label={`${card.next.name}まで`} className="text-liff-member-bar" /> : null}
      <p className="text-sm font-bold">{goal}</p>
      {card.benefits && card.benefits.length > 0 ? <p className="text-xs text-liff-deep-sub">{`特典：${card.benefits.join('・')}`}</p> : null}
    </div>
    {card.downgradeDueAt ? <Card className="space-y-1 p-4">
      <p className="text-xs text-ink-secondary">ランクが下がる前のお知らせ</p>
      <p className="text-sm text-ink">{`${md(card.downgradeDueAt)} までに条件を満たすと、${card.name}のままです。`}</p>
    </Card> : null}
  </section>;
}

export default function MemberCard() {
  const [card, setCard] = useState<MemberCardData | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    fetchMemberCard().then((data) => { if (alive) setCard(data); }).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; };
  }, [attempt]);
  if (failed) return <div role="alert" className="space-y-2 text-sm text-liff-sub"><p>会員証を読み込めませんでした。</p><Button variant="secondary" onClick={() => setAttempt(n => n + 1)}>会員証をもう一度確認</Button></div>;
  return card ? <MemberCardView card={card} /> : null;
}
