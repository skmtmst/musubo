'use client'

import { knownValue } from '@/lib/known-value'
import type { BroadcastSendMode } from './broadcast-schedule'

import type { UnsavedLeaveTarget } from '@/lib/use-unsaved-guard'


import { ApprovalRequestFields } from '@/components/broadcasts/broadcast-approval'
import { type BroadcastStepKey } from '@/components/broadcasts/broadcast-steps'
import ConditionBuilder from '@/components/shared/condition-builder'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import Notice from '@/components/shared/notice'
import TextLink from '@/components/shared/text-link'
import SendConfirmDialog,{ describeExclusion,shiftedShort,shiftedWhen } from '@/components/shared/send-confirm-dialog'
import type { BroadcastApprovalCandidate } from '@/lib/api'
import { type ApiBroadcast,type BroadcastBubble } from '@/lib/api'
import { type TargetMode } from '@/lib/broadcast-audience'
import { formatNumber } from '@/lib/format'
import type { SegmentCondition } from '@/lib/segment-condition'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import type { SendConfirmationPreview } from '@line-crm/shared'
import { AlertTriangle,CheckCircle2 } from 'lucide-react'
import type { Dispatch,SetStateAction, ReactNode } from 'react'
import { BROADCAST_ONLY_CONDITION_AXES,STANDARD_CONDITION_AXES,TYPE_LABELS } from './broadcast-form-model'

type RenderBroadcastConfirmDialogsContext = {
  bDraftUnsupported: boolean
  canConfirm: boolean
  confirmationBlocked: boolean
  confirmationFields: ReactNode
  preflightChecks: { key: string; label: string; value: string; done: boolean }[]
  approvalCandidates: BroadcastApprovalCandidate[]
  approvalCandidatesState: "loading" | "error" | "ready"
  approvalConfig: { threshold: number; singleOperator: boolean; } | null
  approvalConfigState: "loading" | "error" | "ready" | "idle"
  approvalNote: string
  approverId: string
  audienceCount: number | null
  broadcastRole: string | null
  bubbles: BroadcastBubble[]
  cancelLeave: () => void
  canSendBroadcast: boolean
  concurrentBroadcasts: { id: string; title: string; scheduledAt: string; }[]
  conditionDialogOpen: boolean
  conditionDraft: SegmentCondition | null
  confirmAudienceLabel: string
  confirmLeave: () => void
  confirmMessage: () => Promise<void>
  confirmOpen: boolean
  currentStep: BroadcastStepKey | null
  error: string
  exclusionNote: string | null
  goToStep: (step: BroadcastStepKey) => void | undefined
  leaveTarget: UnsavedLeaveTarget | null
  needsApproval: boolean
  needsApprovalSingle: boolean
  preflightDialogOpen: boolean
  selectedAccountId: string | null
  quota: { monthlyUsed: number | null; monthlyLimit: number | null; remaining: number | null; planned: number; state: "available" | "insufficient" | "unavailable"; reason: string | null; } | null
  quotaInsufficient: boolean
  quotaNote: string | null
  runPreflight: (silent?: boolean) => Promise<void>
  save: () => Promise<void>
  saveDraftNow: () => Promise<boolean>
  saving: boolean
  scheduledDate: string
  scheduledLabel: string | null
  scheduledTime: string
  sendWhenLabel: string | null
  sendMode: BroadcastSendMode
  sendPreview: { state: "loading" | "error" | "ready"; data: SendConfirmationPreview | null; broadcast: ApiBroadcast | null; }
  setApprovalNote: Dispatch<SetStateAction<string>>
  setApproverId: Dispatch<SetStateAction<string>>
  setCondition: Dispatch<SetStateAction<SegmentCondition | null>>
  setConditionDialogOpen: Dispatch<SetStateAction<boolean>>
  setConditionDraft: Dispatch<SetStateAction<SegmentCondition | null>>
  setConfirmOpen: Dispatch<SetStateAction<boolean>>
  setPreflightDialogOpen: Dispatch<SetStateAction<boolean>>
  setPreviewSeq: Dispatch<SetStateAction<number>>
  targetMode: TargetMode
  title: string
}

export function renderBroadcastConfirmDialogs({ bDraftUnsupported, canConfirm, confirmationBlocked, confirmationFields, preflightChecks, approvalCandidates, approvalCandidatesState, approvalConfig, approvalConfigState, approvalNote, approverId, audienceCount, broadcastRole, bubbles, cancelLeave, canSendBroadcast, concurrentBroadcasts, conditionDialogOpen, conditionDraft, confirmAudienceLabel, confirmLeave, confirmMessage, confirmOpen, currentStep, error, exclusionNote, goToStep, leaveTarget, needsApproval, needsApprovalSingle, preflightDialogOpen, selectedAccountId, quota, quotaInsufficient, quotaNote, runPreflight, save, saveDraftNow, saving, scheduledDate, scheduledLabel, scheduledTime, sendMode, sendWhenLabel, sendPreview, setApprovalNote, setApproverId, setCondition, setConditionDialogOpen, setConditionDraft, setConfirmOpen, setPreflightDialogOpen, setPreviewSeq, targetMode, title }: RenderBroadcastConfirmDialogsContext) {
  return (<><UnsavedLeaveDialog
      open={leaveTarget !== null}
      subject="配信の変更"
      busy={saving}
      saveFailureReason={error || undefined}
      onSave={saveDraftNow}
      saveDisabled={bDraftUnsupported}
      error={bDraftUnsupported ? 'B案は下書きに保存できません。' : undefined}
      onConfirm={confirmLeave}
      onCancel={cancelLeave}
    />

    {/*
      最終確認（設計 `FpgxH` 6-1-H）。

      **押した瞬間に予約が確定しないようにする。** 出す値はどれも
      いま画面が持っているものだけで、固定値は使わない。人数は
      `runPreflight()` が数えたぶん（`preflight.audienceCount`）。
    */}

    <ConfirmDialog
      open={conditionDialogOpen}
      title="配信対象の条件を設定"
      description="条件を組み合わせて、この配信を届ける友だちを決めます。"
      confirmLabel="この条件を反映"
      cancelLabel="キャンセル"
      designNode="sqFXf"
      onCancel={() => setConditionDialogOpen(false)}
      onConfirm={() => {
        setCondition(conditionDraft)
        setConditionDialogOpen(false)
      }}
    >
      <div className="space-y-4">
        <section className="rounded-control border border-hairline bg-canvas-sunken p-4">
          <div className="flex items-center justify-between gap-3"><h3 className="text-sm font-bold text-ink">現在の条件</h3><button type="button" className="text-xs font-semibold text-action" onClick={() => setConditionDraft(null)}>条件を初期化</button></div>
          <p className="mt-2 text-xs text-ink-secondary">{conditionDraft ? '設定中の詳細条件を編集しています。' : '条件はまだ設定されていません。'}</p>
        </section>
        <section className="rounded-control border border-hairline p-4">
          <h3 className="mb-3 text-sm font-bold text-ink">条件 1</h3>
          <ConditionBuilder value={conditionDraft} onChange={setConditionDraft} showCount={false} />
        </section>
        <section>
          <h3 className="text-sm font-bold text-ink">利用できる条件軸</h3>
          <p className="mt-2 text-xs font-medium text-ink-secondary">標準互換（15軸）</p>
          <div className="mt-2 flex flex-wrap gap-1.5">{STANDARD_CONDITION_AXES.map((axis) => <span key={axis} className="rounded-pill border border-hairline px-2 py-1 text-xs text-ink-secondary">{axis}</span>)}</div>
          <p className="mt-3 text-xs font-medium text-ink-secondary">この画面だけの軸（6軸）</p>
          <div className="mt-2 flex flex-wrap gap-1.5">{BROADCAST_ONLY_CONDITION_AXES.map((axis) => <span key={axis} className="rounded-pill border border-hairline px-2 py-1 text-xs text-ink-faint">{axis}</span>)}</div>
          <Notice tone="info" className="mt-3">複数条件は「すべて一致（AND）」または「いずれか一致（OR）」で結合できます。未接続の軸は選択肢に出ません。</Notice>
        </section>
      </div>
    </ConfirmDialog>

    <ConfirmDialog
      open={preflightDialogOpen}
      title={quotaInsufficient ? '配信枠が不足しています' : '配信前チェック'}
      description={quotaInsufficient
        ? `現在の送信枠では${formatNumber(quota?.planned)}通を送信できません。対象を絞るか、配信設定を確認してください。`
        : '対象・メッセージ・日時・送信枠の確認結果です。'}
      confirmLabel="対象を見直す"
      cancelLabel="キャンセル"
      designNode="vW4Es"
      titleIcon={quotaInsufficient || preflightChecks.some(check => !check.done) ? <AlertTriangle size={20} /> : <CheckCircle2 size={20} />}
      onCancel={() => setPreflightDialogOpen(false)}
      onConfirm={() => {
        setPreflightDialogOpen(false)
        goToStep('audience')
      }}
    >
      <ul className="space-y-2 rounded-control border border-hairline bg-canvas-sunken p-4 text-sm">
        {preflightChecks.map(check => <li key={check.key} className={check.done ? 'text-success' : 'text-warning'}>{check.done ? '✓' : '⚠'} {check.label}：{check.key === 'audience' ? audienceCount === null ? '対象人数をまだ取得できていません' : `対象人数 ${formatNumber(audienceCount)}人を確認してください` : check.value}</li>)}
      </ul>
      {(quota === null || quota.state === 'unavailable') && <TextLink inline href={selectedAccountId ? `/accounts/detail?id=${encodeURIComponent(selectedAccountId)}` : '/accounts'}>LINEの接続設定を見る</TextLink>}
    </ConfirmDialog>

    {/* 共通の「送る前の確かめ」（U1・板 F94nep／RxxfO）。承認が要るときは、承認者を選ぶ下の窓を使う。 */}
    <SendConfirmDialog
      open={confirmOpen && !needsApprovalSingle}
      subtitle={`${title.trim() || '新しい一斉配信'}・${confirmAudienceLabel}`}
      scheduled={sendMode === 'scheduled'}
      state={currentStep ? sendPreview.state : audienceCount === null ? 'error' : 'ready'}
      block={(broadcastRole === 'viewer' || broadcastRole === 'staff') && !canSendBroadcast ? 'no-permission' : null}
      hidePrimary={Boolean(currentStep) && approvalConfigState !== 'ready'}
      unavailableNote={currentStep && approvalConfigState === 'loading' ? '承認の設定を確認しています…' : currentStep && approvalConfigState === 'error' ? '承認の設定を確認できません。確認画面を開き直してください' : undefined}
      onRetry={() => (currentStep ? setPreviewSeq((value) => value + 1) : void runPreflight())}
      recipients={currentStep ? (sendPreview.data?.recipients ?? null) : audienceCount}
      recipientsNote={currentStep && sendPreview.data ? describeExclusion(sendPreview.data.recipients, sendPreview.data.excluded) : exclusionNote ?? undefined}
      purpose="marketing"
      whenLabel={currentStep && sendPreview.data?.quietHoursShiftTo
        ? `${shiftedWhen(sendPreview.data.quietHoursShiftTo)} に送る`
        : sendWhenLabel ?? '送る時間は未設定'}
      whenNote={currentStep && sendPreview.data?.quietHoursShiftTo
        ? '夜の静かな時間（21〜8 時）のため、次の 8:00 に送ります'
        : concurrentBroadcasts.length > 0
          ? '同じ時刻の前後 1 時間に別の予約配信があります'
          : sendMode === 'scheduled' ? '予約は送る時刻の 1 分前まで［予約を取り消す］で止められます' : undefined}
      sender={currentStep ? sendPreview.data?.sender ?? null : null}
      bodyHead={(currentStep && sendPreview.data?.firstText) || String(bubbles.find((b) => b.type === 'text')?.content.text ?? '') || `${knownValue(TYPE_LABELS, bubbles[0]?.type ?? 'text', 'メッセージ')}を送ります`}
      bubbleCount={bubbles.length}
      allRecipients={targetMode === 'all' && !sendPreview.data?.stoppable}
      extraCaution={quotaInsufficient ? (quotaNote ?? undefined) : undefined}
      approval={needsApproval && approvalConfig ? { note: `${formatNumber(approvalConfig.threshold)} 人以上は承認が要る店です。承認されたら${sendMode === 'scheduled' && scheduledDate ? ` ${Number(scheduledDate.slice(5, 7))}/${Number(scheduledDate.slice(8, 10))} ${scheduledTime} に` : ''}送ります` } : null}
      confirmationFields={confirmationFields}
      approvalFields={needsApproval && approvalConfig && audienceCount !== null ? (
        <ApprovalRequestFields
          bare
          recipientCount={audienceCount}
          threshold={approvalConfig.threshold}
          candidates={approvalCandidates}
          candidatesState={approvalCandidatesState}
          approverId={approverId}
          onApproverChange={setApproverId}
          note={approvalNote}
          onNoteChange={setApprovalNote}
        />
      ) : undefined}
      primaryDisabled={!canConfirm || confirmationBlocked || (needsApproval && approverId === '')}
      primaryLabel={needsApproval ? '承認を依頼する' : (() => {
        const n = currentStep ? sendPreview.data?.recipients ?? null : audienceCount
        const shifted = currentStep ? sendPreview.data?.quietHoursShiftTo : null
        if (n !== null && shifted) return `${shiftedShort(shifted)} に ${formatNumber(n)} 人へ送る`
        const shortAt = sendMode === 'scheduled' && scheduledDate ? `${Number(scheduledDate.slice(5, 7))}/${Number(scheduledDate.slice(8, 10))} ${scheduledTime}` : null
        return n === null ? '送る' : sendMode === 'scheduled' ? `${formatNumber(n)} 人に${shortAt ? ` ${shortAt} で` : ''}予約する` : `${formatNumber(n)} 人に送る`
      })()}
      onConfirm={() => (currentStep && !needsApproval ? confirmMessage() : save())}
      onBack={() => { if (!saving) setConfirmOpen(false) }}
      error={error || undefined}
    /></>)
}
