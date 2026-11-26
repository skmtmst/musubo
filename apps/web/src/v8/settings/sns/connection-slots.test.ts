/**
 * 契約枠の数え方と追加・解除の筋書き（★v7 F1・F3・F4・F5・F6／要件 §4-1）。
 *
 * 画面ではなくこの文書が判定を持つ決まりなので、受入条件のうち数の話はここで確かめる。
 * - 受入条件1：1サービスに接続を2件積める（Google 2件・Instagram 2件）。
 * - 受入条件2：契約枠の中の追加は料金確認を挟まない（`within-quota`）。
 * - 受入条件3：枠を超える追加は有料枠 = max(0, max(Google数, Instagram数) − 1)、
 *   1枠 ¥3,300（税込）で両サービスが各1個ずつ増える。無料期間中は0円、追加した月は日割り。
 *   各サービス11個目は個別見積もり。
 * - 受入条件4：解除で枠数が減り、契約枠は変わらない。
 */

import { describe, expect, it } from 'vitest'
import type { InstagramConnectionStatus } from '@line-crm/shared'
import type { GoogleConnection, GoogleConnectionData } from '@/lib/restaurant-google-api'
import {
  SNS_CONNECTION_LIMIT,
  SNS_DEFAULT_CONTRACTED,
  SNS_SLOT_UNIT_YEN,
  asConnectionPorts,
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

function service(svc: SnsService, connected: number): SnsServiceSlots {
  return {
    service: svc,
    connections: Array.from({ length: connected }, (_, i) => conn(svc, `${svc}-${i + 1}`)),
  }
}

/**
 * `view(Google接続数, Instagram接続数, 契約枠)`。
 * 契約枠は両サービス共通の1つの数（1 + 買った追加枠の数）。
 */
function view(g: number, ig: number, contracted: number): SnsSlotsView {
  return {
    contracted,
    googleBusiness: service('googleBusiness', g),
    instagram: service('instagram', ig),
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

  it('有料枠は max(0, 多いほうの接続数 − 1)。1枠で両サービスが各1個ずつ増える', () => {
    // 基本料金に Google・Instagram が各1個ぶん入るので、各1個までは有料枠なし。
    expect(paidSlotCount(view(1, 1, 1))).toBe(0)
    expect(paidSlotCount(view(0, 0, 1))).toBe(0)
    // 1枠(¥3,300)で両サービスが各2個になるので、{2,2} は1枠ぶん。
    expect(paidSlotCount(view(2, 2, 2))).toBe(1)
    // 片方だけ3個でも、多いほうで決まるので2枠。
    expect(paidSlotCount(view(3, 2, 3))).toBe(2)
    // 2枠なら各3個ぶん。{3,3} も同じ2枠。
    expect(paidSlotCount(view(3, 3, 3))).toBe(2)
    // 少ない側の数は料金に効かない。
    expect(paidSlotCount(view(0, 4, 4))).toBe(3)
  })

  it('「連携 n個（契約枠 m個）」を出す。契約枠は両サービス同じ数', () => {
    const slots = view(2, 3, 2)
    expect(slotCountText(slots.googleBusiness, slots.contracted)).toBe('連携 2個（契約枠 2個）')
    expect(slotCountText(slots.instagram, slots.contracted)).toBe('連携 3個（契約枠 2個）')
    expect(slotCountText(service('instagram', 0), 1)).toBe('連携 0個（契約枠 1個）')
  })
})

describe('追加の筋書き（受入条件2・3）', () => {
  const PAID = { kind: 'paid', monthlyDaysRemaining: 15, monthlyDaysInPeriod: 30 } as const
  const TRIAL = { kind: 'trialing' } as const

  it('契約枠の中の追加は料金確認を挟まずそのまま認可へ進む', () => {
    const plan = planAddition(view(1, 0, 2), 'googleBusiness', PAID)
    expect(plan).toEqual({ kind: 'within-quota', service: 'googleBusiness', connectedAfter: 2, contracted: 2 })
  })

  it('契約枠の中の追加は請求の段が分からなくても進める', () => {
    const plan = planAddition(view(0, 1, 2), 'instagram', null)
    expect(plan.kind).toBe('within-quota')
  })

  it('枠を超える追加は日割りの請求つきで料金確認へ進む（支払い中）', () => {
    const plan = planAddition(view(2, 2, 2), 'googleBusiness', PAID)
    if (plan.kind !== 'over-quota') throw new Error(`over-quota のはずが ${plan.kind}`)

    expect(plan.connectedBefore).toBe(2)
    expect(plan.connectedAfter).toBe(3)
    expect(plan.contracted).toBe(2)
    // 契約枠2個ぶん（= 買った1枠）がすでに有料枠1枠。超えるので1枠増える。
    expect(plan.paidSlotsBefore).toBe(1)
    expect(plan.paidSlotsAfter).toBe(2)
    expect(plan.addedSlots).toBe(1)
    expect(plan.monthlyIncreaseYen).toBe(3300)
    expect(plan.monthlyAfterYen).toBe(6600)
    // 月次期間の残り15/30日ぶんの日割り。
    expect(plan.dueNowYen).toBe(1650)
    expect(plan.trialing).toBe(false)
  })

  it('すでに有料枠がある状態でも、増える枠は1枠ぶんだけ数える', () => {
    const plan = planAddition(view(3, 3, 3), 'googleBusiness', PAID)
    if (plan.kind !== 'over-quota') throw new Error(`over-quota のはずが ${plan.kind}`)

    // 契約枠3個 = 買った2枠。4個目で3枠になる。
    expect(plan.paidSlotsBefore).toBe(2)
    expect(plan.paidSlotsAfter).toBe(3)
    expect(plan.addedSlots).toBe(1)
    expect(plan.monthlyIncreaseYen).toBe(3300)
    expect(plan.monthlyAfterYen).toBe(9900)
  })

  it('無料期間中は今回の支払いが0円になる', () => {
    const plan = planAddition(view(1, 0, 1), 'googleBusiness', TRIAL)
    if (plan.kind !== 'over-quota') throw new Error(`over-quota のはずが ${plan.kind}`)

    expect(plan.trialing).toBe(true)
    expect(plan.dueNowYen).toBe(0)
    // 無料期間が終わったあとの料金は出す。
    expect(plan.monthlyIncreaseYen).toBe(3300)
    expect(plan.monthlyAfterYen).toBe(3300)
  })

  it('請求の段が分からないときは枠を超える追加を止める', () => {
    const plan = planAddition(view(1, 0, 1), 'googleBusiness', null)
    expect(plan).toEqual({
      kind: 'billing-unknown',
      service: 'googleBusiness',
      connectedAfter: 2,
      contracted: 1,
    })
  })

  it('上限10個に達していたら個別見積もりで止める（11個目）', () => {
    for (const billing of [PAID, TRIAL, null]) {
      const plan = planAddition(view(SNS_CONNECTION_LIMIT, 0, 2), 'googleBusiness', billing)
      expect(plan).toEqual({
        kind: 'individual-quote',
        service: 'googleBusiness',
        connected: 10,
        contracted: 2,
      })
    }
  })

  it('上限はサービスごとに数える（片方が上限でも他方は追加できる）', () => {
    const slots = view(SNS_CONNECTION_LIMIT, 1, 2)
    expect(planAddition(slots, 'googleBusiness', PAID).kind).toBe('individual-quote')
    expect(planAddition(slots, 'instagram', PAID).kind).toBe('within-quota')
  })
})

describe('解除の筋書き（受入条件4）', () => {
  it('多いほうの接続数が変わらない解除では有料枠が減らない', () => {
    const slots = view(2, 2, 2)
    const target = slots.googleBusiness.connections[1]!
    const plan = planRemoval(slots, 'googleBusiness', target)

    expect(plan.connection).toBe(target)
    expect(plan.connectedBefore).toBe(2)
    expect(plan.connectedAfter).toBe(1)
    expect(plan.contracted).toBe(2)
    // Instagram が2個のままなので、多いほうは2個で変わらない。
    expect(plan.paidSlotsBefore).toBe(1)
    expect(plan.paidSlotsAfter).toBe(1)
    expect(plan.monthlyDecreaseYen).toBe(0)
  })

  it('多いほうの接続数が減る解除は有料枠が1枠減る', () => {
    const slots = view(3, 2, 3)
    const plan = planRemoval(slots, 'googleBusiness', slots.googleBusiness.connections[2]!)

    expect(plan.paidSlotsBefore).toBe(2)
    expect(plan.paidSlotsAfter).toBe(1)
    // 契約枠は解除しても変わらない。
    expect(plan.contracted).toBe(3)
    expect(plan.monthlyDecreaseYen).toBe(3300)
  })

  it('少ないほうのサービスを解除しても料金は変わらない', () => {
    const slots = view(3, 3, 3)
    const plan = planRemoval(slots, 'instagram', slots.instagram.connections[0]!)

    // Google が3個のままなので有料枠2枠は残る。
    expect(plan.paidSlotsBefore).toBe(2)
    expect(plan.paidSlotsAfter).toBe(2)
    expect(plan.monthlyDecreaseYen).toBe(0)
  })

  it('最後の1件を解除しても0個より下がらない', () => {
    const slots = view(1, 0, 1)
    const plan = planRemoval(slots, 'googleBusiness', slots.googleBusiness.connections[0]!)

    expect(plan.connectedAfter).toBe(0)
    expect(plan.contracted).toBe(1)
    expect(plan.paidSlotsBefore).toBe(0)
    expect(plan.paidSlotsAfter).toBe(0)
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
      store: { id: 'store-1', name: '見本 本店', lineAccountId: 'acc-1' },
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
        locationTitle: '見本 本店',
        googleAccountEmail: 'owner@example.com',
        lastSyncedAt: '2026-11-01T00:00:00.000Z',
        confirmationRevision: 4,
      }),
      fmt,
    )

    expect(slots.service).toBe('googleBusiness')
    expect(slots.connections).toHaveLength(1)
    const row = slots.connections[0]!
    expect(row).toMatchObject({
      id: 'gc-1',
      service: 'googleBusiness',
      name: '見本 本店',
      state: 'connected',
      primary: true,
      version: 4,
      // 行の目印とは別に「操作する相手」を持つ。画面はこれをAPIへ渡す。
      connectionId: 'gc-1',
    })
    expect(row.meta).toEqual(['owner@example.com', '最後に取り込んだ日時 日時(2026-11-01T00:00:00.000Z)'])
  })

  it('Google は接続の id が無いとき操作先を空にする（店舗名で代用しない）', () => {
    const row = googleSlots(
      googleData({ status: 'connected', locationName: 'locations/1', locationTitle: '見本 本店' }),
      fmt,
    ).connections[0]!

    // 一覧の並びには店舗名を使うが、APIへ渡す相手は分からないので付けない。
    expect(row.id).toBe('locations/1')
    expect(row.connectionId).toBeNull()
  })

  it('主連携はサーバーの値で決め、先頭を主連携と決め打ちしない', () => {
    const data = googleData({ id: 'gc-1', status: 'connected', locationTitle: '然カフェ 本店', confirmationRevision: 4 })

    // サーバーがこの接続を主連携としているとき。
    expect(googleSlots(data, fmt, null, 'gc-1').connections[0]!.primary).toBe(true)
    // 別の接続が主連携のときは札を付けない。
    expect(googleSlots(data, fmt, null, 'gc-2').connections[0]!.primary).toBe(false)
    // 口が取れないとき（null）は今までどおり1件しか出せないので主連携として扱う。
    expect(googleSlots(data, fmt).connections[0]!.primary).toBe(true)
  })

  it('Google の未接続・読み取れないときは行を作らない', () => {
    expect(googleSlots(googleData({ status: 'disconnected' }), fmt).connections).toHaveLength(0)
    expect(googleSlots(null, fmt).connections).toHaveLength(0)
  })

  it('Google の選ぶ段・認可切れはそれぞれの状態の行になる', () => {
    const pending = googleSlots(googleData({ status: 'pending_location' }), fmt).connections[0]!
    // 店舗名が無いときは店の名前で代わりに出す。
    expect(pending).toMatchObject({ state: 'pending', name: '見本 本店', version: null })

    expect(googleSlots(googleData({ status: 'expired' }), fmt).connections[0]!.state).toBe('expired')
    expect(googleSlots(googleData({ status: 'reauth_required' }), fmt).connections[0]!.state).toBe('expired')
    expect(googleSlots(googleData({ status: 'no_permission' }), fmt).connections[0]!.state).toBe('error')
  })

  function igStatus(
    state: InstagramConnectionStatus['state'],
    connection?: InstagramConnectionStatus['connection'],
  ): InstagramConnectionStatus {
    return { state, replyEnabled: false, ...(connection ? { connection } : {}) }
  }

  const IG_CONNECTION = {
    /* 接続そのものの id。画面には出さないが、操作の宛先としてAPIへ渡す。 */
    id: 'igc-1',
    pageId: 'page-1',
    instagramId: 'ig-1',
    pageName: '見本 カフェ',
    username: 'sample_shop',
    expiresAt: '2026-12-31T00:00:00.000Z',
    dataAccessExpiresAt: null,
    version: 3,
    syncedAt: '2026-10-07T01:00:00.000Z',
  }

  it('Instagram の接続済みは `@ユーザー名` の行になり、主連携は持たない', () => {
    const slots = instagramSlots(igStatus('connected', IG_CONNECTION), fmt)

    expect(slots.service).toBe('instagram')
    const row = slots.connections[0]!
    expect(row).toMatchObject({
      id: 'ig-1',
      service: 'instagram',
      name: '@sample_shop',
      state: 'connected',
      primary: false,
      version: 3,
      // 行の目印は Instagram のアカウント id。操作の相手は接続そのものの id で別物。
      connectionId: 'igc-1',
    })
    expect(row.meta).toEqual(['ビジネスアカウント', '接続した日 日時(2026-10-07T01:00:00.000Z)'])
  })

  it('Instagram は接続の id が無いとき操作先を空にする（アカウントidで代用しない）', () => {
    const row = instagramSlots(igStatus('connected', { ...IG_CONNECTION, id: undefined }), fmt).connections[0]!

    // ここで instagramId を宛先に使うとサーバーが見つけられず必ず失敗する。
    expect(row.id).toBe('ig-1')
    expect(row.connectionId).toBeNull()
  })

  it('Instagram はユーザー名が無いときページ名を出す', () => {
    const slots = instagramSlots(igStatus('connected', { ...IG_CONNECTION, username: null }), fmt)
    expect(slots.connections[0]!.name).toBe('見本 カフェ')
  })

  it('Instagram の認可切れも行として出す', () => {
    const slots = instagramSlots(igStatus('expired', IG_CONNECTION), fmt)
    expect(slots.connections[0]!.state).toBe('expired')
  })

  it('Instagram の未接続・未設定・読み取れないときは行を作らない', () => {
    expect(instagramSlots(igStatus('disconnected'), fmt).connections).toHaveLength(0)
    expect(instagramSlots(igStatus('unconfigured'), fmt).connections).toHaveLength(0)
    expect(instagramSlots(null, fmt).connections).toHaveLength(0)
  })

  /**
   * 接続一覧の口の返事から行を作る道（受入条件1・承認済み Pen v10 の F1 `tIRy5`・F2 `VH2Ga`）。
   * v10 は Google・Instagram とも「連携 2個」の一覧で、Google は両方の行の末尾に
   * 「営業時間へ →」がある。並びはサーバーが主連携→並び順で返すので、ここでは並べ替えない。
   */
  describe('接続一覧の口の返事を複数行へ直す（受入条件1）', () => {
    const GOOGLE_LIST: GoogleConnection[] = [
      {
        id: 'gc-1',
        status: 'connected',
        locationName: 'locations/1',
        locationTitle: '見本 A店',
        googleAccountEmail: 'shop@example.com',
        lastSyncedAt: '2026-10-02T08:00:00.000Z',
        confirmationRevision: 4,
      },
      {
        id: 'gc-2',
        status: 'connected',
        locationName: 'locations/2',
        locationTitle: '見本 B店',
        googleAccountEmail: 'shop@example.com',
        lastSyncedAt: '2026-10-01T21:00:00.000Z',
        confirmationRevision: 2,
      },
    ]

    it('Google は一覧の件数ぶんの行になり、先頭だけが主連携', () => {
      const slots = googleSlots(googleData({ id: 'gc-1', status: 'connected' }), fmt, GOOGLE_LIST)

      expect(slots.connections).toHaveLength(2)
      expect(slots.connections.map((row) => [row.name, row.primary, row.connectionId, row.version])).toEqual([
        ['見本 A店', true, 'gc-1', 4],
        ['見本 B店', false, 'gc-2', 2],
      ])
      expect(slotCountText(slots, 2)).toBe('連携 2個（契約枠 2個）')
    })

    it('Google は行ごとに店舗の目印を持つ（営業時間への行き先を行ごとに決められる）', () => {
      const rows = googleSlots(googleData({ id: 'gc-1', status: 'connected' }), fmt, GOOGLE_LIST).connections
      expect(rows.map((row) => row.locationName)).toEqual(['locations/1', 'locations/2'])

      const pendingRow = googleSlots(googleData({ id: 'gc-1', status: 'connected' }), fmt, [
        GOOGLE_LIST[0]!,
        { ...GOOGLE_LIST[1]!, locationName: undefined },
      ]).connections
      expect(pendingRow[1]!.locationName).toBeNull()
    })

    it('Google は一覧の中の解除済みを行にしない。残った先頭が主連携になる', () => {
      const slots = googleSlots(googleData({ id: 'gc-1', status: 'connected' }), fmt, [
        { ...GOOGLE_LIST[0]!, status: 'disconnected' },
        GOOGLE_LIST[1]!,
      ])

      expect(slots.connections.map((row) => [row.connectionId, row.primary])).toEqual([['gc-2', true]])
    })

    it('Google は一覧を読めていないとき1件ぶんの返事から1行だけ作る', () => {
      const data = googleData({ id: 'gc-1', status: 'connected', locationTitle: '見本 A店' })
      for (const list of [null, undefined, []] as const) {
        const slots = googleSlots(data, fmt, list)
        expect(slots.connections.map((row) => row.connectionId)).toEqual(['gc-1'])
        expect(slots.connections[0]!.primary).toBe(true)
      }
    })

    const IG_LIST = {
      state: 'connected' as const,
      connections: [
        { ...IG_CONNECTION, id: 'igc-1', instagramId: 'ig-1', username: 'zen_shibuya', state: 'connected' as const },
        {
          ...IG_CONNECTION,
          id: 'igc-2',
          instagramId: 'ig-2',
          username: 'zen_ebisu',
          version: 7,
          state: 'expired' as const,
          syncedAt: '2026-10-01T01:00:00.000Z',
        },
      ],
    }

    it('Instagram は一覧の件数ぶんの行になり、状態は行ごと・主連携は持たない', () => {
      const slots = instagramSlots(igStatus('connected', IG_CONNECTION), fmt, IG_LIST)

      expect(slots.connections.map((row) => [row.name, row.state, row.connectionId, row.version, row.primary])).toEqual([
        ['@zen_shibuya', 'connected', 'igc-1', 3, false],
        ['@zen_ebisu', 'expired', 'igc-2', 7, false],
      ])
      expect(slots.connections[1]!.meta).toEqual(['ビジネスアカウント', '接続した日 日時(2026-10-01T01:00:00.000Z)'])
    })

    it('Instagram は一覧を読めていないとき1件ぶんの返事から1行だけ作る', () => {
      const status = igStatus('connected', IG_CONNECTION)
      for (const list of [null, undefined, { state: 'connected' as const, connections: [] }] as const) {
        expect(instagramSlots(status, fmt, list).connections.map((row) => row.connectionId)).toEqual(['igc-1'])
      }
    })

    it('一覧の行はそのまま解除の筋書きへ渡せる（枠は減り、契約枠は動かない）', () => {
      const google = googleSlots(googleData({ id: 'gc-1', status: 'connected' }), fmt, GOOGLE_LIST)
      const instagram = instagramSlots(igStatus('connected', IG_CONNECTION), fmt, IG_LIST)
      const view: SnsSlotsView = { contracted: 2, googleBusiness: google, instagram }

      const plan = planRemoval(view, 'googleBusiness', google.connections[1]!)
      expect(plan.connection.connectionId).toBe('gc-2')
      expect(plan.connectedBefore).toBe(2)
      expect(plan.connectedAfter).toBe(1)
      expect(plan.contracted).toBe(2)
    })
  })
})

describe('契約枠・主連携・請求の段の形の確かめ', () => {
  const PORTS = {
    lineAccountId: 'acc-1',
    contracted: 2,
    counts: { googleBusiness: 1, instagram: 1 },
    linkedSlots: 1,
    billing: { kind: 'trialing' },
    googleConnections: [{ id: 'g-1', label: '然カフェ 本店', state: 'connected', version: 4, isPrimary: true }],
    primaryVersion: 7,
  }

  it('必要な項目がそろった返事はそのまま受け取る', () => {
    expect(asConnectionPorts(PORTS)).toBe(PORTS)
  })

  it('別アカウントの契約枠と不正な請求日数は追加の許可に使わない', () => {
    expect(asConnectionPorts(PORTS, 'acc-2')).toBeNull()
    expect(asConnectionPorts({ ...PORTS, contracted: Infinity })).toBeNull()
    expect(asConnectionPorts({ ...PORTS, contracted: 1.5 })).toBeNull()
    expect(asConnectionPorts({ ...PORTS, primaryVersion: -1 })).toBeNull()
    expect(asConnectionPorts({ ...PORTS, billing: { kind: 'paid', monthlyDaysRemaining: 31, monthlyDaysInPeriod: 30 } })).toBeNull()
    expect(asConnectionPorts({ ...PORTS, billing: { kind: 'paid', monthlyDaysRemaining: 3, monthlyDaysInPeriod: 30 } }, 'acc-1')).toBeTruthy()
  })

  it('主連携の配列が無い返事は取れなかった扱いにする', () => {
    expect(asConnectionPorts({ ...PORTS, googleConnections: undefined })).toBeNull()
    expect(asConnectionPorts({ items: [], total: 0, page: 1, limit: 20 })).toBeNull()
  })

  it('契約枠・版が数で無い返事は取れなかった扱いにする', () => {
    expect(asConnectionPorts({ ...PORTS, contracted: '2' })).toBeNull()
    expect(asConnectionPorts({ ...PORTS, primaryVersion: null })).toBeNull()
  })

  it('接続の行に ID・主連携の印が無い返事は取れなかった扱いにする', () => {
    expect(asConnectionPorts({ ...PORTS, googleConnections: [{ label: '然カフェ 本店' }] })).toBeNull()
    expect(asConnectionPorts({ ...PORTS, googleConnections: [null] })).toBeNull()
  })

  it('返事が中身を持たないときは取れなかった扱いにする', () => {
    expect(asConnectionPorts(undefined)).toBeNull()
    expect(asConnectionPorts(null)).toBeNull()
    expect(asConnectionPorts('')).toBeNull()
  })

  it('接続が0件の返事は形がそろっていれば受け取る', () => {
    const empty = { ...PORTS, googleConnections: [] }
    expect(asConnectionPorts(empty)).toBe(empty)
  })
})
