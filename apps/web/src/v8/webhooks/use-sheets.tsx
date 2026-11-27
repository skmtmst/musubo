'use client'
import { emptyValue } from '@/components/shared/empty-value'
import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { useAccount } from '@/contexts/account-context'
import { api,type GoogleSheetsConnection,type GoogleSheetsSyncRun } from '@/lib/api'
import { useStaffRole } from '@/lib/staff-role'
import { isGoogleSheetsConnectionPayload,isGoogleSheetsRunsPayload } from '@line-crm/shared'
import { useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  useWebhookOverview
} from './shell'
import { shortDateTime } from './words'




import { runKindLabel, runStatusLabel, STALE_RUN_MS, groupRuns, syncResultProblem } from './sheets-runs'

type LoadStatus = 'loading' | 'ready' | 'error'

/* OAuth の戻り先の知らせ（管理画面 の google-sheets-panel と同じ言葉）。 */
const CALLBACK_MESSAGES: Record<string, { tone: 'success' | 'warn' | 'danger'; text: string }> = {
  connected: { tone: 'success', text: 'Googleアカウントと接続しました。書き出し先のスプレッドシートを設定してください。' },
  reconnected: { tone: 'success', text: 'Googleアカウントを再接続しました。' },
  'error:denied': { tone: 'warn', text: 'Googleでの許可が取り消されました。接続するには、もう一度「Googleアカウントを接続する」から進んでください。' },
  'error:invalid_state': { tone: 'danger', text: '接続の確認に失敗しました。時間が経ちすぎた可能性があります。もう一度最初からお試しください。' },
  'error:no_refresh_token': { tone: 'danger', text: 'Googleから長期利用の許可を受け取れませんでした。Googleアカウント側でこのアプリへの許可を一度取り消してから、接続をやり直してください。' },
  'error:account_missing': { tone: 'danger', text: '接続しようとしたLINEアカウントが見つかりません。アカウントの選択を確かめてからやり直してください。' },
  'error:oauth_not_configured': { tone: 'danger', text: 'この環境にはGoogle接続の設定がまだありません。管理者に確かめてください。' },
  'error:encryption_key_missing': { tone: 'danger', text: 'この環境の暗号化設定が不足しています。管理者に確かめてください。' },
  'error:state_cancelled': { tone: 'warn', text: 'この接続操作は、途中で別の接続操作や解除が行われたため取り消されました。接続したい場合はもう一度最初から進めてください。' },
  'error:no_permission': { tone: 'danger', text: 'Googleの許可画面でスプレッドシートの許可が外れていたため、接続していません。もう一度接続して、この許可を付けたままにしてください。' },
}

export function sheetsCallbackNotice(result: string | null) {
  if (!result) return null
  if (Object.prototype.hasOwnProperty.call(CALLBACK_MESSAGES, result)) return CALLBACK_MESSAGES[result]
  return result.startsWith('error:') ? { tone: 'danger' as const, text: 'Googleとの接続に失敗しました。もう一度お試しください。' } : null
}

export function sheetsLastSyncText(at: string | null | undefined, status: string | null | undefined, kind: string | null | undefined): string {
  return at ? `${shortDateTime(at)}${kind ? ` ${runKindLabel(kind)}` : ''}・${runStatusLabel(status ?? '')}` : emptyValue('unknown')
}

export function useSheets() {

  const saveErrors = useSaveFormErrors()
  usePageTitle('外部連携')
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const { selectedAccountId, selectedAccount, accounts } = useAccount()
  const accountScope = useRef({ id: selectedAccountId, generation: 0 })
  if (accountScope.current.id !== selectedAccountId) accountScope.current = { id: selectedAccountId, generation: accountScope.current.generation + 1 }
  const accountGeneration = accountScope.current.generation
  const staffRole = useStaffRole()
  const isOwner = staffRole === 'owner'
  const searchParams = useSearchParams()
  const callbackResult = searchParams.get('sheets')
  const overview = useWebhookOverview()

  const [connection, setConnection] = useState<GoogleSheetsConnection | null>(null)
  const [runs, setRuns] = useState<GoogleSheetsSyncRun[]>([])
  /* 接続の操作ができるかは口が返す（canManage）。 */
  const [canManage, setCanManage] = useState(false)
  const [oauthConfigured, setOauthConfigured] = useState(true)
  const [syncRunning, setSyncRunning] = useState(false)
  const [status, setStatus] = useState<LoadStatus>('loading')
  const [actionError, setActionError] = useState('')
  const [saveNotice, setSaveNotice] = useState('')
  const [disconnectNotice, setDisconnectNotice] = useState('')
  const [runsError, setRunsError] = useState('')
  const [runsLoading, setRunsLoading] = useState(false)
  const [busy, setBusy] = useState<'connect' | 'target' | 'sync' | 'disconnect' | null>(null)
  const writeLocks = useRef(new Map<string, 'target' | 'sync'>())
  const [showTargetForm, setShowTargetForm] = useState(false)
  const [targetInput, setTargetInput] = useState('')
  const [disconnectFor, setDisconnectFor] = useState<{ id: string; label: string } | null>(null)

  const accountRef = useRef(selectedAccountId)
  accountRef.current = selectedAccountId
  const loadGenerationRef = useRef(0)
  const runsGenerationRef = useRef(0)

  const loadRuns = useCallback(async (accountId: string, signal?: AbortSignal) => {
    const generation = ++runsGenerationRef.current
    setRunsLoading(true)
    try {
      const res = await api.webhooks.googleSheets.runs(accountId, { signal })
      if (runsGenerationRef.current !== generation || accountRef.current !== accountId) return
      if (res.success && isGoogleSheetsRunsPayload(res.data)) {
        setRuns(res.data.runs)
        setRunsError('')
      } else {
        setRunsError('同期の記録を読み込めませんでした。')
      }
    } catch (saveFailure) {
      if (runsGenerationRef.current !== generation || accountRef.current !== accountId) return
      const fieldFailure = saveErrors.capture(saveFailure)
      { if (!fieldFailure)
      setRunsError('同期の記録を読み込めませんでした。') }
    } finally {
      if (runsGenerationRef.current === generation && accountRef.current === accountId) setRunsLoading(false)
    }
  }, [saveErrors])

  const load = useCallback(async () => {
    const generation = ++loadGenerationRef.current
    const accountId = selectedAccountId
    setConnection(null)
    setActionError('')
    if (!accountId) {
      setRuns([])
      setRunsError('')
      setStatus('ready')
      return true
    }
    setStatus('loading')
    const signal = AbortSignal.timeout(30_000)
    const runsPromise = loadRuns(accountId, signal)
    const result = await api.webhooks.googleSheets.connection(accountId, { signal })
      .then((res) => ({ ok: true as const, res }))
      .catch(() => ({ ok: false as const }))
    if (loadGenerationRef.current !== generation || accountRef.current !== accountId) {
      await runsPromise
      return false
    }
    const payload = result.ok && result.res.success ? result.res.data : undefined
    if (isGoogleSheetsConnectionPayload(payload)) {
      setConnection(payload.connection)
      setCanManage(payload.canManage)
      setOauthConfigured(payload.oauthConfigured)
      setSyncRunning(payload.syncRunning)
      setShowTargetForm(payload.connection.status === 'pending_target')
      setStatus('ready')
      setSaveNotice('')
      await runsPromise
      return true
    }
    setStatus('error')
    await runsPromise
    return false
  }, [selectedAccountId, loadRuns])

  useEffect(() => { void load() }, [load])

  const previousAccountRef = useRef(selectedAccountId)
  useEffect(() => {
    if (previousAccountRef.current === selectedAccountId) return
    previousAccountRef.current = selectedAccountId
    setDisconnectFor(null)
    setTargetInput('')
    setShowTargetForm(false)
    setBusy(selectedAccountId ? writeLocks.current.get(selectedAccountId) ?? null : null)
    setActionError('')
    setSaveNotice('')
    setDisconnectNotice('')
  }, [selectedAccountId])

  const handleConnect = async () => {
    const accountId = selectedAccountId
    if (!accountId) return
    setBusy('connect')
    setActionError('')
    try {
      const res = await api.webhooks.googleSheets.connectStart(accountId)
      if (accountRef.current !== accountId) return
      if (!res.success) {
        setActionError(res.error)
        return
      }
      window.location.assign(res.data.authorizeUrl)
    } catch (saveFailure) {
      if (accountRef.current !== accountId) return
      const fieldFailure = saveErrors.capture(saveFailure)
      { if (!fieldFailure)
      setActionError('接続を始められませんでした。時間をおいて、もう一度お試しください。') }
    } finally {
      if (accountRef.current === accountId) setBusy(null)
    }
  }

  const handleSaveTarget = async (event: React.FormEvent) => {
    event.preventDefault()
    const accountId = selectedAccountId
    if (!accountId || writeLocks.current.has(accountId)) return
    writeLocks.current.set(accountId, 'target')
    setBusy('target')
    setActionError('')
    setSaveNotice('')
    try {
      const res = await api.webhooks.googleSheets.setTarget(accountId, targetInput.trim())
      if (accountRef.current !== accountId) return
      if (!res.success) {
        setActionError(res.error)
        return
      }
      setTargetInput('')
      setShowTargetForm(false)
      const loaded = await load()
      if (accountRef.current !== accountId) return
      if (!loaded) setSaveNotice('出力先を保存しましたが、最新の状態を読み込めませんでした。「もう一度読み込む」で状態を確かめてください。')
    } catch (saveFailure) {
      if (accountRef.current !== accountId) return
      const fieldFailure = saveErrors.capture(saveFailure)
      { if (!fieldFailure)
      setActionError('出力先を保存できませんでした。通信を確かめて、もう一度お試しください。') }
    } finally {
      writeLocks.current.delete(accountId)
      if (accountRef.current === accountId) setBusy(null)
    }
  }

  const handleSync = async () => {
    const accountId = selectedAccountId
    if (!accountId || writeLocks.current.has(accountId)) return
    writeLocks.current.set(accountId, 'sync')
    setBusy('sync')
    setActionError('')
    try {
      const res = await api.webhooks.googleSheets.sync(accountId)
      if (accountRef.current !== accountId) return
      /*
       * WEB233：同期の失敗は、HTTP 200 のまま data.status / results で返ることがある。
       * 読み直し（load）は帯の文を消すので、読み直したあとに理由を出す。
       */
      const problem = res.success ? syncResultProblem(res.data) : res.error
      await load()
      if (accountRef.current !== accountId) return
      if (problem) setActionError(problem)
    } catch (saveFailure) {
      if (accountRef.current !== accountId) return
      const fieldFailure = saveErrors.capture(saveFailure)
      { if (!fieldFailure)
      setActionError('同期を始められませんでした。時間をおいて、もう一度お試しください。') }
    } finally {
      writeLocks.current.delete(accountId)
      if (accountRef.current === accountId) setBusy(null)
    }
  }

  const handleDisconnect = async () => {
    const accountId = selectedAccountId
    if (!accountId || accountScope.current.generation !== accountGeneration || accountRef.current !== accountId || disconnectFor?.id !== accountId) return
    setBusy('disconnect')
    setDisconnectNotice('')
    try {
      const res = await api.webhooks.googleSheets.disconnect(accountId)
      if (accountScope.current.generation !== accountGeneration || accountRef.current !== accountId) return
      if (!res.success) {
        setActionError('接続を解除できませんでした。状態を読み直してから、もう一度お試しください。')
        setDisconnectFor(null)
        return
      }
      setDisconnectFor(null)
      if (!res.data?.revoked) {
        setDisconnectNotice('このアプリ側の連携は解除しましたが、Google側の許可の取り消しに失敗しました。Googleアカウントの「セキュリティ」設定から、このアプリへのアクセスを取り消してください。')
      }
      await load()
    } catch (saveFailure) {
      if (accountScope.current.generation !== accountGeneration || accountRef.current !== accountId) return
      const fieldFailure = saveErrors.capture(saveFailure)
      { if (!fieldFailure)
      setActionError('接続を解除できませんでした。時間をおいて、もう一度お試しください。') }
    } finally {
      if (accountScope.current.generation === accountGeneration && accountRef.current === accountId) setBusy(null)
    }
  }

  const callbackNotice = sheetsCallbackNotice(callbackResult)

  const connStatus: 'connected' | 'pending_target' | 'expired' | 'disconnected' = connection?.status ?? 'disconnected'
  const staleRunningRun = runs.find((run) => run.status === 'running' && Date.parse(run.startedAt) < Date.now() - STALE_RUN_MS)
  const effectivelyRunning = syncRunning && !staleRunningRun
  const groups = groupRuns(runs)
  const lastKind = runs.find((run) => run.startedAt === connection?.lastSyncedAt)?.kind
  const lastSyncText = sheetsLastSyncText(connection?.lastSyncedAt, connection?.lastSyncStatus, lastKind)


  return { saveErrors, selectedAccountId, selectedAccount, accounts, isOwner, overview, connection, canManage, oauthConfigured, status, actionError, saveNotice, disconnectNotice, runsError, runsLoading, busy, showTargetForm, setShowTargetForm, targetInput, setTargetInput, disconnectFor, setDisconnectFor, loadRuns, load, handleConnect, handleSaveTarget, handleSync, handleDisconnect, callbackNotice, connStatus, staleRunningRun, effectivelyRunning, groups, lastSyncText }
}
