'use client'
import { formatDateTime, formatListDay, formatNumber } from '@/lib/format'
import { useCallback, useEffect, useRef, useState } from 'react'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import { bookingApi, type BookingPrepayDecision } from '@/lib/api'
import styles from '../../app/booking/prepay-badge-v8.module.css'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField, useSaveFormErrors, SaveErrorScope } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'
import { TextField as SharedTextField } from '@/components/shared/text-field'

function jstMonthDay(iso: string): string {
  return formatListDay(iso, '')
}

function jstDateTime(iso: string): string {
  return formatDateTime(iso, '')
}

/**
 * 前払いのみの印（ eih0r の下半分）。
 * 前払いのみの人だけに印を出す。印を外すときは理由を1行書く。
 * 理由は店だけが見る（お客さまの画面には出さない）。
 */
export default function PrepayBadgeV8({ accountId, friendId, canEdit = true, onChanged }: {
  accountId: string
  friendId: string
  canEdit?: boolean
  onChanged?: () => void
}) {
  const saveErrors = useSaveFormErrors()
  const [decision, setDecision] = useState<BookingPrepayDecision | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const requestRef = useRef(0)
  const [loadError, setLoadError] = useState(false)
  const reload = useCallback(() => {
    const generation = ++requestRef.current
    setLoadError(false)
    setLoaded(false)
    bookingApi.getFriendNoshow(accountId, friendId).then(
      (response) => {
        if (generation !== requestRef.current) return
        setDecision(response.data)
        setLoaded(true)
      },
      () => {
        if (generation !== requestRef.current) return
        setDecision(null)
        setLoadError(true)
        setLoaded(true)
      },
    )
  }, [accountId, friendId])

  useEffect(() => {
    reload()
    return () => { requestRef.current += 1 }
  }, [reload])

  async function clearPrepay() {
    const trimmed = reason.trim()
    if (!trimmed) {
      setError('印を外すときは理由を1行書いてください。')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const response = await bookingApi.setFriendPrepay(accountId, friendId, { mode: 'manual_off', reason: trimmed })
      setDecision(response.data)
      setDialogOpen(false)
      setReason('')
      onChanged?.()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure);


      if (!fieldFailure) {
      setError('印を外せませんでした。入力を確かめて、もう一度お試しください。') }
    } finally {
      setSaving(false)
    }
  }

  if (!loaded)
 return <SaveErrorScope errors={saveErrors}><p className="text-body" role="status">前払い情報を読み込み中…</p></SaveErrorScope>
  if (loadError) return <SaveErrorScope errors={saveErrors}><Notice tone="danger"><p>前払い情報を読み込めませんでした</p><Button onClick={reload}>もう一度読み込む</Button></Notice></SaveErrorScope>
  if (!decision?.prepayOnly) return null
  const dates = decision.recentDates.map(jstMonthDay).filter((text) => text !== '')

  return (
    <SaveErrorScope errors={saveErrors}><div className={styles.badge} data-design="PrepayBadge">
      <svg className={styles.icon} aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none">
        <rect x="2" y="4" width="16" height="12" rx="2" stroke="currentColor" strokeWidth="1.75" />
        <line x1="2" y1="8" x2="18" y2="8" stroke="currentColor" strokeWidth="1.75" />
      </svg>
      <div className={styles.body}>
        <p className={styles.title}>
          前払いのみ（来なかった{formatNumber(decision.noshowCount)}回・直近{decision.windowMonths}か月）
        </p>
        {dates.length > 0 ? (
          <p className={styles.dates}>{dates.join('・')}に来なかった</p>
        ) : null}
        {decision.manual && decision.lastEvent ? (
          <p className={styles.event}>
            {decision.lastEvent.staffName ?? '店'}が{jstDateTime(decision.lastEvent.at)}に
            {decision.lastEvent.action === 'manual_off' ? '外した' : '付けた'}
          </p>
        ) : null}
      </div>
      {canEdit ? (
        <Button variant="secondary" onClick={() => { setReason(''); setError(null); setDialogOpen(true) }}>
          印を外す
        </Button>
      ) : null}
      <Dialog
        open={dialogOpen}
        title="印を外す"
        description="理由を1行書いてください。だれがいつ外したか残ります。理由はお客さまの画面には出しません。"
        confirmLabel="外す"
        busy={saving}
        error={error ?? undefined}
        onConfirm={() => void clearPrepay()}
        onCancel={() => setDialogOpen(false)}
      >
        <Field label="外す理由（1行）"><SaveErrorField names={["reason"]}><SharedTextField
            aria-label="外す理由"
            value={reason}
            maxLength={200}
            onChange={(event) => setReason(event.target.value)}
            placeholder="例：電話で確認が取れた"
          /></SaveErrorField></Field>
      </Dialog>
    </div></SaveErrorScope>
  )
}
