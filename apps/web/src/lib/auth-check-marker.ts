import type { SessionSnapshot } from './session-snapshot'

/*
 * 同じタブで「ログインの確認が通った」印（2026-10-08 オーナー：ページを切り替えると
 * ときどき灰色の地にくるくるだけになる）。
 *
 * 画面が丸ごと読み直される移動（新しい版が出た直後の移動・アカウントの切り替え・
 * 一部のメニューの移動）では、AuthGuard のタブ内の使い回し（30秒）が消え、
 * 別サイトの /api/auth/session の往復が終わるまで全画面のくるくるになっていた。
 *
 * この印があれば、読み直した直後でも中身を先に出し、裏で確認し直す。
 * 確認に失敗したら今までどおりログインへ送り、停止中なら停止の画面に変わる。
 *
 * - 置き場は sessionStorage（このタブだけ。閉じれば消える）
 * - 秘密は入れない。指紋（セッションの受け渡しトークン＋CSRF）はそのまま置かず、
 *   一方向の要約だけを置いて「同じログインか」を比べる
 * - 使ってよいのは、指紋が同じ・AUTH_CHECK_MARKER_TTL_MS 以内・契約が利用中のときだけ
 * - 401・別タブでのログアウト・ログアウトで捨てる（AuthGuard と lib/logout.ts）
 */
export const AUTH_CHECK_MARKER_KEY = 'lh_auth_checked'
export const AUTH_CHECK_MARKER_TTL_MS = 30 * 60_000

interface StoredMarker {
  v: 2
  at: number
  fp: string
  tenantStatus: 'active'
  snapshot: SessionSnapshot | null
  onboardingPath: string | null
}

/** 指紋の一方向の要約（cyrb53）。照合にだけ使う。元の値には戻せない。 */
export function authFingerprintTag(fingerprint: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < fingerprint.length; i += 1) {
    const ch = fingerprint.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** 確認が通ったときに呼ぶ。利用中でなければ印を残さない（停止中は毎回確かめる）。 */
export function rememberAuthCheck(
  fingerprint: string,
  tenantStatus: 'active' | 'suspended' | 'archived',
  snapshot: SessionSnapshot | null,
  onboardingPath: string | null = null,
  now: number = Date.now(),
): void {
  if (tenantStatus !== 'active') {
    forgetAuthCheck()
    return
  }
  const marker: StoredMarker = { v: 2, at: now, fp: authFingerprintTag(fingerprint), tenantStatus, snapshot, onboardingPath }
  try { sessionStorage.setItem(AUTH_CHECK_MARKER_KEY, JSON.stringify(marker)) } catch { /* storage なし：毎回確認する */ }
}

/** 印を捨てる。次に読み直したときは確認が終わるまで待つ。 */
export function forgetAuthCheck(): void {
  try { sessionStorage.removeItem(AUTH_CHECK_MARKER_KEY) } catch { /* storage なし */ }
}

/**
 * 今の指紋で使ってよい印。使えなければ null（期限切れ・指紋ちがい・壊れた値は捨てる）。
 * 返すのは「代理ログイン中か」などの帯の答えだけ（権限は localStorage が持つ）。
 */
export function readAuthCheck(fingerprint: string, now: number = Date.now()): { snapshot: SessionSnapshot | null; onboardingPath: string | null } | null {
  let raw: string | null = null
  try { raw = sessionStorage.getItem(AUTH_CHECK_MARKER_KEY) } catch { return null }
  if (!raw) return null
  let marker: Partial<StoredMarker> | null = null
  try { marker = JSON.parse(raw) as Partial<StoredMarker> } catch { marker = null }
  const usable = !!marker
    && marker.v === 2
    && typeof marker.at === 'number'
    && marker.at <= now
    && now - marker.at < AUTH_CHECK_MARKER_TTL_MS
    && marker.tenantStatus === 'active'
    && (marker.onboardingPath === null || typeof marker.onboardingPath === 'string')
    && marker.fp === authFingerprintTag(fingerprint)
  if (!usable) {
    forgetAuthCheck()
    return null
  }
  return { snapshot: marker?.snapshot ?? null, onboardingPath: marker?.onboardingPath ?? null }
}
