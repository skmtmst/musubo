'use client'

import { knownValue } from '@/lib/known-value'
import { broadcastSendLabel, type BroadcastSendMode } from './broadcast-schedule'

import dynamic from 'next/dynamic'

import { SingleOperatorFields } from '@/components/broadcasts/broadcast-approval'
import { type BroadcastStepKey } from '@/components/broadcasts/broadcast-steps'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import Dialog from '@/components/shared/dialog'
import Notice from '@/components/shared/notice'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { type BroadcastBubble } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { abConfirmLine } from '@/v8/broadcast-ab/public/settings/index'
import { useBroadcastAb } from '@/v8/broadcast-ab/public/use-ab/index'
import type { TemplateEditHost } from '@/v8/template-edit/public/host/index'
import { Send } from 'lucide-react'
import type { Dispatch,SetStateAction, ReactNode } from 'react'
import { TYPE_LABELS,formatScheduleTime } from './broadcast-form-model'
import styles from './broadcast-form-v8.module.css'
import { type TestSendView } from './test-send-view'
import { TextField as SharedTextField } from '@/components/shared/text-field'
const TemplateRichEditor = dynamic(() => import('../../v8/template-edit/rich/index'))
const TemplateRichVideoEditor = dynamic(() => import('../../v8/template-edit/rich-video/index'))
const CarouselV8 = dynamic(() => import('../../v8/templates/carousel/index'))

type RenderBroadcastEditorDialogsContext = {
  confirmationBlocked: boolean
  confirmationFields: ReactNode
  ab: ReturnType<typeof useBroadcastAb>
  approvalConfigState: "loading" | "error" | "ready" | "idle"
  approvalCountInput: string
  audienceCount: number | null
  bubbles: BroadcastBubble[]
  canConfirm: boolean
  composerBusy: boolean
  concurrentBroadcasts: { id: string; title: string; scheduledAt: string; }[]
  confirmAudienceLabel: string
  confirmOpen: boolean
  currentStep: BroadcastStepKey | null
  error: string
  evaluatedAtLabel: string | null
  exclusionNote: string | null
  handleTestSend: () => Promise<boolean | void>
  testTargetAccountId: string | null
  inlineComposer: { index: number; kind: "carousel" | "rich_message" | "rich_video"; } | null
  inlineHost: TemplateEditHost | undefined
  measureOpens: boolean
  needsApproval: boolean
  needsApprovalSingle: boolean
  quotaInsufficient: boolean
  quotaNote: string | null
  save: () => Promise<void>
  saveComposerTemplate: () => Promise<void>
  saving: boolean
  scheduledAtIso: () => string | null
  selectedAccountId: string | null
  sendMode: BroadcastSendMode
  sendWhenLabel: string | null
  setApprovalCountInput: Dispatch<SetStateAction<string>>
  setConfirmOpen: Dispatch<SetStateAction<boolean>>
  setTemplateSaveIndex: Dispatch<SetStateAction<number | null>>
  setTemplateSaveName: Dispatch<SetStateAction<string>>
  setTestDialogOpen: Dispatch<SetStateAction<boolean>>
  templateSaveError: string
  templateSaveIndex: number | null
  templateSaveName: string
  testDialogOpen: boolean
  testHistory: TestSendView[]
  testRecipients: { id: string; displayName: string; pictureUrl: string | null; }[]
  testRecipientState: "loading" | "error" | "ready" | "idle"
  testResult: TestSendView | null
  testSending: boolean
  testRetryBlocked?: boolean
  testResultOpen?: boolean
  setTestResultOpen?: Dispatch<SetStateAction<boolean>>
  title: string
  trackLinks: boolean
}

export function renderBroadcastEditorDialogs({ confirmationBlocked, confirmationFields, ab, approvalConfigState, approvalCountInput, audienceCount, bubbles, canConfirm, composerBusy, concurrentBroadcasts, confirmAudienceLabel, confirmOpen, currentStep, error, evaluatedAtLabel, exclusionNote, handleTestSend, testTargetAccountId, inlineComposer, inlineHost, measureOpens, needsApproval, needsApprovalSingle, quotaInsufficient, quotaNote, save, saveComposerTemplate, saving, scheduledAtIso, selectedAccountId, sendMode, sendWhenLabel, setApprovalCountInput, setConfirmOpen, setTemplateSaveIndex, setTemplateSaveName, setTestDialogOpen, templateSaveError, templateSaveIndex, templateSaveName, testDialogOpen, testHistory, testRecipients, testRecipientState, testResult, testSending, testRetryBlocked, testResultOpen, setTestResultOpen, title, trackLinks }: RenderBroadcastEditorDialogsContext) {
  return (<><div data-design-node="FpgxH">
      <ConfirmDialog
        open={confirmOpen && needsApprovalSingle}
        title={sendMode === 'scheduled' ? 'この内容で予約しますか？' : 'この内容で送りますか？'}
        description={
          needsApproval && !needsApprovalSingle
            ? '送る相手・日時・内容を確認し、承認をお願いする人を選んでください。承認されるまで送られません。'
            : sendMode === 'scheduled' ? '送信対象・日時・内容を確認して予約します。予約後も配信開始前までは編集・取消できます。' : '送ると友だちに届きます。送信は取り消せません。対象と内容を確認してください。'
        }
        confirmLabel={needsApproval && !needsApprovalSingle ? '承認を依頼する' : broadcastSendLabel(sendMode)}
        cancelLabel="戻って修正"
        confirmDisabled={confirmationBlocked}
        busy={saving}
        error={error || undefined}
        onCancel={() => { if (!saving) setConfirmOpen(false) }}
        onConfirm={canConfirm && (!currentStep || approvalConfigState === 'ready') ? () => void save() : undefined}
      >
        {abConfirmLine(ab, audienceCount, new Date(scheduledAtIso() ?? Date.now())) ? <Notice tone="info" data-design-node="a5r5Wg">{abConfirmLine(ab, audienceCount, new Date(scheduledAtIso() ?? Date.now()))}</Notice> : null}
        {currentStep && approvalConfigState === 'loading' ? <p role="status" className="text-xs text-ink-faint">承認の設定を確認しています…</p> : currentStep && approvalConfigState === 'error' ? <Notice tone="danger">承認の設定を確認できません。戻ってから確認画面を開き直してください</Notice> : null}
        <dl className="border-hairline divide-hairline divide-y rounded-control border text-sm">
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-ink-faint">管理名</dt>
            <dd className="text-ink text-right font-medium">{title.trim() || '（未入力）'}</dd>
          </div>
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-ink-faint">配信対象</dt>
            <dd className="text-ink text-right font-medium">
              {confirmAudienceLabel}
              <span className="ml-2 tabular-nums">
                {audienceCount === null ? '—' : `${formatNumber(audienceCount)}人`}
              </span>
            </dd>
          </div>
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-ink-faint">除外</dt>
            <dd className="text-ink-secondary text-right">
              {/* **0人と書かない。** 数としての口がまだ無い。 */}
              {exclusionNote ?? <span className="text-ink-faint">—<span className="ml-2 text-xs">除外した人数はまだ取れません</span></span>}
            </dd>
          </div>
          {/* 送信枠・計算時刻・把握できる重複配信もここへまとめる（IDEA-06）。 */}
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-ink-faint">送信枠</dt>
            <dd className={`text-right ${quotaInsufficient ? 'font-medium text-danger' : 'text-ink-secondary'}`}>
              {quotaNote ?? '—'}
            </dd>
          </div>
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-ink-faint">計算時刻</dt>
            <dd className="text-ink-secondary text-right tabular-nums">{evaluatedAtLabel ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-ink-faint">配信日時</dt>
            <dd className="text-ink text-right font-medium tabular-nums">{sendWhenLabel ?? '—'}</dd>
          </div>
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-ink-faint">送る中身</dt>
            <dd className="text-ink text-right font-medium">
              {formatNumber(bubbles.length)}通（{bubbles.map((b) => knownValue(TYPE_LABELS, b.type, b.type)).join('・')}）
            </dd>
          </div>
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-ink-faint">開封の集計</dt>
            <dd className="text-ink-secondary text-right">
              {measureOpens
                ? audienceCount === null
                  ? '有効（対象人数が分かってから判定します）'
                  : audienceCount >= 20 ? '有効' : '有効（20人未満のため集計されません）'
                : '取らない'}
            </dd>
          </div>
          <div className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-ink-faint">URLの短縮</dt>
            <dd className="text-ink-secondary text-right">{trackLinks ? 'する（クリックを数えます）' : 'しない'}</dd>
          </div>
        </dl>

        {/*
          把握できる重複配信（IDEA-06）。同じ時刻の前後1時間に入っている
          別の予約をここでも出す。送信設定の節でだけ出すと、確認の窓で
          読み合わせるときに見落とす。
        */}
        {concurrentBroadcasts.length > 0 && (
          <Notice tone="warn" className="mt-3">
            <p className="font-semibold">同じ時刻の前後1時間に別の予約配信があります</p>
            <ul className="mt-1 list-disc pl-4">
              {concurrentBroadcasts.map((item) => (
                <li key={item.id}>{formatScheduleTime(item.scheduledAt)}　{item.title}</li>
              ))}
            </ul>
          </Notice>
        )}

        {confirmationFields}

        {/*
          二者承認（設計 A-1・A-4）。承認が要る人数のときだけ出す。
          境目が読めているときだけ判定し、取得失敗中は確定させない。
        */}
        {needsApprovalSingle && audienceCount !== null ? (
          <SingleOperatorFields
            recipientCount={audienceCount}
            value={approvalCountInput}
            onChange={setApprovalCountInput}
          />
        ) : null}

        {/* 人数が無いなら送らせない。上で確認のボタン自体を出していない。 */}
        {audienceCount === null ? (
          <Notice tone="danger" className="mt-3">
            対象の人数を数えられていないため、送信・予約できません。
            宛先と本文を確かめてから、もう一度お試しください。
          </Notice>
        ) : audienceCount === 0 ? (
          <Notice tone="warn" role="alert" className="mt-3">
            いま届く人が0人です。宛先の条件を見直してください。
          </Notice>
        ) : null}
      </ConfirmDialog>
    </div>

    <ConfirmDialog
      open={testDialogOpen}
      title="テストを送る"
      description="登録済みのテスト送信先全員のLINEへ、表示確認用のメッセージを送ります。"
      confirmLabel={testSending ? '送信中…' : 'テストを送る'}
      cancelLabel="キャンセル"
      busy={testSending}
      designNode="h0kahp"
      titleIcon={<Send size={20} />}
      confirmIcon={<Send size={16} />}
      onCancel={() => { if (!testSending) setTestDialogOpen(false) }}
      error={testResult?.kind === 'error' ? testResult.message : error || undefined}
      confirmDisabled={testRetryBlocked}
      confirmDisabledReason="届いたかどうか、配信の記録を確認してください。"
      onSuccess={() => { setTestDialogOpen(false); setTestResultOpen?.(true) }}
      onConfirm={testRecipientState === 'ready' && testRecipients.length > 0 ? () => handleTestSend() : undefined}
    >
      <div className="space-y-3">
        <OperationTargetSummary accounts={[{ id: testTargetAccountId ?? '' }]} />
        {ab.hasB && <Notice tone="info">テスト送信は A案で送ります。</Notice>}
        {testRecipientState === 'loading' && <p className="text-sm text-ink-faint">読み込んでいます</p>}
        {testRecipientState === 'error' && <Notice tone="danger">テスト送信先を読み込めませんでした。</Notice>}
        {testRecipientState === 'ready' && testRecipients.length === 0 && (
          <p className="rounded-control bg-canvas-sunken p-3 text-sm text-ink-faint">
            テスト送信先が登録されていません。アカウント設定で、LINE連携済みの担当者を登録してください。
          </p>
        )}
        {testRecipientState === 'ready' && testRecipients.length > 0 && (
          <>
            {/*
              **宛先は選ばない。** 送信APIは宛先を受け取らず、Workerは
              登録済みのテスト送信先全員へ送る。先頭だけ緑の丸を付けると
              1人を選んだように見えるので、全員を同じ見た目で並べる。
              役職はAPIが返さないので、名前から推定して表示しない。
            */}
            <p className="rounded-control bg-canvas-sunken p-3 text-sm text-ink-secondary">
              登録済みのテスト送信先 {formatNumber(testRecipients.length)}名全員へ送信します。
            </p>
            <ul className="space-y-2">
              {testRecipients.map((recipient) => (
                <li key={recipient.id} className="flex items-center gap-3 rounded-control border border-hairline p-3">
                  {recipient.pictureUrl ? <img width={36} height={36} src={recipient.pictureUrl} alt="" className="h-9 w-9 rounded-pill object-cover" /> : (
                    <span className="flex h-9 w-9 items-center justify-center rounded-pill bg-ink-secondary text-sm font-bold text-on-accent">{recipient.displayName.slice(0, 1)}</span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-bold text-ink">{recipient.displayName}</span>
                </li>
              ))}
            </ul>
            {/*
              テスト送信も通常の pushMessage を通すので、LINE公式アカウントの
              送信枠を使う。「消費しません」と書くと実装と食い違う。
            */}
            <Notice tone="info">
              テスト送信もLINE公式アカウントの送信枠を使用します（見込み {formatNumber((testRecipients.length * bubbles.length))}通）。
            </Notice>
          </>
        )}
        {testResult && testResult.kind !== 'error' && (
          <Notice tone={testResult.kind === 'success' ? 'success' : testResult.kind === 'partial' ? 'warn' : 'danger'}>{testResult.message}</Notice>
        )}
        {testHistory.length > 1 && (
          <section>
            <h4 className="text-xs font-bold text-ink-faint">これ以前の実行履歴</h4>
            <ul className="mt-1 space-y-1">
              {testHistory.slice(1).map((entry, index) => (
                <li key={index}><Notice tone={entry.kind === 'success' ? 'success' : entry.kind === 'partial' ? 'warn' : 'danger'}>{entry.message}</Notice></li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </ConfirmDialog>

    <Dialog open={testResultOpen === true} title="テスト送信の結果" onCancel={() => setTestResultOpen?.(false)}>
      {testResult ? <Notice tone={testResult.kind === 'success' ? 'success' : testResult.kind === 'partial' ? 'warn' : 'danger'}>{testResult.message}</Notice> : null}
      {testHistory.length > 1 ? <section>
        <h4 className="text-xs font-bold text-ink-faint">これ以前の実行履歴</h4>
        <ul className="mt-1 space-y-1">{testHistory.slice(1).map((entry, index) => <li key={index}>
          <Notice tone={entry.kind === 'success' ? 'success' : entry.kind === 'partial' ? 'warn' : 'danger'}>{entry.message}</Notice>
        </li>)}</ul>
      </section> : null}
    </Dialog>

  {inlineComposer && inlineHost ? inlineComposer.kind === 'carousel' ? <CarouselV8 key={`${selectedAccountId}-${inlineComposer.index}`} host={inlineHost} /> : inlineComposer.kind === 'rich_message' ? <TemplateRichEditor key={`${selectedAccountId}-${inlineComposer.index}`} host={inlineHost} /> : <TemplateRichVideoEditor key={`${selectedAccountId}-${inlineComposer.index}`} host={inlineHost} /> : null}
  <Dialog open={templateSaveIndex !== null} title="テンプレートにする" description={`${(templateSaveIndex ?? 0) + 1}通目の吹き出しを保存します。ほかの吹き出しは含みません。`} onCancel={() => setTemplateSaveIndex(null)} confirmLabel="保存する" onConfirm={() => void saveComposerTemplate()} busy={composerBusy} error={templateSaveError || undefined}><label>テンプレートの名前<SaveErrorField names={["templateSaveName","name","template_save_name"]}><SharedTextField aria-label="テンプレートの名前" value={templateSaveName} onChange={(event) => setTemplateSaveName(event.target.value)} className={styles.textInput} /></SaveErrorField></label></Dialog></>)
}
