import { hasStaffAccess, hasDeliveryAccess, type DeliveryFeature, type StaffFeatureOperation } from '@line-crm/shared';

import type { Context, MiddlewareHandler } from 'hono';
import type { Env } from '../worker-env.js';
import type { StaffRole } from './auth/principal/auth.js';
import { readOperationPermissions } from './auth/permissions/auth.js';
import { isHqBusinessOperation } from './hq-role-policy.js';

/**
 * 役割による門番。
 *
 * 更新の可否と閲覧の可否は別の軸で見る:
 *   - 更新（GET 以外）は authMiddleware が readOnly で一律に止める
 *   - ここでは「その役割に許された操作か」だけを見る
 *
 * GET を役割で絞りたい場合もここを使う。読み取り専用の人まで止めたい GET は
 * denyReadOnly と併用する（鍵情報の一覧など）。
 */
export function requireRole(...allowed: StaffRole[]): MiddlewareHandler<Env> {
  return async (c, next) => {
    const staff = c.get('staff');
    const hqBusiness = staff?.hqRole === 'operator' && allowed.includes('admin')
      && isHqBusinessOperation(c.req.method, c.req.path, staff.id);
    const hqRead = staff?.hqRole === 'viewer' && allowed.includes('admin')
      && ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method.toUpperCase())
      && isHqBusinessOperation(c.req.method, c.req.path, staff.id);
    if (!staff || (!allowed.includes(staff.role) && !hqBusiness && !hqRead)) {
      return c.json(
        { success: false, error: `この操作には${roleLabel(allowed[0])}権限が必要です` },
        403,
      );
    }
    return next();
  };
}

/**
 * 項目別permissionによる門番。
 *
 * owner/admin は常に通す。staff は保存済みの権限キーで判定する:
 *   - permissionKeys … すべてのメソッドで有効（edit）
 *   - viewPermissionKeys … GET/HEAD/OPTIONS のみ有効（view）
 * middleware の permissionForApiPath が経路ごとの第一関門、ここは
 * 「同じ経路でも操作単位で別キー」を要求するときに使う。
 */
export function hasStaffPermission(c: Context<Env>, permission: string): boolean {
  const staff = c.get('staff');
  if (!staff) return false;
  if (staff.role === 'owner' || staff.role === 'admin') return true;
  if (staff.hqRole === 'operator') return permission !== 'administrator';
  if (staff.hqRole === 'viewer') return ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method.toUpperCase()) && permission !== 'administrator';
  const safeRead = c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS';
  return staff.permissionKeys?.includes(permission) === true
    || (safeRead && staff.viewPermissionKeys?.includes(permission) === true);
}

export function requirePermission(permission: string): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!hasStaffPermission(c, permission)) {
      return c.json(
        { success: false, error: 'この操作を実行する権限がありません' },
        403,
      );
    }
    return next();
  };
}

/** 表に明記された読取操作だけを、指定のいずれかの閲覧鍵で通す。 */
export function requireReadOperationPermission(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const permissions = readOperationPermissions(c.req.method, c.req.path);
    if (!permissions?.some(permission => hasStaffAccess(c.get('staff'), permission, true))) {
      return c.json({ success: false, error: 'この操作を実行する権限がありません' }, 403);
    }
    return next();
  };
}

/**
 * 読み取り専用の人を、GET であっても止める。
 *
 * 通常、閲覧は役割だけで判断する。ただし鍵情報（APIキーなど）は
 * 「見えること自体が権限」なので、閲覧のみの人には役割にかかわらず
 * 見せない。requireRole と重ねて使う。
 */
export function denyReadOnly(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const staff = c.get('staff');
    if (!staff || staff.readOnly) {
      return c.json(
        { success: false, error: '閲覧のみの権限では、この情報は表示できません' },
        403,
      );
    }
    return next();
  };
}

/**
 * 取り消せない操作に、明示的な確認を要求する。
 *
 * 一斉配信の本送信のように「押したら友だち全員に届き、取り消せない」操作は、
 * 権限があるだけでは足りない。画面の確認ダイアログは押し間違いを減らすが、
 * URL を直接叩けば素通りするので、サーバー側でも意思表示を求める。
 *
 * 呼び出し側は `X-Confirm-Irreversible: <合言葉>` を送る。合言葉は操作ごとに
 * 決め打ちで、たまたま付いていた、では通らないようにする。
 */
export function requireIrreversibleConfirmation(token: string): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (c.req.header('x-confirm-irreversible') !== token) {
      return c.json(
        {
          success: false,
          error: 'この操作は取り消せません。画面の確認手順を経てから実行してください。',
          code: 'CONFIRMATION_REQUIRED',
        },
        428,
      );
    }
    return next();
  };
}

function roleLabel(role: StaffRole | undefined): string {
  switch (role) {
    case 'owner':
      return 'オーナー';
    case 'admin':
      return '管理者';
    case 'staff':
      return 'スタッフ';
    default:
      return '相応の';
  }
}

/** 操作の鍵を束と共通の表から選ぶ。アカウント境界は各routeで確認する。 */
export function requireDeliveryAccess(feature: DeliveryFeature, operation: StaffFeatureOperation = 'edit'): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!hasDeliveryAccess(c.get('staff'), feature, operation)) {
      return c.json({ success: false, error: 'この機能を操作する権限がありません' }, 403);
    }
    return next();
  };
}
