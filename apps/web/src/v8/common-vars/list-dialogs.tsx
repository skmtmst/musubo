'use client'
import TruncatedText from '@/components/shared/truncated-text'
import CommonVarDeleteFields from './delete-fields'
import StatusBadge from '@/components/shared/status-badge'
import { DetailContent, DetailField, DetailInlineEdit } from '@/components/shared/detail-content'

import type { CommonVarDeleteImpactItem } from '@line-crm/shared'

import Button from '@/components/shared/button'
import ConfirmDialog, { deleteConfirmationTitle } from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import DetailPanel from '@/components/shared/detail-panel'
import Dialog,{ DialogActions } from '@/components/shared/dialog'
import Disclosure from '@/components/shared/disclosure'
import { emptyValue } from '@/components/shared/empty-value'
import EntitySelect,{ entityOptionMetadata } from '@/components/shared/entity-select'
import { folderDisplayColor,type FolderDotFolder } from '@/components/shared/folder-dot'
import { Field } from '@/components/shared/form-controls'
import InlineEdit from '@/components/shared/inline-edit'
import Notice from '@/components/shared/notice'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { withViewTransition } from '@/components/shared/view-transition'
import { type CommonVarReplacementCandidate,type CommonVarReplacementImpact } from '@/lib/api'
import { formatStamp } from '@/lib/common-vars'
import { formatNumber } from '@/lib/format'
import type { CommonVar,CommonVarDeleteImpact } from '@line-crm/shared'
import { Pause,TriangleAlert } from 'lucide-react'
import type { Dispatch,RefObject,SetStateAction } from 'react'
import { formatListDate,formatVarValue } from './list-model'
import styles from './list.module.css'
import { blockedReason,canDelete as canDeleteVar,checkedAtText,consequenceText,placeholderText,reasonRequirement,splitItems,unavailableText,usageText } from './model'
import { TextField as SharedTextField } from '@/components/shared/text-field'

type RenderCommonVarDialogsContext = {
  activeIndex: number
  activeItem: CommonVar | null
  activeStopped: boolean
  applyStatus: () => Promise<void>
  batchReason: string
  batchRequestRef: RefObject<{ accountId: string | null; generation: number; }>
  canWrite: boolean
  closeDelete: () => void
  closeStatusDialog: () => void
  confirmDirectDelete: () => Promise<void>
  confirmReplacement: () => Promise<void>
  confirmStopInstead: () => Promise<void>
  current: CommonVar[]
  deleteBatchError: string
  deleteBusy: boolean
  deleteChoice: "stop" | "replace"
  deleteError: string
  deleteImpact: CommonVarDeleteImpact | null
  deletePhase: "loading" | "idle" | "ready" | "error"
  deleteReason: string
  deleteTarget: CommonVar | null
  deleteTargets: CommonVar[]
  deleting: boolean
  folderDotOf: (row: { folderId: string | null; }) => FolderDotFolder | null
  items: CommonVar[]
  openDelete: (item: CommonVar) => Promise<void>
  openStatusDialog: (item: CommonVar, action: "stop" | "resume") => void
  panelStatus: boolean
  removeSelected: () => Promise<void>
  renameVar: (item: CommonVar, next: string) => Promise<void>
  replacementCandidates: CommonVarReplacementCandidate[]
  replacementId: string
  replacementImpact: CommonVarReplacementImpact | null
  replacementPhase: "loading" | "idle" | "ready" | "error"
  router: ReturnType<typeof import('@/components/shared/list-navigation').useListNavigationRouter>
  selectedAccountId: string | null
  selectReplacement: (nextId: string) => Promise<void>
  setActiveId: Dispatch<SetStateAction<string | null>>
  setBatchReason: Dispatch<SetStateAction<string>>
  setDeleteBatchError: Dispatch<SetStateAction<string>>
  setDeleteChoice: Dispatch<SetStateAction<"stop" | "replace">>
  setDeleteReason: Dispatch<SetStateAction<string>>
  setDeleteTargets: Dispatch<SetStateAction<CommonVar[]>>
  setPanelStatus: Dispatch<SetStateAction<boolean>>
  setStatusError: Dispatch<SetStateAction<string>>
  setStatusReason: Dispatch<SetStateAction<string>>
  setTypedKey: Dispatch<SetStateAction<string>>
  setUsageExpanded: Dispatch<SetStateAction<boolean>>
  statusAction: "stop" | "resume"
  statusBusy: boolean
  statusError: string
  statusReason: string
  statusScheduled: CommonVarDeleteImpactItem[]
  statusTarget: CommonVar | null
  typedKey: string
  usageExpanded: boolean
  nameSaving: boolean
  nameReset: number
  setNameDirty: (dirty: boolean) => void
  setNameSaving: (saving: boolean) => void
  protect: (action: () => void) => void
}

export function renderCommonVarDialogs({ activeIndex, activeItem, activeStopped, applyStatus, batchReason, batchRequestRef, canWrite, closeDelete, closeStatusDialog, confirmDirectDelete, confirmReplacement, confirmStopInstead, current, deleteBatchError, deleteBusy, deleteChoice, deleteError, deleteImpact, deletePhase, deleteReason, deleteTarget, deleteTargets, deleting, folderDotOf, items, openDelete, openStatusDialog, panelStatus, removeSelected, renameVar, replacementCandidates, replacementId, replacementImpact, replacementPhase, router, selectedAccountId, selectReplacement, setActiveId, setBatchReason, setDeleteBatchError, setDeleteChoice, setDeleteReason, setDeleteTargets, setPanelStatus, setStatusError, setStatusReason, setTypedKey, setUsageExpanded, statusAction, statusBusy, statusError, statusReason, statusScheduled, statusTarget, typedKey, usageExpanded, nameSaving, nameReset, setNameDirty, setNameSaving, protect }: RenderCommonVarDialogsContext) {
  return ((
    <>
      {/* 止める窓（板 `Hhl9M`）。下の窓を隠すため、削除の窓とは同時に出さない。 */}
      <Dialog
        open={statusTarget !== null && statusTarget.lineAccountId === selectedAccountId && deleteTarget === null && !panelStatus}
        designNode="Hhl9M"
        designWidth={480}
        designLayout="stacked"
        footerAlign="center"
        title={statusTarget ? `「${statusTarget.name}」を${statusAction === 'stop' ? '止める' : '再開する'}` : ''}
        description={
          statusAction === 'stop'
            ? statusTarget?.usageCount === undefined
              ? '止めているあいだ、この共通情報を差し込んだ配信は送られません。あとで再開できます。'
              : `止めているあいだ、この共通情報を差し込んだ配信は送られません（${formatNumber(statusTarget.usageCount)}か所）。あとで再開できます。`
            : 'この共通情報を再び配信で使えるようにします。'
        }
        busy={statusBusy}
        error={statusError || undefined}
        onCancel={closeStatusDialog}
        footer={
          <DialogActions>
            <Button type="button" onClick={closeStatusDialog} disabled={statusBusy}>
              キャンセル
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => void applyStatus()}
              disabled={statusBusy}
              busy={statusBusy}
              busyLabel={statusAction === 'stop' ? '止めています…' : '再開しています…'}
            >
              {statusAction === 'stop' ? (
                <>
                  <Pause size={16} aria-hidden="true" />
                  止める
                </>
              ) : '再開する'}
            </Button>
          </DialogActions>
        }
      >
        {statusTarget ? (
          <div className={styles.dialogBody}>
            <OperationTargetSummary accounts={[{ id: statusTarget.lineAccountId ?? '' }]} />
            {statusAction === 'stop' && statusTarget.nextSchedule ? (
              <Notice tone="warn" role="note" icon={<TriangleAlert size={16} aria-hidden="true" />}>
                <span>
                  決めた日時に変わる予約（{formatStamp(statusTarget.nextSchedule.effectiveFrom)}に「{statusTarget.nextSchedule.value || '（空）'}」へ）があります。止める前に予定も見直してください。
                </span>
              </Notice>
            ) : null}
            <Field label={<><span className={styles.dialogLabel}>
                {statusAction === 'stop' ? '止める理由（記録に残ります）' : '再開する理由（記録に残ります）'}
              </span></>} requirement={reasonRequirement} error={statusError && reasonRequirement.check(statusReason)}><SaveErrorField names={["statusReason","statusError","changeReason","status_reason","status_error"]}><SharedTextField
                value={statusReason}
                onChange={(e) => { setStatusError(''); setStatusReason(e.target.value) }}
                placeholder={statusAction === 'stop' ? 'キャンペーンが終わったため' : '新しい期間の案内を始めるため'}
                className={styles.dialogInput}
              /></SaveErrorField></Field>
            {statusAction === 'stop' && statusScheduled.length > 0 ? (
              <Notice tone="warn" appearance="soft" icon={<TriangleAlert size={16} aria-hidden="true" />}>
                  予約中の{statusScheduled[0].kindLabel}「{statusScheduled[0].name}」が送られなくなります。
                  {statusScheduled.length > 1 ? `ほか${formatNumber(statusScheduled.length - 1)} 件` : ''}
              </Notice>
            ) : null}
          </div>
        ) : null}
      </Dialog>

      {/* 削除の窓（板 `xxKtW`）。使われているものは差し替えか止めるへ導く。 */}
      <Dialog
        open={deleteTarget !== null && deleteTarget.lineAccountId === selectedAccountId}
        designNode="xxKtW"
        designWidth={480}
        designTop={240}
        designHeaderPadding="24px 24px 0"
        /* 絵 ：まだ消せないときは赤い題にしない（差し替え・止めるへ導く窓）。消せるときだけ赤。 */
        tone={deleteImpact && !deleteImpact.canDelete ? 'default' : 'destructive'}
        title={deleteTarget ? deleteImpact && !deleteImpact.canDelete ? '「' + deleteTarget.name + '」はまだ消せません' : deleteConfirmationTitle(deleteTarget.name) : ''}
        titleContent={deleteTarget ? <TruncatedText value={deleteImpact && !deleteImpact.canDelete ? '「' + deleteTarget.name + '」はまだ消せません' : deleteConfirmationTitle(deleteTarget.name)} /> : undefined}
        busy={deleteBusy}
        error={deleteError || undefined}
        onCancel={closeDelete}
        footer={deleteTarget ? (<DialogActions>
            <Button type="button" onClick={closeDelete} disabled={deleteBusy}>
              キャンセル
            </Button>
            {deletePhase === 'ready' && deleteImpact && !deleteImpact.canDelete && deleteChoice === 'replace' ? (<Button
                type="button"
                variant="danger"
                onClick={() => void confirmReplacement()}
                disabled={deleteBusy || replacementPhase !== 'ready' || !replacementImpact?.canReplace || !deleteReason.trim()}
                disabledReason={replacementPhase !== 'ready' ? '差し替え後の影響を確認してください。' : !replacementImpact?.canReplace ? '差し替えられない箇所を確認してください。' : !deleteReason.trim() ? '消した理由・止める理由を入力してください。' : undefined}
                title={deleteBusy ? '差し替えています' : replacementPhase !== 'ready' ? '差し替え後の影響を確認してください' : !replacementImpact?.canReplace ? '差し替えられない箇所を確認してください' : !deleteReason.trim() ? '消した理由・止める理由を入力してください' : undefined}
                busy={deleteBusy}
                busyLabel="差し替え中…"
              >
                差し替えて消す
              </Button>) : null}
            {deletePhase === 'ready' && deleteImpact && !deleteImpact.canDelete && deleteChoice === 'stop' ? (<Button
                type="button"
                variant="primary"
                onClick={() => void confirmStopInstead()}
                disabled={deleteBusy || !deleteReason.trim()}
                disabledReason={!deleteReason.trim() ? '消した理由・止める理由を入力してください。' : undefined}
                title={deleteBusy ? '止めています' : !deleteReason.trim() ? '消した理由・止める理由を入力してください' : undefined}
                busy={deleteBusy}
                busyLabel="止めています…"
              >
                止める
              </Button>) : null}
            {deletePhase === 'ready' && deleteImpact && deleteImpact.canDelete ? (<Button
                  type="button"
                  variant="danger"
                  disabled={!canDeleteVar({ impact: deleteImpact, typedKey, reason: deleteReason, busy: deleteBusy })}
                  disabledReason={blockedReason({ impact: deleteImpact, typedKey, reason: deleteReason }) ?? undefined}
                  onClick={() => void confirmDirectDelete()}
                  busy={deleteBusy}
                  busyLabel="処理中…"
                >
                  このまま削除
                </Button>) : null}
          </DialogActions>) : undefined}
      >
        {deleteTarget ? (
          <div className={`${styles.dialogBody} ${styles.deleteBody}`}>
            <OperationTargetSummary accounts={[{ id: deleteTarget.lineAccountId ?? '' }]} />
            <DetailField label="削除する共通情報" multiline>{deleteTarget.name}</DetailField>
            {/* 絵 xxKtW：説明は窓の横いっぱい（×の列の下まで）。共通の窓の説明は×の左までなので本文側に置く。 */}
            <p className={styles.deleteLead}>
              {deleteImpact && !deleteImpact.canDelete
                ? `${formatNumber(deleteImpact.total)}か所に差し込まれています。消すと、そこが空欄のまま送られます。先に差し込みを外してください。`
                : 'この共通情報と、登録値・次回予約を削除します。テンプレート・配信・フォルダ・友だちは削除しません。'}
            </p>
            {deletePhase === 'loading' ? (
              <p className={styles.dialogLead}>使われている場所を確認しています…</p>
            ) : deletePhase === 'error' ? (
              <Notice tone="danger" >使用先を確認できませんでした。読み直してから、もう一度お試しください。</Notice>
            ) : deleteImpact ? (
              <>
                {splitItems(deleteImpact.items).historical.length > 0 ? (
                  <p className={styles.dialogHint}>
                    送信済みの配信はこれから変わりません（削除を止める理由には含めません）。
                    {splitItems(deleteImpact.items).historical.map((usage) => `${usage.kindLabel}「${usage.name}」`).join('、')}
                  </p>
                ) : null}
                {deleteImpact.canDelete ? (
                  <>
                    <p className={styles.dialogLead}>{usageText(deleteImpact)}</p>
                    {consequenceText(deleteImpact) ? (
                      <p className={styles.dialogLead}>{consequenceText(deleteImpact)}</p>
                    ) : null}
                  </>
                ) : null}

                {(() => {
                  const blocking = splitItems(deleteImpact.items).blocking
                  const visible = usageExpanded ? blocking : blocking.slice(0, 2)
                  const rest = Math.max(0, deleteImpact.blockingTotal - visible.length)
                  return blocking.length > 0 ? (
                    <div className={styles.usageList}>
                      <ul>
                        {visible.map((usageItem) => (
                          <li key={`${usageItem.kind}-${usageItem.href}`} className={styles.usageItem}>
                            <span className={styles.usageItemName}>
                              {`${usageItem.kindLabel}「${usageItem.name}」`}
                            </span>
                            <a href={usageItem.href} className={styles.usageItemLink}>開いて外す</a>
                          </li>
                        ))}
                      </ul>
                      {rest > 0 || usageExpanded ? (
                        <div className={styles.usageItem}>
                          <span className={styles.usageMore}>{usageExpanded ? `${formatNumber(blocking.length)}か所を表示中` : `ほか ${formatNumber(rest)}か所`}</span>
                          {blocking.length > 2 ? (
                            <button
                              type="button"
                              className={styles.usageItemLink}
                              onClick={() => setUsageExpanded((prev) => !prev)}
                            >
                              {usageExpanded ? '畳む' : 'すべて見る'}
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null
                })()}

                {!deleteImpact.canDelete ? (
                  <div className={styles.choiceGroup} role="radiogroup" aria-label="どうしますか">
                    <p className={styles.dialogQuestion}>
                      どうしますか
                    </p>
                    <div
                      className={styles.choiceBox}
                      data-active={deleteChoice === 'replace' || undefined}
                      role="radio"
                      aria-checked={deleteChoice === 'replace'}
                      tabIndex={0}
                      onClick={() => setDeleteChoice('replace')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setDeleteChoice('replace')
                        }
                      }}
                    >
                      <span className={styles.choiceMark} aria-hidden="true" />
                      <span className={styles.choiceTitle}>別の共通情報に差し替えて消す（おすすめ）</span>
                    </div>
                    {deleteChoice === 'replace' ? (
                      <>
                        <SaveErrorField names={["replacementId","replacement_id"]}><EntitySelect
                          size="full"
                          value={replacementId}
                          disabled={deleteBusy || replacementCandidates.length === 0}
                          onChange={(value) => void selectReplacement(value)}
                          aria-label="差し替え先"
                          options={replacementCandidates.length > 0
                            ? replacementCandidates.map((candidate) => {
                              const item = items.find((row) => row.id === candidate.id), folder = item ? folderDotOf(item) : null
                              return { ...entityOptionMetadata(item ?? candidate), value: candidate.id, color: folder ? folderDisplayColor(folder) : undefined, label: `差し替え先：${candidate.name} ${placeholderText(candidate.varKey)}` }
                            })
                            : [{ value: '', label: replacementPhase === 'loading' ? '候補を読み込んでいます' : '差し替えられる候補がありません' }]}
                        /></SaveErrorField>
                        {replacementPhase === 'loading' ? (
                          <p className={styles.dialogHint}>差し替え後の影響を確認しています…</p>
                        ) : replacementPhase === 'error' ? (
                          <p className={styles.dialogError}>差し替え後の影響を確認できませんでした。</p>
                        ) : replacementImpact ? (
                          <p className={replacementImpact.canReplace ? styles.choiceNote : styles.dialogError}>
                            {replacementImpact.canReplace
                              ? `差し替えると、${formatNumber(replacementImpact.replaceableTotal)}か所の「${formatVarValue(deleteTarget.type, deleteTarget.value) || '（空）'}」が${replacementImpact.replacement.name}の中身になります。`
                              : `${formatNumber(replacementImpact.blockedTotal)}か所は自動で差し替えられません。先に個別に確認してください。`}
                          </p>
                        ) : null}
                      </>
                    ) : null}
                    <div
                      className={styles.choiceBox}
                      data-active={deleteChoice === 'stop' || undefined}
                      role="radio"
                      aria-checked={deleteChoice === 'stop'}
                      tabIndex={0}
                      onClick={() => setDeleteChoice('stop')}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          setDeleteChoice('stop')
                        }
                      }}
                    >
                      <span className={styles.choiceMark} aria-hidden="true" />
                      <span className={styles.choiceTitle}>消さずに止める</span>
                    </div>
                    {deleteChoice === 'stop' ? (
                      <p className={styles.choiceNote}>止めているあいだ、差し込んだ配信は送られません。あとで再開できます。</p>
                    ) : null}
                  </div>
                ) : null}

                {unavailableText(deleteImpact) ? (
                  <p className={styles.dialogHint}>{unavailableText(deleteImpact)}</p>
                ) : null}

                <CommonVarDeleteFields key={deleteTarget.id} impact={deleteImpact} reason={deleteReason}
                  typedKey={typedKey} onReasonChange={setDeleteReason} onTypedKeyChange={setTypedKey} error={deleteError} />

                <Disclosure title="確認した範囲" size="compact"><p className={styles.dialogHint}>
                  {checkedAtText(deleteImpact.checkedAt)} 時点で、テンプレート・一斉配信・シナリオ・リマインダ・自動応答・回答フォーム・オートメーション・友だち追加時・共通アクションの9種類を確認しました。
                </p></Disclosure>
              </>
            ) : null}
          </div>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={deleteTargets.length > 0 && deleteTargets.every(item => item.lineAccountId === selectedAccountId)}
        title={deleteTargets.length === 1
          ? `「${deleteTargets[0]?.name ?? ''}」を削除しますか？`
          : `「${deleteTargets[0]?.name ?? ''}」ほか${deleteTargets.length - 1} 件を削除しますか？`}
        description={`選択した${formatNumber(deleteTargets.length)} 件の共通情報と、登録値・次回予約を削除します。テンプレート、配信、フォルダ、友だちは削除しません。この操作は元に戻せません。`}
        confirmLabel="削除する"
        destructive
        busy={deleting}
        error={deleteBatchError || undefined}
        onConfirm={() => removeSelected()}
        onCancel={() => {
          if (deleting) return
          batchRequestRef.current = {
            accountId: selectedAccountId,
            generation: batchRequestRef.current.generation + 1,
          }
          setDeleteBatchError('')
          setBatchReason('')
          setDeleteTargets([])
        }}
      >
        <OperationTargetSummary accounts={[...new Set(deleteTargets.map(item => item.lineAccountId ?? ''))].map(id => ({ id }))} />
        <Field label="消した理由" requirement={reasonRequirement}><SaveErrorField names={["batchReason","batch_reason"]}><SharedTextField
            value={batchReason}
            onChange={(e) => setBatchReason(e.target.value)}
            placeholder="店舗情報の変更のため"
            className={styles.dialogInput}
          /></SaveErrorField></Field>
      </ConfirmDialog>

      {activeItem ? (
        <DetailPanel
          open
          busy={nameSaving}
          title={activeItem.name}
          description={placeholderText(activeItem.varKey)}
          onClose={() => protect(() => {
            setActiveId(null)
            setPanelStatus(false)
          })}
          hasPrev={activeIndex > 0}
          hasNext={activeIndex >= 0 && activeIndex < current.length - 1}
          onPrev={() => setActiveId(current[activeIndex - 1]?.id ?? null)}
          onNext={() => setActiveId(current[activeIndex + 1]?.id ?? null)}
          actions={{ primary: <Button type="button" variant="primary" onClick={() => protect(() => withViewTransition(() => router.push(`/contents/vars/edit?id=${activeItem.id}`)))} busyLabel="移動中…">
                編集する
              </Button>,
    menuItems: [...([{ allowed: canWrite, id: 'detail-0', label: (activeStopped ? '再開する' : '止める'), onSelect: () => protect(() => openStatusDialog(activeItem, activeStopped ? 'resume' : 'stop')) }]),
        ...([{ allowed: canWrite, id: 'detail-1', label: "削除する", onSelect: () => protect(() => { void openDelete(activeItem) }), tone: 'danger' as const }])] }}
         status={<StatusBadge tone={activeStopped ? 'neutral' : (activeItem.status ?? 'active') === 'draft' ? 'warning' : 'success'}>{activeStopped ? '停止中' : (activeItem.status ?? 'active') === 'draft' ? '下書き' : '使用中'}</StatusBadge>}>
<DetailContent>
          <div className={styles.panelBody}>
            <DetailField label="名前"> <DetailInlineEdit allowed={canWrite}
                value={activeItem.name}
                label="共通情報の名前"
                maxLength={100}
                preserveDirtyOnBlur onDirtyChange={setNameDirty} onSavingChange={setNameSaving} resetToken={nameReset}
                onSave={(next) => renameVar(activeItem, next)}
              /> </DetailField>
            <DetailField label="中身">
              {formatVarValue(activeItem.type, activeItem.value) || '（空）'}
             </DetailField>

            <DetailField label="使っている所">
              {activeItem.usageCount === undefined
                ? '—（未取得）'
                : activeItem.usageCount === 0
                  ? emptyValue('none')
                  : `${formatNumber(activeItem.usageCount)}か所`}
             </DetailField>
            <DetailField label="更新・次回">
              {activeItem.nextSchedule
                ? `${formatListDate(activeItem.updatedAt)} ／ ${formatStamp(activeItem.nextSchedule.effectiveFrom)}に変更`
                : `${formatListDate(activeItem.updatedAt)} ／ 予定なし`}
             </DetailField>
            {panelStatus && statusTarget?.id === activeItem.id && statusTarget.lineAccountId === selectedAccountId ? (
              <>
                <OperationTargetSummary accounts={[{ id: statusTarget.lineAccountId ?? '' }]} />
                <p className={styles.panelLabel}>
                  {statusAction === 'stop' ? '止める理由（記録に残ります）' : '再開する理由（記録に残ります）'}
                </p>
                <div className={styles.panelBody}>
                  <SaveErrorField names={["statusReason","statusError","changeReason","status_reason","status_error"]}><SharedTextField
                    value={statusReason}
                    onChange={(e) => { setStatusError(''); setStatusReason(e.target.value) }}
                    placeholder={statusAction === 'stop' ? 'キャンペーンが終わったため' : '新しい期間の案内を始めるため'}
                    aria-label={statusAction === 'stop' ? '止める理由' : '再開する理由'}
                    disabled={statusBusy}
                    className={styles.dialogInput}
                  /></SaveErrorField>
                  <Button
                    type="button"
                    variant="primary"
                    disabled={statusBusy}
                    busy={statusBusy}
                    onClick={() => void applyStatus()}
                   busyLabel={(statusAction === 'stop' ? '止めています…' : '再開しています…')}>
                    {(statusAction === 'stop' ? '止める' : '再開する')}
                  </Button>
                </div>
                {statusError ? <Notice tone="danger" >{statusError}</Notice> : null}
              </>
            ) : null}
          </div>

</DetailContent>
</DetailPanel>
      ) : null}
    </>
  ))
}
