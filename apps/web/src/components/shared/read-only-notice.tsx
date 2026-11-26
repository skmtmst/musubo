'use client'

import { useSyncExternalStore, type HTMLAttributes, type ReactNode } from 'react'
import Notice from './notice'
import { PERMISSION_LOCK_SUMMARY, type PermissionLockKind } from './permission-lock'
import { effectiveStaffRole, readStaffIdentity, subscribeStaffIdentity } from '@/lib/staff-identity-state'
import { readPermissionSessionSnapshot as readSessionSnapshot, SESSION_SNAPSHOT_CHANGED } from '@/lib/session-snapshot'

const subscribeSession = (listener: () => void) => {
  window.addEventListener(SESSION_SNAPSHOT_CHANGED, listener)
  return () => window.removeEventListener(SESSION_SNAPSHOT_CHANGED, listener)
}
const serverSession = () => null

/** 店の画面の閲覧のみの帯の言い方。全画面でこの1つだけを使う。 */
export const READ_ONLY_MESSAGE = '閲覧のみで見ています。変えたい時はオーナーか管理者に頼んでください。'
/** 統括の画面の閲覧のみの帯の言い方。 */
export const READ_ONLY_MESSAGE_HQ = '閲覧のみで見ています。変えたい時は統括の管理者に頼んでください。'
/** 管理者が店の画面の変更権限を持たないときの帯の言い方（管理者に「管理者へ頼んで」と出さない）。 */
export const ADMIN_LOCK_SUMMARY = 'この画面を変える権限がありません。変えたい時はオーナーに頼んでください。'

/**
 * 権限の帯。画面の上に1回だけ、ボタンが押せない理由を短く出す。形・印・言い方はここが持ち、画面で文を書き足さない。
 * 閲覧のみの人には閲覧のみの文、権限の無い担当者や管理者にはその画面で要る権限（`need`）の短い文、
 * 閲覧の代理ログイン中は代理ログインの文。置き場所は型（題のすぐ下・タブの上）が持つ。
 */
export default function ReadOnlyNotice({ scope = 'store', need = 'feature', children, role = 'status', ...props }:
  Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'style' | 'children'> & { scope?: 'store' | 'hq'; need?: Exclude<PermissionLockKind, 'viewer'>; children?: ReactNode }) {
  // 役割は押せないボタンの理由（lockReason）と同じ控えから読み、控えが変われば描き直す。ここで読み込みは起こさない。
  const staffRole = effectiveStaffRole(useSyncExternalStore(subscribeStaffIdentity, readStaffIdentity, () => null))
  const session = useSyncExternalStore(subscribeSession, readSessionSnapshot, serverSession)
  if (staffRole === null) return null
  const readingImpersonation = session?.impersonation?.mode === 'read'
  const text = readingImpersonation ? PERMISSION_LOCK_SUMMARY.impersonation
    : staffRole === 'viewer' ? (scope === 'hq' ? READ_ONLY_MESSAGE_HQ : READ_ONLY_MESSAGE)
      : staffRole === 'admin' && scope === 'store' && need === 'feature' ? ADMIN_LOCK_SUMMARY
        : PERMISSION_LOCK_SUMMARY[scope === 'hq' && need === 'feature' ? 'tenantWide' : need]
  // 既存の店向け補足は維持し、代理閲覧の理由と明示された必要権限を優先する。
  return <Notice {...props} tone="info" role={role} data-read-only-notice>{!readingImpersonation && need === 'feature' && scope === 'store' && children ? children : text}</Notice>
}
