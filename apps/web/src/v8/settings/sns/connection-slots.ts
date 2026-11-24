/**
 * SNS 連携の接続一覧と契約枠の数え方。
 *
 * 承認デザイン（設定SNS連携 複数接続 第1段 v7）の画面が必要とする形へ、
 * API の返事を整える場所。いまの API は Google・Instagram どちらも接続が1件ぶんの形なので、
 * ここで1件の配列に直す。API が配列を返すようになったら、直すのはこの文書だけで済む。
 *
 * 枠と料金の数え方（要件 §3・§4-1）:
 *   基本料金に Google・Instagram が各1個ぶん入る。追加枠1枠（¥3,300税込）を足すと
 *   両サービスの上限が同時に各1個増える（2枠なら各3個）。だから
 *   有料枠 = max(0, max(Google数, Instagram数) − 1) で、`@line-crm/shared` の
 *   `linkedAccountSlots` が正本。ここでは数え直さずそれを使う。
 *
 *   契約枠も同じ考え方で、LINEアカウントごとに1つの数（= 1 + 合意済みの追加枠数）。
 *   サービス別に別の数を持たない。契約枠は「料金の確認を挟むかどうか」と
 *   「連携 n個（契約枠 m個）」の表示にだけ使い、請求額は接続数から出す
 *   （解除したら次回の月次請求から減らす、という今までの進み方をそのまま保つため）。
 */

import {
  DEFAULT_MUSUBO_PRICE_SCHEDULE,
  linkedAccountSlots,
  prorateMonthlyIncrement,
  type InstagramConnectionStatus,
  type SnsConnectionPorts,
  type SnsGoogleConnectionPort,
  type SnsSlotBilling as SharedSnsSlotBilling,
} from '@line-crm/shared'
import type { GoogleConnection, GoogleConnectionData } from '@/lib/restaurant-google-api'
import type { InstagramConnectionList } from '@/lib/api/features/settings'
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
  /**
   * API へ操作先として送る接続の id。画面には出さない。
   * `id` は行の見分け（key・処理中の印）用で、API が受け取る id とは別物。
   */
  connectionId?: string | null
  /**
   * Google で選んだ店舗（ロケーション）の目印。行の末尾に営業時間の画面への行き先を出すかどうかに使う。
   * 店舗を選び終えていない接続と Instagram の行では空。
   */
  locationName?: string | null
}

/** 1サービスぶんの接続。契約枠は両サービス共通なので `SnsSlotsView` が持つ。 */
export type SnsServiceSlots = {
  service: SnsService
  connections: SnsConnectionView[]
}

export type SnsSlotsView = {
  /**
   * 契約枠。LINEアカウントごとに1つの数で、Google・Instagram の両方に同じだけ効く。
   * 値は 1 + 合意済みの追加枠数（追加枠なしなら1）。HQ が持つ。
   */
  contracted: number
  googleBusiness: SnsServiceSlots
  instagram: SnsServiceSlots
}

/**
 * 請求の段。日付と残り日数はサーバーの値だけを使い、利用者の時計から作らない。
 * 形の正本は `@line-crm/shared` の `SnsSlotBilling`（`GET /api/settings/sns/connections` が返す段）。
 * ここでは別に定義せず、同じ型を指すだけにして形がずれないようにする。
 */
export type SnsSlotBilling = SharedSnsSlotBilling

/**
 * 契約枠が取れないときの既定。
 * 契約枠は HQ が持ち、LINEアカウントごとに1つの数（両サービス共通）で返る（要件 §4-1）。
 * ふだんは `GET /api/settings/sns/connections` の `contracted` を使う。
 * その口が返らない LINEアカウント（契約枠の記録が無い＝404）では、
 * 基本料金に入っている各1個ぶんだけを契約枠として数える。
 * 少なく見せて料金の確認を飛ばすことがない側へ寄せた既定。
 */
export const SNS_DEFAULT_CONTRACTED = 1

/**
 * `GET /api/settings/sns/connections` の返事が、この画面が読める形かどうかを確かめる。
 *
 * サーバーや疑似APIは、知らない道でも `success: true` のまま別の形の中身を返すことがある。
 * 形を見ずに受け取ると主連携を探すところで画面全体が止まるので、
 * 必要な項目がそろっていないときは「取れなかった」のと同じ扱いにして、
 * 既定（契約枠1・請求の段なし）へ戻す。
 */
export function asConnectionPorts(data: unknown, accountId?: string): SnsConnectionPorts | null {
  if (!data || typeof data !== 'object') return null
  const ports = data as Partial<SnsConnectionPorts>
  if (typeof ports.lineAccountId !== 'string' || (accountId && ports.lineAccountId !== accountId)) return null
  if (!Number.isSafeInteger(ports.contracted) || ports.contracted! < 1
    || !Number.isSafeInteger(ports.primaryVersion) || ports.primaryVersion! < 0) return null
  if (ports.billing !== null && ports.billing?.kind !== 'trialing') {
    const billing = ports.billing
    if (billing?.kind !== 'paid' || !Number.isSafeInteger(billing.monthlyDaysRemaining)
      || !Number.isSafeInteger(billing.monthlyDaysInPeriod) || billing.monthlyDaysInPeriod < 1
      || billing.monthlyDaysRemaining < 0 || billing.monthlyDaysRemaining > billing.monthlyDaysInPeriod) return null
  }
  if (!Array.isArray(ports.googleConnections)) return null
  const connectionsReadable = ports.googleConnections.every((connection) => {
    if (!connection || typeof connection !== 'object') return false
    const port = connection as Partial<SnsGoogleConnectionPort>
    return typeof port.id === 'string' && typeof port.isPrimary === 'boolean'
  })
  if (!connectionsReadable) return null
  return data as SnsConnectionPorts
}

/* ------------------------------------------------------------------ 枠の数え方 */

/**
 * 有料枠 = max(0, max(Google数, Instagram数) − 1)。
 * 1枠で両サービスの上限が同時に1個ずつ増えるので、多いほうの数だけで決まる。
 * 数式は `@line-crm/shared` の `linkedAccountSlots` が正本なので、ここでは数え直さない。
 */
export function paidSlotCount(slots: SnsSlotsView): number {
  return linkedAccountSlots({
    googleBusiness: slots.googleBusiness.connections.length,
    instagram: slots.instagram.connections.length,
  })
}

/** 片方のサービスの数だけを入れ替えたときの有料枠。追加・解除した後の枠数を出すのに使う。 */
function paidSlotCountWith(slots: SnsSlotsView, service: SnsService, connected: number): number {
  const counts = {
    googleBusiness: slots.googleBusiness.connections.length,
    instagram: slots.instagram.connections.length,
  }
  counts[service] = connected
  return linkedAccountSlots(counts)
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
  const contracted = slots.contracted

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
  const paidSlotsAfter = paidSlotCountWith(slots, service, connectedAfter)
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
  const paidSlotsAfter = paidSlotCountWith(slots, service, connectedAfter)

  return {
    service,
    connection,
    connectedBefore,
    connectedAfter,
    contracted: slots.contracted,
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

/** Google の接続1件を画面の1行へ直す。 */
function googleRow(
  connection: GoogleConnection,
  storeName: string | undefined,
  primary: boolean,
  formatLastSynced: (iso: string) => string,
): SnsConnectionView {
  const meta: string[] = []
  if (connection.googleAccountEmail) meta.push(connection.googleAccountEmail)
  if (connection.lastSyncedAt) meta.push(`最後に取り込んだ日時 ${formatLastSynced(connection.lastSyncedAt)}`)
  return {
    id: connection.id ?? connection.locationName ?? 'google',
    service: 'googleBusiness',
    name: connection.locationTitle ?? storeName ?? '接続先',
    meta,
    state: googleState(connection.status),
    primary,
    version: connection.confirmationRevision ?? null,
    connectionId: connection.id ?? null,
    locationName: connection.locationName ?? null,
  }
}

/**
 * Google の返事を接続の配列へ直す。
 * `list` は接続一覧の口の返事で、接続が何件あってもそのぶんの行を作る。
 * 一覧を読めていないときは、1件ぶんの `data` から繋がっている1件だけを作る。
 * 主連携の指定を取得できた場合はその接続だけに札を付け、取得できない場合はサーバーの一覧の先頭を正本とする。
 * 一覧の並びはサーバーが主連携→並び順で返すので、ここでは並べ替えない。
 */
export function googleSlots(
  data: GoogleConnectionData | null,
  formatLastSynced: (iso: string) => string,
  list?: GoogleConnection[] | null,
  primaryConnectionId?: string | null,
): SnsServiceSlots {
  const storeName = data?.store.name
  if (list && list.length > 0) {
    return {
      service: 'googleBusiness',
      connections: list
        .filter((connection) => connection.status !== 'disconnected')
        .map((connection, index) => googleRow(connection, storeName, primaryConnectionId == null ? index === 0 : connection.id === primaryConnectionId, formatLastSynced)),
    }
  }

  const connection = data?.connection ?? null
  const connections: SnsConnectionView[] = []
  if (connection && connection.status !== 'disconnected') {
    connections.push(googleRow(connection, storeName, primaryConnectionId == null || connection.id === primaryConnectionId, formatLastSynced))
  }

  return { service: 'googleBusiness', connections }
}

/** Instagram の接続1件を画面の1行へ直す。期限切れかどうかは行ごとに持つ。 */
function instagramRow(
  connection: {
    id?: string | null
    instagramId: string
    pageName: string
    username: string | null
    version: number
    syncedAt: string | null
  },
  expired: boolean,
  formatConnected: (iso: string) => string,
): SnsConnectionView {
  const meta = ['ビジネスアカウント']
  if (connection.syncedAt) meta.push(`接続した日 ${formatConnected(connection.syncedAt)}`)
  return {
    id: connection.instagramId,
    service: 'instagram',
    name: connection.username ? `@${connection.username}` : connection.pageName,
    meta,
    state: expired ? 'expired' : 'connected',
    primary: false,
    version: connection.version,
    connectionId: connection.id ?? null,
  }
}

/**
 * Instagram の返事を接続の配列へ直す。
 * `list` は接続一覧の口の返事で、接続が何件あってもそのぶんの行を作る。
 * 一覧を読めていないときは、1件ぶんの `status` から繋がっている1件だけを作る。
 * Instagram には主連携を設けないので `primary` は常に false（要件 §4-3）。
 */
export function instagramSlots(
  status: InstagramConnectionStatus | null,
  formatConnected: (iso: string) => string,
  list?: InstagramConnectionList | null,
): SnsServiceSlots {
  if (list && list.connections.length > 0) {
    return {
      service: 'instagram',
      connections: list.connections.map((connection) =>
        instagramRow(connection, connection.state === 'expired', formatConnected),
      ),
    }
  }

  const connection = status?.connection ?? null
  const connections: SnsConnectionView[] = []
  if (connection && (status?.state === 'connected' || status?.state === 'expired')) {
    connections.push(instagramRow(connection, status.state === 'expired', formatConnected))
  }

  return { service: 'instagram', connections }
}

/** サービスの呼び方。ダイアログの文言は承認デザインに合わせて「Googleマイビジネス」。 */
export function serviceName(service: SnsService): string {
  return service === 'googleBusiness' ? 'Googleマイビジネス' : 'Instagram'
}

/** カードの見出しの呼び方。承認デザインの F1・F2・F7・F8 は「Google ビジネス」。 */
export function serviceCardTitle(service: SnsService): string {
  return service === 'googleBusiness' ? 'Google ビジネス' : 'Instagram'
}

/** 「連携 n個（契約枠 m個）」。契約枠は両サービス共通の数なので外から渡す。 */
export function slotCountText(slots: SnsServiceSlots, contracted: number): string {
  return `連携 ${slots.connections.length}個（契約枠 ${contracted}個）`
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
