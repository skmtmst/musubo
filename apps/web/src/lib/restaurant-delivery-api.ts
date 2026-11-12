import { downloadApiFile, fetchApi } from './api'
import type {
  UberConnectStartData,
  UberConnectionData,
  UberConnectionMutationData,
  UberStoreSelectData,
  UberStoresData,
} from './restaurant-delivery-ubereats-types'

/**
 * 飲食店向け（テスト）「デリバリー受注」のAPI。
 * ★承認済みデザイン デリバリー受注_v02.pen（2026-10-09）D-1 `kDQHr`／D-2 `hjdqV`／
 * D-3 `dgeTy`／D-4 `OzHLO`／D-5 `h7OeT`／D-6 `XCVGd`。
 *
 * 対象は Uber Eats・出前館・ロケットナウ の3つだけ。外部の受注一元化サービスは使わない。
 * 急ぎ度はWorker側だけで決まる。画面はここで返る結果（urgency）と理由の文だけを出す。
 * 取り消せない操作（注文キャンセル・受付の一括停止）は確認手順の見出しを必ず付ける。
 */

const BASE = '/api/restaurant-test/delivery'

/** 取り消せない操作の確認の印。Workerと同じ文字でないと428で止まる。 */
const CANCEL_CONFIRM_TOKEN = 'delivery-order-cancel'
const INTAKE_STOP_CONFIRM_TOKEN = 'delivery-intake-stop'

export const DELIVERY_SERVICES = ['ubereats', 'demaecan', 'rocketnow'] as const
export type DeliveryService = (typeof DELIVERY_SERVICES)[number]

export const DELIVERY_SERVICE_LABELS: Record<DeliveryService, string> = {
  ubereats: 'Uber Eats',
  demaecan: '出前館',
  rocketnow: 'ロケットナウ',
}

export type DeliveryOrderStatus =
  | 'new'
  | 'cooking'
  | 'ready'
  | 'handed_over'
  | 'canceled'
  | 'rejected'
/** D-1のタブは「新着」「調理中」「受け渡し済み」「すべて」の4つ。 */
export type DeliveryOrderTab = 'all' | 'new' | 'cooking' | 'handed_over'
export type DeliveryUrgency = 'urgent' | 'normal' | 'watch'
export type DeliveryConnectionStatus = 'connected' | 'disconnected' | 'error'
export type DeliveryIntakeStatus = 'open' | 'stopped'
export type DeliveryCancelReasonCode =
  | 'out_of_stock'
  | 'store_busy'
  | 'equipment_trouble'
  | 'customer_request'
  | 'other'
export type DeliveryIntakeStopPreset = '30m' | '60m' | '90m' | 'today'

export interface DeliveryServiceState {
  service: DeliveryService
  version?: number
  target?: string | null
  label: string
  connectionStatus: DeliveryConnectionStatus
  /** サーバーが明示的に許可した場合だけUberの個別注文操作を表示する。 */
  orderActionsEnabled?: boolean
  intakeStatus: DeliveryIntakeStatus
  stopUntil: string | null
  todayCount: number
  todayAmount: number
}

export interface DeliveryOrderSummary {
  id: string
  version?: number
  service: DeliveryService
  serviceLabel: string
  orderNumber: string
  status: DeliveryOrderStatus
  statusLabel: string
  totalAmount: number
  itemCount: number
  itemSummary: string
  urgency: DeliveryUrgency
  urgencyReason: string
  receivedAt: string | null
  wantedAt: string | null
}

export interface DeliveryOrdersData {
  success: true
  store: { id: string; name: string }
  services: DeliveryServiceState[]
  /**
   * D-1のKPI4枚。「本日の注文」「本日の売上」「急ぎ対応」「平均準備時間」。
   * 前日と比べられないとき（前日が0件、平均が取れない）は null が届く。
   * そのときは数を作らず「—」を出す。
   */
  kpis: {
    todayCount: number
    todayCountDelta: number
    handedOverCount: number
    todaySales: number
    todaySalesDeltaPercent: number | null
    averageAmount: number | null
    urgentCount: number
    averagePrepMinutes: number | null
    averagePrepMinutesDelta: number | null
  }
  tab: DeliveryOrderTab
  tabCounts: { all: number; new: number; cooking: number; handed_over: number }
  orders: DeliveryOrderSummary[]
}

export interface DeliveryOrderItem {
  name: string
  note: string | null
  quantity: number
  amount: number
}

export interface DeliveryOrderDetailData {
  success: true
  order: {
    id: string
    version?: number
    service: DeliveryService
    serviceLabel: string
    orderNumber: string
    status: DeliveryOrderStatus
    statusLabel: string
    totalAmount: number
    currency: string
    itemCount: number
    urgency: DeliveryUrgency
    urgencyReason: string
    pickupMethod: string | null
    wantedAt: string | null
    customerNote: string | null
    cancelReasonCode: DeliveryCancelReasonCode | null
    canceledBy: string | null
    receivedAt: string | null
    acceptedAt: string | null
    readyAt: string | null
    handedOverAt: string | null
    canceledAt: string | null
  }
  items: DeliveryOrderItem[]
}

export interface DeliveryOrderMutationData {
  success: true
  order: {
    id: string
    status: DeliveryOrderStatus
    statusLabel: string
    updatedAt: string | null
  }
}

export interface DeliveryHistoryOrder {
  id: string
  service: DeliveryService
  serviceLabel: string
  orderNumber: string
  status: DeliveryOrderStatus
  statusLabel: string
  totalAmount: number
  itemCount: number
  itemSummary: string
  cancelReasonCode: DeliveryCancelReasonCode | null
  receivedAt: string | null
  handedOverAt: string | null
}

export interface DeliveryHistoryData {
  success: true
  range: { from: string; to: string }
  filter: { service: DeliveryService | null; status: DeliveryOrderStatus | null }
  /**
   * D-4の集計帯。件数と売上はキャンセル・拒否を除く（足もとの件数と同じ数え方）。
   * キャンセルは canceledCount に分けて届く。
   */
  totals: {
    count: number
    amount: number
    canceledCount: number
    byService: Array<{
      service: DeliveryService
      label: string
      count: number
      amount: number
    }>
  }
  orders: DeliveryHistoryOrder[]
}

export interface DeliveryMenuItem {
  id: string
  version?: number
  target?: string | null
  name: string
  category: string | null
  price: number
  soldOut: boolean
  soldOutAt: string | null
  services: Array<{ service: DeliveryService; label: string }>
}

export interface DeliveryMenuItemsData {
  success: true
  store: { id: string; name: string }
  items: DeliveryMenuItem[]
}

export interface DeliveryBulkSoldOutData {
  success: true
  soldOut: boolean
  updated: string[]
  failed: Array<{ id: string; name: string; code: string; retryable: boolean }>
  skipped: Array<{ id: string; name: string }>
}

export interface DeliveryIntakeStopData {
  success: true
  preset: DeliveryIntakeStopPreset
  stopUntil: string | null
  stopped: DeliveryService[]
  failed: Array<{ service: DeliveryService; code: string; retryable: boolean }>
}

export interface DeliveryIntakeResumeData {
  success: true
  resumed: DeliveryService[]
  failed: Array<{ service: DeliveryService; code: string; retryable: boolean }>
}

/** Uber Eats 接続の型は `restaurant-delivery-ubereats-types` にある（ここから出し直す）。 */
export type {
  UberConnectionStatus,
  UberConnection,
  UberConnectionData,
  UberConnectionMutationData,
  UberStoresData,
  UberStoreSelectData,
  UberConnectStartData,
} from './restaurant-delivery-ubereats-types'
export { isUberConnectionMutationData } from './restaurant-delivery-ubereats-types'

function withAccount(
  path: string,
  accountId: string,
  params: Record<string, string | undefined> = {},
): string {
  const search = new URLSearchParams({ account_id: accountId })
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, value)
  }
  return `${path}?${search.toString()}`
}

export const restaurantDeliveryApi = {
  /** D-1 `kDQHr` 注文一覧（サービスカード・KPI・タブ・一覧）。 */
  orders(
    accountId: string,
    params: { tab?: DeliveryOrderTab; service?: DeliveryService } = {},
  ): Promise<DeliveryOrdersData> {
    return fetchApi<DeliveryOrdersData>(
      withAccount(`${BASE}/orders`, accountId, { tab: params.tab, service: params.service }),
    )
  },

  /** D-2 `hjdqV` 注文の詳細。 */
  order(accountId: string, id: string): Promise<DeliveryOrderDetailData> {
    return fetchApi<DeliveryOrderDetailData>(
      withAccount(`${BASE}/orders/${encodeURIComponent(id)}`, accountId),
    )
  },

  accept(accountId: string, id: string, expectedVersion?: number): Promise<DeliveryOrderMutationData> {
    return fetchApi<DeliveryOrderMutationData>(
      withAccount(`${BASE}/orders/${encodeURIComponent(id)}/accept`, accountId),
      { method: 'POST', body: JSON.stringify({ expectedVersion }) },
    )
  },

  ready(accountId: string, id: string, expectedVersion?: number): Promise<DeliveryOrderMutationData> {
    return fetchApi<DeliveryOrderMutationData>(
      withAccount(`${BASE}/orders/${encodeURIComponent(id)}/ready`, accountId),
      { method: 'POST', body: JSON.stringify({ expectedVersion }) },
    )
  },

  handOver(accountId: string, id: string, expectedVersion?: number): Promise<DeliveryOrderMutationData> {
    return fetchApi<DeliveryOrderMutationData>(
      withAccount(`${BASE}/orders/${encodeURIComponent(id)}/handed-over`, accountId),
      { method: 'POST', body: JSON.stringify({ expectedVersion }) },
    )
  },

  reject(accountId: string, id: string, expectedVersion?: number): Promise<DeliveryOrderMutationData> {
    return fetchApi<DeliveryOrderMutationData>(
      withAccount(`${BASE}/orders/${encodeURIComponent(id)}/reject`, accountId),
      { method: 'POST', body: JSON.stringify({ expectedVersion }) },
    )
  },

  /** D-3 `dgeTy` キャンセル。取り消せないので確認の印を必ず付ける。 */
  cancel(
    accountId: string,
    id: string,
    reasonCode: DeliveryCancelReasonCode,
    expectedVersion?: number,
  ): Promise<DeliveryOrderMutationData> {
    return fetchApi<DeliveryOrderMutationData>(
      withAccount(`${BASE}/orders/${encodeURIComponent(id)}/cancel`, accountId),
      {
        method: 'POST',
        body: JSON.stringify({ reason_code: reasonCode, expectedVersion }),
        headers: { 'x-confirm-irreversible': CANCEL_CONFIRM_TOKEN },
      },
    )
  },

  /** D-4 `OzHLO` 注文履歴・売上。 */
  history(
    accountId: string,
    params: {
      from?: string
      to?: string
      service?: DeliveryService
      status?: DeliveryOrderStatus
    } = {},
  ): Promise<DeliveryHistoryData> {
    return fetchApi<DeliveryHistoryData>(
      withAccount(`${BASE}/history`, accountId, {
        from: params.from,
        to: params.to,
        service: params.service,
        status: params.status,
      }),
    )
  },

  /**
   * D-4 「CSVで保存」。`<a href>` で直接開くと Cookie だけに頼ることになるので、
   * 認証付きで取ってから保存する（TECH-03）。上限で切れたかどうかも返る。
   */
  historyCsv(
    accountId: string,
    params: {
      from?: string
      to?: string
      service?: DeliveryService
      status?: DeliveryOrderStatus
    } = {},
  ): Promise<{ totalCount: number | null; returnedCount: number | null; truncated: boolean }> {
    return downloadApiFile(
      withAccount(`${BASE}/history.csv`, accountId, {
        from: params.from,
        to: params.to,
        service: params.service,
        status: params.status,
      }),
      'delivery-orders.csv',
    )
  },

  /** D-5 `h7OeT` 品切れ一括設定の商品一覧。絞り込みと並べ替えは画面側で行う。 */
  menuItems(accountId: string): Promise<DeliveryMenuItemsData> {
    return fetchApi<DeliveryMenuItemsData>(withAccount(`${BASE}/menu-items`, accountId))
  },

  bulkSoldOut(
    accountId: string,
    itemIds: string[],
    soldOut: boolean,
    confirmation?: { expectedStoreId: string; expectedItems: Array<{ id: string; version: number; target: string }> },
  ): Promise<DeliveryBulkSoldOutData> {
    return fetchApi<DeliveryBulkSoldOutData>(
      withAccount(`${BASE}/menu-items/bulk-sold-out`, accountId),
      { method: 'POST', body: JSON.stringify({ item_ids: itemIds, sold_out: soldOut, ...confirmation }) },
    )
  },

  /** D-6 `XCVGd` 受付の一括停止。取り消せないので確認の印を付ける。 */
  stopIntake(
    accountId: string,
    services: DeliveryService[],
    preset: DeliveryIntakeStopPreset,
    confirmation?: { expectedStoreId: string; expectedStates: Array<{ service: DeliveryService; version: number; target: string }> },
  ): Promise<DeliveryIntakeStopData> {
    return fetchApi<DeliveryIntakeStopData>(withAccount(`${BASE}/intake/stop`, accountId), {
      method: 'POST',
      body: JSON.stringify({ services, preset, ...confirmation }),
      headers: { 'x-confirm-irreversible': INTAKE_STOP_CONFIRM_TOKEN },
    })
  },

  resumeIntake(accountId: string, services: DeliveryService[]): Promise<DeliveryIntakeResumeData> {
    return fetchApi<DeliveryIntakeResumeData>(withAccount(`${BASE}/intake/resume`, accountId), {
      method: 'POST',
      body: JSON.stringify({ services }),
    })
  },

  /**
   * DL-1 `dF4Ov` Uber Eats 接続の今の状態。画面を開いたときに読む。
   * 見るのはこちらのD1だけで、Uber へは問い合わせない。
   */
  ubereatsConnection(accountId: string): Promise<UberConnectionData> {
    return fetchApi<UberConnectionData>(withAccount(`${BASE}/ubereats/connection`, accountId))
  },

  /** Uber 側の店舗を読み、保存済みの接続状態を確かめ直す。 */
  ubereatsCheckConnection(accountId: string): Promise<UberConnectionMutationData> {
    return fetchApi<UberConnectionMutationData>(withAccount(`${BASE}/ubereats/connection/check`, accountId), {
      method: 'POST',
      body: '{}',
    })
  },

  /** 確認窓で明示的に確定したときだけ、Uber Eats の接続を解除する。 */
  ubereatsDisconnect(accountId: string, expectedVersion?: number): Promise<UberConnectionMutationData> {
    return fetchApi<UberConnectionMutationData>(withAccount(`${BASE}/ubereats/connection`, accountId), {
      method: 'DELETE',
      body: JSON.stringify({ confirmed: true, ...(expectedVersion === undefined ? {} : { expectedVersion }) }),
    })
  },

  /**
   * DL-1 `dF4Ov`「Uber Eats にログインしてつなぐ」。
   * 返った `authorizeUrl` へ画面をそのまま移す。鍵や秘密は画面を通らない。
   */
  ubereatsConnectStart(accountId: string): Promise<UberConnectStartData> {
    return fetchApi<UberConnectStartData>(
      withAccount(`${BASE}/ubereats/connect/start`, accountId),
      { method: 'POST', body: '{}' },
    )
  },

  /**
   * DL-4 `X5d8UF`「つなぐお店を選んでください」の候補。
   * Uber へ問い合わせるので、選び口を開くときだけ呼ぶ（画面を開くたびには呼ばない）。
   */
  ubereatsStores(accountId: string): Promise<UberStoresData> {
    return fetchApi<UberStoresData>(withAccount(`${BASE}/ubereats/stores`, accountId))
  },

  /**
   * DL-4 `X5d8UF`「このお店につなぐ」。ここで Uber 側の連携が有効になる。
   * 結果が分からないまま押し直すと連携が重なるため、自動では送り直さない。
   */
  ubereatsSelectStore(accountId: string, storeId: string): Promise<UberStoreSelectData> {
    return fetchApi<UberStoreSelectData>(withAccount(`${BASE}/ubereats/stores/select`, accountId), {
      method: 'POST',
      body: JSON.stringify({ storeId }),
    })
  },
}
