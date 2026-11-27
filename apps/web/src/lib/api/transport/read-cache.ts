import { LIST_REQUEST_TIMEOUT_MS } from '../../request-timeout'

const REUSE_MS = 30_000
const reusablePaths = new Set([
  '/api/line-accounts',
  '/api/operators',
  '/api/staff/me',
  '/api/tenants/me',
  '/api/settings/features',
  '/api/settings/features/visibility',
  '/api/dashboard/style',
  '/api/hq/billing/summary',
])

type ReadEntry = { promise: Promise<unknown>; expiresAt: number; path: string }
const reads = new Map<string, ReadEntry>()
let activeScope: string | undefined
let generation = 0

export function apiReadCacheGeneration(): number { return generation }

/** ログイン・店舗・保存の世代をまたいで、古い応答を再登録しない。 */
export function clearApiReadCache(): void {
  reads.clear()
  generation++
}

export function invalidateApiReads(prefix: string, accountId?: string): void {
  // ETag の互換口にも、部分的な失効を伝える。
  generation++
  for (const [key, entry] of reads) {
    const url = new URL(entry.path, 'https://request.invalid')
    const matchesAccount = !accountId || ['account_id', 'accountId', 'line_account_id', 'lineAccountId']
      .some(name => url.searchParams.get(name) === accountId)
    if (matchesAccount && (url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))) reads.delete(key)
  }
}

export function synchronizeApiReadScope(scope: string): void {
  if (activeScope !== scope) {
    clearApiReadCache()
    activeScope = scope
  }
}

export function canonicalApiPath(path: string): string {
  const url = new URL(path, 'https://request.invalid')
  // 同名の複数値の順序は維持する。異なるキーの並びだけを正規化する。
  url.searchParams.sort()
  return `${url.pathname}${url.search}`
}

/** 手動の読み直しは取得中の便にも相乗りしない。失敗は保存しない。 */
export function shareApiRead<T>(path: string, key: string, load: () => Promise<T>, reload: boolean, noStore = false): Promise<T> {
  const now = Date.now()
  for (const [oldKey, entry] of reads) {
    if (entry.expiresAt <= now) reads.delete(oldKey)
  }
  if (reload) reads.delete(key)
  let entry = reads.get(key)
  if (!entry) {
    const promise = load()
    entry = { promise, expiresAt: now + LIST_REQUEST_TIMEOUT_MS, path }
    reads.set(key, entry)
    const current = entry
    const forget = () => { if (reads.get(key) === current) reads.delete(key) }
    void promise.then(response => {
      if (reads.get(key) !== current) return
      // 表示側が時間切れとした便を、再試行や後着の成功で復活させない。
      if (current.expiresAt <= Date.now()) { forget(); return }
      const successful = response && typeof response === 'object' && 'success' in response
        && response.success === true && 'data' in response
      const url = new URL(path, 'https://request.invalid')
      // 接続の実確認は、同じ一覧でも保存済み表示とは分ける。
      if (!successful || noStore || !reusablePaths.has(url.pathname) || url.searchParams.get('live') === '1') forget()
      else current.expiresAt = Date.now() + REUSE_MS
    }, forget)
  }
  // 表示用の並べ替え・加工が、別の利用者や保存済みの答えへ伝わらない。
  return (entry.promise as Promise<T>).then(response => structuredClone(response))
}

/**
 * 認証確認と並列に始めた取得を、認証確定後の現行スコープへ引き継ぐ。
 * すでに同キーの便がある場合は上書きせず、失敗・非成功・時間切れは覚えない。
 */
export function adoptApiRead<T>(path: string, key: string, promise: Promise<T>, startedAt: number, settledOk = false): void {
  const now = Date.now()
  if (startedAt + LIST_REQUEST_TIMEOUT_MS <= now) return
  for (const [oldKey, entry] of reads) {
    if (entry.expiresAt <= now) reads.delete(oldKey)
  }
  if (reads.has(key)) return
  const url = new URL(path, 'https://request.invalid')
  if (!reusablePaths.has(url.pathname) || url.searchParams.get('live') === '1') return
  if (settledOk) {
    const expiresAt = startedAt + REUSE_MS
    if (expiresAt <= now) return
    reads.set(key, { promise, expiresAt, path })
    return
  }
  const entry: ReadEntry = { promise, expiresAt: startedAt + LIST_REQUEST_TIMEOUT_MS, path }
  reads.set(key, entry)
  const forget = () => { if (reads.get(key) === entry) reads.delete(key) }
  void promise.then(response => {
    if (reads.get(key) !== entry) return
    if (entry.expiresAt <= Date.now()) { forget(); return }
    const successful = response && typeof response === 'object' && 'success' in response
      && response.success === true && 'data' in response
    if (!successful) forget()
    else entry.expiresAt = Date.now() + REUSE_MS
  }, forget)
}
