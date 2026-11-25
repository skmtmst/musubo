import { responseApiError } from './errors'
import { apiAccountContext, clearReportedPathFailures, reportServerFailure, isSessionLostExempt, announceFeatureDisabled } from './request'
import { fetchWithNetworkMessage, extractApiErrorCode } from './errors'
import { API_URL } from './session'
import { adminSessionHeaders } from '../../admin-session'
import type { ApiAccountEventDetail } from '../types/transport'
import { SESSION_LOST_EVENT } from '../../session-events'
import { csvFileName } from '../../csv-file-name'

export async function fetchApiBlob(path: string, init?: { method?: string; accountId?: string | null; body?: string }): Promise<Blob> {
  const method = (init?.method ?? 'GET').toUpperCase()
  const context = apiAccountContext(path, init)
  const reportDetail = {
    method,
    accountId: context.accountId,
    accountIds: context.accountIds,
    explicitNullAccount: init?.accountId === null,
  }
  const res = await fetchWithNetworkMessage(`${API_URL}${path}`, {
    method,
    credentials: 'include',
    headers: { ...adminSessionHeaders(), ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init?.body,
  })
  if (!res.ok) {
    const raw = await res.text()
    const code = extractApiErrorCode(raw)
    if (res.status >= 500) reportServerFailure(path, res.status, { ...reportDetail, code, raw })
    // fetchApi と同じく、業務コード付き401（再認証など）では合図を出さない。
    if (res.status === 401 && typeof window !== 'undefined' && !isSessionLostExempt(code)) {
      window.dispatchEvent(new CustomEvent<ApiAccountEventDetail>(SESSION_LOST_EVENT, { detail: context }))
    }
    announceFeatureDisabled(res.status, code, raw, context)
    throw responseApiError(res, raw, code, undefined)
  }
  clearReportedPathFailures(path, method, reportDetail)
  return res.blob()
}

/**
 * 認証付きでファイルを取り、ブラウザの保存へ渡す。
 *
 * `<a href>` で API の URL を直開きすると Cookie にしか頼れない。
 * サイトをまたぐ Cookie が止められる構成（Bearer 補完経路）や、
 * 管理画面と API のオリジンが違う配置では 401/404 になってしまう。
 * fetchApi と同じ資格情報（Cookie + Bearer 補完）で取ってから Blob で
 * 保存すれば、どの認証経路でも同じ許可だけが通る（TECH-03）。
 * ファイル名はサーバーの Content-Disposition を優先し、無いときだけ
 * fallbackFilename を使う。
 */
/**
 * R495: 上限で切れたCSVを見分けるため、応答の頭の件数も返す。
 * 既存の呼び出しは戻り値を使わないので、そのまま動く。
 */
export async function downloadApiFile(
  path: string,
  fallbackFilename: string,
  options?: { stepUpToken?: string; accountId?: string | null; headers?: HeadersInit },
): Promise<{
  totalCount: number | null
  returnedCount: number | null
  truncated: boolean
}> {
  const context = apiAccountContext(path, options)
  const reportDetail = {
    method: 'GET',
    accountId: context.accountId,
    accountIds: context.accountIds,
    explicitNullAccount: options?.accountId === null,
  }
  const res = await fetchWithNetworkMessage(`${API_URL}${path}`, {
    credentials: 'include',
    headers: {
      ...adminSessionHeaders(),
      ...(options?.stepUpToken ? { 'X-Step-Up-Token': options.stepUpToken } : {}),
      ...options?.headers,
    },
  })
  if (!res.ok) {
    const raw = await res.text()
    const code = extractApiErrorCode(raw)
    if (res.status >= 500) reportServerFailure(path, res.status, { ...reportDetail, code, raw })
    // fetchApi と同じく、業務コード付き401（再認証など）では合図を出さない。
    if (res.status === 401 && typeof window !== 'undefined' && !isSessionLostExempt(code)) {
      window.dispatchEvent(new CustomEvent<ApiAccountEventDetail>(SESSION_LOST_EVENT, { detail: context }))
    }
    announceFeatureDisabled(res.status, code, raw, context)
    throw responseApiError(res, raw, code, undefined)
  }
  clearReportedPathFailures(path, 'GET', reportDetail)
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1]
  const numericHeader = (name: string): number | null => {
    const raw = res.headers.get(name)
    if (raw === null) return null
    const value = Number(raw)
    return Number.isInteger(value) && value >= 0 ? value : null
  }
  const totalCount = numericHeader('X-Csv-Total-Count')
  const returnedCount = numericHeader('X-Csv-Returned-Count')
  const truncated = res.headers.get('X-Csv-Truncated') === '1'
    || (totalCount !== null && returnedCount !== null && totalCount > returnedCount)
  const blob = await res.blob()
  const href = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = href
    const exportActor = res.headers.get('X-Exported-By') ?? ''
    const exportedAt = res.headers.get('X-Exported-At') ?? ''
    const stamped = /^[A-Za-z0-9_-]{1,100}$/.test(exportActor)
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(exportedAt)
      && Number.isFinite(Date.parse(exportedAt))
    const csvName = csvFileName(fallbackFilename, stamped ? new Date(exportedAt) : undefined)
    anchor.download = /\.csv$/i.test(fallbackFilename)
      ? stamped ? `${csvName.slice(0, -4)}-by-${exportActor}-${exportedAt.replace(/[^0-9TZ]/g, '')}.csv` : csvName
      : named ? decodeURIComponent(named) : fallbackFilename
    anchor.click()
  } finally {
    URL.revokeObjectURL(href)
  }
  return { totalCount, returnedCount, truncated }
}
