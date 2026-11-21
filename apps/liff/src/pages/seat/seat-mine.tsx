import type { RestaurantCustomerBooking } from '@line-crm/shared';
import Button from '../../components/ui/button/index.js';
import {
  STATUS_LABEL,
  deadlineText,
  longDate,
  pastDeadline,
  zonedParts,
} from '../../lib/seat-reserve.js';

/**
 * 予約を変える・取り消す (絵なし。③の「予約を変える・取り消す」と LINE の案内から開く)。
 * これからの予約を早い順に並べ、締め切り前だけ「日時・人数を変える」「取り消す」を出す。
 * 締め切りを過ぎたものはボタンを置かず、お店への連絡を案内する。
 */
export default function SeatMine({
  rows,
  timeZone,
  cancelDeadlineMinutesBefore,
  error,
  onChange,
  onCancel,
}: {
  rows: RestaurantCustomerBooking[];
  timeZone: string;
  cancelDeadlineMinutesBefore: number;
  error: string | null;
  onChange: (b: RestaurantCustomerBooking) => void;
  onCancel: (b: RestaurantCustomerBooking) => void;
}) {
  return (
    <div className="space-y-3.5">
      <h2 className="text-xl font-bold text-ink">ご予約の変更・取り消し</h2>
      {rows.length === 0 && (
        <p className="text-[13px] leading-6 text-liff-sub">これからのご予約はありません。</p>
      )}
      {rows.map((b) => {
        const p = zonedParts(b.startsAt, timeZone);
        const late = pastDeadline(b.startsAt, cancelDeadlineMinutesBefore);
        return (
          <section
            key={b.id}
            aria-label={`${longDate(p.date)}${p.hm}のご予約`}
            className="rounded-(--liff-radius-lg) bg-canvas p-3.5 outline outline-1 -outline-offset-1 outline-liff-line"
          >
            <p className="text-[15px] leading-6 font-bold text-ink">{`${longDate(p.date)}${p.hm}〜`}</p>
            <p className="text-[13px] leading-5 text-liff-sub">
              {`${b.guestCount}名・${STATUS_LABEL[b.status] ?? b.status}`}
            </p>
            {late ? (
              <><p className="mt-2 text-[13px] leading-6 text-liff-sub">変更の締め切りを過ぎました。変更はお店へ直接ご連絡ください。</p>
              {b.paymentStatus==='paid' && <Button variant="secondary" onClick={()=>onCancel(b)}>取り消す</Button>}</>
            ) : (
              <>
                <p className="mt-1 text-xs leading-[18px] text-liff-sub">
                  {`取り消し・変更は${deadlineText(b.startsAt, cancelDeadlineMinutesBefore, timeZone)} まで`}
                </p>
                <div className="mt-3 flex gap-2">
                  {b.status === 'confirmed' && (
                    <Button variant="secondary" onClick={() => onChange(b)}>
                      日時・人数を変える
                    </Button>
                  )}
                  <Button variant="secondary" onClick={() => onCancel(b)}>
                    取り消す
                  </Button>
                </div>
              </>
            )}
          </section>
        );
      })}
      {error && (
        <p role="alert" className="text-[13px] leading-6 text-danger">
          {error}
        </p>
      )}
      <div className="pb-40" aria-hidden="true" />
    </div>
  );
}
