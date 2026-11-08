import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { rememberStaffIdentity, forgetStaffIdentity, readStaffIdentity, subscribeStaffIdentity, staffIdentityGeneration } from './staff-identity-state'
import type { StaffMember } from '@line-crm/shared'
import { SESSION_LOST_EVENT } from './session-events'
import { api } from '@/lib/api'

/** 役割だけで管理者に限定する操作。機能を任されたstaffの操作は別の鍵で判定する。 */
export function canManageRole(role: string | null | undefined): boolean {
  if (role === 'owner' || role === 'admin') return true
  const identity = readStaffIdentity()
  return role === 'staff' && identity?.role === 'staff' && identity.hqRole === 'operator' && !identity.readOnly
}

/** メンバー管理・契約・決済を変更できる役割。 */
export function canAdministerRole(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

/**
 * オーナーだけの操作。資格情報の差し替えなど、管理者にも渡していない鍵がある。
 * LINEアカウントの新規登録・接続確認は canManageRole を使う。
 * 管理者に入口を出すとサーバの403で行き止まりになるので、出す側でここを使って分ける。
 */
export function isOwnerRole(role: string | null | undefined): boolean {
  return role === 'owner'
}

/**
 * ログイン中の担当者の役割。`api.staff.me()` で入り直して読む。
 * 手元の保存値は書き換え可能なので判定に使わない。
 *
 * 確認が終わるまで・読めなかったときは null を返す。呼び出し側は
 * そのあいだ変更操作を隠す。
 * 最後の守りはサーバの 403（失敗時は権限不足の文を出す）。
 */
let pendingIdentity: ReturnType<typeof requestStaffIdentity> | null = null
let consumers = 0
const serverIdentity = () => null

/** 読み取り専用の束は役割の表示名より優先する。 */
export function effectiveStaffRole(identity: Pick<StaffMember, 'role' | 'readOnly' | 'roleBundle'> | null): StaffMember['role'] | null {
  return identity ? identity.readOnly || identity.roleBundle === 'view_only' ? 'viewer' : identity.role : null
}

/** 本人ID等も必要な非同期の読み込み用。失敗・古いセッションは許可へ変えない。 */
async function requestStaffIdentity(generation: number) {
  try {
    const response = await api.staff.me()
    if (generation !== staffIdentityGeneration()) throw new Error('Staff session changed')
    if (!response.success) {
      forgetStaffIdentity()
      return response
    }
    // フックがセッション失効を監視している間だけ共有する。
    // 名前・IDだけの単発読取を、次のログインの権限キャッシュにしない。
    if (consumers > 0) rememberStaffIdentity(response.data)
    return { ...response, data: { ...response.data, role: effectiveStaffRole(response.data)! } }
  } catch (error) {
    if (generation === staffIdentityGeneration()) forgetStaffIdentity()
    throw error
  }
}

export function loadStaffIdentity() {
  if (!pendingIdentity) {
    const generation = staffIdentityGeneration()
    const request = Promise.resolve().then(() => requestStaffIdentity(generation)).finally(() => {
      if (pendingIdentity === request) pendingIdentity = null
    })
    pendingIdentity = request
  }
  return pendingIdentity
}

export function useStaffIdentity(): StaffMember | null {
  const identity = useSyncExternalStore(subscribeStaffIdentity, readStaffIdentity, serverIdentity)
  useEffect(() => {
    consumers++
    const invalidate = () => { pendingIdentity = null; forgetStaffIdentity() }
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || ['lh_csrf', 'lh_staff_role'].includes(event.key)) invalidate()
    }
    window.addEventListener(SESSION_LOST_EVENT, invalidate)
    window.addEventListener('storage', onStorage)
    if (!readStaffIdentity() && !pendingIdentity) {
      void loadStaffIdentity().catch(() => {})
    }
    return () => {
      window.removeEventListener(SESSION_LOST_EVENT, invalidate)
      window.removeEventListener('storage', onStorage)
      if (--consumers === 0) invalidate()
    }
  }, [])
  return identity
}

export function useStaffRole(): string | null {
  const identity = useStaffIdentity()
  return effectiveStaffRole(identity)
}

/** 入口の本人確認。未取得・失敗を許可へ変えず、両方のゲートで同じ読み直しを使う。 */
export function useStaffIdentityLoad() {
  const identity = useStaffIdentity()
  const role = effectiveStaffRole(identity)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => { setFailed(false); setAttempt(value => value + 1) }, [])
  useEffect(() => {
    if (role !== null) { setFailed(false); return }
    let active = true
    setFailed(false)
    void loadStaffIdentity().then(result => {
      if (active && !result.success) setFailed(true)
    }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [role, attempt])
  return { identity, failed: role === null && failed, retry }
}

/** 統括のひな形・配信は全社の管理者だけ（APIのaccount_scope判定と同じ）。 */
export function useTenantWideAccess(): boolean {
  const identity = useStaffIdentity()
  return Boolean(identity && canManageRole(identity.role)
    && !identity.readOnly && identity.roleBundle !== 'view_only' && identity.accountScope !== 'accounts')
}

/** 統括メンバー・契約・決済の管理を行える人。 */
export function useTenantAdministratorAccess(): boolean {
  const identity = useStaffIdentity()
  return Boolean(identity && canAdministerRole(identity.role)
    && !identity.readOnly && identity.accountScope !== 'accounts')
}
