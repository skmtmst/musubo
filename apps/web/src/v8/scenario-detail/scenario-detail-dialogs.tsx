'use client'

import ActionEditor from '@/components/scenarios/action-editor'
import BulkPreviewModal from '@/components/scenarios/bulk-preview-modal'
import { ConditionDialog, MoveReferrersNotice, OnCompleteDialog, TestSendDialog, type OnCompleteMode } from '@/components/scenarios/scenario-dialogs'
import TriggerEditor from '@/components/scenarios/trigger-editor'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import { type SegmentCondition } from '@/components/shared/condition-builder'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { emptyValue } from '@/components/shared/empty-value'
import FolderSelect, { folderById, folderCreator } from '@/components/shared/folder-select'
import { Field } from '@/components/shared/form-controls'
import Notice from '@/components/shared/notice'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { TextArea, TextField } from '@/components/shared/text-field'
import VersionCompare from '@/components/shared/version-compare'
import type { ScenarioSimulation } from '@/lib/api'
import { api } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import type { UnsavedLeaveTarget } from '@/lib/use-unsaved-guard'
import type { DeliveryMode, Folder, ScenarioStep, ScenarioTriggerType } from '@line-crm/shared'
import { Copy } from 'lucide-react'
import type { Dispatch, SetStateAction } from 'react'
import { formatScheduleLabel, messageTypeOptions, ScenarioStats, ScenarioWithSteps, StepFormState, TemplateOpt } from './detail-model'
import styles from './detail.module.css'
import type { StartCheckItem } from './start-checklist'

export function ScenarioDetailDialogs({
  renameOpen, saving, scenario, setEditForm,
  setRenameOpen, handleSaveScenario, editForm, folderState,
  folders, canEdit, setFolders, editFolderMissing,
  compareOpen, setCompareOpen, acceptLatestAndContinue, latestSummary,
  currentSummary, leaveTarget, confirmLeave, cancelLeave,
  startOpen, startBusy, startError, preflightLoading,
  preflightFailed, handleStart, startConfirmed, setStartOpen,
  setStartError, startAccountLabel, triggerHeadline, simulation,
  sortedSteps, startCompleteSummary, setSimRetry, startChecks,
  setStartConfirmed, stopOpen, stopBusy, stopError,
  setStopOpen, setStopError, stats, stopConfirmationCount, deleteConfirmationCount, handleStop,
  duplicateOpen, duplicating, setDuplicateOpen, duplicateName,
  setDuplicateName, modeLabel, handleDuplicate, previewOpen,
  id, setPreviewOpen, deleteStepTarget, deletingStepId,
  deleteStepError, handleDeleteStep, setDeleteStepTarget, setDeleteStepError,
  deleteScenarioOpen, deletingScenario, deleteScenarioError, handleDeleteScenario,
  setDeleteScenarioOpen, setDeleteScenarioError, discardDuplicateOpen, duplicateRemainder,
  discardingDuplicate, discardDuplicateError, handleDiscardDuplicate, setDiscardDuplicateOpen,
  setDiscardDuplicateError, audienceOpen, loadScenario, setAudienceOpen,
  onCompleteOpen, setOnCompleteOpen, actionCounts, setActionTarget,
  stepTargetOpen, stepForm, setStepForm, setStepTargetOpen,
  canTestSend, testSend, deliveryMode, templates,
  setTestSend, triggerOpen, setTriggerOpen, setTriggerCount,
  setTriggerRevision, actionTarget, reloadActionCounts,
}: {
  renameOpen: boolean
  saving: boolean
  scenario: ScenarioWithSteps
  setEditForm: Dispatch<SetStateAction<{ name: string; description: string; triggerType: ScenarioTriggerType; isActive: boolean; allowConcurrent: boolean; folderId: string; }>>
  setRenameOpen: Dispatch<SetStateAction<boolean>>
  handleSaveScenario: () => Promise<void>
  editForm: { name: string; description: string; triggerType: ScenarioTriggerType; isActive: boolean; allowConcurrent: boolean; folderId: string; }
  folderState: "error" | "loading" | "ready"
  folders: Folder[]
  canEdit: boolean
  setFolders: Dispatch<SetStateAction<Folder[]>>
  editFolderMissing: boolean
  compareOpen: boolean
  setCompareOpen: Dispatch<SetStateAction<boolean>>
  acceptLatestAndContinue: () => Promise<void>
  latestSummary: string
  currentSummary: string
  leaveTarget: UnsavedLeaveTarget | null
  confirmLeave: () => void
  cancelLeave: () => void
  startOpen: boolean
  startBusy: boolean
  startError: string
  preflightLoading: boolean
  preflightFailed: boolean
  handleStart: () => Promise<void>
  startConfirmed: boolean
  setStartOpen: Dispatch<SetStateAction<boolean>>
  setStartError: Dispatch<SetStateAction<string>>
  startAccountLabel: string
  triggerHeadline: string
  simulation: ScenarioSimulation | null
  sortedSteps: ScenarioStep[]
  startCompleteSummary: string
  setSimRetry: Dispatch<SetStateAction<number>>
  startChecks: StartCheckItem[]
  setStartConfirmed: Dispatch<SetStateAction<boolean>>
  stopOpen: boolean
  stopBusy: boolean
  stopError: string
  setStopOpen: Dispatch<SetStateAction<boolean>>
  setStopError: Dispatch<SetStateAction<string>>
  stats: ScenarioStats | null
  stopConfirmationCount?: number
  deleteConfirmationCount?: number
  handleStop: () => Promise<void>
  duplicateOpen: boolean
  duplicating: boolean
  setDuplicateOpen: Dispatch<SetStateAction<boolean>>
  duplicateName: string
  setDuplicateName: Dispatch<SetStateAction<string>>
  modeLabel: string
  handleDuplicate: (name?: string) => Promise<void>
  previewOpen: boolean
  id: string
  setPreviewOpen: Dispatch<SetStateAction<boolean>>
  deleteStepTarget: ScenarioStep | null
  deletingStepId: string | null
  deleteStepError: string
  handleDeleteStep: () => Promise<void>
  setDeleteStepTarget: Dispatch<SetStateAction<ScenarioStep | null>>
  setDeleteStepError: Dispatch<SetStateAction<string>>
  deleteScenarioOpen: boolean
  deletingScenario: boolean
  deleteScenarioError: string
  handleDeleteScenario: () => Promise<void>
  setDeleteScenarioOpen: Dispatch<SetStateAction<boolean>>
  setDeleteScenarioError: Dispatch<SetStateAction<string>>
  discardDuplicateOpen: boolean
  duplicateRemainder: { copyId: string; copyName: string; stage: string; detail: string; } | null
  discardingDuplicate: boolean
  discardDuplicateError: string
  handleDiscardDuplicate: () => Promise<void>
  setDiscardDuplicateOpen: Dispatch<SetStateAction<boolean>>
  setDiscardDuplicateError: Dispatch<SetStateAction<string>>
  audienceOpen: boolean
  loadScenario: (fresh?: boolean) => Promise<void>
  setAudienceOpen: Dispatch<SetStateAction<boolean>>
  onCompleteOpen: boolean
  setOnCompleteOpen: Dispatch<SetStateAction<boolean>>
  actionCounts: Record<string, number>
  setActionTarget: Dispatch<SetStateAction<{ hook: "step_sent" | "scenario_completed" | "choice_selected"; stepId: string | null; choiceIndex: number | null; title: string; } | null>>
  stepTargetOpen: boolean
  stepForm: StepFormState
  setStepForm: Dispatch<SetStateAction<StepFormState>>
  setStepTargetOpen: Dispatch<SetStateAction<boolean>>
  canTestSend: boolean
  testSend: { stepId: string | null; label: string; } | null
  deliveryMode: DeliveryMode
  templates: TemplateOpt[]
  setTestSend: Dispatch<SetStateAction<{ stepId: string | null; label: string; } | null>>
  triggerOpen: boolean
  setTriggerOpen: Dispatch<SetStateAction<boolean>>
  setTriggerCount: Dispatch<SetStateAction<number | null>>
  setTriggerRevision: Dispatch<SetStateAction<number>>
  actionTarget: { hook: "step_sent" | "scenario_completed" | "choice_selected"; stepId: string | null; choiceIndex: number | null; title: string; } | null
  reloadActionCounts: () => void
}) {
  return (<>
      {/* 名前・説明・置き場を変える鉛筆の小窓。 */}
      <Dialog
        open={renameOpen}
        busy={saving}
        title="名前・説明・置き場を変える"
        description="ここで変えた内容は、下の「保存する」で確定します。"
        onCancel={() => {
          if (scenario) {
            setEditForm({
              name: scenario.name,
              description: scenario.description ?? '',
              triggerType: scenario.triggerType,
              isActive: scenario.isActive,
              allowConcurrent: scenario.allowConcurrent !== false,
              folderId: scenario.folderId ?? '',
            })
          }
          setRenameOpen(false)
        }}
        footer={
          <DialogActions>
            <Button
              disabled={saving}
              onClick={() => {
                if (scenario) {
                  setEditForm({
                    name: scenario.name,
                    description: scenario.description ?? '',
                    triggerType: scenario.triggerType,
                    isActive: scenario.isActive,
                    allowConcurrent: scenario.allowConcurrent !== false,
                    folderId: scenario.folderId ?? '',
                  })
                }
                setRenameOpen(false)
              }}
            >
              閉じる
            </Button>
            <Button variant="primary" onClick={() => void handleSaveScenario()} disabled={!editForm.name.trim() || saving} busy={saving}>
              この内容で保存する
            </Button>
          </DialogActions>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="シナリオ名" required><SaveErrorField names={["name","editForm.name","edit_form.name","edit_form"]}><TextField
              value={editForm.name}
              onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              maxLength={80}
              required
              aria-label="シナリオ名"
            /></SaveErrorField></Field>
          <Field label="説明"><SaveErrorField names={["description","editForm.description","edit_form.description","edit_form"]}><TextArea
              value={editForm.description}
              onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              rows={3}
              maxLength={500}
              aria-label="説明"
            /></SaveErrorField></Field>
          <div className="flex flex-col gap-1">
            <span className="text-ink-secondary text-xs font-semibold">置き場（フォルダ）</span>
            <SaveErrorField names={["folderId","editForm.folderId","folder_id","edit_form.folder_id","edit_form"]}><FolderSelect
              value={editForm.folderId}
              onChange={(value) => setEditForm({ ...editForm, folderId: value })}
              aria-label="置き場（フォルダ）"
              disabled={folderState !== 'ready'}
              folders={folders.map(folderById)}
              // 一覧の左の列の「フォルダを追加」と同じ口（シナリオのフォルダは共有）。
              onCreate={canEdit
                ? folderCreator((name, color) => api.folders.create({ kind: 'scenario', name, color, accountId: scenario?.lineAccountId ?? null }), folderById, (created) => setFolders((current) => [...current, created]))
                : undefined}
            /></SaveErrorField>
            {folderState === 'error' && (
              <p className="text-status-danger text-xs">フォルダ一覧を読み込めませんでした。</p>
            )}
            {editFolderMissing && (
              <p className="text-warning text-xs">
                いま入っているフォルダが見つかりません（削除されたか、別アカウントのものです）。
              </p>
            )}
          </div>
          <SaveErrorField names={["allowConcurrent","editForm.allowConcurrent","allow_concurrent","edit_form.allow_concurrent","edit_form"]}><Checkbox
            checked={editForm.allowConcurrent}
            onCheckedChange={(checked) => setEditForm({ ...editForm, allowConcurrent: checked })}
          >
            同時購読を許可する（ほかのシナリオが動いている人にも並行して流す）
          </Checkbox></SaveErrorField>
        </div>
      </Dialog>

      {/* ★V8 `kz2B6`「違いを比べる」の窓。最新と入力中の設定の要約を比べる。 */}
      <Dialog
        open={compareOpen}
        title="違いを比べる"
        description="ほかの人が保存した最新の内容と、あなたが直している内容を比べます。"
        cancelLabel="閉じる"
        onCancel={() => setCompareOpen(false)}
        footer={
          <DialogActions><Button type="button" variant="primary" onClick={() => acceptLatestAndContinue()} busyLabel="処理中…">
            最新を読み込んで続ける
          </Button></DialogActions>
        }
      >
        <VersionCompare before={latestSummary} after={currentSummary} />
      </Dialog>

      <UnsavedLeaveDialog open={leaveTarget !== null} subject="シナリオの名前・説明などの変更" onConfirm={confirmLeave} onCancel={cancelLeave} />

      {/* 配信を始める前の確認（F1LK4e）。試算と運用記録は画面の持つ実データ。 */}
      <ConfirmDialog
        open={startOpen}
        title="配信をはじめますか"
        description="始める前の最終確認です。はじめると、条件に合う人から順に届きます。"
        designNode="F1LK4e"
        designWidth={560}
        confirmLabel="この内容ではじめる"
        busy={startBusy}
        error={startError}
        onConfirm={preflightLoading || preflightFailed ? undefined : () => handleStart()}
        // WEB228：「内容と対象を確かめました」のチェックが入るまで「この内容ではじめる」を押せない。
        confirmDisabled={!startConfirmed}
        onCancel={() => {
          if (startBusy) return
          setStartOpen(false)
          setStartError('')
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-ink-faint text-xs">シナリオ</p>
            <p className="text-ink text-sm font-semibold">{scenario.name}</p>
          </div>
          <div>
            <p className="text-ink-faint text-xs">LINEアカウント</p>
            <p className="text-ink text-sm font-semibold">{startAccountLabel}</p>
          </div>
          <div>
            <p className="text-ink-faint text-xs">開始対象</p>
            <p className="text-ink text-sm font-semibold">
              きっかけ：{triggerHeadline}
              {simulation
                ? ` → 対象：${formatNumber(simulation.audience.newStartPlanned)} 人`
                : preflightLoading
                  ? ' → 対象：試算中…'
                  : ' → 対象：まだ分かりません'}
            </p>
          </div>
          <div>
            <p className="text-ink-faint text-xs">通数・終了後</p>
            <p className="text-ink text-sm font-semibold">
              {sortedSteps.length} 通・最後の1通のあと「{startCompleteSummary}」
            </p>
          </div>
        </div>

        <ul className="mt-4 space-y-2">
          {preflightLoading ? (
            <li className="text-ink-faint text-xs">開始前の実データを確認しています…</li>
          ) : null}
          {preflightFailed ? (
            <li className="text-status-danger flex items-center gap-2 text-xs">
              <span>対象人数を試算できなかったため、開始はできません。</span>
              <button
                type="button"
                className="text-action font-semibold hover:underline"
                onClick={() => setSimRetry((n) => n + 1)}
              >
                読み直す
              </button>
            </li>
          ) : null}
          {startChecks.map((item) => (
            <li key={item.label} className={styles.checkRow}>
              <span
                aria-hidden
                className={`${styles.checkMark} ${
                  item.state === 'ok'
                    ? styles.checkOk
                    : item.state === 'warn'
                      ? styles.checkWarn
                      : styles.checkUnknown
                }`}
              >
                {item.state === 'ok' ? '✓' : item.state === 'warn' ? '!' : emptyValue('unknown')}
              </span>
              <span>
                <span className="text-ink block font-medium">{item.label}</span>
                <span className="text-ink-faint block text-xs">{item.detail}</span>
              </span>
            </li>
          ))}
        </ul>

        <Notice tone="warn" className="mt-3">
          始めると取り消せません。止めた人には、再開すると続きから届きます。
        </Notice>
        <div className="mt-3">
          <SaveErrorField names={["startConfirmed","start_confirmed"]}><Checkbox
            checked={startConfirmed}
            disabled={preflightLoading || preflightFailed}
            onCheckedChange={setStartConfirmed}
          >
            内容と対象を確かめました
          </Checkbox></SaveErrorField>
        </div>
        {!startConfirmed && !preflightLoading && !preflightFailed && (
          <p className="text-ink-faint mt-2 text-xs">
            上のチェックを入れるまで「この内容ではじめる」は押せません。
          </p>
        )}
      </ConfirmDialog>

      {/* 一時停止の確認（OPGU2）。板の「止める理由（任意）」は受け口（保存先）が API に無いので置かない（BEHAVIOR.md）。
          絵：幅 560・余白 24・間 12。題の左と実行ボタンに印は無い。説明は題の行（×の 36）の下 12。
          ボタンは窓の帯ではなく本文の続き（上に線・間 14・右寄せ）。 */}
      <Dialog
        open={stopOpen}
        title="配信を止めますか"
        tone="destructive"
        confirmation
        designNode="OPGU2"
        designWidth={560}
        designTop={37}
        designHeaderPadding="24px 24px 0"
        designHeaderHeight={48}
        busy={stopBusy}
        error={stopError}
        onCancel={() => {
          if (stopBusy) return
          setStopOpen(false)
          setStopError('')
        }}
      >
        <div className={styles.stopBody}>
          <OperationTargetSummary accounts={scenario?.lineAccountId === null ? [] : [{ id: scenario?.lineAccountId ?? '' }]} allAccounts={scenario?.lineAccountId === null} />
          <p className={styles.stopDesc}>止めても、途中の人の記録は残ります。再開すると止めたところから続きを送ります。</p>
          <dl className={styles.stopRow}>
            <dt>いま途中の人</dt>
            <dd>
              {stopConfirmationCount === undefined
                ? '確認できません'
                : `${formatNumber(stopConfirmationCount)} 人（止まっているあいだ、新しい人は入りません）`}
            </dd>
          </dl>
          <div className={styles.stopFooter}>
            <Button type="button" onClick={() => { setStopOpen(false); setStopError('') }} disabled={stopBusy}>キャンセル</Button>
            <Button type="button" variant="danger" onClick={() => void handleStop()} disabled={stopBusy} busy={stopBusy} busyLabel="処理中…">一時停止する</Button>
          </div>
        </div>
      </Dialog>

      {/* 複製（Al4Ek）。通・アクション・きっかけを写し、止めた状態で作る。名前は本人が決める。 */}
      <Dialog
        open={duplicateOpen}
        designWidth={600}
        /* 絵の窓は上から300。共通の窓は題の上の余白が絵（24＋題の段28の中央）より5少ないので、題の位置を絵に合わせて305で置く。 */
        designTop={305}
        designNode="Al4Ek"
        title="このシナリオを複製する"
        busy={duplicating}
        onCancel={() => {
          if (duplicating) return
          setDuplicateOpen(false)
        }}
      >
        <div className={styles.dupBody}>
          <Field label="新しい名前" required><SaveErrorField names={["duplicateName","duplicate_name"]}><TextField
              value={duplicateName}
              onChange={(e) => setDuplicateName(e.target.value)}
              maxLength={80}
              required
              aria-label="新しい名前"
            /></SaveErrorField></Field>
          <div className={styles.dupBox}>
            <p className={styles.dupBoxTitle}>引き継ぐもの</p>
            <p className={styles.dupBoxBody}>
              {`・メッセージ ${sortedSteps.length} 通${sortedSteps.some((s) => s.question) ? '（質問を含む）' : ''}・開始のきっかけ・アクション・配信対象の条件・最後の1通の後・配信方式（${modeLabel}）・フォルダ`}
            </p>
          </div>
          <div className={styles.dupBox}>
            <p className={styles.dupBoxTitle}>引き継がないもの</p>
            <p className={styles.dupBoxBody}>・購読中の人・配信の記録</p>
          </div>
        <Notice tone="info">
          <span>複製は「停止中」で作られます。開始のきっかけも写しますが、配信を始めるまで誰にも届きません。</span>
        </Notice>
          {/* 絵（Al4Ek）は操作が真ん中。共通の窓の右寄せの操作の段は使わず、本文の続きに置く。 */}
          <div className={styles.dupActions}>
            <Button variant="secondary" onClick={() => setDuplicateOpen(false)} disabled={duplicating}>
              キャンセル
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleDuplicate(duplicateName)}
              disabled={duplicating || !duplicateName.trim()}
              busy={duplicating}
              busyLabel="複製中…"
            >
              <Copy aria-hidden />
              複製する
            </Button>
          </div>
        </div>
      </Dialog>

      <BulkPreviewModal
        open={previewOpen}
        scenarioId={id}
        onClose={() => setPreviewOpen(false)}
      />

      <ConfirmDialog
        open={deleteStepTarget !== null}
        title={deleteStepTarget ? `${sortedSteps.findIndex((step) => step.id === deleteStepTarget.id) + 1} 通目を削除しますか？` : 'この通を削除しますか？'}
        description={deleteStepTarget
          ? `${sortedSteps.findIndex((step) => step.id === deleteStepTarget.id) + 1} 通目と、その配信対象・送信後アクションが削除されます。到達済みの履歴は監査記録として残ります。この操作は取り消せません。`
          : ''}
        confirmLabel="この通を削除する"
        destructive
        busy={deletingStepId !== null}
        error={deleteStepError}
        onConfirm={() => handleDeleteStep()}
        onCancel={() => {
          if (deletingStepId) return
          setDeleteStepTarget(null)
          setDeleteStepError('')
        }}
      ><OperationTargetSummary accounts={scenario?.lineAccountId === null ? [] : [{ id: scenario?.lineAccountId ?? '' }]} allAccounts={scenario?.lineAccountId === null} /></ConfirmDialog>

      <ConfirmDialog
        open={deleteScenarioOpen && scenario !== null}
        title={scenario ? `「${scenario.name}」を削除しますか？` : 'このシナリオを削除しますか？'}
        description={[
          deleteConfirmationCount === undefined
            ? '購読中の人数は確認できません。'
            : deleteConfirmationCount === 0
              ? '現在購読中の友だちは0人です。'
              : `現在${formatNumber(deleteConfirmationCount)} 人が購読中です。途中の人は続きを受け取れません。`,
          'シナリオの設定と今後の配信が削除されます。',
          'これまでの配信履歴は監査記録として残ります。',
          'この操作は取り消せません。',
        ].join(' ')}
        confirmLabel="このシナリオを削除する"
        destructive
        busy={deletingScenario}
        error={deleteScenarioError}
        onConfirm={() => handleDeleteScenario()}
        onCancel={() => {
          if (deletingScenario) return
          setDeleteScenarioOpen(false)
          setDeleteScenarioError('')
        }}
      >
        <OperationTargetSummary accounts={scenario?.lineAccountId === null ? [] : [{ id: scenario?.lineAccountId ?? '' }]} allAccounts={scenario?.lineAccountId === null} />
        {/* R250: 終了後の移動先にされていると、削除で参照元の設定が変わる。件数が取れたときだけ出す。 */}
        <div className="text-ink-secondary mt-3 space-y-2 text-sm">
          <MoveReferrersNotice scenarioId={id} />
        </div>
      </ConfirmDialog>

      {/* SCENARIO-09: 複製が途中で止まったときの、作りかけコピーの削除確認 */}
      <ConfirmDialog
        open={discardDuplicateOpen && duplicateRemainder !== null}
        title={duplicateRemainder ? `作りかけのコピー「${duplicateRemainder.copyName}」を削除しますか？` : ''}
        description={`複製が「${duplicateRemainder?.stage ?? ''}」の途中で止まったため、内容が欠けた状態で残っています。削除しても元のシナリオは変わりません。この操作は取り消せません。`}
        confirmLabel="作りかけのコピーを削除する"
        destructive
        busy={discardingDuplicate}
        error={discardDuplicateError}
        onConfirm={() => handleDiscardDuplicate()}
        onCancel={() => {
          if (discardingDuplicate) return
          setDiscardDuplicateOpen(false)
          setDiscardDuplicateError('')
        }}
      />

      {/* シナリオ全体の配信対象 */}
      {audienceOpen && scenario && (
        <ConditionDialog
          title="対象の絞り込み"
          description="このシナリオを配る相手を絞ります。購読したあとに条件から外れた人は、送らずに止まります。"
          value={(scenario.audienceCondition as SegmentCondition | null) ?? null}
          onSave={async (next) => {
            const res = await api.scenarios.update(id, { audienceCondition: next } as never)
            if (res.success) await loadScenario(true)
          }}
          onClose={() => setAudienceOpen(false)}
        />
      )}

      {/* 最終コンテンツ配信後の処理 */}
      {onCompleteOpen && scenario && (
        <OnCompleteDialog
          scenarioId={id}
          mode={(scenario.onCompleteMode ?? 'pause') as OnCompleteMode}
          targetScenarioId={scenario.onCompleteScenarioId ?? null}
          onSave={async (mode, target) => {
            const res = await api.scenarios.update(id, {
              onCompleteMode: mode,
              onCompleteScenarioId: target,
            } as never)
            if (!res.success) return res.error
            await loadScenario(true)
            return null
          }}
          onClose={() => setOnCompleteOpen(false)}
          actionCount={actionCounts['__complete__'] ?? 0}
          onOpenActions={() => {
            setOnCompleteOpen(false)
            setActionTarget({
              hook: 'scenario_completed',
              stepId: null,
              choiceIndex: null,
              title: '最終コンテンツを配り終えたあと',
            })
          }}
        />
      )}

      {/* 1通ごとの配信対象。保存はフォームの「保存」でまとめて行う。 */}
      {stepTargetOpen && (
        <ConditionDialog
          title="この通の配信対象"
          description="条件に合わない人には、この通だけ送りません。次の通へはそのまま進みます。"
          value={stepForm.targetCondition}
          onSave={async (next) => {
            setStepForm((prev) => ({ ...prev, targetCondition: next }))
          }}
          onClose={() => setStepTargetOpen(false)}
        />
      )}

      {/* テスト送信 */}
      {canTestSend && testSend && (
        <TestSendDialog
          scenarioId={id}
          lineAccountId={scenario?.lineAccountId ?? null}
          stepId={testSend.stepId}
          stepLabel={testSend.label}
          steps={(testSend.stepId
            ? sortedSteps.filter((row) => row.id === testSend.stepId)
            : sortedSteps
          ).map((row) => ({
            id: row.id,
            stepOrder: row.stepOrder,
            displayOrder: sortedSteps.findIndex((step) => step.id === row.id) + 1,
            timing: formatScheduleLabel(deliveryMode, row),
            kind:
              (row.templateId ? templates.find((t) => t.id === row.templateId)?.name : null) ??
              (messageTypeOptions.find((o) => o.value === row.messageType)?.label ??
                row.messageType),
          }))}
          onClose={() => setTestSend(null)}
        />
      )}

      {/* 開始のきっかけ */}
      {triggerOpen && (
        <TriggerEditor
          scenarioId={id}
          onClose={() => setTriggerOpen(false)}
          onChanged={(count) => { setTriggerCount(count); setTriggerRevision((n) => n + 1) }}
          audienceCondition={scenario.audienceCondition}
          activeNow={stats?.activeNow ?? null}
          lineAccountId={scenario.lineAccountId}
        />
      )}

      {/* アクション設定 */}
      {actionTarget && (
        <ActionEditor
          accountId={scenario?.lineAccountId ?? null}
          scenarioId={id}
          hook={actionTarget.hook}
          stepId={actionTarget.stepId}
          choiceIndex={actionTarget.choiceIndex}
          title={actionTarget.title}
          onClose={() => setActionTarget(null)}
          onChanged={reloadActionCounts}
        />
      )}

</>)
}
