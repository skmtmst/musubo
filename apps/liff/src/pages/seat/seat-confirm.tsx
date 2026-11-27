import { TextInput, FieldLabel, FieldCount } from '../../components/forms/controls.js';
import Button from '../../components/ui/button/index.js';
import { useEffect, useState } from 'react';
import PrivacyNote from '../../components/ui/privacy-note.js';
import { changeRule, longDate, remainingText, stayText, zonedParts } from '../../lib/seat-reserve.js';
import { withHonorific,defaultRestaurantReservationForm,type RestaurantReservationForm } from '@line-crm/shared'


/**
 * ② 確認 (V8)。お店・日時・人数・お席・お名前・電話の箱、ご要望、取り消しの決まり、仮押さえの残り時間。
 * 確定のボタンは下の操作の帯 (呼ぶ側) に置く。仮押さえの時間が切れたら onExpired を呼ぶ。
 *
 * ご要望（任意・200字）と電話（任意）は、確定の口へ送る。お席は割り当てた卓・空いている卓の種類。
 * 遅れたときの決まりは店の設定（無ければ LINE で知らせる案内）。変更（reschedule）は前の予約の値を見せるだけ。
 */
export default function SeatConfirm({
  timeZone,
  storeName,
  courseName,
  customerName,
  definition=defaultRestaurantReservationForm(),onName,allergy='',onAllergy,
  startsAt,
  endsAt,
  guestCount,
  cancelDeadlineMinutesBefore,
  seat,
  late,
  note,
  phone,
  onNote,
  onPhone,
  holdExpiresAt,
  holdMinutes,
  reschedule,
  error,
  onBack,
  onExpired,
}: {
  timeZone: string;
  storeName: string;
  courseName?: string | null;
  customerName: string;
  definition?:RestaurantReservationForm;onName?:(value:string)=>void;allergy?:string;onAllergy?:(value:string)=>void;
  startsAt: string;
  endsAt: string;
  guestCount: number;
  cancelDeadlineMinutesBefore: number;
  /** お席の言葉（「テーブル席（お店で決めます）」）。 */
  seat: string;
  /** 遅れたときの決まりの1文（句点なし）。 */
  late: string;
  note: string;
  phone: string;
  onNote: (value: string) => void;
  onPhone: (value: string) => void;
  /** 仮押さえの期限。変更 (reschedule) のときは仮押さえが無いので null。 */
  holdExpiresAt: string | null;
  /** お取りしている長さ (分)。 */
  holdMinutes: number;
  reschedule: boolean;
  error: string | null;
  /** 「← 時刻を選び直す」。下の帯は確定のボタンだけにする (板どおり)。 */
  onBack: () => void;
  onExpired: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!holdExpiresAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [holdExpiresAt]);
  const left = holdExpiresAt ? Date.parse(holdExpiresAt) - now : null;
  useEffect(() => {
    if (left !== null && left <= 0) onExpired();
  }, [left !== null && left <= 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const p = zonedParts(startsAt, timeZone);
  const rows: Array<[string, string]> = [
    ...(storeName.trim() ? [['お店',storeName] as [string,string]] : []),
    ['日時', `${longDate(p.date)}${p.hm}〜${stayText(startsAt, endsAt)}`],
    ['人数', `${guestCount}名`],
    ['コース',courseName ?? '席のみ'],
    ['お席', seat],
    ...(reschedule?[[definition.fields.find(f=>f.id==='name')!.label,withHonorific(customerName,'さま',{space:true})] as [string,string]]:[]),
  ];

  const field=(id:string)=>definition.fields.find(item=>item.id===id)!;
  return (
    <div className="space-y-3.5" data-design-node="B3oGt3">
      <h2 className="text-xl font-bold text-ink">内容を確かめてください</h2>
      <dl data-liff-card className="divide-y divide-liff-divider rounded-(--liff-radius-lg) bg-canvas px-3.5 py-1 outline outline-1 -outline-offset-1 outline-liff-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-start justify-between gap-3 py-3">
            <dt className="shrink-0 text-[13px] leading-5 text-liff-sub">{k}</dt>
            <dd className="min-w-0 text-right text-[13px] leading-5 font-semibold text-ink" title={v}>
              {v}
            </dd>
          </div>
        ))}
        {!reschedule&&<div className="flex items-start justify-between gap-3 py-3"><dt className="shrink-0 text-[13px] leading-5 text-liff-sub"><FieldLabel htmlFor="seat-name" required>{field('name').label}</FieldLabel></dt><dd className="min-w-0 flex-1"><TextInput id="seat-name" value={customerName} maxLength={100} required onChange={e=>onName?.(e.target.value)} autoComplete="name" /></dd></div>}
        {field('phone').enabled&&<div className="flex items-start justify-between gap-3 py-3">
          <dt className="shrink-0 text-[13px] leading-5 text-liff-sub">
            <FieldLabel htmlFor="seat-phone" required={field('phone').required}>{field('phone').label}</FieldLabel>
          </dt>
          <dd className="min-w-0 flex-1">
            {reschedule ? (
              <span className="block truncate text-[13px] leading-5 font-semibold text-ink">{phone || '—'}</span>
            ) : (
              <TextInput
                id="seat-phone"
                type="tel"
                required={field('phone').required}
                inputMode="tel"
                autoComplete="tel"
                maxLength={50}
                value={phone}
                onChange={(e) => onPhone(e.target.value)}
                placeholder="お店からの連絡用"
              />
            )}
            {!reschedule && <FieldCount value={phone} max={50} />}
          </dd>
        </div>}
        {field('allergy').enabled&&<div className="flex items-start justify-between gap-3 py-3"><dt className="shrink-0 text-[13px] leading-5 text-liff-sub"><FieldLabel htmlFor="seat-allergy" required={field('allergy').required}>{field('allergy').label}</FieldLabel></dt><dd className="min-w-0 flex-1">{reschedule?<span>{allergy||'なし'}</span>:<TextInput id="seat-allergy" value={allergy} maxLength={200} required={field('allergy').required} onChange={e=>onAllergy?.(e.target.value)} placeholder="例：乳製品（ない場合は「なし」）" />}</dd></div>}
      </dl>
      {field('note').enabled&&<div className="flex flex-col gap-1.5">
        <FieldLabel htmlFor="seat-note" required={field('note').required}>{field('note').label}</FieldLabel>
        {reschedule ? (
          <p className="flex h-9 items-center truncate rounded-(--liff-radius) bg-canvas px-3 text-sm text-ink outline outline-1 -outline-offset-1 outline-liff-line-strong">
            {note || 'なし'}
          </p>
        ) : (
          <TextInput
            id="seat-note"
            required={field('note').required}
            type="text"
            maxLength={200}
            value={note}
            onChange={(e) => onNote(e.target.value)}
            placeholder="例：記念日です・ベビーカーで行きます"
          />
        )}
        {!reschedule && <FieldCount value={note} max={200} />}
      </div>}
      <ul className="flex flex-col gap-1 rounded-(--liff-radius) bg-liff-off-bg p-3 text-xs leading-[18px] text-liff-sub">
        <li>{`・${changeRule(startsAt, cancelDeadlineMinutesBefore, timeZone, now)}`}</li>
        <li>{`・${late}`}</li>
      </ul>
      {left !== null && (
        <p className="text-xs leading-[18px] text-liff-wait-ink" role="timer" aria-live="off">
          {left > 0
            ? `この時刻を ${holdMinutes}分 お取りしています（残り ${remainingText(left)}）`
            : 'お取りしていた時間が過ぎました。時刻を選び直してください。'}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[13px] leading-6 text-danger">
          {error}
        </p>
      )}
      <PrivacyNote />
      <div className="flex">
        <Button variant="text"
          type="button"
          onClick={onBack}
        >
          ← 時刻を選び直す
        </Button>
      </div>
      <div className="pb-40" aria-hidden="true" />
    </div>
  );
}
