'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Settings2 } from 'lucide-react'
import type { RestaurantTableAssignmentSettings } from '@line-crm/shared'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { isSaveConflict } from '@/components/shared/save-conflict'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { ToggleField } from '@/components/shared/toggle'
import { notifySaved } from '@/components/shared/toast'
import { bookingAssignmentApi } from '@/lib/api/helpers/booking-assignment'
import { ApiError } from '@/lib/api'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { RsDialog } from '@/v8/restaurant/booking-kit/public/parts/index'
import styles from '@/components/shared/restaurant-table-board.module.css'

export default function TableAutoAssignmentDialog({ accountId, storeId, canEdit, onClose }: {
  accountId: string; storeId: string; canEdit: boolean; onClose: () => void
}) {
  const [saved, setSaved] = useState<RestaurantTableAssignmentSettings | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const saveErrors = useSaveFormErrors()
  const alive = useRef(false), writing = useRef(false), editable = useRef(canEdit)
  editable.current = canEdit
  const load = useCallback(async (keepInput = false) => {
    setLoading(true); setError('')
    try {
      const result = await bookingAssignmentApi.getTableAutomation(accountId, storeId)
      if (!alive.current) return
      setSaved(result.data)
      if (!keepInput) setEnabled(result.data.enabled)
      setConflict(false)
    } catch { if (alive.current) setError('設定を読み込めませんでした。もう一度お試しください。') }
    finally { if (alive.current) setLoading(false) }
  }, [accountId, storeId])
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false } }, [load])
  const dirty = saved !== null && enabled !== saved.enabled
  const guard = useUnsavedGuard({ dirty, busy: saving })
  const close = () => { if (!writing.current) { if (dirty) setConfirmClose(true); else onClose() } }
  const save = async () => {
    if (!alive.current || !editable.current || !saved || loading || !dirty || writing.current || conflict) return
    writing.current = true; setSaving(true); setError(''); saveErrors.reset()
    try {
      await bookingAssignmentApi.saveTableAutomation(accountId, storeId, { enabled, expectedVersion: saved.version })
      if (!alive.current) return
      guard.disarm(); notifySaved('自動配席の設定を保存しました'); onClose()
    } catch (cause) {
      if (!alive.current) return
      if (isSaveConflict(cause)) setConflict(true)
      else if (!saveErrors.capture(cause)) setError(cause instanceof ApiError && cause.status === 403 ? '設定を変更する権限がありません。' : '保存できませんでした。もう一度お試しください。')
    } finally { writing.current = false; if (alive.current) setSaving(false) }
  }
  return <SaveErrorScope errors={saveErrors}><>
    <RsDialog open title="自動配席の設定" titleSize={19} width={824} exactWidth minHeight={410} top={385} headerHeight={62}
      titleIcon={<Settings2 size={17} aria-hidden="true" />} titleRow="mark" plainTitle designNode="qu2Fq" busy={saving}
      actionsPlacement="footer" bodyGap={20} bodyOffset={0} contentPadding="20px clamp(20px, 3vw, 28px) 0" footerNote="既存の予約の卓は変わりません。" footerNotePlacement="inline" onCancel={close}
      actions={<><Button presentation="restaurant" onClick={close} disabled={saving}>キャンセル</Button><Button presentation="restaurant" variant="primary" busy={saving} disabled={loading || !saved || !dirty || conflict} lockedReason={!canEdit ? '設定を変更する権限がありません' : undefined} onClick={() => void save()}>変更を保存</Button></>}>
      {loading ? <p role="status">設定を読み込んでいます…</p> : null}
      {error ? <Notice tone="danger" action={<Button onClick={() => void load(saved !== null)} disabled={loading || saving}>再試行</Button>}>{error}</Notice> : null}
      {conflict ? <Notice tone="warn" action={<Button onClick={() => void load(true)} disabled={loading || saving}>最新を確認する</Button>}>ほかの人が設定を変更しました。入力は残っています。最新を確認してから保存してください。</Notice> : null}
      {saved ? <>
        <SaveErrorField names={['enabled']}><ToggleField size="restaurant" checked={enabled} disabled={loading || saving} lockedReason={!canEdit ? '設定を変更する権限がありません' : undefined}
          description={enabled ? '人数・予約時間・席の条件に合う、空いている卓を選びます。' : '予約は受け付け、卓はスタッフが予約台帳で決めます。'} onChange={setEnabled}>予約の卓を自動で決める</ToggleField></SaveErrorField>
        <p className={styles.autoAssignmentExplanation}>{enabled ? <>人数が収まる小さな卓を優先します。<br />配席後も、予約台帳で変更できます。</> : <>新しい予約は「未配席」になります。<br />未配席の予約も含めて、空席を超えないよう受け付けます。</>}</p>
      </> : null}
      <Notice tone="warn" appearance="caution">ほかのグルメサイトからの予約と、席が重複する（ダブルブッキング）場合がありますので、ご留意ください。</Notice>
    </RsDialog>
    <UnsavedLeaveDialog open={guard.leaveTarget !== null} subject="自動配席の変更" onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} />
    <ConfirmDialog open={confirmClose} title="保存していない変更があります" description="自動配席の変更を保存せずに閉じますか？" primaryAction="cancel" confirmLabel="保存せずに閉じる" cancelLabel="編集を続ける" onConfirm={onClose} onCancel={() => setConfirmClose(false)} />
  </></SaveErrorScope>
}
