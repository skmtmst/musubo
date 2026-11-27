'use client'

/*
 * 友だち詳細で「変える操作」を出してよいか。今の画面と同じ境目：
 * - 担当・対応状況（PUT /api/chats/:id）… オーナー・管理者、または '/chats' 編集キー（N-035）
 * - 情報欄の保存（PUT /api/friends/:id/fields）… オーナー・管理者、または
 *   'attribute.personal_info.edit' を持つスタッフ（個人情報の項目だけ）（N-045）
 * - 項目を作る・シナリオに登録する・リッチメニューの変更 … オーナー・管理者だけ
 *
 * 役割はサーバ（api.staff.me）から読む。読めるまでは変更操作を隠す。
 * 閲覧のみ（どれもできない人）には押せないボタンを置かず隠す（2026-10-06 オーナー）。
 */
import type { FriendField } from '@line-crm/shared'
import { canEditFeature } from '@/lib/staff-capability'
import { canManageRole, useStaffRole } from '@/lib/staff-role'

export type FriendDetailPermissions = {
  manage: boolean
  editSupport: boolean
  saveFields: boolean
  canEditField: (field: FriendField) => boolean
  viewOnly: boolean
}

export function useFriendDetailPermissions(): FriendDetailPermissions {
  const role = useStaffRole()
  const manage = canManageRole(role)
  const editSupport = canEditFeature('/chats', role)
  const saveFields = canEditFeature('attribute.personal_info.edit', role)
  return {
    manage,
    editSupport,
    saveFields,
    canEditField: (field) => manage || Boolean(field && typeof field === 'object' && field.isPersonal === true && saveFields),
    viewOnly: !manage && !editSupport && !saveFields,
  }
}
