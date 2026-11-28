import { useCustomerWords } from './customer-style-scope.js';
import type { RoutedTarget } from '../lib/api.js';
import { bookingPriceText } from '../lib/booking-price.js';
import Card from './ui/card.js';
import Icon from './ui/icon.js';

/**
 * 答えで予約の行き先が決まったときの案内（B6・Z76uuv）。担当を選ばせず、すぐ日時から始める。
 * 行き先は答えで決まっていて、お客さまが書き換えることはできない。
 */
export function RoutedBanner({ target }: { target: RoutedTarget }) {
  const words = useCustomerWords();
  const mode = target.meetingMode === 'online' ? 'オンライン（Zoom・Meet）' : target.meetingMode === 'in_person' ? '対面' : target.meetingMode == null ? null : '形式を確認できません';
  const meta = [target.staffName ? `${words.staff}：${target.staffName}` : null, mode, bookingPriceText(target.price, target.price > 0 ? 'fixed' : 'free')].filter(Boolean).join('・');
  return (
    <section data-routed-banner aria-label="ご案内" className="space-y-2 rounded-(--liff-radius-lg) bg-liff-soft p-3.5 outline-2 -outline-offset-1 outline-liff-primary">
      <p className="text-[15px] leading-6 font-bold text-ink">{`ご相談の内容に合わせて〈${target.menuName}〉をご案内します`}</p>
      <p className="text-xs leading-[18px] text-liff-sub">
        {meta}
        {target.meetingMode === 'online' ? <><br />会議の URL は予約が確定したあと LINE で届きます</> : null}
      </p>
    </section>
  );
}

/** 行き先に空きが無いとき（R02q7）。白い画面にせず、ご利用先へ問い合わせる道を出す。 */
export function NoRoutedSlots({ target, days }: { target: RoutedTarget; days: number }) {
  const words = useCustomerWords();
  const validDays = Number.isSafeInteger(days) && days > 0;
  return (
    <Card className="flex flex-col items-center gap-2 px-5 py-8 text-center">
      <Icon name="calendar-x" className="h-8 w-8 text-liff-sub" />
      <p className="text-[15px] font-bold text-ink">{validDays ? 'ご案内できる日時がありません' : '空き状況を確認できません'}</p>
      <p className="text-xs leading-[18px] text-liff-sub">{validDays ? `今日から ${days} 日間、${target.menuName}の空きがありません。${words.contact}にご相談ください。` : `${words.contact}にご相談ください。`}</p>
    </Card>
  );
}

/** 確認の段（手順の帯の 3 つ目）。ここで内容を見てもらってから、ボタンで送る。 */
export function RoutedConfirm({ target, whenText }: { target: RoutedTarget; whenText: string }) {
  const words = useCustomerWords();
  const rows: Array<[string, string]> = [
    [words.bookingContent, target.menuName],
    ['日時', whenText],
    ...(target.staffName ? [[words.staff, target.staffName] as [string, string]] : []),
    ...(target.meetingMode ? [['形式', target.meetingMode === 'online' ? 'オンライン（Zoom・Meet）' : target.meetingMode === 'in_person' ? '対面' : '確認できません'] as [string, string]] : []),
    ['料金', bookingPriceText(target.price, target.price > 0 ? 'fixed' : 'free')],
  ];
  return (
    <section data-routed-confirm aria-label="ご予約の内容" className="space-y-3.5">
      <h2 className="text-xl font-bold text-ink">内容をご確認ください</h2>
      <Card className="divide-y divide-liff-line p-0">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3 px-3.5 py-3">
            <span className="shrink-0 text-xs text-liff-sub">{k}</span>
            <span className="min-w-0 text-right text-[13px] font-bold text-ink">{v}</span>
          </div>
        ))}
      </Card>
      {target.meetingMode === 'online' ? <p className="text-xs leading-[18px] text-liff-sub">会議の URL は予約が確定したあと LINE で届きます</p> : null}
    </section>
  );
}
