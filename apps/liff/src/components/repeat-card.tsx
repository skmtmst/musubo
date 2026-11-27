import Button from './ui/button/index.js';
import { useEffect, useState } from 'react';
import { api, type LastBookingResponse, type MenuItem, type StaffItem } from '../lib/api.js';
import { logFailure } from '../lib/user-message.js';
import Icon from './ui/icon.js';

/** 前回の日を「2026/9/20（土）」と出す。店の暦日（JST）で切る。 */
export function formatPreviousDate(startsAt: string): string {
  return new Date(startsAt).toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
  });
}

type Ready = {
  source: MenuItem[] | null | undefined;
  menu: MenuItem;
  staff: StaffItem;
  startsAt: string;
  photoUrl: string | null;
};

/**
 * 1-0 前回と同じで予約 (booking-plus 1)。
 * 予約の最初に、前回の予約（メニュー・担当・前回の日）を札で出す。
 * 押すとメニューと担当が入ったまま日時へ直接進む。
 * 対象外（履歴なし・担当が辞めた・メニューが止まっている）は表示しない。
 */
export default function RepeatCard({
  menus: menusProp,
  onRepeat,
}: {
  /** メニュー一覧（渡さないときは中で読む）。まだ無い間は待つ。 */
  menus?: MenuItem[] | null;
  /** 札を押したとき。メニューと担当を入れて日時へ進む。 */
  onRepeat: (menu: MenuItem, staff: StaffItem) => void;
}) {
  const [ready, setReady] = useState<Ready | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    setReady(null); setFailed(false);
    (async () => {
      try {
        const menus = menusProp ?? (await api.menus()).menus;
        if (!alive) return;
        const res: LastBookingResponse = await api.lastBooking();
        if (!alive || !res.available || !res.booking) return;
        const menu = menus.find((m) => m.id === res.booking!.menu.id);
        if (!alive || !menu) return;
        // 担当の札に要る顔写真つきの全体像を取り直す（辞めた・外れたら出さない）。
        const staffRes = await api.staffOf(menu.id);
        if (!alive) return;
        const staff = staffRes.staff.find((s) => s.id === res.booking!.staff.id);
        if (!staff) return;
        setReady({
          source: menusProp,
          menu,
          staff,
          startsAt: res.booking.starts_at,
          photoUrl: res.booking.staff.profile_image_url ?? staff.profile_image_url,
        });
      } catch (e) {
        logFailure('last-booking', e);
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [menusProp, retry]);

  if (failed) return <Button variant="secondary" onClick={() => setRetry(n => n + 1)}>前回の予約を読み直す</Button>;
  if (!ready || ready.source !== menusProp) return null;

  return (
    <Button variant="option"
      type="button"
      onClick={() => onRepeat(ready.menu, ready.staff)}
      aria-label="前回と同じで予約する"
    >
      {ready.photoUrl ? (
        <img
          src={ready.photoUrl}
          alt=""
          className="h-14 w-14 shrink-0 rounded-[10px] object-cover"
        />
      ) : (
        <span className="h-14 w-14 shrink-0 rounded-[10px] bg-liff-photo" aria-hidden="true" />
      )}
      <span className="min-w-0 flex-1">
        <span className="mb-1 inline-block rounded-full bg-liff-soft px-2 py-0.5 text-[11px] font-bold text-liff-primary">
          前回と同じ
        </span>
        <span className="block truncate text-[15px] font-bold text-ink" title={ready.menu.name}>
          {ready.menu.name}
        </span>
        <span className="mt-[3px] block truncate text-xs text-liff-sub">
          {ready.staff.display_name}・前回 {formatPreviousDate(ready.startsAt)}
        </span>
      </span>
      <Icon name="chevron-right" className="h-[18px] w-[18px] shrink-0 text-liff-idle" />
    </Button>
  );
}
