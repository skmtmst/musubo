'use client'

import type { ActionMenuItem } from './action-menu'
import { effectiveStaffRole, readStaffIdentity } from '@/lib/staff-identity-state'
import { readPermissionSessionSnapshot as readSessionSnapshot } from '@/lib/session-snapshot'

/**
 * 権限で使えない操作の理由。言い回しはここだけで持ち、画面で書き足さない。
 * 頼む先は閲覧のみの帯と 403 の文にそろえる。
 */
export const PERMISSION_LOCK_REASON = {
  /** 閲覧のみの人。 */
  viewer: '閲覧のみのため変更できません。オーナーか管理者に頼んでください。',
  /** 機能を任されていない担当者。 */
  feature: 'この機能を変える権限がありません。オーナーか管理者に頼んでください。',
  /** オーナーと管理者だけの操作。 */
  manager: 'この操作はオーナーか管理者だけができます。',
  /** オーナーだけの操作。 */
  owner: 'この操作はオーナーだけができます。',
  /** 統括（全社）の管理者だけの操作。 */
  tenantWide: 'この操作は統括の管理者だけができます。',
  /** 外部連携の送り先。 */
  outgoingWebhook: '送り先は統括の担当者だけが作れます。',
  /** 運営コンソールを閲覧の権限で見ている運営の人。 */
  ops: '閲覧の権限のため変えられません。運営の管理者に頼んでください。',
  /** 運営が閲覧で代理ログインしている間。 */
  impersonation: '代理ログイン（閲覧）中のため変更できません。書き込みに切り替えてから操作してください。',
  /** 直接送信は、書込の代理ログイン中もサーバが拒否する。予約と承認依頼には使わない。 */
  impersonationSend: '代理ログイン中は配信をすぐには送れません。代理ログインを終了してから送ってください。',
  /** 本人の操作として監査に残す記録は、閲覧・書込どちらの代理ログインでもサーバが拒否する。 */
  impersonationAny: '代理ログイン中はこの操作ができません。オーナーか管理者に頼んでください。',
} as const

export type PermissionLockKind = keyof typeof PERMISSION_LOCK_REASON

/**
 * 同じ理由で押せないボタンが並ぶ画面の上に1回だけ出す短い文（閲覧のみの帯と同じ置き場）。
 * 閲覧のみの文は read-only-notice が持つ。ボタンの吹き出しは上の PERMISSION_LOCK_REASON のまま。
 */
export const PERMISSION_LOCK_SUMMARY: Record<Exclude<PermissionLockKind, 'viewer'>, string> = {
  feature: 'この画面を変える権限がありません。変えたい時はオーナーか管理者に頼んでください。',
  manager: 'この画面の変える操作は、オーナーか管理者だけができます。',
  owner: 'この画面の変える操作は、オーナーだけができます。',
  tenantWide: 'この画面の変える操作は、統括の管理者だけができます。',
  outgoingWebhook: '送り先は統括の担当者だけが作れます。',
  impersonation: PERMISSION_LOCK_REASON.impersonation,
  impersonationSend: PERMISSION_LOCK_REASON.impersonationSend,
  impersonationAny: PERMISSION_LOCK_REASON.impersonationAny,
  ops: PERMISSION_LOCK_REASON.ops,
}

/**
 * 役割と操作に要る権限から理由を選ぶ。閲覧のみは何を頼む操作でも閲覧のみの文にする。
 * 許されている時は undefined。役割が未確認でも allowed=false の拒否側の値は維持する。
 * 本人未確認の表示は呼ぶ側で理由を出さず disabled にし、書込は !allowed でも拒否する。
 * 理由の文字列が無いことを、操作の許可として扱わない。
 */
export function permissionLockReason(role: string | null | undefined, allowed: boolean, need: Exclude<PermissionLockKind, 'viewer'> = 'feature'): string | undefined {
  if (allowed) return undefined
  if (role === 'viewer') return PERMISSION_LOCK_REASON.viewer
  return PERMISSION_LOCK_REASON[need]
}

/**
 * 許されていない時だけ、ログイン中の人の役割に合う理由を返す。`lockedReason={lockReason(canEdit)}` の形で使う。
 * 役割は画面が権限を決めるのに読んだもの（`useStaffRole`）と同じ控えから読む。
 */
export function lockReason(allowed: boolean, need: Exclude<PermissionLockKind, 'viewer'> = 'feature'): string | undefined {
  // 閲覧の代理ログイン中は、役割がオーナーでもサーバが書き込みを断るので、代理ログインの文を出す。
  if (readSessionSnapshot()?.impersonation?.mode === 'read') return PERMISSION_LOCK_REASON.impersonation
  return permissionLockReason(effectiveStaffRole(readStaffIdentity()), allowed, need)
}

/** 許されていない時だけ決まった理由を返す。役割に関係なく文が決まる操作に使う。 */
export function lockUnless(allowed: boolean, kind: PermissionLockKind = 'viewer'): string | undefined {
  if (readSessionSnapshot()?.impersonation?.mode === 'read') return PERMISSION_LOCK_REASON.impersonation
  return allowed ? undefined : PERMISSION_LOCK_REASON[kind]
}

/**
 * 「…」の中の項目を、許されていない時も隠さず理由付きの押せない形で残す。
 * `...lockMenuItems(canEdit, [{ id: 'edit', … }])` の形で使う。見るだけの項目は `viewOnly` で押せるまま残す。
 */
export function lockMenuItems(allowed: boolean, items: ActionMenuItem[], need: Exclude<PermissionLockKind, 'viewer'> = 'feature', viewOnly?: (item: ActionMenuItem) => boolean): ActionMenuItem[] {
  const reason = lockReason(allowed, need)
  return reason ? items.map((item) => viewOnly?.(item) ? item : { ...item, lockedReason: reason }) : items
}
