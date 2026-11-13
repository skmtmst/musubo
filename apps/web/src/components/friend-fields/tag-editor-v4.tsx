'use client'

import Notice from '@/components/shared/notice'
import { TAG_ADD_ACTION_LABEL } from '@/components/shared/action-words'
import { useEffect, useRef, useState } from 'react'
import { Coins } from 'lucide-react'
import type { Tag } from '@line-crm/shared'
import { api, type CommonActionResources, type TagDefinitionAction, type TagRetroactivePreview } from '@/lib/api'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { formatNumber } from '@/lib/format'
import { SaveErrorField } from '@/components/shared/save-form-errors'

export type LinkedAction = {
  id: string
  type: string
  label: string
  timing: string
  definition?: TagDefinitionAction
}

export type TagEditorValues = {
  name: string
  groupId: string
  isStarred: boolean
  linked: boolean
  rewardMiles: number
  referralRewardMiles: number
  multiplierBps: number | null
  multiplierPriority: number
  applyToExisting: boolean
  reapplyPolicy: 'first_only' | 'every_time'
  actions: LinkedAction[]
}

export type TagEditorInitialValues = Partial<Omit<TagEditorValues, 'actions'>> & {
  actions?: LinkedAction[]
}

export const ACTION_TYPES = [
  ['テキスト送信', 'テキスト送信'],
  ['テンプレート送信', 'テンプレート'],
  ['タグ追加', 'タグ'],
  ['タグ解除', 'タグ'],
  ['友だち情報更新', '友だち情報'],
  ['対応マーク変更', '対応'],
  ['シナリオ開始', 'シナリオ'],
  ['シナリオ停止', 'シナリオ'],
  ['リマインダ開始', 'リマインダ'],
  ['リマインダ解除', 'リマインダ'],
  ['リッチメニュー切替', 'リッチメニュー'],
  ['担当者通知', '通知'],
  ['マイル付与', 'マイル'],
] as const
export type TagEditorActionLabel = (typeof ACTION_TYPES)[number][0]

/**
 * 画面に出す言葉（2026-10-15 司令塔・絵 ）。「〜を送る」「〜を付ける」の形にそろえる。
 * 上の表の名前（「テキスト送信」など）は保存・権限・統括の絞り込みが読む内部の名前なので変えない。
 */
export const ACTION_DISPLAY: Record<TagEditorActionLabel, string> = {
  'テキスト送信': 'テキストを送る',
  'テンプレート送信': 'テンプレートを送る',
  'タグ追加': TAG_ADD_ACTION_LABEL,
  'タグ解除': 'タグを外す',
  '友だち情報更新': '友だち情報を変える',
  '対応マーク変更': '対応マークを変える',
  'シナリオ開始': 'シナリオを始める',
  'シナリオ停止': 'シナリオを止める',
  'リマインダ開始': 'リマインダを始める',
  'リマインダ解除': 'リマインダを止める',
  'リッチメニュー切替': 'リッチメニューを変える',
  '担当者通知': '担当者に知らせる',
  'マイル付与': 'マイルを付ける',
}

export const ACTION_DEFINITIONS: Record<(typeof ACTION_TYPES)[number][0], { actionType: string; resource?: keyof CommonActionResources; paramKey?: string }> = {
  'テキスト送信': { actionType: 'send_message' },
  'テンプレート送信': { actionType: 'send_message', resource: 'templates', paramKey: 'templateId' },
  'タグ追加': { actionType: 'add_tag', resource: 'tags', paramKey: 'tagId' },
  'タグ解除': { actionType: 'remove_tag', resource: 'tags', paramKey: 'tagId' },
  '友だち情報更新': { actionType: 'set_metadata', resource: 'friendFields', paramKey: 'fieldId' },
  '対応マーク変更': { actionType: 'set_support_mark', resource: 'supportMarks', paramKey: 'markId' },
  'シナリオ開始': { actionType: 'start_scenario', resource: 'scenarios', paramKey: 'scenarioId' },
  'シナリオ停止': { actionType: 'stop_scenario', resource: 'scenarios', paramKey: 'scenarioId' },
  'リマインダ開始': { actionType: 'start_reminder', resource: 'reminders', paramKey: 'reminderId' },
  'リマインダ解除': { actionType: 'stop_reminder', resource: 'reminders', paramKey: 'reminderId' },
  'リッチメニュー切替': { actionType: 'switch_rich_menu', resource: 'richMenus', paramKey: 'richMenuPageId' },
  '担当者通知': { actionType: 'notify_staff', resource: 'notificationRules', paramKey: 'notificationRuleId' },
  'マイル付与': { actionType: 'grant_mileage' },
}

const ACTION_PRESENTATION: Record<string, { label: string; category: string }> = Object.fromEntries(
  ACTION_TYPES.map(([label, category]) => [ACTION_DEFINITIONS[label].actionType, { label, category }]),
)

export function linkedActionFromDefinition(action: TagDefinitionAction, saved?: NonNullable<Tag['linkedActions']>[number]): LinkedAction {
  const presentation = ACTION_PRESENTATION[action.type] ?? { label: action.type, category: 'その他' }
  const delayMinutes = Number(action.params.delayMinutes ?? 0)
  const timing = delayMinutes <= 0 ? 'すぐに' : delayMinutes % 1440 === 0 ? `${delayMinutes / 1440}日後` : delayMinutes % 60 === 0 ? `${delayMinutes / 60}時間後` : `${delayMinutes}分後`
  const content = typeof action.params.content === 'string' ? action.params.content : null
  const amount = typeof action.params.amount === 'number' ? `${action.params.amount} マイル` : null
  const detailedType = action.type === 'send_message' && content ? 'テキスト送信' : presentation.label
  return { id: action.id, type: detailedType, label: saved?.label ?? content ?? amount ?? presentation.label, timing: saved?.timing ?? timing, definition: action }
}

export function definitionsForSave(actions: LinkedAction[]): TagDefinitionAction[] {
  return actions.flatMap((action) => action.definition ? [{ ...action.definition, id: action.id }] : [])
}

/**
 * 遡及実行の確認窓（N-047）。
 *
 * 人数・合計マイルはサーバーが数えたもの（/retroactive-preview）を出す。
 * 画面で勝手に数えた値を見せると、実際に付与される対象と食い違う。
 * 確認ボタンはサーバーの計算が返ってくるまで押せない。実行時は
 * previewToken を保存APIへ渡し、サーバー側で対象の再計算と照合する。
 */
export function RetroactiveDialog({ values, count, tagId, accountId, onCancel, onSaveWithoutApplying, onSave, referenceState = false }: { values: TagEditorValues; count: number; tagId: string | null; accountId: string | null; onCancel: () => void; onSaveWithoutApplying: () => void; onSave: (previewToken: string) => void; referenceState?: boolean }) {
  const scopeKey = JSON.stringify([accountId, tagId, values.rewardMiles, values.referralRewardMiles])
  const scope = useRef({ key: scopeKey })
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey }
  const openedScope = useRef(scope.current)
  const requestSequence = useRef(0)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const isCurrent = () => active.current && openedScope.current === scope.current
  const close = () => { if (isCurrent()) { active.current = false; onCancel() } }
  const [accepted, setAccepted] = useState(referenceState)
  const [preview, setPreview] = useState<TagRetroactivePreview | null>(null)
  const [previewError, setPreviewError] = useState('')
  const fetchPreview = () => {
    if (!tagId || !accountId || !isCurrent()) return
    const request = ++requestSequence.current
    setPreviewError('')
    void api.tags.retroactivePreview(tagId, accountId, {
      self: values.rewardMiles,
      referrer: values.referralRewardMiles,
    }).then((res) => {
      if (!isCurrent() || request !== requestSequence.current) return
      if (res.success) setPreview(res.data)
      else setPreviewError(res.error || '対象を再計算できませんでした。時間をおいて、もう一度お試しください。')
    }).catch(() => { if (isCurrent() && request === requestSequence.current) setPreviewError('対象を再計算できませんでした。時間をおいて、もう一度お試しください。') })
  }

  useEffect(() => {
    // 固定表示（visual-qa）はAPIを呼ばず、設計確認用の固定数を出す。
    if (referenceState) return
    fetchPreview()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referenceState, tagId, accountId, values.rewardMiles, values.referralRewardMiles])

  const loading = !referenceState && !preview && !previewError
  const selfTargets = preview ? preview.selfTargets : count
  const referralTargets = preview ? preview.referralTargets : Math.min(count, 34)
  const rewardTotal = preview ? preview.selfMiles : selfTargets * values.rewardMiles
  const referralTotal = preview ? preview.referralMiles : referralTargets * values.referralRewardMiles
  return <Dialog open={isCurrent()} size="large" tone="destructive" confirmation dirty={false}
    onCancel={close} title={`${selfTargets + referralTargets}人にさかのぼってマイルを積みますか？`}
    titleIcon={<Coins aria-hidden="true" />}
    footer={<DialogActions>

          <Button variant="secondary" type="button" onClick={() => { if (isCurrent()) { active.current = false; onSaveWithoutApplying() } }}>反映しないで保存する</Button>
          <Button variant="primary" type="button" disabled={!accepted || loading || Boolean(previewError)} onClick={() => { if (isCurrent() && accepted && !loading && !previewError) { active.current = false; onSave(preview?.previewToken ?? '') } }}>{loading ? '対象を計算中…' : 'さかのぼって反映して保存する'}</Button>
            </DialogActions>}
  >
        <OperationTargetSummary accounts={[{ id: accountId ?? '' }]} />
        <p className="mt-2 text-sm leading-6 text-ink-secondary">「{values.name || 'このタグ'}」の変更を、いまこのタグが付いている人にも適用します。人数はサーバーで再計算した値です。</p>
        <div className="mt-4 overflow-hidden rounded-control border border-hairline">
          <dl className="divide-y divide-hairline text-sm">
            <div className="grid grid-cols-[1fr_165px_130px] px-4 py-2.5"><dt>本人マイル</dt><dd>+{values.rewardMiles} マイル × {selfTargets}人{preview && preview.selfExcluded > 0 ? `（付与済み${preview.selfExcluded}人を除く）` : ''}</dd><dd className="text-right font-semibold text-success">+{formatNumber(rewardTotal)} マイル</dd></div>
            <div className="grid grid-cols-[1fr_165px_130px] px-4 py-2.5"><dt>紹介者マイル</dt><dd>+{values.referralRewardMiles} マイル × {referralTargets}人{preview && preview.referralExcluded > 0 ? `（付与済み${preview.referralExcluded}人を除く）` : ''}</dd><dd className="text-right font-semibold text-success">+{formatNumber(referralTotal)} マイル</dd></div>
            <div className="grid grid-cols-[1fr_165px_130px] bg-success-bg/40 px-4 py-2.5 font-medium"><dt>合計</dt><dd>{selfTargets + referralTargets}人が対象</dd><dd className="text-right text-success">+{formatNumber((rewardTotal + referralTotal))} マイル</dd></div>
            <div className="grid grid-cols-[1fr_165px_130px] px-4 py-2.5"><dt>倍率 {values.multiplierBps ? `${values.multiplierBps / 10000}倍` : 'なし'}</dt><dd>さかのぼりません</dd><dd className="text-right">次回付与から</dd></div>
            <div className="grid grid-cols-[1fr_165px_130px] px-4 py-2.5"><dt>連動アクションの送信</dt><dd>さかのぼって送りません</dd><dd className="text-right">送信0件</dd></div>
          </dl>
        </div>
        <Notice tone="warn" heading={<> この操作は取り消せません </>}>

          <p>さかのぼって積んだマイルは自動では戻せません。取り消すにはマイル画面から手動で調整が必要です。</p>
        </Notice>
        {previewError && (
          <Notice tone="danger" action={<> <Button variant="text" size="inline" data-notice-inline-action type="button" onClick={fetchPreview}>再計算する</Button> </>} role="alert">
            {previewError}

          </Notice>
        )}
        <SaveErrorField names={["accepted"]}><Checkbox className="mt-3" checked={accepted} onCheckedChange={setAccepted}>人数と合計マイルを確認しました</Checkbox></SaveErrorField>
        <p className="mt-3 whitespace-nowrap text-xs leading-4 text-ink-faint">新規作成のときはこのダイアログは出ません。まだ誰にもタグが付いていないため、送信やマイル付与も起きません。</p>
  </Dialog>
}
