import type { RestaurantCustomerBooking } from '@line-crm/shared';
import StatusView from '../../components/ui/status-view.js';
import CompletionPanel from '../../components/ui/completion-panel.js';
import { STATUS_LABEL, changeRule, longDate, zonedParts } from '../../lib/seat-reserve.js';

/**
 * ③ 受け付けました。予約内容と店名を表示する。
 * 下の帯 (LINEに戻る・予約を変える・取り消す) は呼ぶ側が置く。
 */
export default function SeatDone({
  booking,
  storeName,
  timeZone,
  cancelDeadlineMinutesBefore,
  changed,completionMessage,
}: {
  booking: RestaurantCustomerBooking;
  storeName: string;
  timeZone: string;
  cancelDeadlineMinutesBefore: number;
  /** 変更のあと。題を「変更しました」にする。 */
  changed: boolean;
  completionMessage?:string;
}) {
  if (!Object.hasOwn(STATUS_LABEL, booking.status) || !Number.isFinite(Date.parse(booking.startsAt))) {
    return <CompletionPanel designNode="kxmnZ">
      <StatusView icon="calendar" tone="wait" large title="予約の状態を確認してください" body="予約の内容を確認できませんでした。お店へお問い合わせください。" />
    </CompletionPanel>;
  }
  const p = zonedParts(booking.startsAt, timeZone);
  const rows: Array<[string, string]> = [
    ['日時', `${longDate(p.date)}${p.hm}〜`],
    ['人数', `${booking.guestCount}名`],
    ...(booking.courseName ? [['コース', booking.courseName] as [string, string]] : []),
    ['お店', storeName],
    ['状態', booking.status === 'confirmed' ? '確定' : STATUS_LABEL[booking.status] ?? booking.status],
  ];
  return (
    <CompletionPanel designNode="kxmnZ">
      <StatusView
        icon="check"
        tone="success"
        large
        title={changed ? 'ご予約を変更しました' : 'ご予約を受け付けました'}
        body={`${!changed&&completionMessage?completionMessage:'ご予約の内容をご確認ください。'}\n${changeRule(booking.startsAt, cancelDeadlineMinutesBefore, timeZone)}。`}
      />
      <dl className="rounded-(--liff-radius-lg) bg-canvas px-3.5 py-1 outline outline-1 -outline-offset-1 outline-liff-line">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-start gap-2 py-2.5">
            <dt className="w-18 shrink-0 text-xs leading-[17px] text-liff-sub">{k}</dt>
            <dd className="min-w-0 flex-1 truncate text-[15px] leading-[22px] font-bold text-ink" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </CompletionPanel>
  );
}
