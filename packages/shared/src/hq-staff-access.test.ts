import { describe, expect, it } from 'vitest';
import { hasDeliveryAccess, hasStaffAccess, hqRoleForStaff } from './staff-permissions';

describe('統括の3役割', () => {
  it('全アカウントの統括メンバーだけを特定し、店舗の個別権限を維持する', () => {
    const base = { role: 'staff', role_bundle: 'hq_operator', access_level: 'full', assigned_line_account_id: null, account_scope: 'all' };
    expect(hqRoleForStaff(base)).toBe('operator');
    expect(hqRoleForStaff({ ...base, role_bundle: 'custom' })).toBeNull();
    expect(hqRoleForStaff({ ...base, role_bundle: 'view_only', access_level: 'read_only' })).toBeNull();
    expect(hqRoleForStaff({ ...base, assigned_line_account_id: 'line-1' })).toBeNull();
    expect(hqRoleForStaff({ ...base, account_scope: 'accounts' })).toBeNull();
    expect(hqRoleForStaff({ ...base, role: 'admin' })).toBeNull();
    expect(hqRoleForStaff({ ...base, role_bundle: 'hq_viewer', access_level: 'read_only' })).toBe('viewer');
  });

  it('担当者は業務を操作でき、閲覧のみは変更できない', () => {
    expect(hasDeliveryAccess({ role: 'staff', hqRole: 'operator' }, 'broadcasts', 'edit')).toBe(true);
    expect(hasDeliveryAccess({ role: 'staff', hqRole: 'operator' }, 'richMenus', 'publish')).toBe(true);
    expect(hasStaffAccess({ role: 'staff', hqRole: 'viewer', readOnly: true }, '/friends', true)).toBe(true);
    expect(hasStaffAccess({ role: 'staff', hqRole: 'viewer', readOnly: true }, '/friends')).toBe(false);
    expect(hasStaffAccess({ role: 'staff', permissionKeys: [] }, '/friends')).toBe(false);
  });
});
