import { readStaffIdentity } from './staff-identity-state'

const HANDOFF_MAX_AGE_MS = 30_000
const shownInBrowserSession = new Set<string>()
let handoff: { key: string; expiresAt: number } | null = null

function welcomeKey() {
  const identity = readStaffIdentity()
  if (!identity?.id || !identity.tenantId) return null
  return `musubo:registration-welcome:${encodeURIComponent(identity.tenantId)}:${encodeURIComponent(identity.id)}`
}

function hasSeenWelcome(key: string) {
  if (shownInBrowserSession.has(key)) return true
  try { return window.localStorage.getItem(key) === '1' } catch { return false }
}

/** 同じタブで登録完了から統括へ進むときだけ、表示を引き継ぐ。 */
export function prepareRegistrationWelcome() {
  const key = welcomeKey()
  handoff = key && !hasSeenWelcome(key) ? { key, expiresAt: Date.now() + HANDOFF_MAX_AGE_MS } : null
}

/** 表示する前に確認を記録し、再登録・再読込でも表示し直さない。 */
export function consumeRegistrationWelcome() {
  const request = handoff
  handoff = null
  if (!request || Date.now() >= request.expiresAt || request.key !== welcomeKey() || hasSeenWelcome(request.key)) return false
  shownInBrowserSession.add(request.key)
  try { window.localStorage.setItem(request.key, '1') } catch { /* 保存できない場合も同じタブでは一度だけ。 */ }
  return true
}
