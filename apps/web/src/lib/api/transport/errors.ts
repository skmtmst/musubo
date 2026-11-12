import { readApiError } from '@line-crm/shared'
import type { ApiFieldErrors } from '@line-crm/shared'

/**
 * Non-2xx API responses. message prefers the reason the Worker sent, falling
 * back to the legacy `API error: <status>` shape (existing catch blocks render
 * e.message), while `status` lets callers branch on the code without parsing
 * the string.
 */
export class ApiError extends Error {
  /** useFormErrors のサーバー側の検証結果として渡す欄ごとの理由。 */
  readonly fields: ApiFieldErrors
  readonly status: number
  readonly code: string | undefined
  /** 409などで画面を最新状態へ描き直すための機械データ。利用者へ直接表示しない。 */
  readonly data: unknown
  /**
   * 追跡番号（incidentId / requestId）。失敗の問い合わせに使う番号で、
   * 画面は「（追跡番号 …）」として添える（要件 管理画面-34 §9-1）。
   */
  readonly trackingId: string | undefined
  readonly requestId: string | undefined
  /**
   * 429などでサーバーが返す待ち秒数（`Retry-After` 応答ヘッダ由来）。
   * 無い応答では `undefined`——画面は秒数なしの待ち案内にするだけ。
   */
  readonly retryAfterSeconds: number | undefined

  constructor(status: number, message?: string, code?: string, data?: unknown, trackingId?: string, retryAfterSeconds?: number, fields: ApiFieldErrors = {}) {
    super(message || `API error: ${status}`)
    this.name = 'ApiError'
    this.fields = fields
    this.status = status
    this.code = code
    this.data = data
    this.trackingId = trackingId
    this.requestId = trackingId
    this.retryAfterSeconds = retryAfterSeconds
  }
}

/**
 * `Retry-After` 応答ヘッダを待ち秒数にする（m23m）。
 *
 * 秒数と日時の両方を受け、1〜3600秒に丸める。0以下・読めない値・
 * 過ぎた日時は `undefined`（画面は秒数なしの待ち案内にする）。
 */
/**
 * 通信断の1行（R506系）。
 *
 * fetch が通信の失敗で投げるのは英語の TypeError（`Failed to fetch` など）で、
 * そのまま画面へ出すと運用者に意味が通じない。ここで日本語にして投げ直す。
 * 画面は `err.message` をそのまま出せる（英語の検証文と違い、運用者の言葉）。
 */
export const NETWORK_FAILURE_MESSAGE = '通信できませんでした。接続を確かめて、もう一度お試しください。'

export async function fetchWithNetworkMessage(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init)
  } catch (error) {
    // 中断（AbortError・DOMException）は打ち切り合図なので、そのまま通す。
    // 時間切れの打ち切りを失敗と数えないため（`use-server-list` の約束）。
    if (error instanceof TypeError) throw new Error(NETWORK_FAILURE_MESSAGE)
    throw error
  }
}

export function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (value === null) return undefined
  const text = value.trim()
  if (!text) return undefined
  if (/^\d+$/.test(text)) {
    const seconds = Number(text)
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return undefined
    return Math.min(seconds, 3600)
  }
  const at = Date.parse(text)
  if (Number.isNaN(at)) return undefined
  const seconds = Math.ceil((at - Date.now()) / 1000)
  if (seconds <= 0) return undefined
  return Math.min(seconds, 3600)
}

/**
 * 保存・更新が失敗した理由を、運用者の言葉で返す（WRITE-01）。
 *
 * `ApiError.message` に入るのは 400/409/422/428 の安全と判定済みの本文だけ。
 * 403・404・5xx は `API error: 500` のような内部文しか持たないので、
 * status からこちらで言葉を決める。本文をそのまま出さないのは
 * `extractApiErrorMessage` と同じ考え方。
 */
export function describeSaveFailure(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status < 500) {
      const detail = safeOperatorMessage(err.message)
      if (/[ぁ-んァ-ヶ一-龠]/u.test(detail)) return detail
    }
    switch (err.status) {
      case 401:
        return 'ログインの状態が切れています。ログインし直してから、もう一度お試しください。'
      case 403:
        return 'このLINEアカウントや権限では保存できません。'
          + '選んでいるアカウントと権限を確認してください。'
      case 404:
        return '対象が見つかりませんでした。ほかの人が削除したか、'
          + '別のLINEアカウントのデータです。一覧から開き直してください。'
      case 429:
        return '短い時間に操作が集中しました。少し待ってから、もう一度お試しください。'
      default:
        return err.status >= 500
          ? 'サーバー側で保存できませんでした。時間をおいて、もう一度お試しください。'
            + '続く場合は管理者へ連絡してください。'
          : '保存できませんでした。もう一度お試しください。'
    }
  }
  if (err instanceof Error) {
    const detail = extractApiErrorMessage(JSON.stringify({ error: err.message }), 400)
    if (/[ぁ-んァ-ヶ一-龠]/u.test(detail)) return detail
  }
  return '保存できませんでした。通信が切れている可能性があります。'
    + '接続を確かめて、もう一度お試しください。'
}

/**
 * Statuses whose response body is safe to show the operator verbatim.
 *
 * These are application-level validation or conflict responses whose message
 * tells the operator how to recover. A separate content guard below keeps
 * database, stack, HTML and other internal detail out of the screen.
 * (422 の本文は日本語の検証文のみであることを #496-11 で監査済み。)
 */
/*
 * R503: 429（入力上限など）の本文も表示対象にする。サーバーが返すのは
 * 利用者向けの回復案内だけ（内部情報は safeOperatorMessage が弾く）。
 *
 * D016: 410（招待の期限切れなど）・404（正しくないURLなど）も同じ扱いに
 * する。サーバーはこの2つに日本語の次の行動まで書いた案内を返している
 * （招待 `この招待は無効または期限切れです…`、メール変更
 * `この確認リンクは無効または期限切れです…`、URL `この URL は…`）。
 * 通さないと `API error: 410` だけになり、次に何をすればよいか分からない。
 * 403・5xx は入れない。403 の本文は機械コード中心で画面は状態別の案内を
 * 持ち、5xx の本文は内部の失敗の中身を持ちうるため。
 */
const BODY_MESSAGE_STATUSES = new Set([400, 404, 409, 410, 422, 428, 429])

const INTERNAL_ERROR_MARKERS = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/i,
  /D1_ERROR/i,
  /\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b.+\b(?:FROM|INTO|TABLE|SET)\b/is,
  /(?:stack trace|node_modules|\.tsx?:\d+|\.mjs:\d+)/i,
  /<\/?(?:html|script|body)\b/i,
  /(?:api[_ -]?key|authorization|bearer|password|secret|token)\s*[:=]/i,
]

function safeOperatorMessage(value: unknown): string {
  if (typeof value !== 'string') return ''
  const message = value.trim()
  if (!message || message.length > 240 || /^[a-z][a-z0-9_]{0,63}$/.test(message)
    || INTERNAL_ERROR_MARKERS.some((marker) => marker.test(message))) return ''
  return message
}

/**
 * Pull the human-readable reason out of an error response body.
 *
 * Without this a fixable input mistake reached the operator as
 * `API error: 500`, indistinguishable from a server fault. Bodies that are
 * not JSON (HTML error pages, proxies) are dropped rather than shown as-is.
 */
export function extractApiErrorMessage(raw: string, status: number): string {
  if (!raw || !BODY_MESSAGE_STATUSES.has(status)) return ''
  try {
    const payload = JSON.parse(raw) as { message?: unknown }
    return safeOperatorMessage(readApiError(payload).message) || safeOperatorMessage(payload?.message)
  } catch {
    // Not JSON — fall through to the status-only message.
  }
  return ''
}

/** 400/422 の欄ごとの理由だけを取り出す。古い error のみの応答も受けられる。 */
export function extractApiFieldErrors(raw: string, status: number): ApiFieldErrors {
  if (status !== 400 && status !== 422) return {}
  try {
    const fields = readApiError(JSON.parse(raw)).fields
    return Object.fromEntries(Object.entries(fields).flatMap(([key, reason]) => {
      const message = safeOperatorMessage(reason)
      return key.length > 0 && message ? [[key, message]] : []
    }))
  } catch { return {} }
}

/** 保存の catch からフォームへ渡す。ネットワークエラーなどには欄の理由はない。 */
export function getApiFieldErrors(error: unknown): ApiFieldErrors {
  return error instanceof ApiError ? error.fields : {}
}

/** 共通ApiErrorと、移行前のbody.error分岐を同じ読み取り口にする。 */
export function getApiErrorCode(error: unknown): string | undefined {
  const legacy = error !== null && typeof error === 'object' && 'body' in error ? error.body : undefined
  return readApiError(error).code ?? readApiError(legacy).code
}

/**
 * 画面分岐にだけ使う、Worker由来の機械コードを取り出す。
 *
 * 本文を利用者へ表示してよいかとは別の契約。大文字・小文字どちらの
 * SNAKE_CASEも受け取る(判定画面の `STALE_CANDIDATE` 等、#496-12)。
 * 英字始まり・英数字と `_` のみ・64文字以内に絞り、SQL・外部API・HTML
 * などの内部文言はコードとしても受け取らない。
 */
export function extractApiErrorCode(raw: string): string | undefined {
  if (!raw) return undefined
  try {
    return readApiError(JSON.parse(raw)).code
  } catch {
    // JSONでなければ機械コードも無い。
  }
  return undefined
}

/** エラー本文の `data` だけを機械処理用に保持する。本文の文言は表示契約と分ける。 */
/**
 * 失敗応答の追跡番号を取り出す。
 *
 * `incidentId`（未処理エラーは index.ts が毎回採番する）と
 * `requestId`（共通基盤 §10 の応答形式）の両方を見る。
 * 無い応答では何も返さない——画面は追跡番号を添えないだけ。
 */
export function extractApiErrorTrackingId(raw: string): string | undefined {
  if (!raw) return undefined
  try {
    return readApiError(JSON.parse(raw)).requestId
  } catch {
    return undefined
  }
}

export function extractApiErrorData(raw: string): unknown {
  if (!raw) return undefined
  try {
    const body = JSON.parse(raw) as { data?: unknown; currentVersion?: unknown; reason?: unknown }
    if (!body || typeof body !== 'object') return undefined
    if (body.data !== undefined) return body.data
    if (typeof body.reason === 'string') return { reason: body.reason }
    // 旧成果地点APIは互換性のため currentVersion を最上位で返す。
    // 409の機械データとして同じdata口へ正規化し、画面が再取得判断に使えるようにする。
    if (Number.isSafeInteger(body.currentVersion) && Number(body.currentVersion) >= 1) {
      return { currentVersion: Number(body.currentVersion) }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** HTTP応答から公開エラーを作る。本文の採用とdataの公開範囲は呼出元が決める。 */
export function responseApiError(response: Response, raw: string, code: string | undefined = extractApiErrorCode(raw), data?: unknown,
  options: { fallbackMessage?: string; retryAfterSeconds?: number; preserveBodyMessage?: boolean } = {}): ApiError {
  return new ApiError(
    response.status,
    extractApiErrorMessage(raw, options.preserveBodyMessage ? 400 : response.status) || options.fallbackMessage,
    code,
    data,
    extractApiErrorTrackingId(raw) ?? response.headers.get('X-Request-ID') ?? undefined,
    options.retryAfterSeconds ?? parseRetryAfterSeconds(response.headers.get('Retry-After')),
    extractApiFieldErrors(raw, response.status),
  )
}
