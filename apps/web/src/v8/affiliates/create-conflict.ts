import type { Affiliate } from '@line-crm/shared'

export type AffiliateEditValues = Required<Pick<Affiliate,
  'name' | 'rewardMode' | 'commissionRate' | 'isActive' | 'email' | 'holdDays' | 'payoutCycle' | 'notifyOnConversion'>>

/** 保存の時に Worker が今の値と比べる、開いた時の値。一覧の行（集計つき）からも作れる。 */
export type AffiliateEditSource = Pick<Affiliate, 'name' | 'commissionRate' | 'isActive'> & Partial<Pick<Affiliate, 'rewardMode' | 'email' | 'holdDays' | 'payoutCycle' | 'notifyOnConversion'>>

export function affiliateEditValues(affiliate: AffiliateEditSource): AffiliateEditValues {
  return {
    name: affiliate.name,
    rewardMode: affiliate.rewardMode ?? (affiliate.commissionRate > 0 ? 'rate' : 'fixed'),
    commissionRate: affiliate.commissionRate,
    isActive: affiliate.isActive,
    email: affiliate.email ?? null,
    holdDays: affiliate.holdDays ?? null,
    payoutCycle: affiliate.payoutCycle ?? null,
    notifyOnConversion: affiliate.notifyOnConversion ?? false,
  }
}

const LABELS: Record<keyof AffiliateEditValues, string> = {
  name: '名前・屋号', rewardMode: '報酬の決め方', commissionRate: '売上に対する割合（%）',
  isActive: 'すぐに計測を始める', email: 'メールアドレス', holdDays: '保留期間（日）',
  payoutCycle: '締めと支払い', notifyOnConversion: '本人に LINE で知らせる',
}

function displayValue(key: keyof AffiliateEditValues, value: AffiliateEditValues[keyof AffiliateEditValues]): string {
  if (value === null || value === '') return '未設定'
  if (typeof value === 'boolean') return value ? 'オン' : 'オフ'
  if (key === 'rewardMode') {
    if (value === 'fixed') return '成果1件ごとに定額'
    if (value === 'rate') return '売上に対する割合'
    if (value === 'none') return '報酬なし（計測のみ）'
  }
  return String(value)
}

export function affiliateEditDifferences(draft: AffiliateEditValues, latest: Affiliate) {
  const current = affiliateEditValues(latest)
  return (Object.keys(LABELS) as Array<keyof AffiliateEditValues>)
    .filter(key => draft[key] !== current[key])
    .map(key => ({ text: `${LABELS[key]}：あなたの下書き「${displayValue(key, draft[key])}」／最新「${displayValue(key, current[key])}」` }))
}
