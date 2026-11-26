import { knownValue } from '@/lib/known-value'
/*
 * 友だち追加時の配信の公開（確認）で使う小さな決まり。
 * 管理画面（app/friend-add-settings/publish/publish-flow.ts）と同じ中身を写した（src/v8 は @/app を読めない）。
 */
import type { FriendAddRoutingValidation, FriendAddRoutingVersion } from '@line-crm/shared'
import type { FriendAddRule } from '@/lib/api'

/** 作る手順（5段）。確認・完了の頭で同じ並びを使う。 */
export const PUBLISH_STEPS = ['基本設定', '流入リンク', '初回案内', 'あわせて行うこと', '確認'] as const

/** 作る画面（/friend-add-settings?view=edit）の手順の指定。PUBLISH_STEPS と同じ並び。 */
export const PUBLISH_STEP_KEYS = ['basic', 'routes', 'message', 'actions', 'preview'] as const

/** 済んだ段を押したときの行き先：同じ初回案内の作る画面のその段。 */
export function editStepHref(ruleId: string, index: number): string {
  return `/friend-add-settings?view=edit&id=${encodeURIComponent(ruleId)}&step=${PUBLISH_STEP_KEYS[index]}`
}

/** 有効にできるか。サーバの確認が通り、最後のテストが成功していること。 */
export function canPublish(input: { validation: FriendAddRoutingValidation | null; busy: boolean }): boolean {
  const v = input.validation
  if (!v || input.busy) return false
  if (!v.canPublish) return false
  return v.lastTestStatus === 'succeeded'
}

/** 有効にできない理由。押せないボタンを黙って出さない。 */
export function blockedReason(validation: FriendAddRoutingValidation | null): string | null {
  if (!validation) return '確認の結果をまだ読み込めていません。'
  if (validation.lastTestStatus === null) return 'テストで判定が通るまで、有効にはできません'
  if (validation.lastTestStatus === 'failed') return '最後のテストで判定が通りませんでした。直してからもう一度テストしてください'
  if (!validation.canPublish) {
    const failed = validation.checks.filter((check) => check.status === 'failed')
    return failed.length > 0
      ? `${failed.map((check) => check.label).join('・')}を直してください。`
      : '確認が終わっていない項目があります。'
  }
  return null
}

/** 同じ下書きを2回公開しないための鍵。管理画面 と同じ作り。 */
export function idempotencyKeyFor(version: Pick<FriendAddRoutingVersion, 'accountId' | 'versionId'>): string {
  const key = `friend-add-publish-${version.accountId}-${version.versionId}`
  return key.length >= 16 ? key : key.padEnd(16, '0')
}

/** あわせて行うことの短い要約（「タグ・友だち情報・シナリオの3つ」）。 */
export function actionSummaryText(rule: FriendAddRule): string {
  const labels = rule.definition.actions.map((action) =>
    action.type === 'add_tag' || action.type === 'remove_tag' ? 'タグ' : 'シナリオ')
  if (rule.definition.scenarioId) labels.push('シナリオ')
  const unique = [...new Set(labels)]
  const count = rule.definition.actions.length + (rule.definition.scenarioId ? 1 : 0)
  return unique.length === 0 ? 'なし' : `${unique.join('・')}の${count}つ`
}

const MESSAGE_TYPE_LABEL: Record<string, string> = {
  text: 'テキスト',
  template: 'テンプレート',
  form: '回答フォーム',
  scenario: 'シナリオ',
}

/** 最初に送るもの（「テキスト 64字・追加してすぐ」）。 */
export function firstSendText(rule: FriendAddRule): string {
  const d = rule.definition
  if (rule.friendKind === 'returning' && d.returningMode === 'none') return '配信なし（あわせて行うことだけ）'
  const what = d.messageType === 'text' && d.messageText
    ? `テキスト ${d.messageText.length}字`
    : knownValue(MESSAGE_TYPE_LABEL, d.messageType, '種類を確認できません')
  return `${what}${d.timing === 'immediate' ? '・追加してすぐ' : '・シナリオの時刻に'}`
}
