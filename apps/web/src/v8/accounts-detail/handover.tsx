'use client'
import { japaneseDetailOf } from '@/components/shared/api-error-message'

import CopyTextButton from '@/components/shared/copy-text-button'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { Play, RotateCcw } from 'lucide-react'
import type { LineAccount } from '@line-crm/shared'
import { api, ApiError, type AccountHandover, type AccountHandoverDecision } from '@/lib/api'
import { formatDateTime, formatNumber } from '@/lib/format'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { SettingsPage } from '@/components/templates'
import { Steps } from '@/components/templates/steps'
import SettingsInnerNav from '@/components/layout/settings-inner-nav'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import StickyBar from '@/components/shared/sticky-bar'
import { DataTable, TableHeadRow, Th, Tr, Td, TableStateRow } from '@/components/shared/table'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Notice from '@/components/shared/notice'
import Select from '@/components/shared/select'
import TargetMissing from '@/components/shared/target-missing'
import { TextField } from '@/components/shared/text-field'
import { notifyToast } from '@/components/shared/toast'
import { useStepUpGate } from '@/components/step-up-prompt'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { DIFFERENT_PROVIDER_DETAIL, DIFFERENT_PROVIDER_LEAD, HANDOVER_PILLS, countsLine, decisionLabel, handoverPill, totalsMatch } from './handover-view'
import styles from './handover.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { Field } from '@/components/shared/form-controls'
import { emptyValue } from '@/components/shared/empty-value'
import NumberInput from '@/components/shared/number-field'
import { DetailLoading } from '@/components/templates/detail-page'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import ReadOnlyNotice from '@/components/shared/read-only-notice'

/*
 * ★V8 LINEアカウントの乗り換え（Pencil ）。
 *
 * 白い板の頭（乗り換え（元 → 先）・説明・右に「アカウントの詳細へ戻る」）→ 左に設定の中のメニュー →
 * 4つの段の札 → どこからどこへ／事前確認の結果 → 要確認の判断の表 → 保存していない書き換えの帯 →
 * 戻せること／気をつけること → 下の行（未判断の数・引き継ぎをやめる・本実行する）。
 * データの口・守り（確認の窓・本人確認・二重押し防止・閲覧のみ・切り戻し）は今の画面
 * （app/accounts/handover の page.tsx・handover-v8.tsx）と同じ。動きの一覧は BEHAVIOR.md。
 */

type HandoverDecisionView = AccountHandoverDecision & {
  sourceName?: string
  candidateName?: string | null
  evidenceLabel?: string
}

type HandoverView = AccountHandover & {
  decisions: HandoverDecisionView[]
  unresolvedReviews: number | null
}

/** 見るだけの担当者（staff）には変更の入口を出さない（R522）。口側も owner/admin だけ。 */
const NO_MANAGE_NOTE = '閲覧のみで見ています。引き継ぎの変更はオーナーと管理者だけができます。引き継ぎの状態はこのまま見られます。'

/** サーバの言葉があればそれを、無ければ決まった文を出す。 */
function apiMessage(caught: unknown, fallback: string): string {
  return japaneseDetailOf(caught) || fallback
}

export default function AccountHandoverV8() {
  const saveErrors = useSaveFormErrors()
  const search = useSearchParams()
  const id = search?.get('id') ?? ''
  const staffRole = useStaffRole()
  // 役割が確認できるまでは、閲覧のみとして変更操作を隠す。
  const canManage = canManageRole(staffRole)
  const [account, setAccount] = useState<LineAccount | null>(null)
  const [accounts, setAccounts] = useState<LineAccount[]>([])
  /** 補助の一覧（受け取り先の名前）だけの失敗。本体は隠さず、ここだけ読み直す（R521）。 */
  const [accountsFailed, setAccountsFailed] = useState(false)
  const [accountsRetrying, setAccountsRetrying] = useState(false)
  const [handover, setHandover] = useState<HandoverView | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [missing, setMissing] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied'>('idle')
  const [refreshing, setRefreshing] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [executeConfirmation, setExecuteConfirmation] = useState<{ id: string; revision: number | undefined } | null>(null)
  const [executing, setExecuting] = useState(false)
  const [executeError, setExecuteError] = useState('')
  /** 本人確認の窓（X-3: 本実行・切り戻しで使う）。 */
  const { gate: stepUpGate, prompt: stepUpPrompt } = useStepUpGate()
  const [issuing, setIssuing] = useState(false)
  const [linkCode, setLinkCode] = useState('')
  const [linking, setLinking] = useState(false)
  const [linkError, setLinkError] = useState('')
  const [declaredTotalInput, setDeclaredTotalInput] = useState('')
  /** 申告の数の欄。絵に無いので、事前確認の結果の右上から開く。 */
  const [declaredOpen, setDeclaredOpen] = useState(false)
  const [rollbackOpen, setRollbackOpen] = useState(false)
  const [rollbackConfirmation, setRollbackConfirmation] = useState<{ id: string; revision: number | undefined } | null>(null)
  const [rollingBack, setRollingBack] = useState(false)
  const [rollbackError, setRollbackError] = useState('')
  /** 人が書き換えた判断（保存するまで下書き）。 */
  const [decisionEdits, setDecisionEdits] = useState<Record<string, 'link' | 'new' | 'skip'>>({})
  const [savingDecisions, setSavingDecisions] = useState(false)
  const [decisionError, setDecisionError] = useState('')
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelConfirmation, setCancelConfirmation] = useState<{ id: string; revision: number | undefined } | null>(null)
  const confirmationState = useRef({ key: '', execute: null as object | null, cancel: null as object | null, rollback: null as object | null })
  const currentKey = JSON.stringify([id, canManage, handover])
  if (confirmationState.current.key !== currentKey) {
    confirmationState.current = { key: currentKey, execute: null, cancel: null, rollback: null }
  }
  const openConfirmation = (kind: 'execute' | 'cancel' | 'rollback') => {
    confirmationState.current[kind] = {}
  }

  const [cancelling, setCancelling] = useState(false)
  /*
   * 段4で書き換えた判断は「判断を保存する」まで端末にしか無い（下の帯が「まだ保存していません」と出す）。
   * その間に画面を離れると書き換えが消えるので、離れる前に確かめる。保存・読み直しで空になると外れる。
   */
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({
    dirty: canManage && Object.keys(decisionEdits).length > 0,
    busy: savingDecisions,
  })

  const loadAccounts = useCallback(async () => {
    try {
      const res = await api.lineAccounts.list()
      if (!res.success) { setAccountsFailed(true); return }
      setAccounts(res.data)
      setAccountsFailed(false)
    } catch (saveFailure) {
      saveErrors.capture(saveFailure)
      setAccountsFailed(true)
    }
  }, [saveErrors]);

  const retryAccounts = useCallback(async () => {
    if (accountsRetrying)

 return
    setAccountsRetrying(true)
    try { await loadAccounts() } finally { setAccountsRetrying(false) }
  }, [accountsRetrying, loadAccounts])

  const load = useCallback(async () => {
    if (!id) return
    setStatus('loading')
    setMissing(false)
    void loadAccounts()
    try {
      const [accountRes, handoversRes] = await Promise.all([
        api.lineAccounts.get(id),
        api.accountHandovers.listForAccount(id),
      ])
      if (!accountRes.success || !handoversRes.success) { setStatus('error'); return }
      setAccount(accountRes.data)
      const current = handoversRes.data[0]
      if (!current) {
        setHandover(null)
        setStatus('ready')
        return
      }
      const detailRes = await api.accountHandovers.get(current.id)
      if (!detailRes.success) { setStatus('error'); return }
      setHandover(detailRes.data as HandoverView)
      setDeclaredTotalInput(
        detailRes.data.declaredFriendTotal !== null && detailRes.data.declaredFriendTotal !== undefined
          ? String(detailRes.data.declaredFriendTotal)
          : '',
      )
      setDecisionEdits({})
      setStatus('ready')
    } catch (caught) {
      saveErrors.capture(caught);

      if (caught instanceof ApiError && caught.status === 404) {
        setMissing(true);

        setStatus('ready');

        return
      }
      setStatus('error')
    }
  }, [id, loadAccounts, saveErrors])

  useEffect(() => { void load() }, [load])
  usePageTitle('乗り換え')
  /* 板の頭の［アカウントの詳細へ戻る］は 2026-10-08 に無くした。詳細へは上の帯のパンくずで戻る。 */
  usePageCrumbs(account
    ? [{ label: '設定' }, { label: 'LINEアカウント', href: '/accounts' }, { label: account.name, href: `/accounts/detail?id=${account.id}` }]
    : [{ label: '設定' }, { label: 'LINEアカウント', href: '/accounts' }])

  const destination = accounts.find((item) => item.id === handover?.toAccountId) ?? null
  const countsAreComplete = handover?.counts ? totalsMatch(handover.counts, handover.counts.sourceTotal) : false

  /** 事前確認をやり直す。申告の数も一緒に送る。 */
  const rerunPreview = async () => {
    if (!handover?.counts || !countsAreComplete) return
    setRefreshing(true)
    try {
      const { sourceTotal, auto, review, unmatched, lookalike } = handover.counts
      const declared = declaredTotalInput.trim()
      const result = await api.accountHandovers.preview(handover.id, {
        sourceFriendTotal: sourceTotal,
        counts: { auto, review, unmatched, lookalike },
        declaredFriendTotal: declared === '' ? null : Number(declared),
      })
      if (!result.success) return
      const detail = await api.accountHandovers.get(handover.id)
      if (detail.success) setHandover(detail.data as HandoverView)
    } finally {
      setRefreshing(false)
    }
  }

  /** 段1。このアカウントを移し元にしてコードを出す。 */
  const issueCode = async () => {
    if (issuing || !account) return
    setIssuing(true)
    try {
      const res = await api.accountHandovers.issue(account.id)
      if (!res.success) throw new Error(res.error)
      await load()
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setExecuteError('引き継ぎコードを発行できませんでした。しばらくおいてから、もう一度お試しください。') }
    } finally {
      setIssuing(false)
    }
  }

  /** 段2。このアカウントを受け取り先にしてコードを読む。読んだら移し元の画面を開き直す。 */
  const submitLinkCode = async () => {
    const code = linkCode.trim()
    if (!code || linking || !account) return
    setLinking(true)
    setLinkError('')
    try {
      const res = await api.accountHandovers.link(code, account.id)
      if (!res.success) throw new Error(res.error)
      setLinkCode('')
      const detail = await api.accountHandovers.get(res.data.id)
      if (detail.success && detail.data.fromAccountId) {
        window.location.href = `/accounts/handover?id=${detail.data.fromAccountId}`
        return
      }
      await load()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setLinkError(apiMessage(caught, 'コードを読めませんでした。期限（72時間）を過ぎていないか、書き写しを確かめてください。')) }
    } finally {
      setLinking(false)
    }
  }

  /** 段4。人が書き換えた判断を保存する。 */
  const saveDecisions = async () => {
    if (!handover || savingDecisions) return
    const changed = handover.decisions.filter((d) => decisionEdits[d.id] !== undefined)
    if (changed.length === 0) return
    setSavingDecisions(true)
    setDecisionError('')
    try {
      const res = await api.accountHandovers.saveDecisions(handover.id, changed.map((d) => ({
        fromFriendId: d.from_friend_id,
        toFriendId: decisionEdits[d.id] === 'link' ? d.to_friend_id : null,
        decision: decisionEdits[d.id]!,
        bucket: d.bucket,
        note: d.note ?? null,
      })))
      if (!res.success) throw new Error(res.error)
      const detail = await api.accountHandovers.get(handover.id)
      if (detail.success) {
        setHandover(detail.data as HandoverView)
        setDecisionEdits({})
      }
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setDecisionError(apiMessage(caught, '判断を保存できませんでした。しばらくおいてから、もう一度お試しください。')) }
    } finally {
      setSavingDecisions(false)
    }
  }

  /** 段6。切り戻し。本実行から7日間だけ。 */
  const runRollback = async (ticket: object | null) => {
    if (!handover || rollingBack || !ticket || confirmationState.current.rollback !== ticket || !rollbackOpen || !rollbackConfirmation || rollbackConfirmation.id !== handover.id) return
    if (!rollbackConfirmation.revision) { setRollbackError('切り戻せませんでした。期限（7日間）を過ぎていないか確かめてください。'); return }

    setRollingBack(true)
    setRollbackError('')
    try {
      const token = await stepUpGate('account_handover.execute', '引き継ぎの切り戻し')
      if (token === null || confirmationState.current.rollback !== ticket) { setRollingBack(false); return }
      const res = await api.accountHandovers.rollback(rollbackConfirmation.id, undefined, token, rollbackConfirmation.revision)

      if (!res.success) throw new Error(res.error)
      setRollbackOpen(false)
      const detail = await api.accountHandovers.get(handover.id)
      if (detail.success) setHandover(detail.data as HandoverView)
      notifyToast(`切り戻しました。${formatNumber(res.data.restoredCount)} 人を元のアカウントへ戻しました。`)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)

      { if (!fieldFailure)
      setRollbackError(apiMessage(caught, '切り戻せませんでした。期限（7日間）を過ぎていないか確かめてください。')) }
    } finally {
      setRollingBack(false)
    }
  }

  /** 進行中の引き継ぎを取り消す。終わった引き継ぎは消せない。 */
  const runCancel = async (ticket: object | null) => {
    if (!handover || cancelling || !ticket || confirmationState.current.cancel !== ticket || !cancelOpen || !cancelConfirmation || cancelConfirmation.id !== handover.id) return false
    if (!cancelConfirmation.revision) { setExecuteError('取り消せませんでした。しばらくおいてから、もう一度お試しください。'); return false }

    setCancelling(true)
    try {
      const res = await api.accountHandovers.cancel(cancelConfirmation.id, cancelConfirmation.revision)
      if (!res.success) throw new Error(res.error)
      setCancelOpen(false)
      await load()
      return true
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setExecuteError('取り消せませんでした。しばらくおいてから、もう一度お試しください。') }
      return false
    } finally {
      setCancelling(false)
    }
  }

  /** 段5。本実行。確認の窓と本人確認を済ませてから進める（X-3）。 */
  const executeHandover = async (ticket: object | null) => {
    if (!handover || executing || !ticket || confirmationState.current.execute !== ticket || !confirmOpen || !executeConfirmation || executeConfirmation.id !== handover.id) return
    if (!executeConfirmation.revision) { setExecuteError('本実行できませんでした。しばらくおいてから、もう一度お試しください。'); return }

    setExecuting(true)
    setExecuteError('')
    try {
      const token = await stepUpGate('account_handover.execute', '友だちの引き継ぎを本実行する')
      if (token === null || confirmationState.current.execute !== ticket) { setExecuting(false); return }
      const result = await api.accountHandovers.execute(executeConfirmation.id, token, executeConfirmation.revision)

      if (!result.success) {
        setExecuteError(result.error)
        return
      }
      setConfirmOpen(false)
      const detail = await api.accountHandovers.get(handover.id)
      if (detail.success) setHandover(detail.data as HandoverView)
      const moved = result.data.movedCount ?? result.data.plannedCount ?? 0
      notifyToast(result.data.failureReason ?? `本実行が終わりました。${formatNumber(moved)} 人を移しました。`)
    } catch (saveFailure) {
      const fieldFailure = saveErrors.capture(saveFailure)

      { if (!fieldFailure)
      setExecuteError('本実行できませんでした。しばらくおいてから、もう一度お試しください。') }
    } finally {
      setExecuting(false)
    }
  }

  const frame = (title: string, description: string | undefined, children: ReactNode) => (
    <div className={styles.screen}>
      <SettingsPage layout="account-handover" boardId="x2dSNv" title={title} help={description} navigation={<SettingsInnerNav inline />}>
        {children}
      </SettingsPage>
      {stepUpPrompt}
    </div>
  )

  if (!id) {
    return frame('乗り換え', undefined, (
      <TargetMissing
        kind="unspecified"
        title="乗り換えるアカウントが指定されていません"
        description="LINEアカウントの一覧からアカウントを選び、詳細の「乗り換え」から進んでください。"
        backHref="/accounts"
        backLabel="LINEアカウントの一覧へ戻る"
      />
    ))
  }
  if (status === 'loading') return frame('乗り換え', undefined, <DetailLoading />)
  if (missing || (status === 'ready' && !account)) {
    return frame('乗り換え', undefined, (
      <TargetMissing
        kind="not-found"
        title="このアカウントは見つかりません"
        description="削除されたか、別の記録です。一覧から選び直してください。"
        backHref="/accounts"
        backLabel="LINEアカウントの一覧へ戻る"
      />
    ))
  }
  if (status === 'error' || !account) {
    return frame('乗り換え', undefined, (
      <TargetMissing
        kind="error"
        title="乗り換えの情報を読み込めませんでした"
        description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。"
        onRetry={() => void load()}
      />
    ))
  }

  const viewerBand = !canManage ? (
    <ReadOnlyNotice role="status">{NO_MANAGE_NOTE}</ReadOnlyNotice>
  ) : null

  // 段1・段2の入口。出す側と受け取る側の両方の口を出す。
  if (!handover) {
    return frame(`乗り換え（${account.name}）`, '引き継ぎコードで両方のアカウントをつなぎます。コードを出すだけ・読むだけでは何も変わりません。', (
      <>
        <HandoverSteps current={1} />
        {viewerBand}
        <div className={styles.duo}>
          <Card surface="inset" layout="vertical" contentPadding="var(--polish-space-card)" gap="var(--tpl-acd-ho-list-gap)" className={styles.card}>
            <h3 className={styles.cardTitle}>このアカウントから移す</h3>
            <p className={styles.list}>引き継ぎコードを発行します。コードの期限は72時間で、1回だけ使えます。発行するだけでは何も変わりません。</p>
            {executeError ? <Notice tone="danger" message={executeError} onClose={() => setExecuteError('')} /> : null}
            {canManage ? (
              <span><Button type="button" variant="primary" disabled={issuing} busy={issuing} busyLabel="発行中…" onClick={() => { setExecuteError(''); void issueCode() }}>引き継ぎコードを出す</Button></span>
            ) : null}
          </Card>
          <Card surface="inset" layout="vertical" contentPadding="var(--polish-space-card)" gap="var(--tpl-acd-ho-list-gap)" className={styles.card}>
            <h3 className={styles.cardTitle}>このアカウントへ移す</h3>
            <p className={styles.list}>移し元のアカウントで発行した引き継ぎコードを入れてください。読んだだけでは友だちは動きません。あとで事前確認をします。</p>
            {canManage ? (
              <div className={styles.inlineForm}>
                <SaveErrorField names={["linkCode","link_code"]}><TextField placeholder="引き継ぎコード" aria-label="引き継ぎコード" value={linkCode} onChange={(event) => setLinkCode(event.target.value)} disabled={linking} /></SaveErrorField>
                <Button type="button" variant="primary" disabled={linking || !linkCode.trim()} busy={linking} busyLabel="確認中…" onClick={() => void submitLinkCode()}>コードを読む</Button>
              </div>
            ) : null}
            {linkError ? <Notice tone="danger" >{linkError}</Notice> : null}
          </Card>
        </div>
      </>
    ))
  }

  const pill = handoverPill(handover.status)
  const unresolved = handover.unresolvedReviews ?? 0
  const reviewTotal = handover.counts?.review ?? null
  const decided = reviewTotal !== null ? Math.max(0, reviewTotal - unresolved) : null
  const editCount = Object.keys(decisionEdits).length
  const declaredMismatch = handover.declaredFriendTotal !== null
    && handover.declaredFriendTotal !== undefined
    && handover.counts !== null
    && handover.declaredFriendTotal !== handover.counts.sourceTotal
  const executeDisabled = unresolved > 0 || handover.status === 'completed' || editCount > 0 || declaredMismatch
  const destinationName = destination?.name ?? '受け取り先'
  const executeTicket = confirmationState.current.execute
  const cancelTicket = confirmationState.current.cancel
  const rollbackTicket = confirmationState.current.rollback
  const handoverTargets = [
    { id: handover.fromAccountId ?? '', name: handover.fromAccountId === account.id ? account.name : undefined, label: '移し元のLINEアカウント' },
    { id: handover.toAccountId ?? '', name: destination?.name, label: '移し先のLINEアカウント' },
  ]

  return <SaveErrorScope errors={saveErrors}>{frame(`乗り換え（${account.name} → ${destination?.name ?? emptyValue('unknown')}）`, '引き継ぎコードで両方のアカウントをつなぎました。「要確認」を全部決めるまで本実行できません。', (
    <>
      <HandoverSteps current={pill} />
      {viewerBand}

      <div className={styles.duo}>
        <Card className={styles.box} layout="vertical" surface="muted" corner="control" contentPadding="var(--polish-space-card)" gap="var(--tpl-acd-ho-box-gap)">
          <p className={styles.boxHead}>
            <span className={styles.boxLabel}>どこからどこへ</span>
            <span className={styles.boxLabel}>
              コード {handover.code}{handover.codeExpiresAt ? `（${formatDateTime(handover.codeExpiresAt)} まで）` : ''}{' '}
              <CopyTextButton value={handover?.code ?? ""} aria-label="引き継ぎコードをコピー"  />
            </span>
          </p>
          <p className={styles.boxValue}>{account.name}（引継ぎ元・元データを残す）→ {destination?.name ?? emptyValue('unknown')}（引継ぎ先）</p>
          {handover.providerMatch === 'different' ? (
            <p className={styles.boxWarn}>{DIFFERENT_PROVIDER_LEAD}。{DIFFERENT_PROVIDER_DETAIL}</p>
          ) : null}
          {accountsFailed ? (
            <Notice
              tone="warn"
              message="受け取り先の一覧だけ読み込めませんでした。引き継ぎの内容はそのまま見られます。"
              action={<Button type="button" variant="secondary" disabled={accountsRetrying} busy={accountsRetrying} busyLabel="読み込んでいます" onClick={() => void retryAccounts()}>一覧だけ読み直す</Button>}
            />
          ) : null}
        </Card>
        <Card className={`${styles.box} ${styles.result}`} layout="vertical" surface="muted" corner="control" contentPadding="var(--polish-space-card)" gap="var(--tpl-acd-ho-box-gap)">
          <p className={styles.boxHead}>
            <span className={styles.boxLabel}>事前確認の結果</span>
            {canManage ? (
              <Button type="button" variant="text" textTone="ink" presentation="account-inline" aria-expanded={declaredOpen} onClick={() => setDeclaredOpen((open) => !open)}>
                {handover.declaredFriendTotal != null ? `申告 ${formatNumber(handover.declaredFriendTotal)} 人` : '申告の数を入れる'}
              </Button>
            ) : handover.declaredFriendTotal != null ? (
              <span className={styles.boxLabel}>申告 {formatNumber(handover.declaredFriendTotal)} 人</span>
            ) : null}
          </p>
          <p className={styles.boxValue}>{countsAreComplete && handover.counts ? countsLine(handover.counts) : '事前確認の合計が元の友だちの数と合わないので、数を出していません'}</p>
          {canManage && declaredOpen ? (
            <div className={styles.declared}><Field label="移し元のシステムが言う友だちの数（分からなければ空欄）。違うままでは本実行しません。" htmlFor="acd-declared"><div className={styles.inlineForm}>
                <SaveErrorField names={["declaredTotalInput","declared_total_input"]}><NumberInput id="acd-declared" type="number" min={0} placeholder="例：14" value={declaredTotalInput} onChange={(event) => setDeclaredTotalInput(event.target.value)} disabled={refreshing || !handover.counts} /></SaveErrorField>
                <Button type="button" disabled={refreshing || !countsAreComplete} busy={refreshing} busyLabel="確認中…" onClick={() => void rerunPreview()}>事前確認をやり直す</Button>
              </div></Field></div>
          ) : null}
          {declaredMismatch ? (
            <p className={styles.boxWarn}>申告の数（{formatNumber(handover.declaredFriendTotal)}人）と事前確認の合計（{handover.counts?.sourceTotal ?? emptyValue('unknown')}人）が違います。差の理由を確かめてから、数を直すか事前確認をやり直してください。</p>
          ) : null}
        </Card>
      </div>

      <Card variant="records" padding="rows"><DataTable presentation="account-handover" label={`要確認 ${handover.counts?.review ?? emptyValue('unknown')}人の判断`}>
        <thead>
        <TableHeadRow>
          <Th className={styles.colName}>元の友だち</Th>
          <Th className={styles.colName}>受け取り先の候補</Th>
          <Th className={styles.colEvidence}>つないだ根拠</Th>
          <Th className={styles.colChoice}>この人の判断</Th>
        </TableHeadRow></thead>
        <tbody>{handover.decisions.length === 0 ? (
          <TableStateRow colSpan={4} kind="empty" title="決めた人はまだいません。" />
        ) : handover.decisions.map((decision) => {
          const shown = decisionEdits[decision.id] ?? decision.decision
          // 人が決める段（X-3）。「要確認」「別人の可能性」の行だけ書き換えられる。見るだけの人には出さない。
          const editable = canManage && (decision.bucket === 'review' || decision.bucket === 'lookalike')
          const name = decision.sourceName ?? decision.from_friend_id
          return (
            <Tr data-row-id={decision.id} key={decision.id}>
              <Td className={styles.colName}><div className={styles.nameStack}>
                <span className={styles.name} title={name}>{name}</span>

              </div></Td>
              <Td className={styles.colName}><div className={styles.nameStack}>
                <span className={styles.name}>{decision.candidateName ?? '候補なし'}</span>

              </div></Td>
              <Td className={styles.colEvidence}>{decision.evidenceLabel ?? decision.note ?? '—'}</Td>
              <Td className={styles.colChoice}>
                {editable ? (
                  <SaveErrorField names={["shown","decisionEdits","decision_edits"]}><Select
                    width={150}
                    aria-label={`${name}の判断`}
                    value={shown}
                    disabled={savingDecisions}
                    onChange={(value) => setDecisionEdits((prev) => ({ ...prev, [decision.id]: value as 'link' | 'new' | 'skip' }))}
                    options={[
                      ...(decision.to_friend_id || shown === 'link' ? [{ value: 'link', label: '同じ人' }] : []),
                      { value: 'new', label: '新しく作る' },
                      { value: 'skip', label: '引き継がない' },
                    ]}
                  /></SaveErrorField>
                ) : (
                  <span className={styles.fixed}>{decisionLabel(shown)}</span>
                )}
              </Td>
            </Tr>
          )
        })}</tbody>
      </DataTable></Card>

      {canManage && (editCount > 0 || decisionError) ? (
        <Notice role={decisionError ? "alert" : "note"} tone={decisionError ? "danger" : "warn"} action={<>
          <Button type="button" disabled={refreshing || !countsAreComplete} busy={refreshing} busyLabel="確認中…" onClick={() => void rerunPreview()}>
            <RotateCcw size={16} aria-hidden="true" />事前確認をやり直す
          </Button>
          <Button type="button" variant="primary" disabled={savingDecisions} busy={savingDecisions} onClick={() => void saveDecisions()}>判断を保存する</Button>
        </>}>
          {decisionError
            ? decisionError
            : <p className={styles.pendingText}>{formatNumber(editCount)} 件の書き換えをまだ保存していません。保存するまで本実行へ進めません。</p>}
        </Notice>
      ) : null}

      <div className={styles.duo}>
        <Card surface="standard" layout="vertical" contentPadding="var(--polish-space-card)" gap="var(--tpl-acd-ho-list-gap)" className={styles.card}>
          <h3 className={styles.cardTitle}>戻せること</h3>
          <p className={styles.list}>{[
            '・7日以内は、今回作った対応付けだけを戻せます',
            '・引継ぎ後に増えた履歴や配信拒否は消しません',
            '・送信済みのメッセージは取り消せません',
          ].join('\n')}</p>
        </Card>
        <Card surface="standard" layout="vertical" contentPadding="var(--polish-space-card)" gap="var(--tpl-acd-ho-list-gap)" className={styles.card}>
          <h3 className={styles.cardTitle}>気をつけること</h3>
          <p className={styles.list}>{[
            '・本実行しても、元のアカウントの友だち・履歴・元のID と所属は残します',
            '・本実行の前に、控えと戻し先の目印を作ります',
            '・送信を止める設定と同意状態は、厳しいほうを引き継ぎます',
            '・名前と画像だけが似ている組は、自動では同じ人にしません',
            '・配信元の切り替えは、別に確かめてから行います（この実行では切り替えません）',
          ].join('\n')}</p>
        </Card>
      </div>

      {executeError ? <Notice tone="danger" message={executeError} onClose={() => setExecuteError('')} /> : null}

      <StickyBar presentation="account-handover" status={<p className={styles.bottomNote}>
          {unresolved > 0
            ? `未判断が ${unresolved} 人残っています${reviewTotal !== null && decided !== null ? `（要確認 ${formatNumber(reviewTotal)} 人のうち ${decided} 人を決めた）` : ''}。全員を決めると本実行できます`
            : ''}
        </p>} actions={<>
        {/* 取り消しは進行中だけ。変更なので見るだけの人には出さない。 */}
        {canManage && handover.status !== 'completed' && handover.status !== 'failed' && handover.status !== 'cancelled' ? (
          <Button type="button" onClick={() => { setExecuteError(''); openConfirmation('cancel'); setCancelConfirmation({ id: handover.id, revision: handover.confirmationRevision }); setCancelOpen(true) }}>引き継ぎをやめる</Button>
        ) : null}
        {canManage && handover.status !== 'completed' ? (
          <Button type="button" variant="primary" disabled={executeDisabled} title={executeDisabled ? unresolved > 0 ? '全員の判断を決めてください' : executing ? '実行しています' : '事前確認と判断の状態を確かめてください' : undefined} busy={executing} busyLabel="実行中…" onClick={() => { setExecuteError(''); openConfirmation('execute'); setExecuteConfirmation({ id: handover.id, revision: handover.confirmationRevision }); setConfirmOpen(true) }}>

            <Play size={16} aria-hidden="true" />本実行する{unresolved > 0 ? `（あと ${unresolved} 人）` : ''}
          </Button>
        ) : null}
      </>} />

      {/* 切り戻し（X-3）。本実行から7日間だけ。変更なので見るだけの人には出さない。 */}
      {canManage && handover.status === 'completed' && !handover.rolledBackAt && handover.rollbackDeadline
        && handover.rollbackDeadline > new Date().toISOString() ? (
          <Card surface="standard" layout="vertical" contentPadding="var(--polish-space-card)" gap="var(--tpl-acd-ho-list-gap)" className={styles.card}>
            <h3 className={styles.cardTitle}>移した友だちを元へ戻す</h3>
            <p className={styles.list}>{formatDateTime(handover.rollbackDeadline)} まで切り戻せます。動かした友だちだけを元のアカウントへ戻します。</p>
            <span><Button type="button" variant="danger" onClick={() => { setRollbackError(''); openConfirmation('rollback'); setRollbackConfirmation({ id: handover.id, revision: handover.confirmationRevision }); setRollbackOpen(true) }}>切り戻す</Button></span>

          </Card>
        ) : null}
      {handover.rolledBackAt ? (
        <Notice tone="info" message={`切り戻し済みです（${formatDateTime(handover.rolledBackAt)}）。${handover.rollbackNote ? `理由: ${handover.rollbackNote}` : ''}`} />
      ) : null}

      <UnsavedLeaveDialog open={leaveTarget !== null} subject="保存していない判断の書き換え" onConfirm={confirmLeave} onCancel={cancelLeave} />
      <ConfirmDialog
        open={confirmOpen && confirmationState.current.execute !== null}
        title="本実行しますか？"
        description={`要確認はすべて決めました。本実行すると、決めた内容で友だちが「${destinationName}」へ移ります。元のアカウントの友だち・履歴・配信は消しません。約 ${formatNumber(handover.decisions.filter(decision => decision.decision === 'link' || decision.decision === 'new').length)} 人を移します。`}
        confirmLabel="本実行する" busyLabel="実行中…"
        busy={executing}
        error={executeError}
        onConfirm={() => executeHandover(executeTicket)}
        onCancel={() => { if (!executing) { confirmationState.current.execute = null; setConfirmOpen(false); setExecuteError('') } }}
      ><OperationTargetSummary accounts={handoverTargets} /></ConfirmDialog>
      <ConfirmDialog
        open={cancelOpen && confirmationState.current.cancel !== null}
        title="この引き継ぎを取り消しますか？"
        description="進行中の引き継ぎをやめます。コードは使えなくなり、決めた内容は破棄されます。元のアカウントの友だちは変わりません。"
        confirmLabel="引き継ぎを取り消す" busyLabel="取り消し中…"
        destructive
        busy={cancelling}
        error={executeError || undefined} onSuccess={() => setCancelOpen(false)} onConfirm={() => runCancel(cancelTicket)}
        onCancel={() => { if (!cancelling) { confirmationState.current.cancel = null; setCancelOpen(false) } }}
      ><OperationTargetSummary accounts={handoverTargets} /></ConfirmDialog>
      <ConfirmDialog
        open={rollbackOpen && confirmationState.current.rollback !== null}
        title="移した友だちを元へ戻しますか？"
        description={`本実行で「${destinationName}」へ移した友だちを、元の「${account.name}」へ戻します。移したあとで人が動かした人は戻しません。人数は戻す時に決まります。`}
        confirmLabel="切り戻す" busyLabel="戻し中…"
        destructive
        busy={rollingBack}
        error={rollbackError}
        onConfirm={() => runRollback(rollbackTicket)}
        onCancel={() => { if (!rollingBack) { confirmationState.current.rollback = null; setRollbackOpen(false); setRollbackError('') } }}
      ><OperationTargetSummary accounts={handoverTargets} /></ConfirmDialog>
    </>
  ))}</SaveErrorScope>
}

/** 乗り換えの段（型の共通部品 Steps・Fa8ED）。題と説明のすぐ下・左寄せ・1行。段は押せない。 */
function HandoverSteps({ current }: { current: number }) {
  return (
    <Steps
      label="乗り換えの段"
      currentKey={String(current)}
      steps={HANDOVER_PILLS.map((label, index) => ({
        key: String(index + 1),
        label,
        state: index + 1 < current ? 'done' as const : 'todo' as const,
      }))}
    />
  )
}
