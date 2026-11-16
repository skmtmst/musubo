/**
 * SNS 連携の接続一覧と契約枠の数え方。
 *
 * 承認デザイン（設定SNS連携 複数接続 第1段 v7）の画面が必要とする形へ、
 * API の返事を整える場所。いまの API は Google・Instagram どちらも接続が1件ぶんの形なので、
 * ここで1件の配列に直す。API が配列を返すようになったら、直すのはこの文書だけで済む。
 *
 * 契約枠の数え方（要件 §4-1）:
 *   有料枠 = Σ max(0, 接続数 − 契約枠)（サービスごとに出して足す）
 * `packages/shared` の `musuboLinkedAdditionPrice` はまだ「max(Google, Instagram) − 1」で数えるため、
 * 契約枠に合わせた数え方はここで持つ。単価・上限10個・無料期間¥0・日割りは共通設計をそのまま使う。
 */

import {
  DEFAULT_MUSUBO_PRICE_SCHEDULE,
  prorateMonthlyIncrement,
  type InstagramConnectionStatus,
} from '@line-crm/shared'
import type { GoogleConnectionData } from '@/lib/restaurant-google-api'
import { GOOGLE_CONNECTION_STATUS } from '@/lib/status-labels'

/** 連携できる先。主連携は Google ビジネスの接続にだけ設ける（要件 §4-3）。 */
export type SnsService = 'googleBusiness' | 'instagram'

/** 1サービスあたりの接続数の上限。11個目からは個別見積もり（要件 §4-1）。 */
export const SNS_CONNECTION_LIMIT = 10

/** 追加連携枠の単価（税込）。共通の料金表を正本にする。 */
export const SNS_SLOT_UNIT_YEN = DEFAULT_MUSUBO_PRICE_SCHEDULE.linkedAccountSlotYen

/** 接続の状態。札の文字は status-labels が持つ。 */
export type SnsConnectionState = 'connected' | 'expired' | 'pending' | 'error'

/** 画面の1行ぶん。 */
export type SnsConnectionView = {
  id: string
  service: SnsService
  /** 行の名前。Google はロケーション名、Instagram は `@ユーザー名`。 */
  name: string
  /** 名前の下の行。`・` でつないで出す。 */
  meta: string[]
  state: SnsConnectionState
  /** 営業時間・店舗情報の正本かどうか。Instagram は常に false。 */
  primary: boolean
  /** 解除のときに送る版。無い接続は null。 */
  version: number | null
}

/** 1サービスぶんの接続と枠。 */
export type SnsServiceSlots = {
  service: SnsService
  connections: SnsConnectionView[]
  /** 契約時にヒアリングした個数。HQ が持つ。 */
  contracted: number
}

export type SnsSlotsView = {
  googleBusiness: SnsServiceSlots
  instagram: SnsServiceSlots
}

/** 請求の段。日付と残り日数はサーバーの値だけを使い、利用者の時計から作らない。 */
export type SnsSlotBilling =
  | { kind: 'trialing' }
  | { kind: 'paid'; monthlyDaysRemaining: number; monthlyDaysInPeriod: number }

/**
 * 契約枠の既定。
 * 契約枠は HQ が持ち、LINEアカウントごとにサービス別で返る形になる（要件 §4-1）。
 * その欄を返す API はまだ無い（要件 §6 の「API型」は別の担当）ので、
 * 返るまでは今の単一接続と同じ1個として数える。
 * 少なく見せて料金の確認を飛ばすことがない側へ寄せた既定。
 */
export const SNS_DEFAULT_CONTRACTED = 1

/* ------------------------------------------------------------------ 枠の数え方 */

function overQuota(connected: number, contracted: number): number {
  return Math.max(0, connected - contracted)
}

/** 有料枠 = Σ max(0, 接続数 − 契約枠)。サービスごとに出して足す。 */
export function paidSlotCount(slots: SnsSlotsView): number {
  return (
    overQuota(slots.googleBusiness.connections.length, slots.googleBusiness.contracted) +
    overQuota(slots.instagram.connections.length, slots.instagram.contracted)
  )
}

/** 枠の料金（税込・月額）。 */
export function slotMonthlyYen(slotCount: number, unitYen: number = SNS_SLOT_UNIT_YEN): number {
  return slotCount * unitYen
}

/* ------------------------------------------------------------ 追加のときの判定 */

export type SnsAdditionPlan =
  /** 契約枠の中。料金確認を挟まず、そのまま認可画面へ進む。 */
  | { kind: 'within-quota'; service: SnsService; connectedAfter: number; contracted: number }
  /** 契約枠を超える。画面内で料金を確認してから認可画面へ進む。 */
  | {
      kind: 'over-quota'
      service: SnsService
      connectedBefore: number
      connectedAfter: number
      contracted: number
      paidSlotsBefore: number
      paidSlotsAfter: number
      addedSlots: number
      /** 次回からの月額増分（税込）。無料期間中も「終了後の料金」として使う。 */
      monthlyIncreaseYen: number
      /** 追加後の連携枠料金の合計（税込・月額）。 */
      monthlyAfterYen: number
      /** 今回の支払い。無料期間中は0、支払い中は月次期間の日割り。 */
      dueNowYen: number
      trialing: boolean
      billing: SnsSlotBilling
    }
  /** 上限10個に達している。11個目からは個別見積もり。 */
  | { kind: 'individual-quote'; service: SnsService; connected: number; contracted: number }
  /**
   * 契約枠を超えるが、請求の段（無料期間か支払い中か・月次期間の残り日数）が分からない。
   * 金額を画面で作らないため、追加の操作を押せない状態にして理由を添える（AGENTS.md §15）。
   */
  | { kind: 'billing-unknown'; service: SnsService; connectedAfter: number; contracted: number }

/**
 * 1件追加するときの進み方を決める。
 * 契約枠の中なら料金確認なし、超えるなら料金確認、上限なら個別見積もり。
 * 請求の段が分からないときは、枠を超える追加だけを止める（枠内の追加は今までどおり進める）。
 */
export function planAddition(
  slots: SnsSlotsView,
  service: SnsService,
  billing: SnsSlotBilling | null,
): SnsAdditionPlan {
  const target = slots[service]
  const connectedBefore = target.connections.length
  const contracted = target.contracted

  if (connectedBefore >= SNS_CONNECTION_LIMIT) {
    return { kind: 'individual-quote', service, connected: connectedBefore, contracted }
  }

  const connectedAfter = connectedBefore + 1
  if (connectedAfter <= contracted) {
    return { kind: 'within-quota', service, connectedAfter, contracted }
  }
  if (!billing) {
    return { kind: 'billing-unknown', service, connectedAfter, contracted }
  }

  const paidSlotsBefore = paidSlotCount(slots)
  const paidSlotsAfter = paidSlotsBefore + 1
  const addedSlots = paidSlotsAfter - paidSlotsBefore
  const monthlyIncreaseYen = slotMonthlyYen(addedSlots)
  const trialing = billing.kind === 'trialing'
  const dueNowYen = trialing
    ? 0
    : prorateMonthlyIncrement(
        monthlyIncreaseYen,
        billing.monthlyDaysRemaining,
        billing.monthlyDaysInPeriod,
      )

  return {
    kind: 'over-quota',
    service,
    connectedBefore,
    connectedAfter,
    contracted,
    paidSlotsBefore,
    paidSlotsAfter,
    addedSlots,
    monthlyIncreaseYen,
    monthlyAfterYen: slotMonthlyYen(paidSlotsAfter),
    dueNowYen,
    trialing,
    billing,
  }
}

/* ------------------------------------------------------------ 解除のときの判定 */

export type SnsRemovalPlan = {
  service: SnsService
  connection: SnsConnectionView
  connectedBefore: number
  connectedAfter: number
  /** 契約枠は解除しても変わらない。 */
  contracted: number
  paidSlotsBefore: number
  paidSlotsAfter: number
  /** 次回の月次請求からの減額（税込・月額）。減らない場合は0。 */
  monthlyDecreaseYen: number
}

/** 1件解除したときの枠数と料金の変わり方を出す。契約枠は変えない。 */
export function planRemoval(
  slots: SnsSlotsView,
  service: SnsService,
  connection: SnsConnectionView,
): SnsRemovalPlan {
  const target = slots[service]
  const connectedBefore = target.connections.length
  const connectedAfter = Math.max(0, connectedBefore - 1)
  const paidSlotsBefore = paidSlotCount(slots)
  const paidSlotsAfter =
    paidSlotsBefore -
    (overQuota(connectedBefore, target.contracted) - overQuota(connectedAfter, target.contracted))

  return {
    service,
    connection,
    connectedBefore,
    connectedAfter,
    contracted: target.contracted,
    paidSlotsBefore,
    paidSlotsAfter,
    monthlyDecreaseYen: slotMonthlyYen(paidSlotsBefore - paidSlotsAfter),
  }
}

/* ------------------------------------------------------------------- 形の変換 */

/** 画面に出す札の言い方の元になる状態へ直す。 */
function googleState(status: string | null | undefined): SnsConnectionState {
  if (status === 'connected') return 'connected'
  if (status === 'pending_location') return 'pending'
  if (status === 'expired' || status === 'reauth_required') return 'expired'
  return 'error'
}

/**
 * Google の返事を接続の配列へ直す。
 * いまの API は接続が1件ぶんの形なので、繋がっているときだけ1件の配列にする。
 * 主連携は API が持つようになるまで、先頭の接続を正本として扱う（要件 §4-3 の既定）。
 */
export function googleSlots(
  data: GoogleConnectionData | null,
  contracted: number,
  formatLastSynced: (iso: string) => string,
): SnsServiceSlots {
  const connection = data?.connection ?? null
  const status = connection?.status ?? null
  const connections: SnsConnectionView[] = []

  if (connection && status !== 'disconnected') {
    const meta: string[] = []
    if (connection.googleAccountEmail) meta.push(connection.googleAccountEmail)
    if (connection.lastSyncedAt) meta.push(`最後に取り込んだ日時 ${formatLastSynced(connection.lastSyncedAt)}`)
    connections.push({
      id: connection.id ?? connection.locationName ?? 'google',
      service: 'googleBusiness',
      name: connection.locationTitle ?? data?.store.name ?? '接続先',
      meta,
      state: googleState(status),
      primary: true,
      version: connection.confirmationRevision ?? null,
    })
  }

  return { service: 'googleBusiness', connections, contracted }
}

/**
 * Instagram の返事を接続の配列へ直す。
 * Instagram には主連携を設けないので `primary` は常に false（要件 §4-3）。
 */
export function instagramSlots(
  status: InstagramConnectionStatus | null,
  contracted: number,
  formatConnected: (iso: string) => string,
): SnsServiceSlots {
  const connection = status?.connection ?? null
  const connections: SnsConnectionView[] = []

  if (connection && (status?.state === 'connected' || status?.state === 'expired')) {
    const meta = ['ビジネスアカウント']
    if (connection.syncedAt) meta.push(`接続した日 ${formatConnected(connection.syncedAt)}`)
    connections.push({
      id: connection.instagramId,
      service: 'instagram',
      name: connection.username ? `@${connection.username}` : connection.pageName,
      meta,
      state: status.state === 'expired' ? 'expired' : 'connected',
      primary: false,
      version: connection.version,
    })
  }

  return { service: 'instagram', connections, contracted }
}

/** サービスの呼び方。ダイアログの文言は承認デザインに合わせて「Googleマイビジネス」。 */
export function serviceName(service: SnsService): string {
  return service === 'googleBusiness' ? 'Googleマイビジネス' : 'Instagram'
}

/** カードの見出しの呼び方。承認デザインの F1・F2・F7・F8 は「Google ビジネス」。 */
export function serviceCardTitle(service: SnsService): string {
  return service === 'googleBusiness' ? 'Google ビジネス' : 'Instagram'
}

/** 「連携 n個（契約枠 m個）」。 */
export function slotCountText(slots: SnsServiceSlots): string {
  return `連携 ${slots.connections.length}個（契約枠 ${slots.contracted}個）`
}

/**
 * 行に出す札の言葉と色。status-labels の表だけを読む（画面で言葉を作らない）。
 * 承認デザインは期限切れの行を「期限切れ」と書くが、同じ接続を設定と SNS で
 * 別の言葉にしないという既存の決まりに合わせ、表の「接続の異常」をそのまま使う。
 */
export function connectionStatusLabel(
  state: SnsConnectionState,
): (typeof GOOGLE_CONNECTION_STATUS)[keyof typeof GOOGLE_CONNECTION_STATUS] {
  if (state === 'connected') return GOOGLE_CONNECTION_STATUS.connected
  if (state === 'pending') return GOOGLE_CONNECTION_STATUS.pending_location
  if (state === 'expired') return GOOGLE_CONNECTION_STATUS.expired
  return GOOGLE_CONNECTION_STATUS.no_permission
}
