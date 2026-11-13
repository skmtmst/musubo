'use client'

import { useEffect, useRef, useState } from 'react'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { TextField } from '@/components/shared/text-field'
import { Field } from '@/components/shared/form-controls'
import { notifySaved } from '@/components/shared/toast'
import { bookingAdvancedApi } from '@/lib/api/helpers/booking-advanced'
import Card from '@/components/shared/card'

import { DataTable, Tr, Th, Td } from '@/components/shared/table'

import Button from '@/components/shared/button'
import TruncatedText from '@/components/shared/truncated-text'
import type { BookingGroupView as BookingParty } from '@line-crm/shared'
import { usePreparingDialog } from '@/components/shared/preparing-dialog'
import { hm } from './series-model'
import styles from './party-section.module.css'
import { formatNumber } from '@/lib/format'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import Notice from '@/components/shared/notice'
import { withHonorific } from '@line-crm/shared'

/*
 * 予約の詳細パネルの段「この組（N 人）」（B5-3・Nx1kq）。人ごとのメニュー・担当・時間を並べ、
 * 組をまとめて取り消せる。権限がない取消は理由を付けて押せなくする。同じ担当の 2 人は続けて並ぶ（重ならない）。
 */
export default function PartySection({ party, canOperate, canRemoveMember = false, currentBookingId, accountId, onChanged, onReload, permissionAllowed = canOperate, operationDisabledReason = 'この予約を取り消す権限がありません' }: {
  party: BookingParty
  accountId?: string
  onChanged?: () => void
  onReload?: () => void
  canOperate: boolean
  operationDisabledReason?: string
  permissionAllowed?: boolean
  /** 人を 1 人だけ外せるか（期限内・先払いでないときだけ。B5 の決定）。 */
  canRemoveMember?: boolean
  currentBookingId: string
}) {
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const preparing = usePreparingDialog()
  const [open, setOpen] = useState(false)
  const membersKey = JSON.stringify(party.members.map(member => [member.bookingId, member.version, member.status]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
  const targetScope = useRef({ accountId, groupId: party.groupId, version: party.version, membersKey })
  if (targetScope.current.accountId !== accountId || targetScope.current.groupId !== party.groupId || targetScope.current.version !== party.version || targetScope.current.membersKey !== membersKey) targetScope.current = { accountId, groupId: party.groupId, version: party.version, membersKey }
  const [confirmedScope, setConfirmedScope] = useState<typeof targetScope.current | null>(null)
  const confirmationTicket = useRef<object | null>(null)
  const renderedTicket = confirmationTicket.current
  const currentCanOperate = useRef(canOperate)
  currentCanOperate.current = canOperate && permissionAllowed
  const lockedReason = usePermissionLockReason(permissionAllowed)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const reload = onReload ?? onChanged
  useEffect(() => { setError('') }, [party])
  useEffect(() => { setOpen(false); setBusy(false) }, [accountId, party.groupId])
  useEffect(() => { setBusy(false) }, [party.version, membersKey])
  const cancellable = party.members.filter((member) => member.status === 'requested' || member.status === 'confirmed')
  async function cancelAll() {
    if (!accountId || confirmedScope !== targetScope.current || busy || !canOperate || lockedReason || !reason.trim() || cancellable.length === 0) return
    const scope = targetScope.current
    const expectedMembers = party.members.map(member => ({ bookingId: member.bookingId, version: member.version, status: member.status }))
    if (expectedMembers.some(member => !Number.isSafeInteger(member.version))) { setError('予約を読み直してから、もう一度お試しください。'); return }
    setBusy(true); setError('')
    try {
      const response = await bookingAdvancedApi.cancelGroup(accountId, scope.groupId, reason.trim(), scope.version, expectedMembers as Array<{ bookingId: string; version: number; status: string }>)
      if (!active.current || scope !== targetScope.current) return
      notifySaved(`${response.data.cancelled} 件の予約を取り消しました`)
      confirmationTicket.current = null
      setOpen(false)
      onChanged?.()
    } catch {
      if (!active.current || scope !== targetScope.current) return
      setError(reload ? '取り消せませんでした。入力は残っています。この組を読み直して状態を確認してください。' : '取り消せませんでした。入力は残っています。時間をおいて、もう一度お試しください。')
    } finally { if (active.current && scope === targetScope.current) setBusy(false) }
  }

  return (
    <Card padding="compact" layout="vertical" gap="var(--polish-space-field)" aria-label={`この組（${party.members.length} 人）`}>
      {!permissionAllowed ? <ReadOnlyNotice /> : null}
      <header className={styles.head}>
        <h3 className={styles.title}>この組（{party.members.length} 人）</h3>
        {party.ownerName ? <span className={styles.owner}>{withHonorific(party.ownerName, 'さま', { space: true })}の予約</span> : null}
      </header>
      <DataTable>
        <thead><Tr><Th truncate>人</Th><Th truncate>メニュー</Th><Th truncate>担当</Th><Th truncate>時間</Th></Tr></thead>
        <tbody>
          {party.members.map((m) => (
            <Tr key={m.bookingId} data-current={m.bookingId === currentBookingId || undefined}>
              <Td><TruncatedText value={m.label || m.personName} /></Td><Td><TruncatedText value={m.menuName} /></Td><Td><TruncatedText value={m.staffName ?? '—'} /></Td><Td><TruncatedText value={`${hm(m.startsAt)}〜${hm(m.endsAt)}`} /></Td>
            </Tr>
          ))}
        </tbody>
      </DataTable>
      <DialogActions padding="none">
        {canRemoveMember && party.members.length > 1 ? <Button variant="secondary" disabled={!canOperate} lockedReason={lockedReason} disabledReason={permissionAllowed ? operationDisabledReason : undefined} onClick={() => preparing.open('この人だけ取り消す')}>この人だけ取り消す</Button> : null}
        {cancellable.length > 0 ? <Button variant="secondary" disabled={!canOperate} lockedReason={lockedReason} disabledReason={permissionAllowed ? operationDisabledReason : undefined} onClick={() => { if (!accountId) { preparing.open('組をまとめて取り消す'); return }; confirmationTicket.current = {}; setConfirmedScope(targetScope.current); setReason(''); setError(''); setOpen(true) }}>組をまとめて取り消す</Button> : null}
      </DialogActions>
      <Dialog open={open && confirmedScope?.accountId === accountId && confirmedScope?.groupId === party.groupId} title="組をまとめて取り消しますか？" titleNote={`${formatNumber(cancellable.length)} 件の予約をまとめて取り消します`} size="small" contentLayout="form" role="alertdialog"
        busy={busy} error={error || undefined} cancelLabel="キャンセル" onCancel={() => { if (!busy) { confirmationTicket.current = null; setOpen(false) } }} confirmLabel="まとめて取り消す" confirmLockedReason={lockedReason} confirmDisabled={!canOperate || confirmedScope !== targetScope.current || !reason.trim() || cancellable.length === 0} confirmDisabledReason={!canOperate ? permissionAllowed ? operationDisabledReason : undefined : cancellable.length === 0 ? '取り消せる予約がありません' : confirmedScope !== targetScope.current ? '最新の内容を確認してください' : !reason.trim() ? '取り消す理由を入れてください' : undefined} onConfirm={() => { if (renderedTicket && renderedTicket === confirmationTicket.current && currentCanOperate.current) void cancelAll() }}
>
        <OperationTargetSummary accounts={[{ id: confirmedScope?.accountId ?? '' }]} />
        {confirmedScope !== targetScope.current && canOperate ? <Notice tone="warn">{cancellable.length === 0 ? '取り消せる予約がなくなりました。' : <>組の内容が更新されました。最新の内容を確認してください。<ul>{cancellable.map(member => <li key={member.bookingId}>{member.label || member.personName}・{member.menuName}・{member.staffName ?? '担当未設定'}・{hm(member.startsAt)}〜{hm(member.endsAt)}</li>)}</ul><Button onClick={() => setConfirmedScope(targetScope.current)}>最新の内容を確認しました</Button></>}</Notice> : null}
        <Field label="取り消す理由" required><TextField aria-label="取り消す理由" value={reason} maxLength={500} onChange={(event) => setReason(event.target.value)} /></Field>
        <p>取り消すと元に戻せません。来店済み・取消済みの予約は変えません。この操作ではLINEを自動送信しません。必要な連絡は受信箱から行ってください。</p>
        {error && reload ? <Button onClick={reload}>この組を読み直す</Button> : null}
      </Dialog>
      {preparing.dialog}
    </Card>
  )
}
