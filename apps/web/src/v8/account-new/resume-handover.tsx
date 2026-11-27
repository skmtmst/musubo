'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import LineAccountEntryGate from '@/components/line-account-entry-gate'
import { api, type FollowerImportState, type LineAccountConnectData } from '@/lib/api'
import { styleApi } from '@/lib/api/helpers/styles'
import { useAccount } from '@/contexts/account-context'
import { usePageTitle } from '@/components/shell/page-chrome'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { readStaffIdentity } from '@/lib/staff-identity-state'
import { withRequestTimeout } from '@/lib/request-timeout'
import { PageFrame, PageHeading } from '@/components/templates/page-frame'
import { Steps } from '@/components/templates/steps'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import StickyBar from '@/components/shared/sticky-bar'
import Step5Completion from './step5-completion'
import { handoverProgress, latestFollowerImportState } from './logic'
import { REGISTRATION_STYLE_KEY, registrationImportChoiceKey, registrationStorageKey } from './registration-storage'
import styles from './register.module.css'

const LABELS = ['事前確認', 'アカウント接続', '接続確認', '使い方を選ぶ', '完了'] as const
const STYLE_LABELS: Record<string, string> = {
  restaurant: '飲食店', salon: 'サロン', consult: '面談・相談', lesson: '教室・レッスン', ec: 'EC', standard: '標準',
}

/** 統括から戻っても、登録時と同じ進捗カードで保存済みのジョブを再開する。 */
export default function ResumeFollowerHandover() {
  usePageTitle('LINEアカウントを登録')
  const accountId = useSearchParams().get('accountId') ?? ''
  return <LineAccountEntryGate key={accountId} accountId={accountId} allowHandover>
    <FollowerHandover accountId={accountId} />
  </LineAccountEntryGate>
}

function FollowerHandover({ accountId }: { accountId: string }) {
  const router = useRouter()
  const canAdvance = canManageRole(useStaffRole())
  const choiceKey = registrationImportChoiceKey(registrationStorageKey(REGISTRATION_STYLE_KEY, readStaffIdentity()), accountId)
  const { accounts, setSelectedAccountId } = useAccount()
  const account = accounts.find((item) => item.id === accountId)
  const [state, setState] = useState<FollowerImportState | null>(null)
  const skipped = stateChoice(choiceKey) === false && state?.phase === 'not_started'
  const [readError, setReadError] = useState(false)
  const [stepError, setStepError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const refreshSequence = useRef(0)
  const refreshPending = useRef<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [styleLabel, setStyleLabel] = useState('')
  const running = state?.phase === 'importing_ids' || state?.phase === 'hydrating_profiles'
  const complete = state?.phase === 'completed' || skipped

  const refresh = useCallback(async () => {
    if (!accountId || refreshPending.current !== null) return
    const request = ++refreshSequence.current
    refreshPending.current = request
    setRefreshing(true)
    try {
      const response = await withRequestTimeout(api.lineAccounts.followerImportState(accountId))
      if (request !== refreshSequence.current) return
      if (!response.success) throw new Error(response.error)
      setState((current) => latestFollowerImportState(current, response.data))
      setReadError(false)
    } catch {
      if (request === refreshSequence.current) setReadError(true)
    } finally {
      if (request === refreshSequence.current) { refreshPending.current = null; setRefreshing(false) }
    }
  }, [accountId])

  useEffect(() => {
    setState(null)
    setReadError(false)
    setStepError(false)
    setRefreshing(false)
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => { clearInterval(timer); refreshSequence.current += 1; refreshPending.current = null }
  }, [refresh])

  useEffect(() => {
    setStyleLabel('')
    if (!accountId) return
    let active = true
    void styleApi.get(accountId).then((response) => {
      if (active && response.success) {
        const key = response.data.style
        setStyleLabel(Object.prototype.hasOwnProperty.call(STYLE_LABELS, key) ? STYLE_LABELS[key] : '')
      }
    }).catch(() => undefined)
    return () => { active = false }
  }, [accountId])

  useEffect(() => {
    if (!running || !accountId || !canAdvance) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const advance = async () => {
      try {
        const response = await api.lineAccounts.stepFollowerImport(accountId)
        if (!active) return
        if (!response.success) throw new Error(response.error)
        setStepError(false)
        setState((current) => latestFollowerImportState(current, response.data.state))
        if (response.data.state.phase === 'importing_ids' || response.data.state.phase === 'hydrating_profiles') {
          timer = setTimeout(() => void advance(), response.data.busy ? 3000 : 500)
        }
      } catch {
        if (active) {
          setStepError(true)
          timer = setTimeout(() => void advance(), 5000)
        }
      }
    }
    void advance()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [accountId, canAdvance, running])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const parsedUpdatedAt = state?.updatedAt ? Date.parse(state.updatedAt) : Number.NaN
  const idleSeconds: number | null = state?.updatedAt
    ? (Number.isFinite(parsedUpdatedAt) ? Math.max(0, Math.floor((now - parsedUpdatedAt) / 1000)) : null)
    : null
  const progress = useMemo(() => handoverProgress({
    phase: state?.phase ?? 'importing_ids', received: state?.received ?? 0,
    imported: state?.imported ?? 0, alreadyPresent: state?.alreadyPresent ?? 0,
    reactivated: state?.reactivated ?? 0, claimedUnassigned: state?.claimedUnassigned ?? 0,
    conflicts: state?.conflicts ?? 0, invalid: state?.invalid ?? 0,
    profilesUpdated: state?.profilesUpdated ?? 0,
  }), [state])
  const connection: LineAccountConnectData = {
    id: accountId, steps: [], pictureUrl: account?.pictureUrl ?? null,
    displayName: account?.displayName ?? account?.name,
    basicId: account?.basicId ?? null,
    followerImport: { capability: state?.capability ?? 'available', phase: state?.phase ?? 'importing_ids' },
    remainingActions: [],
  }
  const enter = () => {
    if (!complete) return
    setSelectedAccountId(accountId)
    router.push('/')
  }

  return <PageFrame kind="wizard" boardId="Plmq1">
    <PageHeading title="LINEアカウントを登録" help={skipped ? '友だちの引き継ぎは選択されていません。' : 'いまの友だちを引き継いでいます。終わると完了です。'} steps={<Steps
      label="登録の進捗" summaryLayout="aligned" currentKey="5"
      summaries={{ '1': '事前確認済み', '2': 'LINEの接続設定を確認済み', '3': '', '4': styleLabel }}
      steps={LABELS.map((label, index) => ({ key: String(index + 1), label, order: index + 1, state: index < 4 ? 'done' as const : 'todo' as const }))}
    />} />
    <div className={styles.body}>
      {!accountId ? <ListState kind="error" title="アカウントを確認できません" />
        : readError && !state ? <ListState kind="error" title="引き継ぎの状態を確認できません" onRetry={() => void refresh()} />
        : state?.phase === 'not_started' && !skipped ? <ListState kind="error" title="引き継ぎが開始されていません" onRetry={() => void refresh()} />
        : <Step5Completion connection={connection} accountName={account?.name ?? ''} createdId={accountId}
          importRunning={running || !state} importFriends={!skipped} importState={state} handover={progress}
          idleSeconds={idleSeconds} requestError={readError || stepError} onRefresh={() => void refresh()} refreshing={refreshing} />}
      <StickyBar presentation="account-registration" actions={<>
        {(readError || stepError || (running && (idleSeconds === null || idleSeconds >= 60))) && <Button type="button" variant="primary" busy={refreshing} busyLabel="確認中…" onClick={() => void refresh()}>状態を再確認</Button>}
        {complete && <Button type="button" variant="primary" onClick={enter}>アカウントに入る</Button>}
        <Button href="/hq" variant={complete || readError || stepError ? 'secondary' : 'primary'}><ArrowLeft size={16} aria-hidden="true" />統括コンソールへ戻る</Button>
      </>} />
    </div>
  </PageFrame>
}

function stateChoice(key: string | null): boolean | null {
  try { const value = key ? localStorage.getItem(key) : null; return value === 'true' ? true : value === 'false' ? false : null }
  catch { return null }
}
