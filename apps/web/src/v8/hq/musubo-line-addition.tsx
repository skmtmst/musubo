'use client'

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { api, ApiError } from '@/lib/api'
import type { MusuboLineAdditionPending, MusuboLineAdditionState, MusuboLineAdditionTarget } from '@/lib/api/features/musubo-line-addition'
import PageHeader from '@/components/shared/page-header'
import Card from '@/components/shared/card'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import ListState from '@/components/shared/list-state'
import StepUpPrompt, { isStepUpRequired, type StepUpRequest } from '@/components/step-up-prompt'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import MusuboPaymentRecovery, { RegistrationPaymentRecovery } from './musubo-payment-recovery'
import styles from './musubo-line-addition.module.css'

const billingPath = '/hq/billing/line-addition'
const yen = (value: number) => '¥' + new Intl.NumberFormat('ja-JP').format(value)
const dateTime = (value: string) => new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric',
  hour: '2-digit', minute: '2-digit',
}).format(new Date(value))

function additionHref(additionId: string) {
  return billingPath + '?' + new URLSearchParams({ additionId })
}

function matchesTarget(addition: MusuboLineAdditionPending | undefined, target: MusuboLineAdditionTarget) {
  return 'accountId' in target ? addition?.lineAccountId === target.accountId : addition?.id === target.additionId
}

function AdditionEntry() {
  const params = useSearchParams()
  const accountId = params.get('accountId')
  const additionId = params.get('additionId')
  const ambiguous = params.getAll('accountId').length > 1 || params.getAll('additionId').length > 1
  const target = useMemo<MusuboLineAdditionTarget | undefined>(() => {
    if (accountId && additionId === null) return { accountId }
    if (additionId && accountId === null) return { additionId }
    return undefined
  }, [accountId, additionId])
  if (ambiguous || (!target && (accountId !== null || additionId !== null))) return <RegistrationPaymentRecovery state="unavailable" />
  const key = accountId ? 'account:' + accountId : additionId ? 'addition:' + additionId : ''
  return <MusuboLineAdditionPage key={key} target={target} />
}

export default function AdditionPage() {
  return <Suspense fallback={<ListState kind="loading" title="登録の状態を確認しています" />}><AdditionEntry /></Suspense>
}

function MusuboLineAdditionPage({ target }: { target?: MusuboLineAdditionTarget }) {
  const router = useRouter()
  const [state, setState] = useState<MusuboLineAdditionState | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'failed' | 'unavailable'>('loading')
  const [retryCount, setRetryCount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null)
  const busyLock = useRef(false)
  const linkedId = state?.pending?.lineAccountId ? state.pending.id : null
  const recovering = Boolean(target || linkedId || state?.expired)
  usePageTitle(recovering ? 'お支払い' : 'LINE追加')
  usePageCrumbs(recovering
    ? [{ label: 'アカウント', href: '/accounts' }, { label: 'LINE追加', href: billingPath }]
    : [{ label: 'アカウント', href: '/accounts' }])

  useEffect(() => {
    let disposed = false
    void api.musuboLineAddition.get(target).then(result => {
      if (!result.success) throw new Error(result.error)
      if (disposed) return
      if (target && !matchesTarget(result.data.addition, target)) {
        setLoadState('unavailable')
        return
      }
      setState(result.data)
      setLoadState('ready')
    }).catch(caught => {
      if (disposed) return
      const unavailable = target && caught instanceof ApiError && [400, 403, 404].includes(caught.status)
      setLoadState(unavailable ? 'unavailable' : 'failed')
    })
    return () => { disposed = true }
  }, [target, retryCount])

  useEffect(() => {
    if (!target && linkedId) router.replace(additionHref(linkedId))
  }, [linkedId, router, target])

  const retryLoad = useCallback(() => {
    setLoadState('loading')
    setRetryCount(count => count + 1)
  }, [])

  const acceptAddition = async (token?: string) => {
    if (!state || busyLock.current) return
    busyLock.current = true
    setBusy(true)
    setError('')
    try {
      const amountDueYen = state.pending?.amountDueYen ?? state.price.dueNowYen
      const result = await api.musuboLineAddition.accept({ amountDueYen, activeLineCount: state.activeLineCount }, token)
      if (!result.success) throw new Error(result.error)
      if (result.data.lineAccountId) {
        router.push(additionHref(result.data.id))
      } else if (result.data.canConnect) {
        router.push('/accounts/new')
      } else {
        retryLoad()
      }
    } catch (caught) {
      if (!token && isStepUpRequired(caught)) {
        setStepUp({ purpose: 'line_account.connect', action: 'LINEの追加料金を確定する', retry: acceptAddition })
      } else setError('決済状況を確認できませんでした。内容を読み直して再度お試しください。')
    } finally {
      busyLock.current = false
      setBusy(false)
    }
  }

  if (loadState === 'loading') return <ListState kind="loading" title={target ? '登録の状態を確認しています' : 'LINE追加料金を確認しています'} />
  if (loadState === 'unavailable') return <RegistrationPaymentRecovery state="unavailable" />
  if (loadState === 'failed' || !state) return <ListState kind="error" title="LINE追加料金を表示できませんでした" onRetry={retryLoad} />

  const addition = state.addition ?? state.pending
  if (target || linkedId) {
    if (!addition?.lineAccountId || state.expired || addition.status === 'expired' || addition.status === 'cancelled') {
      return <RegistrationPaymentRecovery state="unavailable" />
    }
    if (addition.status === 'activated') {
      const registrationHref = '/accounts/new?' + new URLSearchParams({ resume: addition.lineAccountId })
      return <RegistrationPaymentRecovery state="activated" registrationHref={registrationHref} />
    }
    const refresh = async () => {
      const result = await api.musuboLineAddition.reconcile({ additionId: addition.id }).catch((caught: unknown) => {
        if (caught instanceof ApiError && [400, 403, 404].includes(caught.status)) {
          setLoadState('unavailable')
          return null
        }
        throw caught
      })
      if (!result) return
      if (!result.success) throw new Error(result.error)
      if (result.data.id !== addition.id || result.data.lineAccountId !== addition.lineAccountId) {
        setLoadState('unavailable')
        return
      }
      const updated = result.data
      setState({ ...state, addition: updated })
    }
    return <RegistrationPaymentRecovery state={addition.status === 'paid' ? 'processing' : 'failed'}
      onRefresh={refresh} paymentUrl={addition.paymentUrl} />
  }

  const pending = state.pending
  const ordinal = state.price.addedLineOrdinal
  const confirm = stepUp && <StepUpPrompt request={stepUp} onDone={() => setStepUp(null)} onClose={() => setStepUp(null)} />
  if (state.expired) {
    return <><MusuboPaymentRecovery view={{
      kind: 'addition', state: 'expired', amountYen: state.price.dueNowYen,
      addedLineOrdinal: ordinal, activeLineCount: state.activeLineCount,
      holdUntil: pending?.expiresAt ?? new Date().toISOString(),
    }}
      onPrimary={async () => { await acceptAddition() }}
      onSecondary={() => router.push('/accounts')} secondaryLabel="アカウント一覧へ" />
      {error && <Notice tone="danger" message={error} />}
      {confirm}
    </>
  }
  if (pending && !pending.canConnect) return <RegistrationPaymentRecovery state="unavailable" />

  return <div className={styles.page}>
    <PageHeader breadcrumb={[]} title={ordinal + '個目のLINEを追加しますか'} />
    {error && <Notice tone="danger" message={error} />}
    <div className={styles.columns}>
      <Card as="section" layout="vertical" padding="roomy" gap="normal">
        <h2>追加料金のご確認</h2>
        <div className={styles.priceRows}>
          <div><span>追加するLINE</span><strong>{ordinal}個目</strong></div>
          <div><span>LINE基本料金の増分</span><strong>{yen(state.price.coreIncrementYen)}／{state.price.coreIncrementInterval === 'year' ? '年' : '月'}</strong></div>
          {state.price.headquartersIncrementMonthlyYen > 0 &&
            <div><span>統括料金の増分</span><strong>{yen(state.price.headquartersIncrementMonthlyYen)}／月</strong></div>}
          <div><span>追加後のLINE基本料金</span><strong>{yen(state.recurringAfter.coreYen)}／{state.recurringAfter.coreInterval === 'year' ? '年' : '月'}</strong></div>
          <div><span>追加後の月額オプション</span><strong>{yen(state.recurringAfter.optionsYen)}／月</strong></div>
        </div>
        <div className={styles.due}><span>今回の追加分（税込）</span>
          <strong>{yen(pending?.amountDueYen ?? state.price.dueNowYen)}</strong></div>
        <p className={styles.explanation}>{state.price.dueNowYen === 0
          ? '無料体験中のため、本日の請求はありません。LINEの接続が完了すると追加分を有効化します。'
          : 'LINEの接続情報を確認した後、追加分の決済が成功すると有効化します。決済が完了しなければ既存のLINEはそのまま使えます。'}</p>
        {pending && <p className={styles.explanation}>保留期限：{dateTime(pending.expiresAt)}</p>}
      </Card>
      <Card as="section" layout="vertical" padding="roomy" gap="normal">
        <h2>この後の流れ</h2>
        <ol className={styles.flow}>
          <li>料金を確認してLINEアカウントを接続</li>
          <li>有料利用中は追加分のお支払いを確認</li>
          <li>決済成功後に新しいLINEを有効化</li>
        </ol>
        <p className={styles.explanation}>カード情報はStripeで扱い、musuboには保存しません。</p>
        <div className={styles.actions}>
          {pending?.canConnect ? <Button href="/accounts/new">LINE接続へ</Button>
            : <Button type="button" busy={busy} onClick={() => void acceptAddition()}>確認してLINE接続へ</Button>}
        </div>
      </Card>
    </div>
    {confirm}
  </div>
}
