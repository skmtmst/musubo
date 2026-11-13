'use client'

import { RadioGroup } from '@/components/shared/radio'

import Card from '@/components/shared/card'

import { useCallback, useEffect, useRef, useState } from 'react'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Drawer from '@/components/shared/drawer'
import { Field } from '@/components/shared/form-controls'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import StatusBadge from '@/components/shared/status-badge'
import Radio from '@/components/shared/radio'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { TextField } from '@/components/shared/text-field'
import { notifySaved } from '@/components/shared/toast'
import { friendDeliveryConsentHistoryApi, friendDeliveryConsentsApi, type FriendDeliveryConsent, type FriendDeliveryConsentEvent } from '@/lib/api/helpers/friend-delivery-consents'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import styles from './delivery-consent.module.css'
import { withHonorific } from '@line-crm/shared'
import { ApiError } from '@/lib/api'
import { readSaveFieldErrors } from '@/lib/api/helpers/field-errors'
import { describeSaveFailure } from '@/lib/api/transport/errors'

/*
 * ★V8 友だち詳細「配信の受け取り」（E9-1 `mAbif`）。目的ごと（予約の連絡・お知らせ・キャンペーン・宣伝・アンケート）に、
 * 届けてよいかを「受け取る／止めている／不明」で記録する。理由は必須。
 * 本人が止めた宣伝を店が「受け取る」へ戻すときは、注意の窓を挟む（本人の意思を店が上書きするため）。
 * 変えられるのはオーナー・管理者だけ（閲覧のみの人には［変える］を置かない）。
 */
const PURPOSES: Array<{ key: string; label: string; note: string }> = [
  { key: 'transaction', label: '予約の連絡', note: '前日・当日の案内、変更・取り消しの知らせ' },
  { key: 'notice', label: 'お知らせ', note: 'お店からの大事なお知らせ' },
  { key: 'marketing', label: 'キャンペーン・宣伝', note: 'クーポン・新しいメニューの案内' },
  { key: 'survey', label: 'アンケート', note: '来店後のアンケート' },
]
const STATE_LABEL: Record<FriendDeliveryConsent['state'], string> = { granted: '受け取る', revoked: '止めている', unknown: '不明' }
const STATE_TONE: Record<FriendDeliveryConsent['state'], 'success' | 'danger' | 'neutral'> = { granted: 'success', revoked: 'danger', unknown: 'neutral' }
const STATES: FriendDeliveryConsent['state'][] = ['granted', 'revoked', 'unknown']

const md = (value: string) => `${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))} ${value.slice(11, 16)}`
const ACTOR: Record<FriendDeliveryConsentEvent['actor']['kind'], string> = { self: '本人', store: '店', system: 'システム', unknown: '不明' }
const stateOf = (side: FriendDeliveryConsentEvent['before']) => (side ? STATE_LABEL[side.state] : '—')
const bySelf = (row: FriendDeliveryConsent | undefined) => Boolean(row && row.source !== 'manual')

export function useDeliveryConsents(friendId: string) {
  const scope = useRef({ friendId, epoch: 0 })
  if (scope.current.friendId !== friendId) scope.current = { friendId, epoch: scope.current.epoch + 1 }
  const request = useRef(0)
  const [data, setData] = useState<{ epoch: number; status: 'loading' | 'ready' | 'error'; rows: FriendDeliveryConsent[] }>({ epoch: 0, status: 'loading', rows: [] })
  const load = useCallback(async () => {
    const epoch = scope.current.epoch
    const seq = ++request.current
    setData(current => ({ epoch, status: 'loading', rows: current.epoch === epoch ? current.rows : [] }))
    try {
      const response = await friendDeliveryConsentsApi.list(friendId)
      if (request.current !== seq || scope.current.epoch !== epoch) return
      if (!response.success) throw new Error('consents_failed')
      setData({ epoch, status: 'ready', rows: Array.isArray(response.data) ? response.data : [] })
    } catch {
      if (request.current === seq && scope.current.epoch === epoch) setData({ epoch, status: 'error', rows: [] })
    }
  }, [friendId])
  useEffect(() => { void load(); return () => { request.current++ } }, [load])
  return { status: data.epoch === scope.current.epoch ? data.status : 'loading' as const, rows: data.epoch === scope.current.epoch ? data.rows : [], reload: load }
}

/** 左の要点の1段：宣伝の受け取りを1行で。 */
export function DeliveryConsentSummary({ status, rows }: { status: 'loading' | 'ready' | 'error'; rows: FriendDeliveryConsent[] }) {
  if (status === 'loading') return <p className={styles.faint}>読み込んでいます</p>
  if (status === 'error') return <p className={styles.faint}>読み込めませんでした</p>
  const marketing = rows.find((row) => row.purpose === 'marketing')
  return <p className={styles.summary}>{`キャンペーン・宣伝：${STATE_LABEL[marketing?.state ?? 'unknown']}`}</p>
}

export default function DeliveryConsentDrawer({ open, friendId, friendName, friendAccountId = null, selectedAccountId = null, rows, canEdit, onClose, onSaved }: {
  open: boolean
  friendId: string
  friendName: string
  friendAccountId?: string | null
  selectedAccountId?: string | null
  rows: FriendDeliveryConsent[]
  canEdit: boolean
  onClose: () => void
  onSaved: () => Promise<void> | void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [next, setNext] = useState<FriendDeliveryConsent['state']>('granted')
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState('')
  const [warn, setWarn] = useState<{ epoch: number; friendId: string; friendName: string; accountId: string | null; purpose: string; state: FriendDeliveryConsent['state']; reason: string; version: number } | null>(null)
  const scope = useRef({ friendId, friendAccountId, selectedAccountId, canEdit, open, epoch: 0 })
  if (scope.current.friendId !== friendId || scope.current.friendAccountId !== friendAccountId || scope.current.selectedAccountId !== selectedAccountId || scope.current.canEdit !== canEdit || scope.current.open !== open) scope.current = { friendId, friendAccountId, selectedAccountId, canEdit, open, epoch: scope.current.epoch + 1 }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const errors = useSaveFormErrors()
  const [events, setEvents] = useState<FriendDeliveryConsentEvent[] | null>(null)
  const [historyFailed, setHistoryFailed] = useState(false)
  const [reviewRequired, setReviewRequired] = useState(false)
  const commitLock = useRef(false)
  const loadHistory = useCallback(async () => {
    try {
      const response = await friendDeliveryConsentHistoryApi.list(friendId, { limit: 20 })
      if (!response.success) throw new Error('history_failed')
      setEvents(Array.isArray(response.data?.items) ? response.data.items : [])
      setHistoryFailed(false)
    } catch {
      setHistoryFailed(true)
    }
  }, [friendId])
  useEffect(() => { if (open) void loadHistory() }, [open, loadHistory])

  const rowOf = (key: string) => rows.find((row) => row.purpose === key)
  const begin = (key: string) => {
    setReviewRequired(false); setEditing(key); setNext(rowOf(key)?.state ?? 'unknown'); setReason(''); setReasonError(''); setError('')
  }

  const commit = async (confirmation?: NonNullable<typeof warn>) => {
    if (!editing || reviewRequired || commitLock.current || busy || !canEdit || !open) return
    if (confirmation && (confirmation.epoch !== scope.current.epoch || confirmation.friendId !== friendId || confirmation.purpose !== editing || confirmation.state !== next || confirmation.reason !== reason.trim() || confirmation.version !== (rowOf(editing)?.version ?? 0))) {
      setReviewRequired(true); setError('対象や受け取り設定が変わりました。閉じて読み直し、もう一度選んでください。'); return false
    }
    const epoch = scope.current.epoch
    commitLock.current = true
    setBusy(true); setError('')
    try {
      const current = rowOf(editing)
      const response = await friendDeliveryConsentsApi.save(confirmation?.friendId ?? friendId, confirmation?.purpose ?? editing, { state: confirmation?.state ?? next, reason: confirmation?.reason ?? reason.trim(), expectedVersion: confirmation?.version ?? current?.version ?? 0 })
      if (scope.current.epoch !== epoch) return false
      if (!response.success) throw new Error('save_failed')
      notifySaved('配信の受け取りを保存しました。')
      setWarn(null); setEditing(null)
      await onSaved()
      await loadHistory()
      return true
    } catch (reason) {
      if (scope.current.epoch !== epoch) return false
      errors.capture(reason)
      const needsReview = !(reason instanceof ApiError) || reason.status === 409 || reason.status >= 500
      setReviewRequired(needsReview)
      const fieldReasons = readSaveFieldErrors(reason)
      setReasonError(fieldReasons.reason ?? fieldReasons['input.reason'] ?? '')
      setError(needsReview ? '保存結果を確認できませんでした。閉じて、本人の受け取り設定と理由を確かめてください。' : describeSaveFailure(reason))
      if (needsReview) { await onSaved(); await loadHistory() }
      return false
    } finally {
      commitLock.current = false; setBusy(false)
    }
  }

  const submit = () => {
    if (!reason.trim()) { setReasonError('理由を入れてください。'); return }
    const current = editing ? rowOf(editing) : undefined
    /* 本人が止めた宣伝を、店が受け取るへ戻すときだけ注意の窓。 */
    if (editing === 'marketing' && current?.state === 'revoked' && next === 'granted' && bySelf(current)) { setWarn({ epoch: scope.current.epoch, friendId, friendName, accountId: friendAccountId, purpose: editing, state: next, reason: reason.trim(), version: current.version }); return }
    void commit()
  }

  const label = (key: string) => PURPOSES.find((item) => item.key === key)?.label ?? key

  return (
    <SaveErrorScope errors={errors}><Drawer
      open={open}
      title="配信の受け取り"
      description={`${withHonorific(friendName, 'さん', { space: true })}・目的ごとに、届けてよいかを記録します`}
      closeAppearance="box"
      heightMode="viewport"
      onClose={onClose}
      footer={editing && canEdit ? (
        <div className={styles.footer}>
          <Button onClick={() => setEditing(null)} disabled={busy}>キャンセル</Button>
          <Button variant="primary" onClick={submit} busy={busy} disabled={busy || reviewRequired} disabledReason={reviewRequired ? '本人の受け取り設定を確認し、理由か選択を見直してください。' : undefined}>保存する</Button>
        </div>
      ) : undefined}
    >
      <div className={styles.body}>
        {error ? <Notice tone="danger" message={error} /> : null}
        <Card padding="compact" layout="vertical" gap="var(--polish-space-field)" aria-label="目的ごとの受け取り">
          {PURPOSES.map((purpose) => {
            const row = rowOf(purpose.key)
            const state = row?.state ?? 'unknown'
            return (
              <div key={purpose.key} className={styles.row}>
                <div className={styles.rowText}>
                  <span className={styles.rowTitle}>{purpose.label}</span>
                  <span className={styles.rowNote}>{purpose.note}</span>
                </div>
                <StatusBadge tone={STATE_TONE[state]}><span>{STATE_LABEL[state]}</span></StatusBadge>
                {canEdit ? <Button variant="secondary" onClick={() => begin(purpose.key)} disabled={busy}>変える</Button> : null}
              </div>
            )
          })}
        </Card>
        {editing && canEdit ? (
          <section className={styles.edit} aria-label={`${label(editing)}を変える`}>
            <h3 className={styles.sectionTitle}>{`変える（${label(editing)}）`}</h3>
            <Card padding="compact" layout="vertical" gap="var(--polish-space-field)">
              <RadioGroup className={styles.radios} label="受け取り">
                {STATES.map((state) => (
                  <Radio key={state} name="consent-state" value={state} checked={next === state} disabled={busy} onChange={() => { setNext(state); setReviewRequired(false); setError('') }}>{state === 'unknown' ? '不明（まだ聞いていない）' : STATE_LABEL[state]}</Radio>
                ))}
              </RadioGroup>
              <Field label="理由" required error={reasonError}>
                <TextField aria-label="理由" value={reason} placeholder="例：お電話で「宣伝はいらない」とご連絡" disabled={busy} onChange={(event) => { setReason(event.target.value); setReasonError(''); setReviewRequired(false); setError('') }} />
              </Field>
            </Card>
          </section>
        ) : null}
        <section aria-label="履歴">
          <h3 className={styles.sectionTitle}>履歴</h3>
          {historyFailed ? <p className={styles.faint}>履歴を読み込めませんでした。</p> : events === null ? <p className={styles.faint}>読み込んでいます</p> : events.length === 0 ? <p className={styles.faint}>まだ記録はありません。</p> : (
            <DataTable>
              <thead><TableHeadRow><Th>いつ</Th><Th>目的</Th><Th>前 → 後</Th><Th>だれ</Th></TableHeadRow></thead>
              <tbody>
                {events.map((event) => (
                  <Tr key={event.id}>
                    <Td>{md(event.createdAt)}</Td>
                    <Td>{label(event.purpose)}</Td>
                    <Td>{`${stateOf(event.before)} → ${stateOf(event.after)}`}</Td>
                    <Td><span title={event.reason ?? undefined}>{ACTOR[event.actor.kind]}</span></Td>
                  </Tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </section>
      </div>
      <ConfirmDialog
        open={warn !== null && warn.epoch === scope.current.epoch}
        title="本人が止めた宣伝を、受け取るに戻しますか？"
        description="この方は、ご自分で宣伝を止めています。店の判断で戻すと、お客さまの意思に反して宣伝が届くことがあります。電話や来店で、本人から了承を得たときだけ戻してください。理由は記録に残ります。"
        confirmLabel="受け取るに戻す"
        destructive
        busy={busy}
        confirmDisabled={reviewRequired}
        confirmDisabledReason="閉じて、本人の受け取り設定と理由を確かめてください。"
        error={error || undefined} onSuccess={() => setWarn(null)} onConfirm={() => warn ? commit(warn) : undefined}
        onCancel={() => { setWarn(null); setReviewRequired(false); setError('') }}
      ><OperationTargetSummary accounts={[{ id: warn?.accountId ?? '', name: warn?.accountId ? undefined : '不明' }]} externalTarget={{ label: '友だち', name: warn?.friendName }} /></ConfirmDialog>
    </Drawer></SaveErrorScope>
  )
}
