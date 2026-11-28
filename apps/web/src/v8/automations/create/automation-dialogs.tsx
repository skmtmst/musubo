'use client'

import TruncatedText from '@/components/shared/truncated-text'

import ConditionBuilder, { type SegmentCondition } from '@/components/shared/condition-builder'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import Dialog from '@/components/shared/dialog'
import { emptyValue } from '@/components/shared/empty-value'
import { formatNumber } from '@/lib/format'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import type { UnsavedLeaveTarget } from '@/lib/use-unsaved-guard'
import type { Automation } from '@line-crm/shared'
import type { Dispatch, SetStateAction } from 'react'
import styles from './create.module.css'

export function AutomationDialogs({
  conditionOpen, setConditionOpen, condition, setCondition,
  activateConfirmOpen, saving, setActivateConfirmOpen, save, error,
  name, selectedEvent, triggerConfigSummary, targetSummary,
  previewCount, actionSummary, eventType, compareOpen,
  conflict, setCompareOpen, leaveTarget, leaveBusy,
  confirmLeave, cancelLeave,
}: {
  conditionOpen: boolean
  setConditionOpen: Dispatch<SetStateAction<boolean>>
  condition: SegmentCondition | null
  setCondition: Dispatch<SetStateAction<SegmentCondition | null>>
  activateConfirmOpen: boolean
  saving: boolean
  setActivateConfirmOpen: Dispatch<SetStateAction<boolean>>
  save: (activate: boolean, force?: boolean) => Promise<boolean | void>
  error?: string
  name: string
  selectedEvent: { value: Automation["eventType"]; label: string; note: string; }
  triggerConfigSummary: string
  targetSummary: string
  previewCount: number | null
  actionSummary: string
  eventType: string
  compareOpen: boolean
  conflict: { draftId: string; serverVersionId: string; serverName: string; serverEventLabel: string; serverActionCount: number; } | null
  setCompareOpen: Dispatch<SetStateAction<boolean>>
  leaveTarget: UnsavedLeaveTarget | null
  leaveBusy: boolean
  confirmLeave: () => void
  cancelLeave: () => void
}) {
  const validPreviewCount = typeof previewCount === 'number' && Number.isFinite(previewCount) && previewCount >= 0
    ? previewCount
    : null
  const validServerActionCount = conflict
    && typeof conflict.serverActionCount === 'number'
    && Number.isFinite(conflict.serverActionCount)
    && conflict.serverActionCount >= 0
    ? conflict.serverActionCount
    : null
  return (<>
      {/* だれに：条件の窓。一斉配信・シナリオと同じ条件（標準互換・15軸）。 */}
      <Dialog
        open={conditionOpen}
        // 条件は親の下書きで保つ。閉じても入力は消えない。
        dirty={false}
        title="動かす相手"
        description="条件を付けないと、きっかけに当てはまった人全員に動きます。一斉配信やシナリオと同じ条件です。"
        designWidth={720}
        confirmLabel="この条件にする"
        cancelLabel="閉じる"
        onConfirm={() => setConditionOpen(false)}
        onCancel={() => setConditionOpen(false)}
      >
        <ConditionBuilder value={condition} onChange={setCondition} label="このルールで動かす相手" showCount={false} />
      </Dialog>

      <ConfirmDialog
        contentLayout="form"
        open={activateConfirmOpen}
        title="この内容で動かし始めますか"
        description="下書きを保存して、そのまま動かし始めます。内容を確認してください。"
        confirmLabel="保存して動かし始める"
        cancelLabel="戻って直す"
        busy={saving}
        error={error || undefined}
        confirmDisabled={Boolean(conflict)}
        confirmDisabledReason="閉じて最新の内容と比べてください。"
        onSuccess={() => setActivateConfirmOpen(false)}
        onConfirm={() => {
          if (saving || conflict) return
          return save(true)
        }}
        onCancel={() => {
          if (saving) return
          setActivateConfirmOpen(false)
        }}
      >
        <dl className={styles.kvList}>
          <div className={styles.kvRow}><dt>名前</dt><dd><TruncatedText value={name.trim()} /></dd></div>
          <div className={styles.kvRow}><dt>きっかけ</dt><dd><TruncatedText value={`${selectedEvent.label}（${triggerConfigSummary}）`} /></dd></div>
          <div className={styles.kvRow}>
            <dt>だれに</dt>
            <dd><TruncatedText value={`${targetSummary}${validPreviewCount !== null ? ` 見込み ${formatNumber(validPreviewCount)} 人` : ''}`} /></dd>
          </div>
          <div className={styles.kvRow}><dt>すること</dt><dd><TruncatedText value={actionSummary || emptyValue('unconfigured')} /></dd></div>
          <div className={styles.kvRow}>
            <dt>最初に動くのは</dt>
            <dd><TruncatedText value={['datetime', 'daily', 'weekly'].includes(eventType) ? `次の決めた時刻（${triggerConfigSummary}）` : '次にきっかけが起きたとき'} /></dd>
          </div>
        </dl>
        <p className={styles.sideNote}>
          止め方：動かし始めたあとも「オートメーション」の一覧からいつでも止められます。先に確かめたい場合は「下書きを保存」して、1人で試すこともできます。
        </p>
      </ConfirmDialog>

      {/* tJqST の比べる窓。左に自分のいまの入力、右に保存されている内容。 */}
      <Dialog
        open={compareOpen && Boolean(conflict)}
        title="内容を比べる"
        description="左があなたのいまの入力、右が保存されている内容です。"
        confirmLabel="この内容で保存する"
        cancelLabel="閉じる"
        busy={saving}
        onCancel={() => {
          if (saving) return
          setCompareOpen(false)
        }}
        onConfirm={() => {
          if (saving || !conflict) return
          setCompareOpen(false)
          return save(false, true)
        }}
      >
        {conflict ? (
          <div className={styles.dialogBody}>
            <div className={styles.compareGrid}>
              <section className={styles.subBox}>
                <p className={styles.sideNote}>あなたの入力</p>
                <p className={styles.subTitle}>{name.trim() || '（名前なし）'}</p>
                <p className={styles.sideNote}>{selectedEvent.label}</p>
                <p className={styles.sideNote}>{actionSummary || '処理未設定'}</p>
              </section>
              <section className={styles.subBox}>
                <p className={styles.sideNote}>保存されている内容</p>
                <p className={styles.subTitle}>{conflict.serverName || '（名前なし）'}</p>
                <p className={styles.sideNote}>{conflict.serverEventLabel}</p>
                <p className={styles.sideNote}>
                  {validServerActionCount !== null ? `処理 ${formatNumber(validServerActionCount)} 件` : '処理件数を確認できません'}
                </p>
              </section>
            </div>
            <p className={styles.sideNote}>
              「この内容で保存する」と、相手の変更はあなたの内容で上書きされます。
              相手の内容で続けるときは、窓を閉じて「最新を読み込んで続ける」を押してください。
            </p>
          </div>
        ) : null}
      </Dialog>
      <UnsavedLeaveDialog open={leaveTarget !== null} busy={leaveBusy} onConfirm={confirmLeave} onCancel={cancelLeave} />

</>)
}
