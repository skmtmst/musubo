import { readStaffIdentity } from './staff-identity-state'
import { effectiveStaffEditKeys, hasStaffAccess } from '@line-crm/shared'
/**
 * ログイン中スタッフの項目別権限を画面側で参照する（N-411 / N-424）。
 *
 * 正本は Worker の認可（permissionForApiPath + route guard）。ここは
 * 「見せる操作とAPI結果を一致させる」ための表示制御だけに使う。
 * 役割と鍵は本人APIで確認した応答を使う。保存値からは昇格させない。
 */

function permissionKeys(role: string | null): string[] {
  const identity = readStaffIdentity();
  return identity?.role === role && !identity.readOnly && identity.roleBundle !== 'view_only'
    ? identity.permissionKeys ?? [] : [];
}
function viewPermissionKeys(role: string | null): string[] {
  const identity = readStaffIdentity();
  return identity?.role === role ? identity.permissionViewKeys ?? [] : [];
}

/** 役割は useStaffRole で確認した値だけを渡す。未確認なら隠す。 */
export function isOwnerOrAdmin(role: string | null = null): boolean {
  return role === 'owner' || role === 'admin';
}

export function canEditFeature(permission: string, role: string | null = null): boolean {
  if (isOwnerOrAdmin(role)) return true;
  if (role === 'staff' && readStaffIdentity()?.hqRole === 'operator') return permission !== 'administrator';
  if (permission === 'administrator') return false;
  return role === 'staff' && typeof window !== 'undefined'
    && effectiveStaffEditKeys(permissionKeys(role)).includes(permission);
}

export function canViewFeature(permission: string, role: string | null = null): boolean {
  if (role === 'viewer') {
    const identity = readStaffIdentity();
    return hasStaffAccess(identity && { role: identity.role, hqRole: identity.hqRole, permissionKeys: effectiveStaffEditKeys(identity.permissionKeys ?? []), viewPermissionKeys: identity.permissionViewKeys, readOnly: true }, permission, true);
  }
  if (isOwnerOrAdmin(role)) return true;
  if (role === 'staff' && readStaffIdentity()?.hqRole === 'operator') return permission !== 'administrator';
  if (permission === 'administrator') return false;
  return role === 'staff' && typeof window !== 'undefined'
    && (effectiveStaffEditKeys(permissionKeys(role)).includes(permission)
      || viewPermissionKeys(role).includes(permission));
}
