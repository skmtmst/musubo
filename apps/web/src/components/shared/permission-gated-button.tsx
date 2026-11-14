'use client'

import Button, { type ButtonProps } from './button'
import type { PermissionLockKind } from './permission-lock'
import { usePermissionLockReason } from './use-permission-lock-reason'

type Need = Exclude<PermissionLockKind, 'viewer'>

/**
 * 権限が無い人にも操作を隠さず、灰色＋理由の吹き出しで出すボタン。
 * 権限があればふつうの Button。無ければ押す先（onClick・href）を外し、理由を Button の lockedReason へ渡す。
 * 押下・Enter・スペースの防止と吹き出しは Button が持つ。役割が読めるまでは理由が無いので押せないだけにする。
 */
export default function PermissionGatedButton({ allowed, need = 'feature', ...props }: ButtonProps & { allowed: boolean; need?: Need }) {
  const reason = usePermissionLockReason(allowed, need)
  if (allowed) return <Button {...(props as ButtonProps)} />
  const locked = { ...(props as Record<string, unknown>) }
  delete locked.onClick
  delete locked.href
  delete locked.external
  delete locked.target
  const lockedProps = { ...locked, lockedReason: reason, disabled: reason ? undefined : true } as unknown as ButtonProps
  return <Button {...lockedProps} />
}
