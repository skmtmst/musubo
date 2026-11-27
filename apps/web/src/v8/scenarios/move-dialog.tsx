'use client'

import type { Folder, Scenario } from '@line-crm/shared'
import type { ConfirmedUndoHandle } from '@/lib/undoable'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import FolderSelect from '@/components/shared/folder-select'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import styles from './list.module.css'

type Props = {
  ids: string[] | null
  scenarios: Scenario[]
  folders: Folder[]
  accountTargets: { accounts: Array<{ id: string }>; allAccounts: boolean }
  disabled: boolean
  sameScope: boolean
  lockedReason?: string
  pending: ConfirmedUndoHandle | null
  draft: string
  onDraftChange: (value: string) => void
  onConfirm: () => void
  onClose: () => void
}

/** 保持した移動先と対象のアカウントを確認してから実行する。 */
export default function ScenarioMoveDialog({ ids, scenarios, folders, accountTargets, disabled, sameScope, lockedReason, pending, draft, onDraftChange, onConfirm, onClose }: Props) {
  const hasTargets = Boolean(ids && ids.length > 0)
  const isPending = Boolean(pending)
  return <ConfirmDialog
    open={ids !== null}
    title={ids && ids.length === 1 ? `「${scenarios.find(s => s.id === ids[0])?.name ?? 'シナリオ'}」のフォルダを移動` : `${ids?.length ?? 0} 件のシナリオのフォルダを移動`}
    description="移動先のフォルダを選んでください。「未分類」を選ぶとフォルダから外れます。"
    confirmLabel="移動する"
    confirmDisabled={disabled || !sameScope || !hasTargets || isPending}
    confirmLockedReason={sameScope ? lockedReason : undefined}
    confirmDisabledReason={!sameScope
      ? 'LINEアカウントが変わりました。閉じて選び直してください。'
      : !hasTargets
        ? '移動するシナリオを選んでください。'
        : undefined}
    pendingUndo={pending} onSuccess={onClose} onUndone={onClose}
    busyLabel="移動中…"
    onConfirm={() => { if (disabled || !sameScope || !hasTargets || isPending) return; return onConfirm() }}
    onCancel={onClose}
  >
    <OperationTargetSummary accounts={accountTargets.accounts} allAccounts={accountTargets.allAccounts} />
    <div className={styles.moveBody}>
      <span className={styles.moveLabel}>移動先のフォルダ</span>
      <SaveErrorField names={["moveDraft", "move_draft"]}><FolderSelect
        aria-label="移動先のフォルダ" size="full" value={draft}
        disabled={disabled || !sameScope || !hasTargets || isPending}
        lockedReason={sameScope ? lockedReason : undefined}
        onChange={onDraftChange}
        folders={folders.map(folder => ({ value: folder.id, label: folder.name }))}
      /></SaveErrorField>
    </div>
  </ConfirmDialog>
}
