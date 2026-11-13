import type { DeliveryService, DeliveryServiceState } from '@/lib/restaurant-delivery-api'
import { PREPARING_WORD } from '@/components/shared/preparing-dialog'

export type IntakeAction = 'stop' | 'resume'

/** 接続の状態と受付の操作を分ける。接続済みでも提供前の操作は通さない。 */
export function intakeActionReason(state: DeliveryServiceState | undefined, action: IntakeAction): string | undefined {
  if (!state) return 'サービスの状態を読み直してから操作してください。'
  if (state.service === 'ubereats') return `営業状態の連携は${PREPARING_WORD}`
  if (state.connectionStatus !== 'connected') return state.connectionStatus === 'error'
    ? '接続の異常を解消してください。'
    : '未接続のため操作できません。'
  if (state.intakeStatus !== (action === 'stop' ? 'open' : 'stopped')) return action === 'stop'
    ? 'すでに受付が停止しています。'
    : 'すでに受付を再開しています。'
}

export interface IntakeAccess {
  scope: object
  accountId: string | null
  canManage: boolean
  roleKnown: boolean
  roleFailed?: boolean
  ready: boolean
  services: DeliveryServiceState[]
}

/** 窓全体の操作可否。選択の不足や各サービスの状態で他の行を塞がない。 */
export function intakeContextReason(current: IntakeAccess, scope: object): string | undefined {
  if (!current.roleKnown) return current.roleFailed ? '担当者を確認できませんでした。画面を読み直してください。' : '担当者の確認が終わるまでお待ちください。'
  if (current.scope !== scope) return '店舗や権限が変わったため、受付の操作を中止しました。窓を開き直してください。'
  if (!current.accountId || !current.ready) return '注文の状態を読み直してから操作してください。'
  if (!current.canManage) return '受付を変更する権限がありません。'
}

/** 保持された操作でも、いま表示している店・権限・選択した相手の状態で拒否する。 */
export function intakeOperationReason(current: IntakeAccess, scope: object, selected: DeliveryService[], action: IntakeAction): string | undefined {
  const contextReason = intakeContextReason(current, scope)
  if (contextReason) return contextReason
  if (!selected.length) return '接続済みで受付中のサービスを選んでください。'
  for (const service of selected) {
    const reason = intakeActionReason(current.services.find(state => state.service === service), action)
    if (reason) return reason
  }
}
