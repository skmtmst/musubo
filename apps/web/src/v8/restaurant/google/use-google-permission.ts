import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { usePermissionAccess } from '@/lib/use-feature-access'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import { PERMISSION_LOCK_REASON } from '@/components/shared/permission-lock'
import { usePathname } from 'next/navigation'

/** 本人の機能権限・必要な役割・サーバの制限をすべて満たす場合だけ操作できる。 */
export function useGooglePermission(need: 'feature' | 'manager' | 'tenantWide' = 'feature', serverAllowed = true, permissionPath = '/restaurant-test/google') {
  const pathname = usePathname()
  const effectivePath = pathname === '/settings/google-hours' ? '/settings/sns' : permissionPath
  const role = useStaffRole()
  const featureAllowed = usePermissionAccess(effectivePath)
  const canView = usePermissionAccess(effectivePath, true)
  const permitted = featureAllowed && serverAllowed && (need === 'feature' || canManageRole(role))
  const lockedReason = usePermissionLockReason(permitted, need)
  const allowed = permitted && lockedReason !== PERMISSION_LOCK_REASON.impersonation
  return { allowed, canView, known: role !== null, lockedReason }
}
