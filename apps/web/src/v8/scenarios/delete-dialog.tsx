'use client'

import type { Scenario } from '@line-crm/shared'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { MoveReferrersNotice } from '@/components/scenarios/scenario-dialogs'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import styles from './list.module.css'

type DeleteTarget = Scenario & { subscriberCount?: number | null; stepCount?: number }

type Props = {
  target: DeleteTarget | null
  busy: boolean
  summary: import('@/lib/api/types/scenarios').ScenarioConfirmation | null
  error: string
  disabled: boolean
  targetStillListed: boolean
  sameScope: boolean
  lockedReason?: string
  countLabel: (count: number | null | undefined) => string
  onConfirm: () => void
  onCancel: () => void
}

/** 対象とアカウントを保持し、一覧変更後は古い確認から削除しない。 */
export default function ScenarioDeleteDialog({ target, busy, error, summary, disabled, targetStillListed, sameScope, lockedReason, countLabel, onConfirm, onCancel }: Props) {
  return <ConfirmDialog
    open={target !== null}
    title={target ? `「${target.name}」を削除しますか？` : ''}
    description="各通の中身と、購読中の人の進み具合が一緒に消えます。すでに送ったメッセージは友だちの手元に残り、取り消せません。この操作は取り消せません。"
    confirmLabel="削除する"
    destructive
    busy={busy}
    error={error}
    onConfirm={onConfirm}
    confirmDisabled={disabled || !targetStillListed || !sameScope}
    confirmLockedReason={targetStillListed && sameScope ? lockedReason : undefined}
    confirmDisabledReason={!targetStillListed || !sameScope ? '一覧が変わりました。閉じて選び直してください。' : undefined}
    onCancel={onCancel}
  >
    {target && <div className={styles.deleteBody}>
      <OperationTargetSummary accounts={target.lineAccountId === null ? [] : [{ id: target.lineAccountId ?? '' }]} allAccounts={target.lineAccountId === null} />
      <MoveReferrersNotice scenarioId={target.id} />
      <p>配信中 {countLabel(summary?.activeCount)} ／ 全状態 {countLabel(summary?.totalCount)} ／ 通数{' '}
        {target.stepCount === undefined ? '— 読み込めませんでした' : `${target.stepCount} 通`}
      </p>
      {target.lineAccountId === null && <p className={styles.deleteWarn}>全アカウント共通のシナリオです。すべてのアカウントから消えます。</p>}
      <p className={styles.deleteFaint}>回答フォーム・流入経路・計測リンクからの参照は数えられていません。消したあとに参照が外れることがあります。</p>
      {!targetStillListed && <SaveErrorField names={["duplicateName", "duplicate_name"]}><p className={styles.deleteWarn}>
        このシナリオが一覧から外れました（LINEアカウントの切り替えなど）。この窓を閉じて、いまの一覧から選び直してください。
      </p></SaveErrorField>}
    </div>}
  </ConfirmDialog>
}
