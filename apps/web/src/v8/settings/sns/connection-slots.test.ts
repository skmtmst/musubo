/**
 * 契約枠の数え方と追加・解除の筋書き（★v7 F1・F3・F4・F5・F6／要件 §4-1）。
 *
 * 画面ではなくこの文書が判定を持つ決まりなので、受入条件のうち数の話はここで確かめる。
 * - 受入条件1：1サービスに接続を2件積める（Google 2件・Instagram 2件）。
 * - 受入条件2：契約枠の中の追加は料金確認を挟まない（`within-quota`）。
 * - 受入条件3：枠を超える追加は有料枠 = Σ max(0, 接続数 − 契約枠)、1枠 ¥3,300（税込）、
 *   無料期間中は0円、追加した月は日割り。各サービス11個目は個別見積もり。
 * - 受入条件4：解除で枠数が減り、契約枠は変わらない。
 */

import { describe, expect, it } from 'vitest'
import type { InstagramConnectionStatus } from '@line-crm/shared'
import type { GoogleConnectionData } from '@/lib/restaurant-google-api'
import {
  SNS_CONNECTION_LIMIT,
  SNS_DEFAULT_CONTRACTED,
  SNS_SLOT_UNIT_YEN,
  connectionStatusLabel,
  googleSlots,
  instagramSlots,
  paidSlotCount,
  planAddition,
  planRemoval,
  serviceCardTitle,
  serviceName,
  slotCountText,
  slotMonthlyYen,
  type SnsConnectionView,
  type SnsService,
  type SnsServiceSlots,
  type SnsSlotsView,
} from './connection-slots'

function conn(service: SnsService, id: string, over: Partial<SnsConnectionView> = {}): SnsConnectionView {
  return { id, service, name: id, meta: [], state: 'connected', primary: false, version: 1, ...over }
}

function service(svc: SnsService, connected: number, contracted: number): SnsServiceSlots {
  return {
    service: svc,
    connections: Array.from({ length: connected }, (_, i) => conn(svc, `${svc}-${i + 1}`)),
    contracted,
  }
}

/** `view(Google接続数, Google契約枠, Instagram接続数, Instagram契約枠)`。 */
function view(g: number, gc: number, ig: number, igc: number): SnsSlotsView {
  return {
    googleBusiness: service('googleBusiness', g, gc),
    instagram: service('instagram', ig, igc),
  }
}

describe('契約枠の数え方（受入条件1・3）', () => {
  it('単価は共通の料金表の¥3,300（税込）で、既定の契約枠は1個', () => {
    expect(SNS_SLOT_UNIT_YEN).toBe(3300)
    expect(SNS_DEFAULT_CONTRACTED).toBe(1)
    expect(SNS_CONNECTION_LIMIT).toBe(10)
    expect(slotMonthlyYen(2)).toBe(6600)
    expect(slotMonthlyYen(0)).toBe(0)
  })

  it('有料枠はサービスごとに max(0, 接続数 − 契約枠) を出して足す', () => {
    // 契約枠の中なら有料枠は出ない（Google 2件・Instagram 2件を契約枠どおり持てる）。
    expect(paidSlotCount(view(2, 2, 2, 2))).toBe(0)
    // 片方だけ超える。
    expect(paidSlotCount(view(3, 2, 2, 2))).toBe(1)
    // 両方超えたら足す（Google +2・Instagram +1）。
    expect(paidSlotCount(view(4, 2, 3, 2))).toBe(3)
    // 契約枠より少ない側はマイナスにしない。
    expect(paidSlotCount(view(0, 3, 4, 2))).toBe(2)
  })

  it('「連携 n個（契約枠 m個）」を出す', () => {
    expect(slotCountText(service('googleBusiness', 2, 2))).toBe('連携 2個（契約枠 2個）')
    expect(slotCountText(service('instagram', 3, 1))).toBe('連携 3個（契約枠 1個）')
    expect(slotCountText(service('instagram', 0, 1))).toBe('連携 0個（契約枠 1個）')
  })
})

describe('追加の筋書き（受入条件2・3）', () => {
  const PAID = { kind: 'paid', monthlyDaysRemaining: 15, monthlyDaysInPeriod: 30 } as const
  const TRIAL = { kind: 'trialing' } as const

  it('契約枠の中の追加は料金確認を挟まずそのまま認可へ進む', () => {
    const plan = planAddition(view(1, 2, 0, 1), 'googleBusiness', PAID)
    expect(plan).toEqual({ kind: 'within-quota', service: 'googleBusiness', connectedAfter: 2, contracted: 2 })
  })

  it('契約枠の中の追加は請求の段が分からなくても進める', () => {
    const plan = planAddition(view(0, 1, 1, 2), 'instagram', null)
    expect(plan.kind).toBe('within-quota')
  })

  it('枠を超える追加は日割りの請求つきで料金確認へ進む（支払い中）', () => {
    const plan = planAddition(view(2, 2, 1, 1), 'googleBusiness', PAID)
    if (plan.kind !== 'over-quota') throw new Error(`over-quota のはずが ${plan.kind}`)

    expect(plan.connectedBefore).toBe(2)
    expect(plan.connectedAfter).toBe(3)
    expect(plan.contracted).toBe(2)
    expect(plan.paidSlotsBefore).toBe(0)
    expect(plan.paidSlotsAfter).toBe(1)
    expect(plan.addedSlots).toBe(1)
    expect(plan.monthlyIncreaseYen).toBe(3300)
    expect(plan.monthlyAfterYen).toBe(3300)
    // 月次期間の残り15/30日ぶんの日割り。
    expect(plan.dueNowYen).toBe(1650)
    expect(plan.trialing).toBe(false)
  })

  it('すでに有料枠がある状態でも、増える枠は1枠ぶんだけ数える', () => {
    const plan = planAddition(view(3, 2, 2, 1), 'instagram', PAID)
    if (plan.kind !== 'over-quota') throw new Error(`over-quota のはずが ${plan.kind}`)

    // Google +1・Instagram +1 で有料枠は2枠。
    expect(plan.paidSlotsBefore).toBe(2)
    expect(plan.paidSlotsAfter).toBe(3)
    expect(plan.monthlyIncreaseYen).toBe(3300)
    expect(plan.monthlyAfterYen).toBe(9900)
  })

  it('無料期間中は今回の支払いが0円になる', () => {
    const plan = planAddition(view(1, 1, 0, 1), 'googleBusiness', TRIAL)
    if (plan.kind !== 'over-quota') throw new Error(`over-quota のはずが ${plan.kind}`)

    expect(plan.trialing).toBe(true)
    expect(plan.dueNowYen).toBe(0)
    // 無料期間が終わったあとの料金は出す。
    expect(plan.monthlyIncreaseYen).toBe(3300)
    expect(plan.monthlyAfterYen).toBe(3300)
  })

  it('請求の段が分からないときは枠を超える追加を止める', () => {
    const plan = planAddition(view(1, 1, 0, 1), 'googleBusiness', null)
    expect(plan).toEqual({
      kind: 'billing-unknown',
      service: 'googleBusiness',
      connectedAfter: 2,
      contracted: 1,
    })
  })

  it('上限10個に達していたら個別見積もりで止める（11個目）', () => {
    for (const billing of [PAID, TRIAL, null]) {
      const plan = planAddition(view(SNS_CONNECTION_LIMIT, 2, 0, 1), 'googleBusiness', billing)
      expect(plan).toEqual({
        kind: 'individual-quote',
        service: 'googleBusiness',
        connected: 10,
        contracted: 2,
      })
    }
  })

  it('上限はサービスごとに数える（片方が上限でも他方は追加できる）', () => {
    const slots = view(SNS_CONNECTION_LIMIT, 2, 1, 2)
    expect(planAddition(slots, 'googleBusiness', PAID).kind).toBe('individual-quote')
    expect(planAddition(slots, 'instagram', PAID).kind).toBe('within-quota')
  })
})

describe('解除の筋書き（受入条件4）', () => {
  it('1件だけ減り、契約枠は変わらない', () => {
    const slots = view(2, 2, 2, 2)
    const target = slots.googleBusiness.connections[1]!
    const plan = planRemoval(slots, 'googleBusiness', target)

    expect(plan.connection).toBe(target)
    expect(plan.connectedBefore).toBe(2)
    expect(plan.connectedAfter).toBe(1)
    expect(plan.contracted).toBe(2)
    // 契約枠の中なので有料枠は動かない。
    expect(plan.paidSlotsBefore).toBe(0)
    expect(plan.paidSlotsAfter).toBe(0)
    expect(plan.monthlyDecreaseYen).toBe(0)
  })

  it('契約枠を超えていた分を解除すると有料枠が1枠減る', () => {
    const slots = view(3, 2, 2, 2)
    const plan = planRemoval(slots, 'googleBusiness', slots.googleBusiness.connections[2]!)

    expect(plan.paidSlotsBefore).toBe(1)
    expect(plan.paidSlotsAfter).toBe(0)
    expect(plan.contracted).toBe(2)
    expect(plan.monthlyDecreaseYen).toBe(3300)
  })

  it('解除するサービス以外の有料枠は残す', () => {
    const slots = view(3, 2, 3, 2)
    const plan = planRemoval(slots, 'instagram', slots.instagram.connections[0]!)

    // Instagram の1枠だけ減り、Google の1枠は残る。
    expect(plan.paidSlotsBefore).toBe(2)
    expect(plan.paidSlotsAfter).toBe(1)
    expect(plan.monthlyDecreaseYen).toBe(3300)
  })

  it('最後の1件を解除しても0個より下がらない', () => {
    const slots = view(1, 1, 0, 1)
    const plan = planRemoval(slots, 'googleBusiness', slots.googleBusiness.connections[0]!)

    expect(plan.connectedAfter).toBe(0)
    expect(plan.contracted).toBe(1)
    expect(plan.monthlyDecreaseYen).toBe(0)
  })
})

describe('札とサービスの呼び方', () => {
  it('札の言葉は status-labels の表だけを読む（期限切れは「接続の異常」）', () => {
    expect(connectionStatusLabel('connected')).toEqual({ label: '接続済み', tone: 'success' })
    expect(connectionStatusLabel('pending')).toEqual({ label: '未接続', tone: 'neutral' })
    expect(connectionStatusLabel('expired')).toEqual({ label: '接続の異常', tone: 'danger' })
    expect(connectionStatusLabel('error')).toEqual({ label: '接続の異常', tone: 'danger' })
  })

  it('小窓は「Googleマイビジネス」、カードの見出しは「Google ビジネス」', () => {
    expect(serviceName('googleBusiness')).toBe('Googleマイビジネス')
    expect(serviceName('instagram')).toBe('Instagram')
    expect(serviceCardTitle('googleBusiness')).toBe('Google ビジネス')
    expect(serviceCardTitle('instagram')).toBe('Instagram')
  })
})

describe('API の返事を一覧の形へ直す（受入条件5）', () => {
  function googleData(connection: Record<string, unknown>): GoogleConnectionData {
    return {
      success: true,
      store: { id: 'store-1', name: '然カフェ 本店', lineAccountId: 'acc-1' },
      connection: connection as GoogleConnectionData['connection'],
      candidates: [],
      summary: {
        unrepliedCount: 0, draftCount: 0, attentionCount: 0, newCount: 0,
        storedCount: 0, postsAttentionCount: 0, syncStale: false,
      },
      writeEnabled: true,
      oauthConfigured: true,
      aiAvailable: false,
      permissions: { canManageConnection: true, canPublishReply: true },
    }
  }

  const fmt = (iso: string) => `日時(${iso})`

  it('Google の接続済みは1件の行になり、主連携の札を持つ', () => {
    const slots = googleSlots(
      googleData({
        id: 'gc-1',
        status: 'connected',
        locationTitle: '然カフェ 本店',
        googleAccountEmail: 'owner@example.com',
        lastSyncedAt: '2026-11-01T00:00:00.000Z',
        confirmationRevision: 4,
      }),
      2,
      fmt,
    )

    expect(slots.contracted).toBe(2)
    expect(slots.connections).toHaveLength(1)
    const row = slots.connections[0]!
    expect(row).toMatchObject({
      id: 'gc-1',
      service: 'googleBusiness',
      name: '然カフェ 本店',
      state: 'connected',
      primary: true,
      version: 4,
    })
    expect(row.meta).toEqual(['owner@example.com', '最後に取り込んだ日時 日時(2026-11-01T00:00:00.000Z)'])
  })

  it('Google の未接続・読み取れないときは行を作らない', () => {
    expect(googleSlots(googleData({ status: 'disconnected' }), 1, fmt).connections).toHaveLength(0)
    expect(googleSlots(null, 1, fmt).connections).toHaveLength(0)
  })

  it('Google の選ぶ段・認可切れはそれぞれの状態の行になる', () => {
    const pending = googleSlots(googleData({ status: 'pending_location' }), 1, fmt).connections[0]!
    // 店舗名が無いときは店の名前で代わりに出す。
    expect(pending).toMatchObject({ state: 'pending', name: '然カフェ 本店', version: null })

    expect(googleSlots(googleData({ status: 'expired' }), 1, fmt).connections[0]!.state).toBe('expired')
    expect(googleSlots(googleData({ status: 'reauth_required' }), 1, fmt).connections[0]!.state).toBe('expired')
    expect(googleSlots(googleData({ status: 'no_permission' }), 1, fmt).connections[0]!.state).toBe('error')
  })

  function igStatus(
    state: InstagramConnectionStatus['state'],
    connection?: InstagramConnectionStatus['connection'],
  ): InstagramConnectionStatus {
    return { state, replyEnabled: false, ...(connection ? { connection } : {}) }
  }

  const IG_CONNECTION = {
    pageId: 'page-1',
    instagramId: 'ig-1',
    pageName: '然カフェ',
    username: 'nen_cafe',
    expiresAt: '2026-12-31T00:00:00.000Z',
    dataAccessExpiresAt: null,
    version: 3,
    syncedAt: '2026-10-07T01:00:00.000Z',
  }

  it('Instagram の接続済みは `@ユーザー名` の行になり、主連携は持たない', () => {
    const slots = instagramSlots(igStatus('connected', IG_CONNECTION), 2, fmt)

    expect(slots.contracted).toBe(2)
    const row = slots.connections[0]!
    expect(row).toMatchObject({
      id: 'ig-1',
      service: 'instagram',
      name: '@nen_cafe',
      state: 'connected',
      primary: false,
      version: 3,
    })
    expect(row.meta).toEqual(['ビジネスアカウント', '接続した日 日時(2026-10-07T01:00:00.000Z)'])
  })

  it('Instagram はユーザー名が無いときページ名を出す', () => {
    const slots = instagramSlots(
      igStatus('connected', { ...IG_CONNECTION, username: null }),
      1,
      fmt,
    )
    expect(slots.connections[0]!.name).toBe('然カフェ')
  })

  it('Instagram の認可切れも行として出す', () => {
    const slots = instagramSlots(igStatus('expired', IG_CONNECTION), 1, fmt)
    expect(slots.connections[0]!.state).toBe('expired')
  })

  it('Instagram の未接続・未設定・読み取れないときは行を作らない', () => {
    expect(instagramSlots(igStatus('disconnected'), 1, fmt).connections).toHaveLength(0)
    expect(instagramSlots(igStatus('unconfigured'), 1, fmt).connections).toHaveLength(0)
    expect(instagramSlots(null, 1, fmt).connections).toHaveLength(0)
  })
})
