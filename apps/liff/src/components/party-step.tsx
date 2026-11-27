import { useEffect, useRef, useState } from 'react';
import { api, type MenuItem, type StaffItem } from '../lib/api.js';
import { bookingPriceText, staffNominationFee } from '../lib/booking-price.js';
import { logFailure } from '../lib/user-message.js';
import {
  MAX_ADDONS, addonsOf, menuLine, menuOf, memberMinutes, personLabel, personShort, resize, totals, yen, type PartyMember, type PartyState,
} from '../lib/party.js';
import Button from './ui/button/index.js';
import { ChoiceInput } from './forms/controls.js';
import Card from './ui/card.js';
import Icon from './ui/icon.js';
import LoadErrorView from './load-error-view.js';
import LoadingView from './loading-view.js';

/** 下の帯に出す内訳（人ごと・合計）。 */
export function PartySummary({ party, first, withFee = false }: { party: PartyState; first: MenuItem; withFee?: boolean }) {
  const sum = totals(party, first);
  return (
    <div data-party-summary className="space-y-1 pb-1 text-[13px] leading-5 text-ink">
      {sum.rows.map((r) => (
        <div key={r.index}>
          <p className="flex justify-between gap-3"><span className="min-w-0 truncate"><span className="mr-2">{personShort(r.index)}</span>{menuLine(r.menu, r.member)}{withFee && r.fee === 0 ? `・${r.member.designated && r.member.staff && !r.member.staff.is_designation_optional ? r.member.staff.display_name : '指名なし'}` : ''}</span><span className="liff-num shrink-0">{yen(r.price)}</span></p>
          {withFee && r.fee > 0 ? <p className="flex justify-between gap-3 pl-[3.2em]"><span>指名料（{r.member.staff?.display_name}）</span><span className="liff-num">{yen(r.fee)}</span></p> : null}
        </div>
      ))}
      <p className="flex items-baseline gap-2 pt-1"><span className="text-xs text-liff-sub">合計</span><span className="text-[15px] font-bold">{`${party.size} 人・${sum.sequential ? '続けて' : '同時に'} ${sum.minutes} 分・${yen(sum.price)}`}</span></p>
    </div>
  );
}

/**
 * 1-a メニュー（同伴・追加メニュー・B5・hhUtj）。何人で予約するか（メニューの上限まで）、人ごとのメニューと追加メニュー。
 * 2 人目以降は「1 人目と同じ」が初めから選ばれていて、別のメニューを選べるのは店が人数 2 以上を許したメニューだけ。
 * 進む操作は下の帯（合計つき）にだけ置く。
 */
export default function PartyMenuStep({ menu, party, onParty, onChangeMenu }: {
  menu: MenuItem;
  party: PartyState;
  onParty: (next: PartyState) => void;
  /** 1 人目のメニューを選び直す。 */
  onChangeMenu: () => void;
}) {
  /* 複数人の送信は準備中のまま、メニューの人数上限を表示に反映する。 */
  const max = Math.max(1, Math.floor(menu.max_party_size ?? 1));
  const [picking, setPicking] = useState<number | null>(null);
  const setMember = (index: number, patch: Partial<PartyMember>) => onParty({ ...party, members: party.members.map((m, i) => (i === index ? { ...m, ...patch } : m)) });
  const toggleAddon = (index: number, id: string) => {
    const member = party.members[index];
    const on = member.addonIds.includes(id);
    if (!on && member.addonIds.length >= MAX_ADDONS) return;
    setMember(index, { addonIds: on ? member.addonIds.filter((x) => x !== id) : [...member.addonIds, id], staff: member.staff });
  };
  return (
    <div className="space-y-3.5" data-party-step="menu">
      <h2 className="text-xl font-bold text-ink">メニューを選んでください</h2>
      {max > 1 ? (
        <Card className="space-y-2.5 p-3.5">
          <h3 className="text-sm font-bold text-ink">何人で予約しますか</h3>
          <div className="grid grid-cols-3 gap-2" role="group" aria-label="人数">
            {Array.from({ length: Math.min(max, 3) }, (_, i) => i + 1).map((n) => (
              <Button key={n} variant="option" selected={party.size === n} aria-pressed={party.size === n} onClick={() => onParty(resize(party, n))}>
                <span className="w-full text-center text-sm font-bold">{`${n} 人`}</span>
              </Button>
            ))}
          </div>
          {max > 3 ? <p className="text-xs text-liff-sub">4 人以上は、お店にご相談ください。</p> : null}
        </Card>
      ) : null}
      {party.members.map((member, index) => {
        const mine = menuOf(party, menu, index);
        const first = index === 0;
        const own = !first && member.menu !== null;
        return (
          <Card key={index} className="space-y-3 p-3.5">
            <h3 className="text-sm font-bold text-ink">{party.size === 1 ? 'ご予約のメニュー' : personLabel(index)}</h3>
            {first || own ? (
              <div className="flex items-center justify-between gap-3 rounded-(--liff-radius) bg-liff-soft p-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-ink">{mine.name}</p>
                  <p className="text-xs text-liff-sub">{`${memberMinutes(mine, member) - addonsOf(mine, member).reduce((n, a) => n + a.duration_minutes, 0)} 分・${bookingPriceText(mine.base_price, mine.price_mode)}`}</p>
                </div>
                <Button variant="link" onClick={() => (first ? onChangeMenu() : setPicking(index))}>変える</Button>
              </div>
            ) : (
              <div className="space-y-2" role="radiogroup" aria-label={`${personLabel(index)}のメニュー`}>
                <Button variant="plain" role="radio" aria-checked className="items-start gap-2.5" onClick={() => setMember(index, { menu: null, addonIds: [] })}>
                  <span className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full border-2 border-liff-primary"><span className="h-2 w-2 rounded-full bg-liff-primary" /></span>
                  <span className="min-w-0"><span className="block text-[13px] font-bold text-ink">1 人目と同じ</span><span className="block text-xs text-liff-sub">{`${menu.name}${menu.duration_minutes} 分・${bookingPriceText(menu.base_price, menu.price_mode)}`}</span></span>
                </Button>
                <Button variant="plain" role="radio" aria-checked={false} className="items-center gap-2.5" onClick={() => setPicking(index)}>
                  <span className="h-[18px] w-[18px] shrink-0 rounded-full border-2 border-liff-line-strong" />
                  <span className="min-w-0 flex-1 text-[13px] text-ink">別のメニューを選ぶ</span>
                  <Icon name="chevron-right" className="h-[18px] w-[18px] shrink-0 text-liff-idle" />
                </Button>
              </div>
            )}
            {(mine.addons?.length ?? 0) > 0 && (first || own) ? (
              <fieldset className="space-y-2">
                <legend className="mb-1 text-xs text-liff-sub">{`追加メニュー（${MAX_ADDONS} つまで）`}</legend>
                {mine.addons!.map((a) => {
                  const on = member.addonIds.includes(a.id);
                  return (
                    <label key={a.id} className="flex items-center gap-2.5 text-[13px] text-ink">
                      <ChoiceInput type="checkbox" checked={on} disabled={!on && member.addonIds.length >= MAX_ADDONS} onChange={() => toggleAddon(index, a.id)} />
                      <span>{`${a.name} +${a.duration_minutes} 分・${yen(a.price)}`}</span>
                    </label>
                  );
                })}
              </fieldset>
            ) : null}
          </Card>
        );
      })}
      {picking !== null ? <OtherMenuSheet onClose={() => setPicking(null)} onPick={(m) => { setMember(picking, { menu: m, addonIds: [], staff: null }); setPicking(null); }} /> : null}
      <div className="pb-48" aria-hidden="true" />
    </div>
  );
}

/** 別のメニューを選ぶ（人数 2 以上を許したメニューだけ）。 */
function OtherMenuSheet({ onPick, onClose }: { onPick: (m: MenuItem) => void; onClose: () => void }) {
  const [menus, setMenus] = useState<MenuItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [key, setKey] = useState(0);
  const [loadingMenu, setLoadingMenu] = useState<MenuItem | null>(null);
  const [addonFailed, setAddonFailed] = useState<MenuItem | null>(null);
  const active = useRef(true);
  const selecting = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function selectMenu(menu: MenuItem) {
    if (selecting.current) return;
    selecting.current = true; setLoadingMenu(menu); setAddonFailed(null);
    try {
      const addons = await api.addons(menu.id);
      if (active.current) onPick({ ...menu, addons });
    } catch (error) {
      logFailure('party-menu-addons', error);
      if (active.current) setAddonFailed(menu);
    } finally {
      selecting.current = false;
      if (active.current) setLoadingMenu(null);
    }
  }
  useEffect(() => { setFailed(false); api.menus().then((r) => setMenus(r.menus.filter((m) => (m.max_party_size ?? 1) > 1))).catch((e) => { logFailure('party-menus', e); setFailed(true); }); }, [key]);
  return (
    <div className="fixed inset-0 z-50 text-ink" role="dialog" aria-modal="true" aria-label="別のメニューを選ぶ" onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <Button variant="overlay" aria-label="閉じる" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 mx-auto max-h-[80vh] w-full max-w-md space-y-3 overflow-y-auto rounded-t-(--liff-radius-lg) bg-canvas px-4 pt-4 pb-8">
        <h2 className="text-[15px] font-bold">別のメニューを選ぶ</h2>
        {loadingMenu && <p role="status">追加メニューを読み込んでいます…</p>}
        {addonFailed && <p role="alert">追加メニューを読み込めませんでした。<Button variant="link" onClick={() => void selectMenu(addonFailed)}>もう一度</Button></p>}
        {failed ? <LoadErrorView onRetry={() => setKey((n) => n + 1)} /> : !menus ? <LoadingView /> : menus.length === 0 ? <p className="text-[13px] text-liff-sub">ほかに選べるメニューがありません。</p> : (
          <ul className="space-y-2">
            {menus.map((m) => (
              <li key={m.id}><Button variant="option" disabled={loadingMenu !== null} onClick={() => void selectMenu(m)}><span className="min-w-0 flex-1 text-left"><span className="block truncate text-sm font-bold">{m.name}</span><span className="block text-xs text-liff-sub">{`${m.duration_minutes} 分・${bookingPriceText(m.base_price, m.price_mode)}`}</span></span></Button></li>
            ))}
          </ul>
        )}
        <Button variant="secondary" onClick={onClose}>閉じる</Button>
      </div>
    </div>
  );
}

/**
 * 1-b 担当（同伴・B5・zYErQ）。先頭の「全員 指名なし」が初めに選ばれていて、人ごとに担当を選べる。
 * 指名なしは指名料なし。同じ担当を全員が選ぶと続けて受ける（時間が足し算）。
 */
export function PartyStaffStep({ menu, party, onParty, onLoadState }: {
  menu: MenuItem;
  party: PartyState;
  onParty: (next: PartyState) => void;
  onLoadState?: (ready: boolean) => void;
}) {
  const [lists, setLists] = useState<Record<string, StaffItem[]>>({});
  const [failed, setFailed] = useState(false);
  const [key, setKey] = useState(0);
  const menuIds = Array.from(new Set(party.members.map((_, i) => menuOf(party, menu, i).id)));
  useEffect(() => {
    let alive = true;
    setFailed(false);
    Promise.all(menuIds.map((id) => api.staffOf(id).then((r) => {
      if (!r || !Array.isArray(r.staff) || !r.staff.every(s => s && typeof s.id === 'string' && s.id.trim() && typeof s.display_name === 'string')) {
        throw new Error('Invalid party staff response');
      }
      return [id, r.staff] as const;
    })))
      .then((pairs) => { if (alive) setLists(Object.fromEntries(pairs)); })
      .catch((e) => { logFailure('party-staff', e); if (alive) setFailed(true); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuIds.join(','), key]);
  const ready = !failed && menuIds.every((id) => (lists[id]?.length ?? 0) > 0);
  /* 初めは全員 指名なし（空いている人）。担当が決まっていない人だけ埋める。 */
  useEffect(() => {
    if (!ready || party.members.every((m) => m.staff)) return;
    onParty({ ...party, members: party.members.map((m, i) => (m.staff ? m : { ...m, staff: (lists[menuOf(party, menu, i).id] ?? []).find((s) => s.is_designation_optional === 1) ?? lists[menuOf(party, menu, i).id]?.[0] ?? null, designated: false })) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  useEffect(() => { onLoadState?.(ready); }, [ready, onLoadState]);
  if (failed) return <LoadErrorView onRetry={() => setKey((n) => n + 1)} />;
  if (!menuIds.every((id) => lists[id])) return <LoadingView />;

  const allAny = party.members.every((m) => !m.designated);
  const sum = totals(party, menu);
  const setStaff = (index: number, staff: StaffItem | null) => onParty({ ...party, members: party.members.map((m, i) => (i === index ? { ...m, staff, designated: staff !== null && !staff.is_designation_optional } : m)) });
  const chooseAny = (member: PartyMember, mine: MenuItem): StaffItem | null => (lists[mine.id] ?? []).find((s) => s.is_designation_optional === 1) ?? null;
  return (
    <div className="space-y-3.5" data-party-step="staff">
      <div>
        <h2 className="text-xl font-bold text-ink">担当を選んでください</h2>
        <p className="mt-3.5 text-xs leading-[18px] text-liff-sub">{`${party.size} 人・${sum.sequential ? '続けて' : '同時に'} ${sum.minutes} 分`}</p>
      </div>
      <label className={`flex items-center gap-2.5 rounded-(--liff-radius-lg) p-3.5 text-sm font-bold text-ink outline-2 -outline-offset-1 ${allAny ? 'outline-liff-primary' : 'outline-liff-line'}`}>
        <ChoiceInput type="checkbox" checked={allAny}
          onChange={(e) => { if (e.target.checked) onParty({ ...party, members: party.members.map((m, i) => ({ ...m, staff: chooseAny(m, menuOf(party, menu, i)), designated: false })) }); }} />
        全員 指名なし（空いている人）
      </label>
      {party.members.map((member, index) => {
        const mine = menuOf(party, menu, index);
        return (
          <Card key={index} className="space-y-3 p-3.5">
            <div className="flex items-baseline justify-between gap-2"><h3 className="text-sm font-bold text-ink">{personLabel(index)}</h3><span className="min-w-0 truncate text-xs text-liff-sub">{menuLine(mine, member)}</span></div>
            <div className="grid grid-cols-3 gap-2" role="group" aria-label={`${personLabel(index)}の担当`}>
              {(lists[mine.id] ?? []).map((s) => {
                const any = s.is_designation_optional === 1;
                const selected = any ? !member.designated : member.designated && member.staff?.id === s.id;
                const diff = staffNominationFee(s);
                return (
                  <Button key={s.id} variant="option" selected={selected} aria-pressed={selected} onClick={() => setStaff(index, any ? s : s)}>
                    <span className="flex w-full flex-col items-center gap-0.5">
                      <span className="text-sm font-bold">{s.display_name}</span>
                      {any ? <span className="text-[10.5px] font-normal text-liff-sub">指名料なし</span> : diff > 0 ? <span className="text-[10.5px] font-normal text-liff-sub">{`+${yen(diff)}`}</span> : null}
                    </span>
                  </Button>
                );
              })}
            </div>
          </Card>
        );
      })}
      <div className="pb-52" aria-hidden="true" />
    </div>
  );
}
