import type { StatusBadgeTone } from '@/components/shared/status-badge'
import type { UberConnection, UberConnectionData, UberConnectionStatus } from '@/lib/restaurant-delivery-api'

/**
 * ★V8-B 設定 › デリバリー連携（★承認済み `デリバリー連携_v04.pen` 2026-10-18）の
 * 3社の並び・文章・状態の読み替え。画面本体（`delivery.tsx`）から切り出した入れ物。
 *
 * ここには絵を描く部分（JSX）は置かない。画面本体はこのファイルから読み込む。
 * 試験や呼び出し側はこれまでどおり `./delivery` からも読める（同じ名前で出し直している）。
 */

export type DeliveryStatus = 'disconnected' | 'connected' | 'error' | 'applying'

export const STATUS: Record<DeliveryStatus, { label: string; tone: StatusBadgeTone }> = {
  disconnected: { label: '未接続', tone: 'neutral' },
  connected: { label: '接続中', tone: 'success' },
  error: { label: '接続エラー', tone: 'danger' },
  applying: { label: '申し込み受付中', tone: 'warning' },
}

/** つなぐお店の候補。各社のログインから戻ったあと、サーバ経由で受け取る並び。 */
export type DeliveryStore = { id: string; name: string; address: string }

export type DeliveryService = {
  id: 'uber' | 'demaecan' | 'rocketnow'
  name: string
  /** 段の説明（題のすぐ下） */
  sub: string
  /** つなぎ方。login＝各社のログインで繋ぐ／apply＝musubo が申し込みを代行する */
  connect: 'login' | 'apply'
  /** つなぐ手順の案内（真珠色の囲み） */
  guide: string
  /** 返事が来てつなげるようになった会社だけ true。false の間はボタンを押せない。 */
  ready: boolean
  status: DeliveryStatus
  /** つないだお店の名前（接続中・接続エラーのとき） */
  storeName?: string
  connectedAt?: string
  checkedAt?: string
  connectionVersion?: number
  appliedAt?: string
  /** 状態の下へ出す帯（`OIY4Z` の Notice）。接続エラー・申し込み受付中・ログイン直後に使う。 */
  stateNote?: string
  /** 帯の色。既定は状態まかせ（接続エラーだけ赤）。ログインから戻った知らせはここで指定する。 */
  stateNoteTone?: 'warn' | 'danger'
  /** 各社のログインで許可されたお店の一覧（`X5d8UF` の選び口に出す） */
  stores?: DeliveryStore[]
  /** 外部側の結果が未確定で、安全な照合も重ねてはいけない状態。 */
  connectionCheckBlocked?: boolean
  /** 外部側の結果が未確定で、解除を重ねてはいけない状態。 */
  connectionDisconnectBlocked?: boolean
  /** 加盟店の認可を更新する必要があり、再ログインの入口を出す状態。 */
  needsReauthorization?: boolean
}

/**
 * 会社の名前のうしろに「で」「に」などを足す。
 * 英数字で終わる名前（Uber Eats）のあとだけ半角の空きを入れ、日本語の名前（出前館）はそのまま続ける。
 * 承認案の文（「Uber Eats での許可を…」「Uber Eats の連携を…」）と、
 * 数字の単位の決まり（`docs/v8-design-rules.md`「単位は数字の後ろに半角の空き」）に合わせる。
 */
export function withParticle(name: string, particle: string): string {
  return /[0-9A-Za-z]$/.test(name) ? `${name} ${particle}` : `${name}${particle}`
}

/** つなぐボタンの名札。解除の窓の案内文でも同じ言い方を使う。 */
export function connectLabel(service: DeliveryService): string {
  return service.connect === 'login' ? `${withParticle(service.name, 'に')}ログインしてつなぐ` : '連携を申し込む'
}

/**
 * 3社の並びと文章。承認案 `dF4Ov` のとおり Uber Eats ／ 出前館 ／ ロケットナウ の順。
 * 状態と日付は、各社の返事が来てつなぎ込んだときにサーバから受け取る。
 */
export const SERVICES: DeliveryService[] = [
  {
    id: 'uber',
    name: 'Uber Eats',
    sub: 'Uber Eats への接続を設定します。注文の連携は受注画面で確認します',
    connect: 'login',
    guide:
      'ボタンを押すと Uber Eats のログイン画面が開きます。ふだんお使いの Uber Eats のIDでログインし、「許可」を押してください。そのあと、つなぐお店を選ぶ画面に戻ります。',
    // Uber Eats だけ受け口がつながっている。この環境に接続の設定が無い場合は
    // サーバの返事（oauthConfigured）で false に戻し、押させない。
    ready: true,
    status: 'disconnected',
  },
  {
    id: 'demaecan',
    name: '出前館',
    sub: '出前館に入った注文を、この画面へ取り込みます',
    connect: 'apply',
    guide:
      '出前館への連携はまだ始まっていません。',
    ready: false,
    status: 'disconnected',
  },
  {
    id: 'rocketnow',
    name: 'ロケットナウ',
    sub: 'ロケットナウに入った注文を、この画面へ取り込みます',
    connect: 'apply',
    guide:
      'ロケットナウへの連携はまだ始まっていません。',
    ready: false,
    status: 'disconnected',
  },
]

/** 返事を待っている間、押せないボタンに添える説明。 */
export const WAITING = 'いま musubo が各デリバリーサービスへ連携のお手続きを進めています。できるようになり次第、この画面からつなげます。'

/** 状態の下へ出す帯の中身。 */
type StateNote = { text: string; tone: 'warn' | 'danger' }

/**
 * サーバが持つ Uber の状態を、承認済みの4つの札（未接続・接続中・接続エラー・申し込み受付中）へ移す。
 * `pending_store` はまだ注文が入らないので「未接続」。札は増やさず、下の帯で続きを伝える。
 */
export const UBER_DESIGN_STATUS: Record<UberConnectionStatus, DeliveryStatus> = {
  disconnected: 'disconnected',
  pending_store: 'disconnected',
  connected: 'connected',
  expired: 'error',
  no_permission: 'error',
}

/** サーバの状態そのものを説明する帯。 */
export const UBER_STATE_NOTE: Partial<Record<UberConnectionStatus, StateNote>> = {
  pending_store: {
    // 承認案 `X5d8UF` の選び口がつながったので、続きはお店自身で選べる。
    text: 'Uber Eats へのログインは受け取りました。続けて、下のボタンから「つなぐお店」を選んでください。選び終わると、この段が「接続中」に変わります。',
    tone: 'warn',
  },
  expired: {
    text: 'Uber Eats へのログインの期限が切れました。「Uber Eats にログインし直す」から、もう一度許可してください。完了後に接続を確かめてください。',
    tone: 'danger',
  },
  no_permission: {
    text: 'Uber Eats 側の接続の許可が外れています。musubo が Uber Eats へ確認します。',
    tone: 'danger',
  },
}

/**
 * Uber から戻ったときの `?ubereats=` の符号。サーバは分類済みの符号だけを載せる
 * （自由文・鍵・トークンは載らない）。ここでお店向けの言い方へ直す。
 */
const UBER_RETURN_NOTE: Record<string, StateNote> = {
  pending_store: UBER_STATE_NOTE.pending_store as StateNote,
  reauthorized: { text: 'Uber Eats へのログインを更新しました。接続を確かめたあと、必要な操作をもう一度行ってください。', tone: 'warn' },
  'error:denied': { text: 'Uber Eats の画面で「許可」が押されなかったため、つなげませんでした。もう一度お試しください。', tone: 'danger' },
  'error:invalid_state': { text: 'ログインの受け付けから時間が経ちすぎたため、やり直しが必要です。もう一度ボタンを押してください。', tone: 'danger' },
  'error:store_missing': { text: 'このLINEアカウントにお店が紐付いていないため、つなげませんでした。musubo へお知らせください。', tone: 'danger' },
  'error:oauth_not_configured': { text: 'musubo 側の接続の設定が足りないため、つなげませんでした。musubo が設定を確認します。', tone: 'danger' },
  'error:encryption_key_missing': { text: 'musubo 側の設定が足りないため、つなげませんでした。musubo が設定を確認します。', tone: 'danger' },
  'error:token_exchange_failed': { text: 'Uber Eats との通信に失敗したため、つなげませんでした。少し待ってからもう一度お試しください。', tone: 'danger' },
}

/** 表に無い符号（Uber 側の分類）も、言い方を決めて出す。符号そのものは画面に出さない。 */
function uberReturnNote(flash: string): StateNote | undefined {
  if (flash === '') return undefined
  const known = UBER_RETURN_NOTE[flash]
  if (known) return known
  if (flash.startsWith('error:')) {
    return { text: 'Uber Eats とのつなぎを完了できませんでした。もう一度お試しください。続くときは musubo へお知らせください。', tone: 'danger' }
  }
  return undefined
}

/** 確定した接続状態を、画面の1段ぶんの書き換えへ直す。 */
export function uberConnectionPatch(connection: UberConnection, flash = ''): Partial<DeliveryService> {
  const activationUnresolved = connection.lastError === 'pos_activation_started' || connection.lastError === 'pos_activation_unknown'
  const deactivationUnresolved = connection.lastError === 'pos_deactivation_started' || connection.lastError === 'pos_deactivation_unknown'
  const storeReviewRequired = connection.lastError === 'store_provision_review_required'
    || connection.lastError === 'store_menu_refresh_review_required'
  const disconnectReauthorizationPending = connection.lastError === 'pos_disconnect_reauthorization_pending'
  if (activationUnresolved || deactivationUnresolved || storeReviewRequired || disconnectReauthorizationPending) {
    return {
      ready: false,
      connectionVersion: connection.version ?? undefined,
      status: 'error',
      connectionCheckBlocked: deactivationUnresolved,
      connectionDisconnectBlocked: true,
      needsReauthorization: false,
      // 接続開始前の保存値は依頼時の写し。保存済み接続の要確認状態は確認用に残す。
      storeName: deactivationUnresolved || storeReviewRequired || disconnectReauthorizationPending ? connection.storeName ?? undefined : undefined,
      connectedAt: deactivationUnresolved || storeReviewRequired || disconnectReauthorizationPending ? connection.connectedAt ?? undefined : undefined,
      checkedAt: connection.checkedAt ?? undefined,
      stateNote: deactivationUnresolved
        ? '連携を解除した結果を確認する必要があります。操作を繰り返さず musubo へお知らせください。'
        : disconnectReauthorizationPending
          ? 'Uber Eats へのログインを更新しました。「接続を確かめる」で状態を確認してください。確認後、必要ならもう一度解除してください。'
        : storeReviewRequired
          ? 'Uber Eats 側の接続状態を確認する必要があります。「接続を確かめる」で確認し、解消しない場合は musubo へお知らせください。'
        : 'お店をつないだ結果を確認する必要があります。送り直さず musubo へお知らせください。',
      stateNoteTone: 'danger',
    }
  }
  const note = uberReturnNote(flash) ?? UBER_STATE_NOTE[connection.status]
  return {
    connectionVersion: connection.version ?? undefined,
    connectionCheckBlocked: false,
    connectionDisconnectBlocked: connection.status === 'expired',
    needsReauthorization: connection.status === 'expired',
    status: UBER_DESIGN_STATUS[connection.status],
    storeName: connection.storeName ?? undefined,
    connectedAt: connection.connectedAt ?? undefined,
    checkedAt: connection.checkedAt ?? undefined,
    stateNote: note?.text,
    stateNoteTone: note?.tone,
  }
}

/** サーバから読んだ接続状態と環境のOAuth設定を、画面の1段へ反映する。 */
export function uberPatch(data: UberConnectionData, flash: string): Partial<DeliveryService> {
  return {
    // この環境に接続の設定が無ければ押させない。
    ready: data.oauthConfigured,
    // 外部側の結果が未確定なら、OAuth設定があっても再送操作は止める。
    ...uberConnectionPatch(data.connection, flash),
  }
}
