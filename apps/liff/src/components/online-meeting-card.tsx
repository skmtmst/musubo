import { jstCalendar as japanCalendar } from '@line-crm/shared';
import { useEffect, useState } from 'react';
import { api, type BookingHistoryItem } from '../lib/api.js';
import Icon from './ui/icon.js';
import Button from './ui/button/index.js';
import { useCustomerStyle } from './customer-style-scope.js';

/**
 * 予約が済んだあとのオンラインの会議（B7・★V8 sjkwK・I5hxa）。
 * 確定：会議の URL を開くボタンは開始 10 分前から終わりまでだけ出す（それより前は時刻だけ）。
 * 確認待ち：URL は出さず「確定したら LINE で送る」とだけ伝える（口も確定の前は URL を返さない）。
 * 読む口は予約の履歴（/api/liff/booking/me の meeting_mode・meeting_url）。対面・読めないときは何も出さない。
 */
const JOIN_BEFORE_MS = 10 * 60 * 1000;

export function meetingProvider(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    if (host.endsWith('zoom.us')) return 'Zoom';
    if (host === 'meet.google.com') return 'Google Meet';
    if (host.endsWith('teams.microsoft.com') || host.endsWith('teams.live.com')) return 'Teams';
  } catch {
    return null;
  }
  return null;
}

function hm(ms: number): string {
  const d = japanCalendar(new Date(ms));
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function safeMeetingUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

export default function OnlineMeetingCard({ bookingId, status, booking, now = () => Date.now() }: { bookingId: string | null | undefined; status: string; booking?: BookingHistoryItem; now?: () => number }) {
  const [item, setItem] = useState<BookingHistoryItem | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const style = useCustomerStyle();
  const current = booking ?? item;
  const [, tick] = useState(0);
  useEffect(() => { setCopyState('idle'); }, [bookingId]);
  useEffect(() => {
    if (current?.meeting_mode !== 'online' || current.status !== 'confirmed' || status !== 'confirmed') return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [current?.meeting_mode, current?.status, status]);
  useEffect(() => {
    setItem(null);
    if (!bookingId || booking) return;
    let alive = true;
    void Promise.resolve().then(() => api.me()).then((res) => {
      if (alive) setItem([...res.upcoming, ...res.past].find((entry) => entry.id === bookingId) ?? null);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [bookingId, booking]);
  if (!current || current.id !== bookingId) return null;
  if (current.meeting_mode === 'in_person') return style === 'consult' ? <p className="text-[13px] leading-5 text-ink">対面で行います。場所はトークのご案内をご確認ください。</p> : null;
  if (current.meeting_mode !== 'online') return null;
  const confirmed = status === 'confirmed' && current.status === 'confirmed';
  const url = safeMeetingUrl(current.meeting_url);
  const provider = confirmed ? meetingProvider(url) : null;
  const start = new Date(current.starts_at).getTime();
  const end = current.ends_at ? new Date(current.ends_at).getTime() : start + 60 * 60 * 1000;
  const t = now();
  const open = confirmed && url && t >= start - JOIN_BEFORE_MS && t <= end;
  return (
    <section aria-label="オンラインの会議" className="space-y-2.5 rounded-(--liff-radius-lg) bg-canvas p-3.5 outline outline-2 -outline-offset-2 outline-liff-primary">
      <p className="flex items-center gap-2 text-[15px] font-bold text-ink">
        <Icon name="video" className="h-4 w-4 shrink-0 text-liff-primary" />
        {provider ? `オンライン（${provider}）` : 'オンライン'}
      </p>
      {!confirmed ? (
        <p className="text-[13px] leading-5 text-ink">予約が確定したら、会議の URL をお送りします。</p>
      ) : !url ? (
        <p className="text-[13px] leading-5 text-ink">会議の URL は前日までにお送りします。</p>
      ) : (
        <>
          <p className="text-[13px] leading-5 text-ink">{`担当：${current.staff_name}`}</p>
          <Button onClick={() => { if (!navigator.clipboard?.writeText) { setCopyState('failed'); return; } void navigator.clipboard.writeText(url).then(() => setCopyState('copied')).catch(() => setCopyState('failed')); }}>URLをコピー</Button>
          {copyState !== 'idle' ? <p role="status" className="text-xs text-liff-sub">{copyState === 'copied' ? 'URLをコピーしました。' : 'コピーできませんでした。'}</p> : null}
          {open ? (
            <Button variant="primary" onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}>会議に参加する</Button>
          ) : null}
          <p className="text-xs leading-[18px] text-liff-sub">
            {open ? '会議の画面が開きます。' : t > end ? '面談の終了時刻を過ぎています。' : `開始 10 分前（${hm(start - JOIN_BEFORE_MS)}）から参加のボタンが出ます。`}
          </p>
        </>
      )}
    </section>
  );
}
