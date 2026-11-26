import { responseApiError } from './errors'
import { announceApiMutation } from './mutation-events'
import type { FeatureDisabledEventDetail, FetchApiOptions, ApiAccountEventDetail } from '../types/transport'
import { getFeatureDisabledContext } from '../../feature-disabled-context'
import { FEATURE_DISABLED_EVENT, getCsrfToken, API_URL, MUTATING_METHODS, apiReadScope } from './session'
import { adminSessionHeaders } from '../../admin-session'
import { fetchWithNetworkMessage, extractApiErrorCode, extractApiErrorData, extractUnresolvedVariableData } from './errors'
import { SESSION_LOST_EVENT } from '../../session-events'
import { canonicalApiPath, clearApiReadCache, shareApiRead, synchronizeApiReadScope } from './read-cache'

/** FEATURE_DISABLED の公開情報だけを共通 shell へ渡す。 */
export function extractFeatureDisabledDetail(raw: string): FeatureDisabledEventDetail {
  if (!raw) return {}
  try {
    const body = JSON.parse(raw) as { featureId?: unknown }
    return typeof body.featureId === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(body.featureId)
      ? { featureId: body.featureId }
      : {}
  } catch {
    return {}
  }
}

export function shouldAnnounceFeatureDisabled(status: number, code: string | undefined): boolean {
  return status === 403 && code === 'FEATURE_DISABLED'
}

/** 応答待ちの間に画面が切り替わっても、呼出元のアカウントを保持する。 */
export function apiAccountContext(path: string, options?: FetchApiOptions): ApiAccountEventDetail {
  const featureContext = getFeatureDisabledContext()
  return { ...resolveApiAccountContext(path, options), ...(featureContext ? { featureContext } : {}) }
}

function resolveApiAccountContext(path: string, options?: FetchApiOptions): ApiAccountEventDetail {
  const accountKeys = ['account_id', 'accountId', 'line_account_id', 'lineAccountId']
  const valid = (value: unknown): value is string => typeof value === 'string'
    && value.trim().length > 0 && value.length <= 256
  const single = (value: string): ApiAccountEventDetail => ({ accountId: value.trim() })
  if (options?.accountId === null) return { accountId: null }
  if (valid(options?.accountId)) return single(options.accountId)
  const query = new URL(path, 'https://request.invalid').searchParams
  for (const key of accountKeys) {
    const id = query.get(key)
    if (valid(id)) return single(id)
  }
  const headerId = new Headers(options?.headers).get('X-Line-Account-Id')
  if (valid(headerId)) return single(headerId)
  if (typeof options?.body === 'string') {
    try {
      const body: unknown = JSON.parse(options.body)
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        const input = body as Record<string, unknown>
        for (const key of accountKeys) if (valid(input[key])) return single(input[key])
        for (const key of ['accountIds', 'lineAccountIds']) {
          const value = input[key]
          if (Array.isArray(value) && value.every(valid)) {
            const ids = [...new Set(value.map(id => id.trim()))]
            return { accountId: ids.length === 1 ? ids[0]! : null, accountIds: ids }
          }
        }
      }
    } catch { /* 本文の検証はAPI側の責務。合図には秘密値・本文を載せない。 */ }
  }
  return { accountId: null }
}

export function announceFeatureDisabled(status: number, code: string | undefined, raw: string, context: ApiAccountEventDetail): void {
  if (typeof window === 'undefined' || !shouldAnnounceFeatureDisabled(status, code)) return
  window.dispatchEvent(new CustomEvent<FeatureDisabledEventDetail>(FEATURE_DISABLED_EVENT, {
    detail: { ...extractFeatureDisabledDetail(raw), ...context },
  }))
}

/*
 * 401 でも「セッションが届いていない」とは限らない業務コード（#1058）。
 *
 * 再認証（step-up）フローが返す401は、呼んだ画面（緊急操作など）が自分で
 * 6桁コードの入力やり直しを案内する通常の状態。ここで合図を出すと、
 * 画面の案内の上に閉じられないセッション喪失モーダルが被さってしまう。
 * code の無い401（認証middlewareの `Unauthorized` など）や、ここに無い
 * コードの401は、従来どおりセッション喪失として合図を出す。
 */
const SESSION_LOST_EXEMPT_CODES = new Set([
  // 緊急停止・復旧の再認証grantが未所持/期限切れ（POST /api/operations/*）
  'STEP_UP_REQUIRED',
  // POST /api/auth/step-up が staff 文脈無しで弾く保険の401
  'STEP_UP_UNAUTHORIZED',
])

/** 401 が業務コード付き＝セッション喪失ではない、なら true。 */
export function isSessionLostExempt(code: string | undefined): boolean {
  return code !== undefined && SESSION_LOST_EXEMPT_CODES.has(code)
}

export function reportServerFailure(path: string, status: number): void {
  if (typeof window === 'undefined' || path === '/api/client-errors') return
  const token = getCsrfToken()
  void (async () => {
    try {
      await fetch(`${API_URL}/api/client-errors`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...adminSessionHeaders(),
          ...(token ? { 'X-CSRF-Token': token } : {}),
        },
        body: JSON.stringify({
          message: `API ${status}: ${path}`,
          path: `${window.location.origin}${window.location.pathname}`,
          occurredAt: new Date().toISOString(),
        }),
      })
    } catch {
      // Slack報告自体の失敗で、元のAPIエラー処理を壊さない。
    }
  })()
}

export async function fetchApi<T>(path: string, options?: FetchApiOptions): Promise<T> {
  const context = apiAccountContext(path, options)
  const method = (options?.method ?? 'GET').toUpperCase()
  const load = () => requestApi<T>(path, options, context)
  if (typeof window === 'undefined') return load()
  const scope = apiReadScope()
  synchronizeApiReadScope(scope.key)
  // Cookieだけで本人の世代を識別できない間は、別ログインの答えを共有しない。
  if (!scope.identified) return load()
  if (method !== 'GET' || options?.signal) return load()
  const { headers, accountId: _accountId, method: _method, cache: _cache, suppressFeatureDisabledEvent: _suppress, ...requestOptions } = options ?? {}
  const key = JSON.stringify([method, canonicalApiPath(path), context.accountId, context.accountIds, scope.key, [...new Headers(headers)].sort(), requestOptions])
  const shared = shareApiRead(path, key, () => requestApi<T>(path, options), options?.cache === 'reload' || options?.cache === 'no-store', options?.cache === 'no-store')
  return shared.catch(error => {
    const detail = error instanceof Error ? responseEvents.get(error) : undefined
    if (detail) announceRequestFailure(detail, context, options)
    throw error
  })
}

type ResponseEvent = { status: number; code: string | undefined; feature: FeatureDisabledEventDetail }
const responseEvents = new WeakMap<Error, ResponseEvent>()

function announceRequestFailure(detail: ResponseEvent, context: ApiAccountEventDetail, options?: FetchApiOptions): void {
  if (typeof window === 'undefined') return
  if (detail.status === 401 && !isSessionLostExempt(detail.code)) {
    window.dispatchEvent(new CustomEvent<ApiAccountEventDetail>(SESSION_LOST_EVENT, { detail: context }))
  }
  if (!options?.suppressFeatureDisabledEvent && shouldAnnounceFeatureDisabled(detail.status, detail.code)) {
    window.dispatchEvent(new CustomEvent<FeatureDisabledEventDetail>(FEATURE_DISABLED_EVENT, { detail: { ...detail.feature, ...context } }))
  }
}

async function requestApi<T>(path: string, options: FetchApiOptions | undefined, context?: ApiAccountEventDetail): Promise<T> {
  const { accountId: _accountId, suppressFeatureDisabledEvent: _suppressEvent, ...requestInit } = options ?? {}
  const method = (options?.method ?? 'GET').toUpperCase()
  const csrfHeaders: Record<string, string> = {}
  if (MUTATING_METHODS.has(method)) {
    const token = getCsrfToken()
    if (token) csrfHeaders['X-CSRF-Token'] = token
  }
  /*
   * PERF-10: 本文を持たない GET/HEAD には Content-Type を付けない。
   * `application/json` は CORS の safelist 外なので、付いているだけで
   * 全 GET が preflight（OPTIONS往復）の対象になっていた。Cookie だけで
   * 認証できる環境では、このヘッダを外すと GET が「simple request」になり
   * preflight が消える。Bearer のフォールバック（Authorization）や
   * CSRF ヘッダを伴う変更系は、もともと preflight が必要なので従来どおり
   * 付ける（削っても往復は減らない）。
   */
  const isBodylessMethod = method === 'GET' || method === 'HEAD'
  const res = await fetchWithNetworkMessage(`${API_URL}${path}`, {
    ...requestInit,
    // Send the HttpOnly session cookie with every request.
    credentials: 'include',
    headers: {
      ...(isBodylessMethod ? {} : { 'Content-Type': 'application/json' }),
      ...adminSessionHeaders(),
      ...csrfHeaders,
      ...options?.headers,
    },
  })
  if (res.status >= 500) reportServerFailure(path, res.status)
  if (!res.ok) {
    const raw = await res.text()
    const code = extractApiErrorCode(raw)
    /*
     * 401 は「セッションがサーバーに届いていない」。
     *
     * 管理画面とAPIは別サイトなので、ブラウザがサイトをまたぐCookieを
     * 止めると全部のAPIがこれになる。各画面がそれぞれ「エラー」と出すだけ
     * だと、全画面が同時に壊れているのに理由がどこにも出ない。
     * 1か所で受けられるように知らせる（受け手は SessionLostNotice）。
     * STEP_UP_REQUIRED などの業務401だけは画面が自分で処理するので出さない。
     */
    if (res.status === 401 && typeof window !== 'undefined' && !isSessionLostExempt(code)) {
      clearApiReadCache()
    }
    const data = res.status === 400 && code === 'UNRESOLVED_TEMPLATE_VARIABLES'
      ? extractUnresolvedVariableData(raw)
      : res.status === 409 || res.status === 429 || res.status === 502 || res.status === 503 && code === 'invalid_saved_form'
        ? extractApiErrorData(raw) : undefined
    const error = responseApiError(res, raw, code, data)
    const detail = { status: res.status, code, feature: extractFeatureDisabledDetail(raw) }
    responseEvents.set(error, detail)
    if (context) announceRequestFailure(detail, context, options)
    throw error
  }
  if (res.status === 204) {
    if (MUTATING_METHODS.has(method)) {
      clearApiReadCache()
      announceApiMutation(path, context?.accountId ?? null, context?.accountIds)
    }
    return undefined as T
  }
  const body = await res.json() as T
  // 更新の影響は別資源の表示にも及ぶため、成功後は保守的に全読取を失効させる。
  if (MUTATING_METHODS.has(method) && !(body && typeof body === 'object' && 'success' in body && body.success === false)) {
    clearApiReadCache()
    announceApiMutation(path, context?.accountId ?? null, context?.accountIds)
  }
  return body
}
