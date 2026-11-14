import { broadcastAbApi as gap2 } from '@/lib/api/helpers/gap2'
import type { BroadcastBubble } from '@line-crm/shared'

/* G1 A/B テストの口：組2（gap2）の lib/api-gap2 に合わせる画面側の形（契約 API-CONTRACT-GAP2 §G1）。 */

export type AbMetric = 'click' | 'booking' | 'purchase'
export type AbUndecided = 'stop' | 'send_a'
export type AbStatus = 'draft' | 'testing' | 'decided' | 'undecided' | 'finished' | 'expired'

export type AbSettings = {
  testRatioPct: 10 | 20 | 30 | 50
  metric: AbMetric
  decideAfterMinutes: number
  undecidedPolicy: AbUndecided
}

export type AbVariantResult = {
  key: 'A' | 'B'
  label?: string | null
  sent: number
  failed: number
  clicks: number | null
  clickRate: number | null
  bookings: number | null
  purchases: number | null
  purchaseAmount: number | null
}

export type AbResult = {
  status: AbStatus
  metric: AbMetric
  decideAfterMinutes: number
  variants: AbVariantResult[]
  winner: 'A' | 'B' | null
  confidence: number | null
  decideAt: string | null
  /** 決められないとき、選ぶ期限（24 時間）。 */
  chooseUntil?: string | null
  /** 決められなかったため A を送った（決まらないとき＝A を送る）。 */
  fallback?: boolean
  remainder: { count: number; scheduledAt: string | null; sentAt: string | null }
  /** 組2 の今の段は模擬送信だけ（本物の LINE には送らない）。 */
  testMode?: boolean
}

type AbApiResult = Partial<Omit<AbResult, 'variants' | 'remainder'>> & {
  variants?: Array<Partial<AbVariantResult> & { key: 'A' | 'B' }>
  remainder?: Partial<AbResult['remainder']> & { sent?: number }
  decidedAt?: string | null
}

type Result<T> = { success: true; data: T }

/** B 案の本文（今は文字の案だけ。組2 の口は text を受ける）。 */
export function variantText(bubbles: BroadcastBubble[]): string {
  return bubbles.filter((bubble) => bubble.type === 'text').map((bubble) => String(bubble.content.text ?? '')).join('\n\n').trim()
}

/*
 * 組2（gap2）の口 `broadcastAbApi`（lib/api-gap2）を画面の形へ合わせる。
 * 口が返さない値（決めるまでの時間・選ぶ期限・予約の数など）は null のまま出し、0 と言わない。
 */
export const broadcastAbApi = {
  saveTest: (broadcastId: string, body: AbSettings & { expectedVersion: number }) =>
    gap2.save(broadcastId, { ...body, metric: 'click', decideAfterMinutes: body.decideAfterMinutes as 60 | 120 | 240 | 480 | 1440 }),
  removeTest: (broadcastId: string, expectedVersion: number) => gap2.remove(broadcastId, expectedVersion),
  saveVariant: (broadcastId: string, key: 'A' | 'B', messages: BroadcastBubble[], expectedVersion: number) =>
    gap2.saveVariant(broadcastId, key, variantText(messages), expectedVersion),
  startMock: gap2.startMock,
  result: async (broadcastId: string): Promise<Result<AbResult>> => {
    const res = await gap2.result(broadcastId) as { success: boolean; data?: Record<string, unknown> | null }
    if (res.success !== true || !res.data) throw new Error('ab result failed')
    const raw = res.data as AbApiResult
    const variants = raw.variants ?? []
    return {
      success: true,
      data: {
        status: raw.status as AbStatus,
        metric: (raw.metric ?? 'click') as AbMetric,
        decideAfterMinutes: Number(raw.decideAfterMinutes ?? 240),
        variants: variants.map((variant) => ({ key: variant.key, label: variant.label ?? null, sent: variant.sent ?? 0, failed: variant.failed ?? 0, clicks: variant.clicks ?? null, clickRate: variant.clickRate ?? null, bookings: variant.bookings ?? null, purchases: variant.purchases ?? null, purchaseAmount: variant.purchaseAmount ?? null })),
        winner: raw.winner ?? null,
        confidence: raw.confidence ?? null,
        decideAt: raw.decideAt ?? null,
        chooseUntil: raw.chooseUntil ?? null,
        fallback: raw.fallback ?? false,
        remainder: { count: raw.remainder?.count ?? 0, scheduledAt: raw.remainder?.scheduledAt ?? null, sentAt: raw.remainder?.sentAt ?? (raw.remainder?.sent ? raw.decidedAt ?? null : null) },
        testMode: raw.testMode === true,
      },
    }
  },
  choose: (broadcastId: string, variant: 'A' | 'B' | 'none', confirmedRecipientCount: number, idempotencyKey: string) =>
    gap2.chooseMock(broadcastId, variant, confirmedRecipientCount, idempotencyKey),
}
