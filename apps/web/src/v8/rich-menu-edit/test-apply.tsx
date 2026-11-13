'use client'

import { isConflictResponse } from '@/components/shared/save-conflict'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, type RichMenuTestApplyItem, type RichMenuTestApplyUserMenuAction } from '@/lib/api'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Notice from '@/components/shared/notice'
import { formatDateTime, formatNumber } from '@/lib/format'
import styles from '@/app/rich-menus/new/create-v8.module.css'

type TestApplyState = {
  linked: boolean
  confirmationRevision?: number
  destinationToken?: string | null
  linkGuidance: string | null
  destination: { staffName: string | null; lineUserIdMasked: string } | null
  active: RichMenuTestApplyItem | null
  recent: RichMenuTestApplyItem[]
}

const APPLY_STATUS_LABEL: Record<string, string> = {
  running: '適用中', applied: '自分のLINEに出ています', reverting: '取り消し中',
  reverted: '取り消し済み', failed: '失敗',
}

function revertNotice(action: RichMenuTestApplyUserMenuAction | undefined): string {
  switch (action) {
    case 'restored': return '適用前の表示へ戻しました。'
    case 'already_restored': return 'すでに適用前の表示に戻っていました。テスト用に作ったメニューだけ削除しました。'
    case 'left_as_is': return '適用後にあなたの表示が別のメニューへ変わっていたため、今の表示はそのままにしました。テスト用に作ったメニューだけ削除しました。'
    case 'untouched': return 'あなたの表示は一度も変わっていなかったため、そのままにしました。'
    default: return 'テスト適用を取り消しました。'
  }
}

/** 要件5-6：本人に連携済みのLINEだけで試し、元の表示へ戻す。 */
export default function RichMenuTestApply({ groupId, accountId }: { groupId: string; accountId: string }) {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<TestApplyState | null>(null)
  const [loadError, setLoadError] = useState('')
  const [confirmKind, setConfirmKind] = useState<'apply' | 'revert' | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [actionError, setActionError] = useState('')
  const keyRef = useRef('')
  const busyRef = useRef(false)
  const confirmation = useRef<{ expectedConfirmationRevision: number; expectedDestinationToken: string } | null>(null)
  const generation = useRef(0)
  const mounted = useRef(false)
  const context = useRef({ groupId, accountId })
  if (context.current.groupId !== groupId || context.current.accountId !== accountId) context.current = { groupId, accountId }
  const confirmTicket = useRef<{ context: typeof context.current; applyId: string | null } | null>(null)
  const renderedTicket = confirmTicket.current

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; confirmTicket.current = null }
  }, [])

  const load = useCallback(async () => {
    const request = ++generation.current
    try {
      const res = await api.richMenuGroups.testApplyState(groupId)
      if (request !== generation.current) return
      if (!res.success) throw new Error(res.error)
      setState(res.data)
      setLoadError('')
      return res.data
    } catch (e) {
      if (request !== generation.current) return
      setLoadError(e instanceof ApiError && e.status === 403
        ? 'テスト適用の状態を見る権限がありません。' : 'テスト適用の状態を確認できませんでした。時間をおいて、もう一度お試しください。')
    }
  }, [groupId])

  useEffect(() => {
    if (open) void load()
    return () => { generation.current += 1 }
  }, [open, load])

  function openConfirm(kind: 'apply' | 'revert') {
    confirmation.current = typeof state?.confirmationRevision === 'number' && state.destinationToken
      ? { expectedConfirmationRevision: state.confirmationRevision, expectedDestinationToken: state.destinationToken } : null
    confirmTicket.current = { context: context.current, applyId: kind === 'revert' ? state?.active?.id ?? null : null }

    keyRef.current = crypto.randomUUID()
    setActionError('')
    setConfirmKind(kind)
  }

  async function run() {
    if (!mounted.current || !confirmKind || busyRef.current || (confirmKind === 'revert' && !renderedTicket?.applyId)) return
    busyRef.current = true
    setBusy(true)
    setActionError('')
    setNotice('')
    const request = generation.current
    try {
      if (confirmKind === 'apply') {
        if (!confirmation.current) throw new Error('確認した版がありません')
        const res = await api.richMenuGroups.testApply(groupId, keyRef.current, confirmation.current)
        if (request !== generation.current) return
        if (!res.success) throw new Error(res.error)
        setNotice('あなたのLINEにこのメニューを出しました。LINEアプリで見え方を確認してください。')
      } else {
        const res = await api.richMenuGroups.testApplyRevert(groupId, keyRef.current, renderedTicket?.applyId ?? undefined)
        if (request !== generation.current) return
        if (!res.success) throw new Error(res.error)
        setNotice(revertNotice(res.data.userMenuAction))
      }
      confirmTicket.current = null
      setConfirmKind(null)
      await load()
    } catch (e) {
      if (request !== generation.current) return
      if (isConflictResponse(e)) {
        confirmation.current = null
        const latest = await load()
        if (!mounted.current) return
        if (latest?.linked && typeof latest.confirmationRevision === 'number' && latest.destinationToken) {
          confirmation.current = { expectedConfirmationRevision: latest.confirmationRevision, expectedDestinationToken: latest.destinationToken }
          keyRef.current = crypto.randomUUID()
        } else setConfirmKind(null)
      }
      setActionError(isConflictResponse(e)
        ? 'ほかの操作と重なりました。状態を確認してから、もう一度お試しください。'
        : confirmKind === 'apply'
          ? 'テスト適用できませんでした。しばらくおいてから、もう一度お試しください。'
          : '取り消せませんでした。しばらくおいてから、もう一度お試しください。')
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const active = state?.active
  const destination = state?.destination
    ? `宛先: ${state.destination.staffName ?? 'あなた'}のLINE（${state.destination.lineUserIdMasked}）` : ''
  const canRevert = active && (active.status === 'applied' || (active.status === 'failed' && active.previousCaptured))
  function close() {
    if (busyRef.current) return
    confirmTicket.current = null
    setConfirmKind(null)
    setOpen(false)
  }

  return <>
    {' '}<Button type="button" variant="text" size="inline" onClick={() => setOpen(true)}>自分のLINEで試す</Button>
    <Dialog open={open} title="自分のLINEで試す" cancelLabel="閉じる" onCancel={close}>
      <div className={styles.stack}>
        <p className={styles.cardNote}>あなたのLINEアカウントにだけ、このメニューを出して見え方を確かめます。ほかの友だちの表示は変わりません。</p>
        {loadError ? <Notice tone="danger" message={loadError} action={<Button type="button" variant="text" size="inline" onClick={() => void load()}>再試行</Button>} /> : null}
        {notice ? <Notice tone="success" message={notice} /> : null}
        {!state && !loadError ? <p className={styles.cardNote} role="status">読み込み中…</p> : null}
        {state && !state.linked ? <Notice tone="warn" message={state.linkGuidance ?? 'テスト適用にはLINE連携が必要です。'} /> : null}
        {state?.linked ? <>
          {destination ? <p className={styles.cardNote}>{destination}</p> : null}
          {active ? <p className={styles.cardNote} title={active.status === 'failed' ? active.lastErrorCode?.slice(0, 60) : undefined}>いまの状態: {APPLY_STATUS_LABEL[active.status] ?? '状態を確認しています'}</p> : null}
          {canRevert
            ? <Button type="button" onClick={() => openConfirm('revert')} disabled={busy}>元のメニューに戻す</Button>
            : <Button type="button" variant="primary" onClick={() => openConfirm('apply')} disabled={busy || Boolean(active && active.status !== 'reverted' && active.status !== 'failed')}>自分のLINEに適用して試す</Button>}
          {state.recent.length > 0 ? <p className={styles.cardNote}>最近の適用: {formatNumber(state.recent.length)}件（直近 {formatDateTime(state.recent[0].createdAt)}）</p> : null}
        </> : null}
      </div>
    </Dialog>
    <ConfirmDialog open={confirmKind === 'apply'} title="自分のLINEにこのメニューを出しますか？"
      description={`${destination ? `${destination}。` : ''}あなたのトーク画面のメニューだけがこの内容に変わります。ほかの友だちには出ません。「元のメニューに戻す」でいつでも戻せます。`}
      confirmLabel="自分のLINEに適用する" busy={busy} error={actionError || undefined}
      onConfirm={() => { if (renderedTicket && confirmTicket.current === renderedTicket && renderedTicket.context === context.current) void run() }} onCancel={() => { if (!busyRef.current) { confirmTicket.current = null; setConfirmKind(null) } }}><OperationTargetSummary accounts={[{ id: accountId }]} /></ConfirmDialog>
    <ConfirmDialog open={confirmKind === 'revert'} title="テスト適用を取り消しますか？"
      description={`${destination ? `${destination}。` : ''}あなたのトーク画面のメニューを、適用前の表示へ戻します。適用後に表示が変わっていた場合は上書きしません。テスト用に作ったメニューがあればLINE上から削除します。`}
      confirmLabel="元のメニューに戻す" busy={busy} error={actionError || undefined}
      onConfirm={() => { if (renderedTicket && confirmTicket.current === renderedTicket && renderedTicket.context === context.current) void run() }} onCancel={() => { if (!busyRef.current) { confirmTicket.current = null; setConfirmKind(null) } }}><OperationTargetSummary accounts={[{ id: accountId }]} /></ConfirmDialog>
  </>
}
