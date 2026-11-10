'use client'

/*
 * 統括の一括配信の承認・テスト送信（API-18）。店の一斉配信と同じ承認の形（二者承認・1人運用の人数の確認）を、
 * 店と同じ部品（components/broadcasts/broadcast-approval.tsx）で出す。作る⑤（H9eG3n）と詳細（下書き）で使う。
 *   - 送る人数が店の決めた数以上なら、別の統括担当者（オーナー・管理者）の承認が要る。承認されるまで送れない。
 *   - 統括担当者が1人だけのときは、送るときに人数を入れて確かめる（confirmedRecipientCount）。
 *   - 承認するときは本人確認（step-up：broadcast.approval）。
 *   - 中身・送るアカウントを変えると承認は外れる（口が版を上げて承認を消す）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BroadcastApprovalState, HqBroadcastRun } from '@line-crm/shared'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import Notice from '@/components/shared/notice'
import { HqAccountSelectField } from '@/components/shared/hq-account-picker'
import { notifyToast } from '@/components/shared/toast'
import { japaneseDetailOf } from '@/components/shared/api-error-message'
import StepUpPrompt from '@/components/step-up-prompt'
import { ApprovalRequestFields, ApproverSection, formatApprovalDateTime } from '@/components/broadcasts/broadcast-approval'
import { ApiError } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import { hqBroadcastsApi } from '@/lib/hq-broadcasts-api'
import { emptyValue } from '@/components/shared/empty-value'
import OperationTargetSummary from '@/components/shared/operation-target-summary'

export type HqApproval = {
  state: BroadcastApprovalState | null
  candidates: Array<{ id: string; name: string }>
  loading: boolean
  failed: boolean
  reload: () => void
}

/** 下書きの承認の状態と、承認できる人（名前を出すため）。版が変わるたびに読み直す。 */
export function useHqApproval(run: Pick<HqBroadcastRun, 'id' | 'version' | 'status'> | null): HqApproval {
  const [state, setState] = useState<BroadcastApprovalState | null>(null)
  const [candidates, setCandidates] = useState<Array<{ id: string; name: string }>>([])
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [tick, setTick] = useState(0)
  const id = run && run.status === 'prepared' ? run.id : null
  const version = run?.version ?? null
  useEffect(() => {
    if (!id) { setState(null); return }
    let current = true
    setLoading(true); setFailed(false)
    void Promise.all([hqBroadcastsApi.approval(id), hqBroadcastsApi.approvalCandidates().catch(() => null)])
      .then(([approval, people]) => {
        if (!current) return
        setState(approval.data)
        if (people) setCandidates(people.data.map((person) => ({ id: person.id, name: person.name })))
      })
      .catch(() => { if (current) { setState(null); setFailed(true) } })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [id, version, tick])
  const reload = useCallback(() => setTick((value) => value + 1), [])
  return { state, candidates, loading, failed, reload }
}

/** 送る口の関門。required かつ 2人以上の運用は承認済み（人数が同じ）でないと送れない。 */
export function approvalGate(state: BroadcastApprovalState | null): 'none' | 'single' | 'needsRequest' | 'pending' | 'approved' {
  if (!state || !state.gate.required) return 'none'
  if (state.gate.singleOperator) return 'single'
  if (state.approval.status === 'approved' && state.approval.confirmedCount === state.gate.recipientCount) return 'approved'
  if (state.approval.status === 'pending') return 'pending'
  return 'needsRequest'
}

function errorText(caught: unknown, fallback: string): string {
  return japaneseDetailOf(caught) || fallback
}

/**
 * 承認の帯（依頼する・待っている・差し戻された・承認された）と、頼まれた人の操作（承認する・差し戻す）。
 * 承認を頼む窓は呼ぶ側の主ボタン（「承認を依頼する」）から開く（requestOpen）。
 */
export function HqApprovalBlock({
  run, approval, requestOpen, onRequestClose, onChanged, scheduledLabel, messageSummary,
}: {
  run: HqBroadcastRun
  approval: HqApproval
  requestOpen: boolean
  onRequestClose: () => void
  /** 承認の状態が変わり、下書きの版が上がった（呼ぶ側は下書きを読み直す）。 */
  onChanged: () => void
  scheduledLabel: string | null
  messageSummary: string
}) {
  const [approverId, setApproverId] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [stepUp, setStepUp] = useState<null | { retry: (token: string) => Promise<void> }>(null)
  const state = approval.state
  const nameOf = (id: string | null) => (id ? approval.candidates.find((person) => person.id === id)?.name ?? null : null)

  const run1 = async (action: () => Promise<unknown>, done: string) => {
    setBusy(true); setMessage('')
    try {
      await action()
      notifyToast(done)
      approval.reload(); onChanged()
      return true
    } catch (caught) {
      setMessage(errorText(caught, '承認の操作ができませんでした。読み直してから、もう一度お試しください。'))
      return false
    } finally {
      setBusy(false)
    }
  }

  const approve = async (token?: string): Promise<void> => {
    setBusy(true); setMessage('')
    try {
      await hqBroadcastsApi.approve(run.id, run.version, token)
      notifyToast('承認しました')
      approval.reload(); onChanged()
    } catch (caught) {
      if (!token && caught instanceof ApiError && caught.code === 'STEP_UP_REQUIRED') {
        setStepUp({ retry: async (next) => { await approve(next) } })
        return
      }
      setMessage(errorText(caught, '承認できませんでした。読み直してから、もう一度お試しください。'))
    } finally {
      setBusy(false)
    }
  }

  if (approval.failed) return <Notice tone="warn" action={<Button size="compact" onClick={approval.reload}>もう一度読み込む</Button>}>承認が要るかを確かめられませんでした。</Notice>
  if (!state || !state.gate.required) return null

  const gate = approvalGate(state)
  return (
    <>
      {gate === 'single' ? (
        <Notice tone="info">{`送る人数が ${formatNumber(state.gate.threshold)} 通以上です。統括の担当者が1人なので、送るときに人数を入れて確かめます。`}</Notice>
      ) : gate === 'needsRequest' ? (
        <Notice tone="warn">
          {state.approval.status === 'rejected'
            ? `差し戻されました（理由：${state.approval.rejectReason || emptyValue('unknown')}）。内容を直して、もう一度承認を依頼してください。`
            : `送る人数が ${formatNumber(state.gate.threshold)}通以上なので、もう1人の承認が要ります。承認されるまで送られません。`}
        </Notice>
      ) : gate === 'pending' ? (
        <Notice
          tone="info"
          action={state.viewer.isRequester ? <Button size="compact" disabled={busy} onClick={() => void run1(() => hqBroadcastsApi.cancelApproval(run.id, run.version), '承認の依頼を取り消しました')} busy={Boolean(busy)} busyLabel="処理中…">依頼を取り消す</Button> : undefined}
        >
          {`${nameOf(state.approval.approverStaffId) ? `${nameOf(state.approval.approverStaffId)}さんの` : ''}承認を待っています（依頼 ${formatApprovalDateTime(state.approval.requestedAt)}）。${state.approval.note ? `ひとこと：${state.approval.note}` : ''}`}
        </Notice>
      ) : gate === 'approved' ? (
        <Notice tone="success">{`${nameOf(state.approval.decidedByStaffId) ? `${nameOf(state.approval.decidedByStaffId)}さんが` : ''}承認しました。送る操作へ進めます。`}</Notice>
      ) : null}
      {message && !requestOpen ? <Notice tone="danger" >{message}</Notice> : null}
      <ApproverSection
        approval={state.approval}
        viewer={state.viewer}
        requesterName={nameOf(state.approval.requestedByStaffId)}
        recipientCount={state.gate.recipientCount}
        scheduledLabel={scheduledLabel}
        messageSummary={messageSummary}
        messageHref={`/hq/broadcasts/detail?id=${encodeURIComponent(run.id)}`}
        onApprove={() => void approve()}
        onReject={(reason) => void run1(() => hqBroadcastsApi.reject(run.id, run.version, reason), '差し戻しました')}
        busy={busy}
        message={null}
      />
      <ConfirmDialog
        open={requestOpen}
        title="承認を依頼する"
        description={`送る相手 ${formatNumber(state.gate.recipientCount)} 人。承認されるまで送られません。`}
        confirmLabel="承認を依頼する"
        busy={busy}
        error={message || undefined}
        onCancel={() => { if (!busy) { setMessage(''); onRequestClose() } }}
        onConfirm={approverId ? () => run1(() => hqBroadcastsApi.requestApproval(run.id, run.version, approverId, note.trim() || undefined), '承認を依頼しました').then((ok) => { if (ok) onRequestClose() }) : undefined}
      >
        <ApprovalRequestFields
          recipientCount={state.gate.recipientCount}
          threshold={state.gate.threshold}
          candidates={approval.candidates.map((person) => ({ ...person, role: 'admin', canApprove: true })) as never}
          candidatesState={approval.loading ? 'loading' : 'ready'}
          approverId={approverId}
          onApproverChange={setApproverId}
          note={note}
          onNoteChange={setNote}
        />
      </ConfirmDialog>
      {stepUp ? (
        <StepUpPrompt
          request={{ purpose: 'broadcast.approval', action: '一括配信を承認する', retry: stepUp.retry }}
          onDone={() => setStepUp(null)}
          onClose={() => setStepUp(null)}
        />
      ) : null}
    </>
  )
}

/**
 * テストを送る窓（API-18：選んだアカウントの「テスト送信の宛先」へ全部の吹き出しを送る）。
 * 下書きがまだ無い・古いときは、呼ぶ側の prepare で下書きを作り直してから送る。
 */
export function HqTestSendDialog({
  open, accounts, prepare, onClose,
}: {
  open: boolean
  accounts: Array<{ id: string; name: string }>
  /** 送る前に下書きを今の中身にそろえ、その id を返す。そろえられなければ null。 */
  prepare: () => Promise<string | null>
  onClose: () => void
}) {
  const [accountId, setAccountId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const chosen = accounts.some((account) => account.id === accountId) ? accountId : accounts[0]?.id ?? ''
  const scope = useRef({ open, chosen, generation: 0 })
  if (scope.current.open !== open || scope.current.chosen !== chosen) scope.current = { open, chosen, generation: scope.current.generation + 1 }
  const renderedScope = scope.current
  const [recipients, setRecipients] = useState<{ scope: typeof renderedScope; count: number; recipients: Array<{id:string;displayName:string|null}>; token: string } | null>(null)
  const [recipientsError, setRecipientsError] = useState(false)
  useEffect(() => {
    let alive = true
    setRecipients(null); setRecipientsError(false)
    if (renderedScope.open && renderedScope.chosen) void hqBroadcastsApi.testRecipients(renderedScope.chosen).then(result => {
      if (alive && result.success && Number.isSafeInteger(result.data.count) && result.data.count > 0 && result.data.count <= 5 && Array.isArray(result.data.recipients) && result.data.recipients.length === result.data.count && result.data.recipients.every(person => typeof person.id === 'string' && (person.displayName === null || typeof person.displayName === 'string')) && /^[a-f0-9]{64}$/.test(result.data.token)) setRecipients({ scope: renderedScope, ...result.data })
      else if (alive) setRecipientsError(true)
    }).catch(() => { if (alive) setRecipientsError(true) })
    return () => { alive = false }
  }, [renderedScope])
  const lock = useRef<object | null>(null)
  useEffect(() => { lock.current = null; setBusy(false); setError('') }, [renderedScope])
  const send = async () => {
    if (!open || !chosen || busy || lock.current || renderedScope !== scope.current || !recipients || recipients.scope !== renderedScope) return
    const confirmedRecipients = recipients
    const ticket = {}; lock.current = ticket
    const current = () => scope.current === renderedScope && lock.current === ticket
    setBusy(true); setError('')
    try {
      const id = await prepare()
      if (!current()) return
      if (!id) { setError('先に入れていない所を直してください。'); return }
      const result = (await hqBroadcastsApi.testSend(id, chosen, confirmedRecipients.token)).data
      if (!current()) return
      notifyToast(result.failed ? `テストを ${formatNumber(result.sent)} 人に送りました（${formatNumber(result.failed)} 人は送れませんでした）` : `テストを ${formatNumber(result.sent)} 人に送りました`)
      onClose()
    } catch (caught) {
      if (current()) {
        if (caught instanceof ApiError && caught.status === 409 && caught.code === 'HQ_TEST_RECIPIENT_CHANGED') {
          const data = caught.data as {count?:unknown} | undefined
          const count = typeof data?.count === 'number' && Number.isSafeInteger(data.count) ? `現在 ${formatNumber(data.count)} 人です。` : ''
          setRecipients(null); setRecipientsError(true)
          setError(`テスト宛先が変わりました。${count}閉じて確認し直してください。`)
        } else setError(errorText(caught, 'テストを送れませんでした。アカウントのテスト送信の宛先を確かめてください。'))
      }
    } finally {
      if (current()) { lock.current = null; setBusy(false) }
    }
  }
  return (
    <ConfirmDialog
      key={renderedScope.generation}
      open={open}
      title="テストを送る"
      description="選んだアカウントの「テスト送信の宛先」（1〜5人）に、いまの中身をそのアカウントの名前で送ります。友だち全員には送りません。"
      confirmLabel="テストを送る"
      busy={busy}
      error={error || undefined}
      onCancel={() => { if (!busy) { setError(''); onClose() } }}
      confirmDisabled={recipients?.scope !== renderedScope}
      confirmDisabledReason="テスト送信の宛先を確認してください。"
      onConfirm={() => send()}
    >
      {chosen && <OperationTargetSummary accounts={[{ id: chosen, name: accounts.find(account => account.id === chosen)?.name }]} />}
      {recipients?.scope === renderedScope ? <p>送信先 {formatNumber(recipients.count)} 人：{recipients.recipients.map(person => person.displayName || '名前未設定').join('、')}</p> : <p>{recipientsError ? 'テスト送信の宛先を確認できません。' : 'テスト送信の宛先を確認しています。'}</p>}
      {accounts.length === 0 ? <p className="text-ink-faint text-xs">先に送るアカウントを選んでください。</p> : (
        <HqAccountSelectField label="テストを送るアカウント" accounts={accounts} value={chosen} onChange={setAccountId} disabled={busy} />
      )}
    </ConfirmDialog>
  )
}
