import { formatYen } from '@line-crm/shared';
import { bookingPriceText, staffNominationFee } from '../lib/booking-price.js';
import Button from './ui/button/index.js';
import { useEffect, useState } from 'react';
import { api, type MenuItem, type StaffItem } from '../lib/api.js';
import { logFailure } from '../lib/user-message.js';
import LoadErrorView from './load-error-view.js';
import LoadingView from './loading-view.js';
import Icon from './ui/icon.js';

/** 指名料。担当別料金との差ではなく、APIが返した指名料を使う。 */
export function nominationFee(_menu: Pick<MenuItem, 'base_price'>, staff: Pick<StaffItem, 'price' | 'is_designation_optional' | 'nomination_fee'>): number {
  return staffNominationFee(staff);
}

/**
 * 1-b 担当を選ぶ (★V8・)。札を押すと選ばれるだけで、進むのは下の操作の帯。
 * 「指名なし」(is_designation_optional) は先頭に来る。脇の文は
 * 「いちばん早く空いている人」か「役職・指名料」。選んだ札は緑枠＋薄い緑。
 * 担当できる人がいないときは、その理由だけ出す (案内は付けない)。
 */
export default function StaffList({
  menu,
  selectedId,
  onSelect,
  onLoadState,
}: {
  /** 選んだメニュー。要約の行 (名前・分・料金) と担当の読み出しに使う。 */
  menu: MenuItem;
  selectedId: string | null;
  onSelect: (s: StaffItem) => void;
  /** 読み込み中・失敗・選ぶものが無い間は、下の帯を出さないための合図。 */
  onLoadState?: (ready: boolean) => void;
}) {
  const [loaded, setLoaded] = useState<{ menuId: string; list: StaffItem[] } | null>(null);
  const list = loaded?.menuId === menu.id ? loaded.list : null;
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoaded(null);
    setFailed(false);
    api
      .staffOf(menu.id)
      .then((r) => {
        if (!r || !Array.isArray(r.staff)) throw new Error('Invalid staff response');
        if (alive) setLoaded({ menuId: menu.id, list: r.staff });
      })
      .catch((e) => {
        logFailure('staff', e);
        if (alive) setFailed(true);
      });
    return () => { alive = false; };
  }, [menu.id, reloadKey]);

  useEffect(() => {
    onLoadState?.(list !== null && !failed && list.length > 0);
  }, [list, failed, onLoadState]);

  if (failed) return <LoadErrorView onRetry={() => setReloadKey((k) => k + 1)} />;
  if (!list) return <LoadingView />;
  if (list.length === 0) {
    return <p className="text-[13px] leading-6 text-liff-sub">この予約内容を担当できるスタッフがいません。</p>;
  }

  return (
    <div className="space-y-3.5">
      <div>
        <h2 className="text-xl font-bold text-ink">担当を選んでください</h2>
        <p className="mt-3.5 text-xs leading-[18px] text-liff-sub">
          {`${menu.name}・${menu.duration_minutes}分・${
            bookingPriceText(menu.base_price, menu.price_mode)
          }`}
        </p>
      </div>
      <ul className="space-y-3.5">
        {list.map((s) => {
          const selected = s.id === selectedId;
          const optional = s.is_designation_optional === 1;
          /* 指名料：お客さまが指名したときだけ。指名なし（おまかせ）は掛からない。指名料は担当別料金と別に設定される。 */
          const fee = nominationFee(menu, s);
          const name = optional ? '指名なし（指名料なし）' : s.display_name;
          const sub = optional ? 'いちばん早く空いている人' : s.role ?? '';
          return (
            <li key={s.id}>
              <Button variant="option" selected={selected}
                type="button"
                onClick={() => onSelect(s)}
                aria-pressed={selected}
              >
                {s.photo_url || s.profile_image_url ? (
                  <img
                    src={s.photo_url || s.profile_image_url!}
                    alt=""
                    className="h-12 w-12 shrink-0 rounded-full object-cover"
                  />
                ) : optional ? (
                  <span
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-liff-chip text-liff-sub"
                    aria-hidden="true"
                  >
                    <Icon name="users" className="h-[22px] w-[22px]" />
                  </span>
                ) : (
                  <span
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-liff-photo text-lg font-bold text-liff-photo-ink"
                    aria-hidden="true"
                  >
                    {s.display_name.slice(0, 1)}
                  </span>
                )}
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[15px] font-bold text-ink" title={name}>
                    {name}
                  </span>
                  <span className="mt-0.5 block truncate text-[11.5px] text-liff-sub" title={sub}>
                    {sub}
                  </span>
                </span>
                {selected ? (
                  <Icon name="circle-check" className="h-[22px] w-[22px] shrink-0 text-liff-primary" />
                ) : fee > 0 ? (
                  <span className="shrink-0 rounded-[5px] border border-liff-primary px-2 py-0.5 text-[11.5px] font-bold text-liff-primary">{`指名料 +${formatYen(fee)}`}</span>
                ) : null}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
