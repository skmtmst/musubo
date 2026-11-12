/**
 * 設定 › デリバリー連携（★承認済み デリバリー連携_v04.pen 2026-10-18
 * DL-1 `dF4Ov`／DL-2 `OIY4Z`／DL-3 `kJLks`／DL-4 `X5d8UF`）の Uber Eats 接続の型。
 *
 * `restaurant-delivery-api.ts` から切り出した型だけの入れ物。
 * 呼び出し側はこれまでどおり `restaurant-delivery-api` から読める（同じ名前で出し直している）。
 *
 * `pending_store` は「ログインは済んだが、つなぐお店をまだ選んでいない」状態。
 * 画面ではまだ「つながっていない」として出す（お店を選ぶまで注文は入らない）。
 */
export type UberConnectionStatus =
  | 'pending_store'
  | 'connected'
  | 'expired'
  | 'no_permission'
  | 'disconnected'

export interface UberConnection {
  status: UberConnectionStatus
  version?: number | null
  storeName: string | null
  connectedAt: string | null
  provisionedAt: string | null
  checkedAt: string | null
  /** 分類済みの符号だけ。Uber が返した自由文は入らない。 */
  lastError: string | null
}

export interface UberConnectionData {
  success: true
  store: { id: string; name: string }
  /** この環境に接続の設定があるか。無ければ画面はつなぐボタンを押させない。 */
  oauthConfigured: boolean
  connection: UberConnection
}

/** 接続確認と解除はOAuth設定の有無を推測せず、確定した接続状態だけを返す。 */
export interface UberConnectionMutationData {
  success: true
  connection: UberConnection
}

const UBER_CONNECTION_STATUSES = new Set<UberConnectionStatus>([
  'pending_store',
  'connected',
  'expired',
  'no_permission',
  'disconnected',
])

/** 不完全な成功応答で画面の接続状態を変えないための境界検査。 */
export function isUberConnectionMutationData(value: unknown): value is UberConnectionMutationData {
  if (!value || typeof value !== 'object') return false
  const data = value as { success?: unknown; connection?: Record<string, unknown> }
  const connection = data.connection
  const nullableString = (item: unknown) => item === null || typeof item === 'string'
  return data.success === true
    && Boolean(connection)
    && UBER_CONNECTION_STATUSES.has(connection?.status as UberConnectionStatus)
    && nullableString(connection?.storeName)
    && nullableString(connection?.connectedAt)
    && nullableString(connection?.provisionedAt)
    && nullableString(connection?.checkedAt)
    && nullableString(connection?.lastError)
}

export interface UberStoresData {
  success: true
  /** ログインした人が管理しているお店。`DeliveryStore` と同じ形で選び口へ渡す。 */
  stores: Array<{ id: string; name: string; address: string }>
}

export interface UberStoreSelectData {
  success: true
  connection: UberConnectionData['connection']
}

export interface UberConnectStartData {
  success: true
  mode: 'connect' | 'reconnect'
  /** Uber のログイン画面のURL。画面はここへそのまま移動する。 */
  authorizeUrl: string
}
