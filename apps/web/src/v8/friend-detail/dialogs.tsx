'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { Chat, Scenario } from '@line-crm/shared'
import Dialog from '@/components/shared/dialog'
import Select from '@/components/shared/select'
import { EntityKindField } from '@/components/shared/entity-picker-sources'
import { api, ApiError, describeSaveFailure } from '@/lib/api'
import { loadOperators } from '@/lib/operators-cache'
import type { PanelStatus } from './use-friend-detail'
import styles from './detail.module.css'
import { Field } from '@/components/shared/form-controls'
import { withPermissionFailure } from '@/components/shared/api-error-message'
import { DetailLoading } from '@/components/templates/detail-page'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import { TextArea } from '@/components/shared/text-field'

/*
 * 個別操作から開く2つの窓：対応状況を編集（N-035）・シナリオに登録する（NEXT-09）。
 * 今の画面では左の欄・下の操作の中に開いていた入力を、V8 では窓にした（中身・送る口は同じ）。
 */

export function useSupportEditor(friendId: string, onSaved: (notice: string) => void, onConflict: (message: string) => void, accountId: string | null = null) {
  const saveErrors = useSaveFormErrors()
  const scopeRef = useRef({ friendId, accountId })
  const [targetAccount, setTargetAccount] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  /*
   * 窓を開いた時の友だち（WEB125）。同じ画面のまま ?id= が変わっても、A の入力・改訂値を B へ送らない。
   * 対象が変わったら窓は閉じた扱いにし、読込・保存の遅い応答は世代で捨てる。
   */
  const [target, setTarget] = useState<string | null>(null)
  const genRef = useRef(0)
  if (scopeRef.current.friendId !== friendId || scopeRef.current.accountId !== accountId) {
    genRef.current += 1
    scopeRef.current = { friendId, accountId }
  }
  const scope = scopeRef.current
  const [status, setStatus] = useState<Chat['status']>('resolved')
  const [operatorId, setOperatorId] = useState('')
  const [notes, setNotes] = useState('')
  const [revision, setRevision] = useState(0)
  const [operators, setOperators] = useState<Array<{ id: string; name: string; disabled?: boolean }>>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (target === null || (target === friendId && targetAccount === accountId)) return
    genRef.current += 1
    setOpen(false)
    setTarget(null)
    setStatus('resolved')
    setOperatorId('')
    setRevision(0)
    setBusy(false)
    setError('')
  }, [friendId, accountId, target, targetAccount])

  /* 開くたびに今の担当・対応状況を取り直す。GET /api/chats/:id は友だちIDでも引ける。 */
  const openEditor = useCallback(async () => {
    if (scope !== scopeRef.current) return
    const owner = friendId
    const gen = ++genRef.current
    setTarget(owner)
    setTargetAccount(accountId)
    setOpen(true)
    setError('')
    setBusy(true)
    try {
      const [chatRes, operatorRes] = await Promise.all([api.chats.get(owner), accountId ? loadOperators(accountId) : Promise.resolve({ success: true as const, data: [] })])
      if (gen !== genRef.current) return
      if (chatRes.success) {
        setStatus(chatRes.data.status)
        setOperatorId(chatRes.data.operatorId ?? '')
        setNotes(chatRes.data.notes ?? '')
        setRevision(chatRes.data.revision)
      }
      if (operatorRes.success) {
        const current = chatRes.success ? chatRes.data : null
        setOperators(current?.operatorId && current.operatorName && !operatorRes.data.some(o => o.id === current.operatorId) ? [{ id: current.operatorId, name: current.operatorName, disabled: true }, ...operatorRes.data] : operatorRes.data)
      }
      else setError('担当者の選択肢を読み込めませんでした')
    } catch {
      if (gen !== genRef.current) return
      setError('対応の状況を読み込めませんでした')
    } finally {
      if (gen === genRef.current) setBusy(false)
    }
  }, [friendId, accountId, scope])

  const save = async () => {
    // 開いた時の友だちだけへ送る。表示中の友だちと違えば送らない。
    if (scope !== scopeRef.current || busy || target === null || target !== friendId || targetAccount !== accountId) return
    const owner = target
    const gen = ++genRef.current
    setBusy(true)
    setError('')
    try {
      // 読んだ改訂値を付けて、ほかの人の変更を黙って上書きしない。
      const res = await api.chats.update(owner, { status, operatorId: operatorId || null, notes, revision })
      if (gen !== genRef.current) return
      if (!res.success) {
        setError(res.error)
        return
      }
      setOpen(false)
      onSaved('対応状況とメモを更新しました')
    } catch (err) {
      if (gen !== genRef.current) return
      const fieldFailure = saveErrors.capture(err);

      if (err instanceof ApiError && err.status === 409) {
        // 人が入力した状況・担当者は残し、競合した改訂値だけ取り直す。
        // 取り直せない場合は古い改訂値のまま（再保存も409で保護される）。
        const message = 'ほかの担当者が先に更新しました。入力を残して最新の内容を読み直しました。確認して保存してください'
        setError(message)
        onConflict(message)
        try {
          const latest = await api.chats.get(owner)
          if (gen !== genRef.current) return
          if (latest.success) setRevision(latest.data.revision)
          else setError('最新の内容を読み直せませんでした。入力は残っています。もう一度お試しください。')
        } catch (reloadFailure) {
          if (gen !== genRef.current) return
          saveErrors.capture(reloadFailure);

          setError('最新の内容を読み直せませんでした。入力は残っています。もう一度お試しください。')
        }
      } else {
        if (!fieldFailure)


        setError(withPermissionFailure(err, describeSaveFailure(err), 'store'))
      }
    } finally {
      if (gen === genRef.current) setBusy(false)
    }
  }

  const dialog = (
    <SaveErrorScope errors={saveErrors}><Dialog
      open={open && target === friendId && targetAccount === accountId}
      title="対応・メモを編集"
      designWidth={440}
      busy={busy}
      error={error}
      confirmLabel="保存する"
      onConfirm={() => save()}
      onCancel={() => setOpen(false)}
    >
      <div className={styles.dialogBody} data-support-editor>
        <Field label="メモ"><SaveErrorField names={["notes"]}><TextArea
            aria-label="メモ"
            value={notes}
            disabled={busy}
            maxLength={2000}
            onChange={(event) => setNotes(event.target.value)}
          /></SaveErrorField></Field>
        <Field label="対応状況"><SaveErrorField names={["status"]}><Select
            size="full"
            value={status}
            disabled={busy}
            onChange={(value) => setStatus(value as Chat['status'])}
            aria-label="対応状況を変える"
            options={[
              { value: 'unread', label: '未対応' },
              { value: 'in_progress', label: '対応中' },
              { value: 'on_hold', label: '保留' },
              { value: 'resolved', label: '対応済み' },
            ]}
          /></SaveErrorField></Field>
        <Field label="担当者"><SaveErrorField names={["operatorId","operator_id"]}><EntitySelect
            size="full"
            value={operatorId}
            disabled={busy}
            onChange={(value) => setOperatorId(value)}
            aria-label="担当者を変える"
            options={[{ value: '', label: '未割り当て' }, ...(operatorId && !operators.some(o => o.id === operatorId) ? [{ value: operatorId, label: '以前の担当者（確認できません）', disabled: true }] : []), ...operators.map((o) => ({ ...entityOptionMetadata(o), value: o.id, label: o.name, disabled: o.disabled }))]}
          /></SaveErrorField></Field>
      </div>
    </Dialog></SaveErrorScope>
  )

  return { openEditor, dialog }
}

export function useScenarioPicker(
  friendId: string,
  friendName: string,
  accountId: string | null,
  onEnrolled: (notice: string) => void,
) {
  const [open, setOpen] = useState(false)
  const [options, setOptions] = useState<Scenario[]>([])
  const [listStatus, setListStatus] = useState<PanelStatus>('idle')
  const [pick, setPick] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const reqRef = useRef(0)
  const ownerRef = useRef<string | null>(null)
  const ownerAccountRef = useRef<string | null>(null)
  const scopeRef = useRef({ friendId, accountId })
  if (scopeRef.current.friendId !== friendId || scopeRef.current.accountId !== accountId) {
    reqRef.current += 1
    scopeRef.current = { friendId, accountId }
  }
  const scope = scopeRef.current

  /* 開いた後に表示の友だちが変わったら、選んだシナリオを持ち越さずに閉じる（WEB125）。 */
  useEffect(() => {
    if (ownerRef.current === null || (ownerRef.current === friendId && ownerAccountRef.current === accountId)) return
    ownerRef.current = null
    reqRef.current += 1
    setOpen(false)
    setPick('')
    setOptions([])
    setListStatus('idle')
    setError('')
    setBusy(false)
  }, [friendId, accountId])

  /* 選べるのは表示中アカウントのシナリオだけ。選ぶ→確認→登録までここで完結（NEXT-09）。 */
  const openPicker = useCallback(async () => {
    if (scope !== scopeRef.current) return
    ownerRef.current = friendId
    ownerAccountRef.current = accountId
    setOpen(true)
    setError('')
    setPick('')
    const req = ++reqRef.current
    setListStatus('loading')
    try {
      const res = await api.scenarios.list({ accountId: accountId || undefined })
      if (req !== reqRef.current) return
      if (res.success) {
        setOptions(res.data)
        setListStatus('ready')
      } else {
        setListStatus('error')
      }
    } catch {
      if (req !== reqRef.current) return
      setListStatus('error')
    }
  }, [accountId, friendId, scope])

  const enroll = async () => {
    if (scope !== scopeRef.current || busy || listStatus !== 'ready' || ownerRef.current !== friendId || ownerAccountRef.current !== accountId) return
    const owner = friendId
    const req = ++reqRef.current
    const scenario = options.find((s) => s.id === pick)
    if (!scenario) {
      setError('登録するシナリオを選んでください')
      return
    }
    setBusy(true)
    setError('')
    try {
      const res = await api.scenarios.enroll(scenario.id, owner)
      if (req !== reqRef.current || scope !== scopeRef.current) return
      if (res.success) {
        setOpen(false)
        onEnrolled(`「${scenario.name}」に登録しました`)
      } else {
        setError(res.error)
      }
    } catch (err) {
      if (req !== reqRef.current || scope !== scopeRef.current) return
      setError(withPermissionFailure(err, describeSaveFailure(err), 'store'))
    } finally {
      if (req === reqRef.current && scope === scopeRef.current) setBusy(false)
    }
  }

  const active = options.filter((s) => s.isActive)
  const picked = options.find((s) => s.id === pick)
  const dialog = (
    <Dialog
      open={open && ownerRef.current === friendId && ownerAccountRef.current === accountId}
      title="シナリオに登録する"
      designWidth={480}
      busy={busy}
      error={error}
      confirmLabel="このシナリオに登録する"
      confirmDisabled={listStatus !== 'ready' || !active.some((scenario) => scenario.id === pick)}
      confirmDisabledReason={listStatus === 'loading' || listStatus === 'idle' ? 'シナリオを読み込んでいます。' : listStatus === 'error' ? 'シナリオを読み直してください。' : active.length === 0 ? '登録できるシナリオがありません。' : !active.some((scenario) => scenario.id === pick) ? '登録するシナリオを選んでください。' : undefined}
      onConfirm={() => enroll()}
      onCancel={() => setOpen(false)}
    >
      <div className={styles.dialogBody} data-scenario-picker>
        {listStatus === 'loading' || listStatus === 'idle' ? (
          <DetailLoading />
        ) : listStatus === 'error' ? (
          <p className={styles.secNote}>
            シナリオの選択肢を読み込めませんでした
            <button type="button" className={styles.retry} onClick={() => void openPicker()}>もう一度読み込む</button>
          </p>
        ) : active.length === 0 ? (
          <p className={styles.secNote}>登録できるシナリオがありません。</p>
        ) : (
          <>
            <SaveErrorField names={["pick"]}><EntityKindField
              kind="scenario"
              label="登録するシナリオ"
              value={pick}
              disabled={busy}
              accountId={accountId}
              onChange={(value) => setPick(value)}
              options={active}
            /></SaveErrorField>
            {picked ? <p className={styles.memo}>「{picked.name}」に{friendName || 'この友だち'}を登録します。</p> : null}
          </>
        )}
      </div>
    </Dialog>
  )

  return { openPicker, dialog }
}
