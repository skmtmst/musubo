import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type EventBookingMine, type MakeupCredit } from '../lib/api.js';
import { utcToJstHm, utcToJstMd } from '../lib/datetime.js';
import AbsenceNotice from './absence-notice.js';
import AbsenceSheet, { mdHm } from './absence-sheet.js';
import MakeupPicker from './makeup-picker.js';
import Button from './ui/button/index.js';
import Card from './ui/card.js';
import LoadErrorView from './load-error-view.js';

/**
 * 予約の履歴に並ぶ教室の予約（B3・rx3FL・kzE16）。振替を使うクラスの行に［欠席する］、
 * 残っている振替があれば「振替先を選ぶ」。欠席の確定と振替先の選択は別の操作。
 */
export default function LessonHistorySection({ onPicking, onLater, onBookingChanged, creditsOnly = false }: { onPicking?: (picking: boolean) => void; onLater?: () => void; onBookingChanged?: () => void; creditsOnly?: boolean }) {
  const [items, setItems] = useState<EventBookingMine[]>([]);
  const [credits, setCredits] = useState<MakeupCredit[]>([]);
  const [selectedCreditId, setSelectedCreditId] = useState<string | null>(null);
  const [busyCreditId, setBusyCreditId] = useState<string | null>(null);
  const busyCredit = useRef<string | null>(null);
  const [target, setTarget] = useState<EventBookingMine | null>(null);
  const [justAbsent, setJustAbsent] = useState<{ creditId: string; sourceBookingId: string; startsAt: string; name: string | null } | null>(null);
  /** 欠席した回を探すための、今・これまでの予約（振替が返す欠席元の予約 ID から日時と教室名を引く）。 */
  const [known, setKnown] = useState<EventBookingMine[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const loadGeneration = useRef(0);
  const load = useCallback(() => {
    const generation = ++loadGeneration.current;
    setLoadFailed(false);
    Promise.resolve().then(() => api.myEventBookings('upcoming')).then((r) => { if (generation !== loadGeneration.current) return; const rows = r.items; setKnown((prev) => (Array.isArray(rows) ? [...rows, ...prev.filter((p) => !rows.some((i) => i.id === p.id))] : prev)); setItems(r.items.filter((b) => b.makeup?.enabled && (b.status === 'requested' || b.status === 'confirmed') && Date.parse(b.slot_starts_at) > Date.now())); }).catch(() => { if (generation === loadGeneration.current) setLoadFailed(true); });
    Promise.resolve().then(() => api.myEventBookings('past')).then((r) => { if (!r || !Array.isArray(r.items)) throw new Error('Invalid past bookings response'); if (generation === loadGeneration.current) setKnown((prev) => [...prev, ...r.items.filter((i) => !prev.some((p) => p.id === i.id))]); }).catch(() => { if (generation === loadGeneration.current) setLoadFailed(true); });
    Promise.resolve().then(() => api.makeupCredits()).then((r) => {
      if (generation !== loadGeneration.current) return;
      if (!r || !Array.isArray(r.credits) || !r.credits.every(c => c && ['open', 'used', 'expired', 'revoked'].includes(c.status))) throw new Error('Invalid makeup credits response');
      const next = r.credits.filter((c) => c.status === 'open');
      setCredits(next);
      setSelectedCreditId((current) => next.some((c) => c.id === current) ? current : next[0]?.id ?? null);
    }).catch(() => { if (generation === loadGeneration.current) setLoadFailed(true); });
  }, []);
  useEffect(() => { load(); return () => { loadGeneration.current++; }; }, [load]);
  useEffect(() => { onPicking?.(credits.length > 0); return () => onPicking?.(false); }, [credits.length, onPicking]);
  const sourceOf = (c: MakeupCredit) => { if (justAbsent?.creditId === c.id && justAbsent.sourceBookingId === c.source_event_booking_id) return justAbsent; const b = known.find((k) => k.id === c.source_event_booking_id); return b ? { startsAt: b.slot_starts_at, name: b.event_name } : null; };
  const activeCredit = credits.find((c) => c.id === selectedCreditId) ?? credits[0];
  const reportBusy = useCallback((id: string, busy: boolean) => {
    if (busy) { busyCredit.current = id; setBusyCreditId(id); }
    else if (busyCredit.current === id) { busyCredit.current = null; setBusyCreditId(null); }
  }, []);
  const onBusyChange = useMemo(() => {
    const id = activeCredit?.id;
    return (busy: boolean) => { if (id) reportBusy(id, busy); };
  }, [activeCredit?.id, reportBusy]);
  if (loadFailed) return <><AbsenceNotice message={notice} /><LoadErrorView compact note="教室の予約・振替の履歴はなくなっていません。" onRetry={load} /></>;
  if ((creditsOnly || items.length === 0) && credits.length === 0 && !target && !notice) return null;
  return (
    <section className="space-y-3.5" aria-label="教室の予約">
      {credits.length > 1 ? <div className="space-y-2" role="group" aria-label="使う振替">
        <h2 className="text-sm font-bold text-ink">使う振替を選ぶ</h2>
        {credits.map((credit, index) => {
          const source = sourceOf(credit);
          const expires = Number.isFinite(Date.parse(credit.expires_at)) ? `${utcToJstMd(credit.expires_at)} まで` : '期限を確認できません';
          return <Button key={credit.id} variant="option" selected={credit.id === activeCredit?.id} aria-pressed={credit.id === activeCredit?.id} disabled={busyCreditId !== null} onClick={() => { if (busyCredit.current === null) setSelectedCreditId(credit.id); }}>
            <span className="min-w-0 flex-1 text-left">
              <span className="block text-sm font-bold">{`${expires}の振替 ${index + 1}`}</span>
              {source && Number.isFinite(Date.parse(source.startsAt)) ? <span className="block break-words text-xs text-liff-sub">{`${mdHm(source.startsAt)} ${source.name ?? ''}`}</span> : null}
            </span>
          </Button>;
        })}
      </div> : null}
      {activeCredit ? <MakeupPicker key={activeCredit.id} credit={activeCredit} source={sourceOf(activeCredit)} onBusyChange={onBusyChange} onUsed={() => { setJustAbsent(null); load(); onBookingChanged?.(); }} onLater={() => { setJustAbsent(null); onLater?.(); }} /> : null}
      <AbsenceNotice message={notice} />
      <ul className="space-y-3.5">
        {(creditsOnly ? [] : items).map((b) => (
          <li key={b.id}>
            <Card className="space-y-2.5 p-3.5">
              <h3 className="text-[15px] font-bold text-ink">{mdHm(b.slot_starts_at)}</h3>
              <p className="text-[13px] text-ink">{[b.event_name, b.venue_name].filter(Boolean).join('・')}</p>
              <p className="text-xs text-liff-sub">{[b.makeup?.plan_label, b.makeup?.cutoff_at ? `欠席の連絡は ${utcToJstHm(b.makeup.cutoff_at)} まで` : null].filter(Boolean).join('・')}</p>
              <Button variant="secondary" onClick={() => { setNotice(null); setTarget(b); }}>欠席する</Button>
            </Card>
          </li>
        ))}
      </ul>
      {target ? <AbsenceSheet booking={target} onClose={() => setTarget(null)} onDone={({ credit, reason }) => {
        const t = target; setTarget(null);
        if (credit) setJustAbsent({ creditId: credit.id, sourceBookingId: t.id, startsAt: t.slot_starts_at, name: t.event_name }); else if (reason) setNotice(reason);
        load();
      }} /> : null}
    </section>
  );
}
