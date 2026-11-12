'use client'
import { DetailContent, DetailSection, DetailField, DetailNumber, DetailSectionTitle } from '@/components/shared/detail-content'

import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

import EntitySelect from '@/components/shared/entity-select'

import { isConflictResponse, CONFLICT_TEXT } from '@/components/shared/save-conflict'


import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Ban, CalendarPlus, Info, Pencil, Plus, Ticket } from 'lucide-react'
import type { BookingEntitlementEvent, BookingEntitlementOperation, BookingEntitlementView } from '@line-crm/shared'
import Button from '@/components/shared/button'
import Card, { CardHeader } from '@/components/shared/card'
import DateField from '@/components/shared/date-field'
import Dialog from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Drawer from '@/components/shared/drawer'
import { Field } from '@/components/shared/form-controls'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import NumberInput from '@/components/shared/number-field'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import TruncatedText from '@/components/shared/truncated-text'
import { TextField } from '@/components/shared/text-field'
import { RowMenu } from '@/components/shared/row-actions'
import { DataTable, RowNameButton, RowNameLink, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { notifySaved } from '@/components/shared/toast'
import { ApiError } from '@/lib/api'
import { bookingEntitlementsApi } from '@/lib/api/helpers/booking-entitlements'
import { isNotReadyError } from '@/lib/api/helpers/booking-payment-admin'
import { formatListTimestamp } from '@/lib/format'
import { jstDate } from '@/lib/jst-datetime'
import styles from './entitlements.module.css'
import { withHonorific } from '@line-crm/shared'

/*
 * 友だち詳細 › 予約タブの「回数券・月謝」（ 追記・絵 t7AmhL＝手で入れる窓、XrfOE＝履歴の引き出し）。
 * 口：組3 の bookingEntitlementsApi（付与・残りを直す・期限を延ばす・取り消す。理由は必須、誰がしたかは口が残す）。
 * 口が無い間は「現在準備中です」。
 */

type Action = 'give' | 'adjust' | 'extend' | 'revoke'
const NEW_TICKET = '__new__'
const TABLE_LAYOUT = { headHeight: 'var(--polish-table-head)', rowHeight: 'var(--polish-table-row)', gap: 'var(--polish-space-card)', padding: '0 var(--polish-space-section)', bodyTextSize: 'var(--polish-text-body)', collapseScope: 'page' as const }

function shortDay(iso: string) {
  const day = jstDate(new Date(iso))
  return `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`
}
function remainingText(item: BookingEntitlementView) {
  return item.kind === 'monthly' ? `今月 残り ${item.monthRemaining ?? '—'} 回` : `残り ${item.remaining ?? 0} 回`
}
function optionLabel(item: BookingEntitlementView) {
  return `${item.name}（${item.kind === 'monthly' ? `今月 残り ${item.monthRemaining ?? '—'} 回` : `残り ${item.remaining ?? 0} 回`}・${shortDay(item.expires_at)} まで）`
}
function uuid() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`
}

export default function EntitlementsCard({ accountId, friendId, friendName, canEdit }: { accountId: string | null; friendId: string; friendName: string; canEdit: boolean }) {
  const [state, setState] = useState<'loading' | 'ready' | 'not-ready' | 'error'>('loading')
  const [items, setItems] = useState<BookingEntitlementView[]>([])
  const [dialog, setDialog] = useState<{ action: Action; id: string; epoch: number } | null>(null)
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const generation = useRef(0)
  const scope = useRef({ accountId, friendId, canEdit, epoch: 0 })
  if (scope.current.accountId !== accountId || scope.current.friendId !== friendId || scope.current.canEdit !== canEdit) scope.current = { accountId, friendId, canEdit, epoch: scope.current.epoch + 1 }
  const [itemsEpoch, setItemsEpoch] = useState(-1)
  const openDialog = (target: { action: Action; id: string }) => setDialog({ ...target, epoch: scope.current.epoch })

  const reload = useCallback(async () => {
    if (!accountId) return
    const mine = ++generation.current
    const epoch = scope.current.epoch
    setState('loading')
    try {
      const response = await bookingEntitlementsApi.list(accountId, friendId)
      if (mine !== generation.current || epoch !== scope.current.epoch) return
      setItemsEpoch(epoch)
      setItems(response.data.filter((item) => item.status === 'active'))
      setState('ready')
    } catch (cause) {
      if (mine === generation.current && epoch === scope.current.epoch) { setItemsEpoch(epoch); setState(isNotReadyError(cause) ? 'not-ready' : 'error') }
    }
  }, [accountId, friendId, canEdit])

  useEffect(() => { void reload() }, [reload])
  const visibleItems = itemsEpoch === scope.current.epoch ? items : []
  const visibleState = itemsEpoch === scope.current.epoch ? state : 'loading'
  const drawerItem = visibleItems.find((item) => item.id === drawerId) ?? null

  return (
    <Card variant="form" gap="normal">
      <CardHeader size="stacked" title="回数券・月謝" action={canEdit && visibleState === 'ready' ? <Button onClick={() => openDialog({ action: 'give', id: visibleItems[0]?.id ?? NEW_TICKET })}><Plus size={16} aria-hidden="true" />手で入れる</Button> : undefined} />
      {visibleState === 'not-ready' ? <Notice tone="info" icon={<Info size={16} aria-hidden="true" />}>回数券・月謝は、データの準備が済むと店が手で入れられます。</Notice>
        : visibleState === 'loading' ? <ListState kind="loading" title="回数券・月謝を読み込んでいます" />
          : visibleState === 'error' ? <ListState kind="error" title="回数券・月謝を表示できませんでした" onRetry={() => void reload()} />
            : visibleItems.length === 0 ? <p className={styles.minor}>持っている回数券・月謝はありません。店頭で売ったときや紙の回数券を引き継ぐときは［手で入れる］から。</p>
              : (
                <ul className={styles.list}>
                  {visibleItems.map((item) => (
                    <li key={item.id} className={styles.row}>
                      <Ticket size={16} aria-hidden="true" className={styles.rowIcon} />
                      <span className={styles.rowMain}>
                        <RowNameButton onClick={() => setDrawerId(item.id)} title={`${item.name}の履歴を見る`}>{item.name}</RowNameButton>
                        <span className={styles.rowSub}>{`${remainingText(item)}・${shortDay(item.expires_at)} まで`}</span>
                      </span>
                      {canEdit ? <RowMenu appearance="box" size="row" label={`${item.name}の操作`} open={openMenu === item.id} onOpenChange={(next) => setOpenMenu(next ? item.id : null)} items={[
                        { id: 'history', label: '履歴を見る', onSelect: () => setDrawerId(item.id) },
                        { id: 'give', label: '回数を足す', onSelect: () => openDialog({ action: 'give', id: item.id }) },
                        { id: 'adjust', label: '残りを直す', onSelect: () => openDialog({ action: 'adjust', id: item.id }) },
                        { id: 'extend', label: '期限を延ばす', onSelect: () => openDialog({ action: 'extend', id: item.id }) },
                        { id: 'revoke', label: '取り消す', tone: 'danger', onSelect: () => openDialog({ action: 'revoke', id: item.id }) },
                      ]} /> : null}
                    </li>
                  ))}
                </ul>
              )}
      {accountId ? <EntitlementDialog open={dialog !== null && dialog.epoch === scope.current.epoch} initial={dialog} accountId={accountId} friendId={friendId} friendName={friendName} canEdit={canEdit} items={visibleItems}
        onClose={() => setDialog(null)} onDone={() => { setDialog(null); void reload() }} /> : null}
      {accountId ? <EntitlementDrawer item={drawerItem} accountId={accountId} friendName={friendName} canEdit={canEdit} onClose={() => setDrawerId(null)}
        onAdd={(id) => { setDrawerId(null); openDialog({ action: 'give', id }) }} /> : null}
    </Card>
  )
}

const ACTIONS: Array<{ value: Action; title: string; note: string; icon: ReactNode; submit: string }> = [
  { value: 'give', title: '回数券を渡す', note: '新しく付ける・回数を足す', icon: <Plus size={16} aria-hidden="true" />, submit: '回数券を渡す' },
  { value: 'adjust', title: '残りを直す', note: '数え違いを直す', icon: <Pencil size={16} aria-hidden="true" />, submit: '残りを直す' },
  { value: 'extend', title: '期限を延ばす', note: '使える日を延ばす', icon: <CalendarPlus size={16} aria-hidden="true" />, submit: '期限を延ばす' },
  { value: 'revoke', title: '取り消す', note: 'この回数券を使えなくする', icon: <Ban size={16} aria-hidden="true" />, submit: '取り消す' },
]

export function EntitlementDialog({ open, initial, accountId, friendId, friendName, canEdit = true, items, onClose, onDone }: {
  open: boolean
  initial: { action: Action; id: string } | null
  accountId: string
  friendId: string
  friendName: string
  canEdit?: boolean
  items: BookingEntitlementView[]
  onClose: () => void
  onDone: () => void
}) {
  const saveErrors = useSaveFormErrors()
  const [action, setAction] = useState<Action>('give')
  const [targetId, setTargetId] = useState(NEW_TICKET)
  const [count, setCount] = useState('')
  const [expiry, setExpiry] = useState('')
  const [name, setName] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)
  const key = useRef(uuid())
  const scope = useRef({ accountId, friendId, canEdit, open, epoch: 0 })
  if (scope.current.accountId !== accountId || scope.current.friendId !== friendId || scope.current.canEdit !== canEdit || scope.current.open !== open) scope.current = { accountId, friendId, canEdit, open, epoch: scope.current.epoch + 1 }
  const [openedEpoch, setOpenedEpoch] = useState(-1)
  const selected = useRef<{ id: string; version: number } | null>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items
  const chooseTarget = useCallback((id: string) => { const item = itemsRef.current.find(row => row.id === id); selected.current = item ? { id: item.id, version: item.version } : null; setTargetId(id) }, [])

  useEffect(() => {
    if (!open || !initial) return
    setOpenedEpoch(scope.current.epoch)
    setAction(initial.action); chooseTarget(initial.id); setCount(''); setExpiry(''); setName(''); setReason('')
    setError(null); setSubmitted(false); key.current = uuid()
  }, [open, initial, chooseTarget])

  const target = items.find((item) => item.id === targetId) ?? null
  const isNew = action === 'give' && target === null
  const before = target ? (target.kind === 'monthly' ? target.monthRemaining ?? 0 : target.remaining ?? 0) : 0
  const n = Number(count)
  const countValid = count.trim() !== '' && Number.isInteger(n) && (action === 'adjust' ? n >= 0 : n >= 1)
  const after = action === 'give' ? before + (countValid ? n : 0) : action === 'adjust' ? (countValid ? n : before) : action === 'revoke' ? 0 : before
  const needsCount = action === 'give' || action === 'adjust'
  const expiryValid = action !== 'extend' || (expiry !== '' && (!target || expiry > jstDate(new Date(target.expires_at))))
  const valid = reason.trim() !== '' && (!needsCount || countValid) && expiryValid && (!isNew || (name.trim() !== '' && expiry !== '')) && (action === 'give' || target !== null)
  const submitLabel = ACTIONS.find((item) => item.value === action)?.submit ?? '保存する'

  const expiryChoices = useMemo(() => [
    { value: '', label: target ? `${shortDay(target.expires_at)} のまま` : '期限を選ぶ' },
  ], [target])

  async function submit() {
    setSubmitted(true)
    if (!valid || !canEdit || openedEpoch !== scope.current.epoch) return
    if (target && (selected.current?.id !== target.id || selected.current.version !== target.version)) { setError('回数券の内容が変わりました。閉じて読み直し、もう一度選んでください。'); return }
    setBusy(true); setError(null)
    try {
      const endOfDay = (day: string) => new Date(`${day}T23:59:59+09:00`).toISOString()
      if (isNew) {
        await bookingEntitlementsApi.grant(accountId, { friendId, kind: 'ticket', name: name.trim(), remaining: n, validFrom: new Date().toISOString(), expiresAt: endOfDay(expiry), reason: reason.trim() }, key.current)
      } else if (target) {
        const base = { expectedVersion: target.version, reason: reason.trim() }
        const operation: BookingEntitlementOperation = action === 'revoke' ? { ...base, action: 'revoke' }
          : action === 'extend' ? { ...base, action: 'extend', expiresAt: endOfDay(expiry) }
            : { ...base, action: 'adjust', remaining: after }
        await bookingEntitlementsApi.operate(accountId, target.id, operation, key.current)
        if (action === 'give' && expiry && expiry > jstDate(new Date(target.expires_at))) {
          await bookingEntitlementsApi.operate(accountId, target.id, { expectedVersion: target.version + 1, reason: reason.trim(), action: 'extend', expiresAt: endOfDay(expiry) }, uuid())
        }
      }
      notifySaved(action === 'revoke' ? '回数券を取り消しました' : '回数券を更新しました')
      onDone()
    } catch (cause) {
      saveErrors.capture(cause)
      setError(isConflictResponse(cause) ? CONFLICT_TEXT.reopen
        : cause instanceof ApiError && cause.status === 403 ? '回数券を変える権限がありません。'
          : isNotReadyError(cause) ? 'データの準備が済むと保存できます。'
            : '保存できませんでした。もう一度お試しください。')
    } finally {
      setBusy(false)
    }
  }

  return (<SaveErrorScope errors={saveErrors}>{(
    <Dialog open={open && canEdit && openedEpoch === scope.current.epoch} title="回数券を手で入れる" titleNote={`${withHonorific(friendName || 'この友だち', 'さん', { space: true })}・店頭で売った・紙の回数券の引き継ぎなど`} onCancel={onClose} size="medium" busy={busy}
      cancelLabel="キャンセル" confirmLabel={submitLabel} onConfirm={() => void submit()}>
      <div className={styles.dialogBody}>
        <OperationTargetSummary accounts={[{ id: accountId }]} externalTarget={{ label: '友だち', name: friendName }} />
        <RadioCardGroup legend="すること" legendVisible columns={2}>
          {ACTIONS.map((choice) => (
            <RadioCard key={choice.value} name="entitlement-action" value={choice.value} title={choice.title} note={choice.note} icon={choice.icon}
              checked={action === choice.value} disabled={choice.value !== 'give' && items.length === 0}
              disabledReason={choice.value !== 'give' && items.length === 0 ? '持っている回数券がありません' : undefined}
              onChange={(value) => { setAction(value as Action); if (value !== 'give' && targetId === NEW_TICKET && items[0]) chooseTarget(items[0].id) }} />
          ))}
        </RadioCardGroup>
        <div className={styles.fullSelect}><SaveErrorField names={['entitlementId', 'entitlement_id', 'targetId']}><EntitySelect aria-label="対象の回数券" noun="回数券" value={targetId} onChange={chooseTarget} size="full"
          options={[...items.map((item) => ({ value: item.id, label: optionLabel(item) })), ...(action === 'give' ? [{ value: NEW_TICKET, label: '新しい回数券を付ける' }] : [])]} /></SaveErrorField></div>
        {isNew ? (
          <Field label="回数券の名前" required error={submitted && !name.trim() ? '名前を入れてください' : undefined}>
            <SaveErrorField names={['name']}><TextField aria-label="回数券の名前" value={name} maxLength={100} placeholder="例：カット 10回券" onChange={(event) => setName(event.target.value)} /></SaveErrorField>
          </Field>
        ) : null}
        {action !== 'revoke' ? (
          <div className={styles.twoCols}>
            {needsCount ? (
              <Field label={action === 'adjust' ? '直したあとの残り' : isNew ? '回数' : '足す回数'} required error={submitted && !countValid ? '回数を入れてください' : undefined}>
                <SaveErrorField names={["count","remaining"]}><NumberInput aria-label="回数" unit="回" type="number" min={action === 'adjust' ? 0 : 1} value={count} onChange={(event) => setCount(event.target.value)} /></SaveErrorField>
              </Field>
            ) : null}
            <Field label="期限" required={action === 'extend' || isNew} error={submitted && !expiryValid ? '今の期限より後の日を選んでください' : undefined}>
              {expiry === '' && !isNew && action !== 'extend'
                ? <Select aria-label="期限" value="" onChange={() => setExpiry(target ? jstDate(new Date(target.expires_at)) : '')} options={[...expiryChoices, { value: 'change', label: '日付を選ぶ' }]} />
                : <SaveErrorField names={["expiresAt","expires_at","expiry"]}><DateField aria-label="期限" value={expiry} onChange={setExpiry} min={jstDate(new Date())} /></SaveErrorField>}
            </Field>
          </div>
        ) : null}
        <Field label="理由" required error={submitted && !reason.trim() ? '理由を入れてください（履歴に残ります）' : undefined}>
          <SaveErrorField names={["reason"]}><TextField aria-label="理由" value={reason} maxLength={1000} placeholder="例：店頭で現金で買った（10/15 ¥22,000）" onChange={(event) => setReason(event.target.value)} /></SaveErrorField>
        </Field>
        {target || isNew ? (
          <div className={styles.preview}>
            <span>残り<strong className={styles.previewNum}>{`${before} 回 → ${after} 回`}</strong></span>
            <span className={styles.previewNote}>履歴に、あなたの名前と理由が残ります</span>
          </div>
        ) : null}
        {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
      </div>
    </Dialog>
  )}</SaveErrorScope>)
}

function eventLabel(event: BookingEntitlementEvent, before: number | null, after: number | null): { label: string; tone?: 'used' } {
  if (event.action === 'consume') return { label: '使った', tone: 'used' }
  if (event.action === 'grant') return { label: '手で渡した' }
  if (event.action === 'extend') return { label: '期限を延ばした' }
  if (event.action === 'revoke') return { label: '取り消した' }
  if (event.actor_type === 'system') return { label: '戻した' }
  return { label: before !== null && after !== null && after < before ? '手で直した' : '手で足した' }
}
function remainingOf(json: string | null): number | null {
  if (!json) return null
  try { const value = JSON.parse(json) as { remaining?: number | null }; return value.remaining ?? null } catch { return null }
}
function bookingOf(json: string): string | null {
  try { return (JSON.parse(json) as { bookingId?: string }).bookingId ?? null } catch { return null }
}

/** 回数券の履歴（XrfOE）：残り・期限・使った と、誰がいつ何をしたか。 */
export function EntitlementDrawer({ item, accountId, friendName, canEdit, onClose, onAdd }: {
  item: BookingEntitlementView | null
  accountId: string
  friendName: string
  canEdit: boolean
  onClose: () => void
  onAdd: (id: string) => void
}) {
  const [events, setEvents] = useState<BookingEntitlementEvent[] | null | 'error'>(null)
  useEffect(() => {
    if (!item) return
    let alive = true
    setEvents(null)
    bookingEntitlementsApi.history(accountId, item.id).then((response) => { if (alive) setEvents(response.data) }).catch(() => { if (alive) setEvents('error') })
    return () => { alive = false }
  }, [accountId, item])
  const used = Array.isArray(events) ? events.filter((event) => event.action === 'consume').length : null
  return (
    <Drawer open={item !== null} title={item?.name ?? ''} description={withHonorific(friendName || 'この友だち', 'さん', { space: true })} onClose={onClose} width="editor" closeAppearance="box" heightMode="viewport" actions={{ primary: (item ? <Button variant="primary" onClick={() => onAdd(item.id)}><Plus size={16} aria-hidden="true"/>手で入れる</Button> : null), primaryAllowed: canEdit }}>
<DetailContent>
      {item ? (
        <div className={styles.drawerBody}>
          <DetailSection label={`${item.name}の残り・期限・使った回数`}>
            <DetailField label="残り" note=""><DetailNumber value={item.kind === 'monthly' ? item.monthRemaining : item.remaining ?? 0} unit="回" /></DetailField>
            <DetailField label="期限" note=""><DetailNumber value={null} text={shortDay(item.expires_at)} unit="" /></DetailField>
            <DetailField label="使った" note=""><DetailNumber value={used} unit="回" /></DetailField>
          </DetailSection>
          <div className={styles.historyHead}>
            <DetailSectionTitle>履歴</DetailSectionTitle>

          </div>
          {events === null ? <ListState kind="loading" title="履歴を読み込んでいます" />
            : events === 'error' ? <ListState kind="error" title="履歴を表示できませんでした" />
              : (
                <DetailSection>
                  <DataTable aria-label={`${item.name}の履歴`} columnSizing="content" columnLayout={TABLE_LAYOUT}>
                    <thead><TableHeadRow data-table-layout="columns"><Th truncate>日時</Th><Th grow truncate>したこと</Th><Th truncate>前→後</Th><Th truncate>だれ</Th></TableHeadRow></thead>
                    <tbody>{events.map((event) => {
                      const before = remainingOf(event.before_json)
                      const after = remainingOf(event.after_json)
                      const label = eventLabel(event, before, after)
                      const bookingId = bookingOf(event.request_json)
                      return (
                        <Tr key={event.id} data-table-layout="columns">
                          <Td><TruncatedText value={formatListTimestamp(event.created_at)} /></Td>
                          <Td grow><span className={styles.cellStack}>
                            {label.tone === 'used' && bookingId ? <RowNameLink href={`/booking/bookings?booking=${encodeURIComponent(bookingId)}`} title="この予約を開く">{label.label}</RowNameLink> : <span className={styles.cellMain}>{label.label}</span>}
                            <span className={styles.cellSub}>{event.reason}</span>
                          </span></Td>
                          <Td><TruncatedText value={`${before ?? 0}→${after ?? 0}`} /></Td>
                          <Td><TruncatedText value={event.actor_type === 'system' ? '予約' : event.actor_id} /></Td>
                        </Tr>
                      )
                    })}</tbody>
                  </DataTable>
                </DetailSection>
              )}
          <p className={styles.footNote}><Info size={16} aria-hidden="true" />予約で使った行は、押すとその予約を開きます。手で入れた行には理由が必ず残ります。</p>
          {item.kind === 'monthly' ? <StatusBadge tone="info">{`今月 ${item.monthUsed} 回使いました`}</StatusBadge> : null}
        </div>
      ) : null}

</DetailContent>
</Drawer>
  )
}
