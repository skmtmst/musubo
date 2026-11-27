
import { formatNumber as polishFormatNumber } from '@/lib/format'
/* app/line-notifications/customer-kpis.ts から写した。題「今日 送った」と送信枠の数の書き方（「1,041 / 5,000」）だけ ★V8  に合わせた。 */
export type CustomerNotificationKpi = {
  label: string
  value: number | '上限なし' | null
  /** 「1,041 / 5,000」のように数2つをそのまま出すときだけ使う。 */
  valueText?: string
  unit: '通' | null
  note: string
  href: string | null
}

export type LineNotificationQuota =
  | { state: 'available'; total: number; used: number; remaining: number; asOf: string }
  | { state: 'unlimited'; total: null; used: number; remaining: null; asOf: string }
  | { state: 'unavailable'; total: null; used: null; remaining: null; asOf: null; reason: string }

/** 板  の4枚。数は実データだけ。見本の数字は書かない。 */
export function customerNotificationKpis(input: {
  ready: boolean
  sentToday: number | null
  sentLast30d: number | null
  sentBreakdown: string
  failed: number | null
  quota: LineNotificationQuota | null
  /**
   * R611: 一覧の取得に失敗したときは、上部の件数・送信枠も「取得中」の
   * ままにしない。値は null（「—」表示）のまま、注記だけ失敗の言葉へ変える。
   */
  loadFailed?: boolean
}): CustomerNotificationKpi[] {
  const value = (count: number | null): number | null => input.ready ? count : null
  const failed = input.loadFailed === true
  const quotaUnavailable = input.quota?.state === 'unavailable'
    ? input.quota.reason
    : input.quota === null ? (failed ? '取得失敗' : '送信枠を取得中') : 'LINEの今月分'
  const unlimited = input.quota?.state === 'unlimited'
  const validQuota = input.quota?.state === 'available'
    && Number.isSafeInteger(input.quota.used) && input.quota.used >= 0
    && Number.isSafeInteger(input.quota.total) && input.quota.total >= 0

  return [
    { label: '今日 送った', value: value(input.sentToday), unit: '通', note: input.sentBreakdown || (failed ? '取得失敗' : '種類別の件数は未取得'), href: null },
    { label: 'この30日', value: value(input.sentLast30d), unit: '通', note: failed ? '取得失敗' : '', href: null },
    unlimited
      ? { label: '今月の送信枠', value: '上限なし', unit: null, note: 'LINEの今月分', href: null }
      : input.quota?.state === 'available'
        ? {
          label: '今月の送信枠',
          value: input.ready && validQuota ? input.quota.used : null,
          valueText: input.ready && validQuota ? `${polishFormatNumber(input.quota.used)} / ${polishFormatNumber(input.quota.total)}` : undefined,
          unit: '通',
          note: validQuota ? quotaUnavailable : '送信枠を確認できません',
          href: null,
        }
        : { label: '今月の送信枠', value: null, unit: '通', note: quotaUnavailable, href: null },
    {
      label: '送れなかった',
      value: value(input.failed),
      unit: '通',
      note: input.failed === null ? '件数は失敗の一覧で確かめます' : '確認と別の連絡が必要',
      href: '/line-notifications?tab=failures',
    },
  ]
}

export function canOpenCustomerNotificationKpi(kpi: CustomerNotificationKpi): boolean {
  return kpi.href !== null && typeof kpi.value === 'number' && kpi.value > 0
}
