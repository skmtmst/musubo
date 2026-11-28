'use client'

import { notifySaved } from '@/components/shared/toast'

import { useState } from 'react'
import type { AdEventMapping } from '@line-crm/shared'
import Dialog from '@/components/shared/dialog'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import Select from '@/components/shared/select'
import { Field } from '@/components/shared/form-controls'
import { TextField } from '@/components/shared/text-field'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { describeSaveFailure } from '@/lib/api'

type Values = Pick<AdEventMapping, 'mode' | 'eventName' | 'googleActionId'>

export default function AdMappingDialog({ item, onClose, onSave }: {
  item: AdEventMapping
  onClose: () => void
  onSave: (values: Values) => Promise<boolean>
}) {
  const [mode, setMode] = useState(item.mode)
  const [name, setName] = useState(item.eventName ?? '')
  const [actionId, setActionId] = useState(item.googleActionId ?? '')
  const [busy, setBusy] = useState(false)

  const [error, setError] = useState('')
  const errors = useSaveFormErrors()
  const dirty = mode !== item.mode || name !== (item.eventName ?? '') || actionId !== (item.googleActionId ?? '')
  const { leaveTarget, confirmLeave, cancelLeave, disarm } = useUnsavedGuard({ dirty, busy, onDiscard: onClose })
  const save = async () => {

    setBusy(true)
    setError('')
    try {
      if (await onSave({ mode, eventName: mode === 'manual' ? name : null, googleActionId: actionId || null })) {
        disarm()
        notifySaved('広告への対応を保存しました。')
      }
    } catch (failure) {
      if (!errors.capture(failure)) setError(describeSaveFailure(failure))
    } finally {

      setBusy(false)
    }
  }
  return <SaveErrorScope errors={errors}>
    <Dialog open title={`${item.pointName}の広告への対応`} busy={busy} dirty={dirty} error={error} onCancel={onClose} onConfirm={() => save()} confirmLabel="保存">
      <Field label="対応方法"><Select aria-label={`${item.pointName} ${item.provider}の対応方法`} value={mode} disabled={busy} onChange={value => setMode(value as AdEventMapping['mode'])} options={[{ value: 'auto', label: '自動で対応' }, { value: 'manual', label: '名前を指定する' }, { value: 'off', label: '送らない' }]} /></Field>
      {mode === 'manual' ? <Field label="広告に返す名前"><TextField aria-label={`${item.pointName} ${item.provider}に返す名前`} value={name} maxLength={100} disabled={busy} onChange={event => setName(event.target.value)} /></Field> : null}
      {item.provider === 'google' && mode !== 'off' ? <Field label="Googleの成果ID" note="空欄なら連携設定を使います。Google広告で確認して入力してください。"><TextField aria-label={`${item.pointName} Googleの成果ID`} value={actionId} disabled={busy} onChange={event => setActionId(event.target.value)} /></Field> : null}
    </Dialog>
    <ConfirmDialog open={leaveTarget !== null} title="保存せずに移動しますか？" description="変更した広告の対応が失われます。" confirmLabel="保存せずに移動" onConfirm={confirmLeave} onCancel={cancelLeave} />
  </SaveErrorScope>
}
