'use client'

import React, { useContext, useEffect, useLayoutEffect, useState } from 'react'
import DifferencesFilter, { sameKnownValues } from '@/components/shared/differences-filter'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { Field } from '@/components/shared/form-controls'
import Select from '@/components/shared/select'
import type { FriendProfileCandidate } from '@/lib/api'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'

export type ProfileCandidateDraft = Record<string, {
  optionIndex: string
  updateMode: 'auto' | 'fixed'
}>

export function emptyProfileCandidateDraft(
  candidates: FriendProfileCandidate[],
): ProfileCandidateDraft {
  return Object.fromEntries(candidates.map((field) => [
    field.fieldKey,
    { optionIndex: '', updateMode: 'fixed' as const },
  ]))
}

export function selectedProfileCandidateCount(
  candidates: FriendProfileCandidate[],
  draft: ProfileCandidateDraft,
): number {
  return candidates.filter((field) => {
    const optionIndex = draft[field.fieldKey]?.optionIndex
    const index = Number(optionIndex)
    return optionIndex !== ''
      && Number.isInteger(index)
      && index >= 0
      && typeof field.options[index]?.candidateId === 'string'
  }).length
}

export default function MergedProfileDialog({
  open,
  candidates,
  sourceLabels = {},
  draft,
  revision,
  busy,
  error,
  onChange,
  onCancel,
  onSave,
  onDirtyChange,
}: {
  open: boolean
  candidates: FriendProfileCandidate[]
  sourceLabels?: Record<string, string>
  draft: ProfileCandidateDraft
  revision: number
  busy: boolean
  error?: string
  onChange: (next: ProfileCandidateDraft) => void
  onCancel: () => void
  onSave: () => void
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [differencesOnly, setDifferencesOnly] = useState(true)
  useEffect(() => { if (open) setDifferencesOnly(true) }, [open])
  useEffect(() => { if (error) setDifferencesOnly(false) }, [error])
  const visibleCandidates = candidates.filter((field) => !differencesOnly || !sameKnownValues(field.options.map((option) => option.valuePreview)))
  const selectedCount = selectedProfileCandidateCount(candidates, draft)
  const dirty = selectedCount > 0
  const depth = useContext(OverlayDepthContext)
  useLayoutEffect(() => { if (!open) return; onDirtyChange?.(dirty || busy); return () => onDirtyChange?.(false) }, [open, dirty, busy, onDirtyChange])
  const guard = useUnsavedGuard({ dirty: open && (dirty || busy), busy: open && busy, onDiscard: () => { onDirtyChange?.(false); onCancel() } })
  const close = () => guard.guarded(() => { if (!dirty) onCancel() })
  useEffect(() => { if (!open) guard.cancelLeave() }, [open, guard.cancelLeave])
  return (<>
    <Dialog
      open={open}
      title="統合プロフィールを編集"
      description="項目ごとに採用する値と、その後の更新方法を選びます。画面にはマスク済みの値だけを表示します。"
      busy={busy}
      error={error}
      dirty={false}
      onCancel={close}
      designNode="Hn9eE"
      footer={(
        <DialogActions>
          <Button type="button" onClick={close} disabled={busy}>キャンセル</Button>
          <Button type="button" variant="primary" onClick={onSave} disabled={busy || selectedCount === 0} disabledReason={selectedCount === 0 ? '保存する値を選んでください。' : undefined} busy={busy}>
            {`選んだ${selectedCount}項目を保存`}
          </Button>
        </DialogActions>
      )}
    >
      <div className="flex flex-col gap-3">
        <p className="rounded-control bg-canvas-sunken px-3 py-2 text-xs leading-5 text-ink-secondary">
          読み込んだのは第{revision}版です。先に別の人が変更した場合は上書きしません。
        </p>
        <DifferencesFilter checked={differencesOnly} onChange={setDifferencesOnly} />
        {candidates.length > 0 && visibleCandidates.length === 0 ? <p className="text-body">違う項目はありません。</p> : null}
        {candidates.length === 0 ? (
          <p className="text-xs leading-5 text-ink-faint">採用する値の候補はまだありません。</p>
        ) : visibleCandidates.map((field) => {
          const row = draft[field.fieldKey] ?? { optionIndex: '', updateMode: 'fixed' as const }
          return (
            <Card key={field.fieldKey} padding="default">
              <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-3">
                <p className="text-sm font-bold leading-5 text-ink">{field.fieldLabel}</p>
                <Field label="採用する値">
                  <SaveErrorField names={["optionIndex","row.optionIndex","option_index","row.option_index"]}><Select
                    size="full"
                    className="w-full"
                    aria-label={`${field.fieldLabel}の採用値`}
                    value={row.optionIndex}
                    onChange={(value) => onChange({
                      ...draft,
                      [field.fieldKey]: { ...row, optionIndex: value },
                    })}
                    options={[
                      { value: '', label: '変更しない' },
                      ...field.options.map((option, index) => ({
                        value: String(index),
                        label: `${sourceLabels[option.sourceFriendId] || option.sourceLabel}：${option.valuePreview ?? '値は未取得'}`,
                      })),
                    ]}
                  /></SaveErrorField>
                </Field>
                <Field label="これからの更新">
                  <SaveErrorField names={["updateMode","row.updateMode","update_mode","row.update_mode"]}><Select
                    size="full"
                    className="w-full"
                    aria-label={`${field.fieldLabel}の更新方法`}
                    value={row.updateMode}
                    disabled={row.optionIndex === ''}
                    onChange={(value) => onChange({
                      ...draft,
                      [field.fieldKey]: {
                        ...row,
                        updateMode: value as 'auto' | 'fixed',
                      },
                    })}
                    options={[
                      { value: 'fixed', label: 'この値で固定' },
                      { value: 'auto', label: '同じ取得元の新しい値で更新' },
                    ]}
                  /></SaveErrorField>
                </Field>
              </div>
            </Card>
          )
        })}
      </div>
    </Dialog>
    <OverlayDepthContext.Provider value={depth + 1}><UnsavedLeaveDialog open={open && guard.leaveTarget !== null} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} busy={busy} /></OverlayDepthContext.Provider>
  </>)
}
