'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useOptionalAccount } from '@/contexts/account-context'
import { useAccountStyle } from '@/hooks/use-account-style'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { readStaffIdentity } from '@/lib/staff-identity-state'
import { isLineAccountEntryReady, resolveLineAccountEntry, subscribeLineAccountEntry } from '@/lib/line-account-entry'
import { isAccountIndependentRoute } from '@/lib/store-route-guard'
import { useFirstSteps } from '@/v8/dashboard/public/first-steps-model/index'
import { GUIDE_ENGINE_EVENT, readGuideEngineState } from './guide-engine'
import { GuideOverlay } from './guide-overlay'
import { GuideSetupComplete } from './guide-last-step'
import { GuideFirstMessage } from './guide-first-message'
import { GuideMenuPicker } from './guide-menu-picker'
import { GuidePublishMenu } from './guide-publish-menu'
import { guideProcedure } from './guide-script'
import { GuideSharedProvider, type SharedGuide } from './guide-shared'
import { useGuideSignal } from './guide-signal'
import { useSetupMutationRefresh } from './use-setup-mutation-refresh'

/*
  開店準備ガイドの入れ物。全画面で1つ。画面側は置かない。
  案内はどの画面でも同じ形で出すため、画面ごとに別の入れ物を作らない。

  案内する手順の対象（卓を作る・メニューを保存する…）は、はじめにやることの画面ではなく
  それぞれの設定画面にあるので、重ね表示はダッシュボードではなくアプリ全体に1つ置く。

  進み具合は全画面で共有する。
*/

export function GuideHost({ children }: { children: ReactNode }) {
  const account = useOptionalAccount()
  const accountId = account?.selectedAccountId ?? null
  const role = useStaffRole()
  const staffId = readStaffIdentity()?.id
  /**
   * 案内が動いているか。控え（localStorage）を見て決め、
   * 控えが変わった合図でも見直す（ダッシュボードで「開始」を押した直後もここで気づく）。
   */
  const subscribeGuideState = useCallback((onStoreChange: () => void) => {
    if (typeof window === 'undefined') return () => {}
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ accountId?: string }>).detail
      if (!detail?.accountId || detail.accountId === accountId) onStoreChange()
    }
    window.addEventListener(GUIDE_ENGINE_EVENT, changed)
    return () => window.removeEventListener(GUIDE_ENGINE_EVENT, changed)
  }, [accountId])
  const snapshotKey = useSyncExternalStore(
    subscribeGuideState,
    () => {
      const { phase, stepKey } = readGuideEngineState(accountId, staffId)
      return `${phase}:${stepKey ?? ''}`
    },
    () => '',
  )
  const [phase = 'idle', stepKey = ''] = snapshotKey ? snapshotKey.split(':') : []
  const armed = snapshotKey !== '' && (phase === 'active' || phase === 'paused')
  const watch = snapshotKey !== '' && phase === 'active' && stepKey === 'firstMessage'
  const checkingAccount = snapshotKey !== '' && phase === 'active' && stepKey === 'accounts'
  return <GuideSession accountId={accountId} staffId={staffId} role={role} armed={armed}
    watchFirstMessage={watch} checkingAccount={checkingAccount} rememberedReady={snapshotKey !== ''}>{children}</GuideSession>
}

function useAccountsGuideEntry(accountId: string | null, scope: string | null, checkingAccount: boolean): boolean {
  const [verifiedScope, setVerifiedScope] = useState<string | null>(null)
  const verified = scope !== null && verifiedScope === scope
  // 一覧を離れるか対象が変わるまで、次の手順へ進むための確認を保つ。
  useEffect(() => { setVerifiedScope(null) }, [scope])
  useEffect(() => {
    if (!scope || !accountId || !checkingAccount || verified) return
    let current = true
    void resolveLineAccountEntry(accountId).then(result => {
      if (current && result.destination === 'dashboard') setVerifiedScope(scope)
    }).catch(() => {})
    return () => { current = false }
  }, [scope, accountId, checkingAccount, verified])
  return verified
}

function matchesGuideLocation(pathname: string, query: Pick<URLSearchParams, 'get'>, href: string): boolean {
  const [path, search] = href.split('#')[0].split('?')
  return pathname === path && Array.from(new URLSearchParams(search)).every(([key, value]) => query.get(key) === value)
}

function GuideSession({ accountId, staffId, role, armed, watchFirstMessage, checkingAccount, rememberedReady, children }: {
  accountId: string | null; staffId?: string; role: string | null; armed: boolean; watchFirstMessage: boolean; checkingAccount: boolean; rememberedReady: boolean; children: ReactNode
}) {
  const account = useOptionalAccount()
  const style = useAccountStyle(accountId)
  const pathname = usePathname()
  const entryReady = useSyncExternalStore(subscribeLineAccountEntry, () => isLineAccountEntryReady(accountId), () => false)
  const accountsScope = pathname === '/accounts' && accountId && staffId && canManageRole(role)
    ? JSON.stringify([accountId, staffId]) : null
  const accountsGuideReady = useAccountsGuideEntry(accountId, accountsScope, checkingAccount)
  const canOpenGuide = accountsGuideReady || (entryReady && !isAccountIndependentRoute(pathname))
  const independentScope = rememberedReady && pathname !== '/accounts' && isAccountIndependentRoute(pathname) && accountId && staffId
    ? JSON.stringify([accountId, staffId]) : null
  const independentReady = useAccountsGuideEntry(accountId, independentScope, true)
  const canLoadSetup = entryReady || accountsGuideReady || independentReady
  const search = useSearchParams()
  const query = search.toString()
  const qrOpen = search.has('qr')
  const requestedStep = pathname === '/' ? search.get('guide') : null
  const entryStep = requestedStep === 'richMenu' || requestedStep === 'firstMessage' ? requestedStep : null
  const watchers = useRef(new Set<symbol>())
  const [sharedWatch, setSharedWatch] = useState(false)
  const setWatch = useCallback((id: symbol, enabled: boolean) => { if (enabled) watchers.current.add(id); else watchers.current.delete(id); setSharedWatch(watchers.current.size > 0) }, [])
  const canPreloadSetup = Boolean(accountId && role !== null && !pathname.startsWith('/accounts/new') && (pathname !== '/accounts' || checkingAccount))
  const cacheScope = JSON.stringify([staffId, role])
  const first = useFirstSteps(accountId, role, { style: style.data?.style ?? null, enabled: canLoadSetup, preload: canPreloadSetup, watchWaiting: false, watchFirstMessage: watchFirstMessage || sharedWatch, cacheScope })
  const retained = useRef<{ scope: string; summary: typeof first.summary; dismissed: boolean | null; style: typeof style.data extends infer T ? T extends { style: infer S } ? S : null : null }>({ scope: '', summary: null, dismissed: null, style: null })
  const retainedScope = JSON.stringify([accountId, staffId, role])
  if (retained.current.scope !== retainedScope || role === null || first.status === 'error' || style.status === 'error') {
    retained.current = { scope: retainedScope, summary: first.summary, dismissed: first.dismissed ?? null, style: style.data?.style ?? null }
  } else {
    if (first.summary) retained.current.summary = first.summary
    if (first.dismissed !== null && first.dismissed !== undefined) retained.current.dismissed = first.dismissed
    if (style.data?.style) retained.current.style = style.data.style
  }
  const guide = first.guide
  const summary = canLoadSetup ? first.summary ?? retained.current.summary : null
  const dismissed = canLoadSetup ? first.dismissed ?? retained.current.dismissed : null
  const shared = useMemo<SharedGuide>(() => ({ guide, summary, dismissed, setup: { accountId, run: first.runState, progress: first.styleProgress, setWatch } }), [guide, summary, dismissed, first.runState, first.styleProgress, accountId, setWatch])

  const index = summary?.steps.findIndex(step => step.key === guide.stepKey) ?? -1
  const step = index >= 0 ? summary?.steps[index] ?? null : null
  /** 9項目の済みは実データ計測の値のまま渡す（ガイドで済みにしない）。 */
  const segments = useMemo(() => summary?.steps.map(item => item.done) ?? [], [summary])

  const scripted = (style.data?.style ?? retained.current.style) === 'restaurant'
  const procedure = scripted ? guideProcedure(guide.stepKey, guide.procedureIndex) : null
  const next = summary?.steps.slice(index + 1).find(item => !item.done && item.href)
  const advance = guide.advanceProcedure
  const pause = guide.pause

  /*
    段や手順が変わったら、その手順の対象がある画面へ実際に移る。
    移らないと重ね表示の対象がその画面に無く、案内が消えて先へ進めない。
    始めた直後も同じ。「続きから」は最初の未完了の段の手順1なので、
    ダッシュボードで始めたらその手順の画面まで連れていく。
    連れていかないと、ダッシュボードには対象が無いので案内が1.5秒で自動停止してしまう。
    台本が画面を指定している手順も同じ扱い。
  */
  const router = useRouter()
  const requestedPlace = useRef<string | null>(null)
  const reachedPlace = useRef<string | null>(null)
  const handledEntry = useRef<string | null>(null)
  useEffect(() => {
    if (!entryStep) { handledEntry.current = null; return }
    if (!canOpenGuide || guide.loading || !scripted || !accountId || !guide.startAt || !summary) return
    const target = summary.steps.find(item => item.key === entryStep && item.href)
    const entry = `${accountId}:${entryStep}`
    if (!target || handledEntry.current === entry) return
    handledEntry.current = entry
    if (guide.stepKey === entryStep && guide.phase === 'paused') guide.resume()
    else if (guide.stepKey !== entryStep || guide.phase !== 'active') guide.startAt(entryStep)
    const next = new URLSearchParams(query)
    next.delete('guide')
    if (entryStep === 'firstMessage') next.delete('qr')
    router.replace(next.size ? `/?${next}` : '/')
  }, [accountId, canOpenGuide, entryStep, guide, query, router, scripted, summary])
  const stepHref = step?.href ?? null
  const procedureHref = procedure?.href ?? null
  /** この手順の対象がある画面。手順の指定が無ければ段の行き先。 */
  const firstMessageStep = scripted && step?.key === 'firstMessage'
  const menuPickerStep = scripted && step?.key === 'richMenu'
  const targetHref = firstMessageStep || menuPickerStep ? '/' : procedureHref ?? stepHref
  const needsPublishReview = scripted && step?.key === 'scenario' && step.done &&
    guide.procedureIndex === 2 && guide.phase === 'active'
  const inPublishReview = needsPublishReview && pathname.startsWith('/rich-menus')
  const onTargetScreen = inPublishReview || !targetHref || matchesGuideLocation(pathname, search, targetHref)
  const place = `${accountId}:${guide.stepKey}:${guide.procedureIndex}`
  const leavingGuideScreen = !onTargetScreen && reachedPlace.current === place
  useEffect(() => {
    if (!canOpenGuide || guide.loading || guide.phase !== 'active') {
      requestedPlace.current = null
      reachedPlace.current = null
      return
    }
    if (entryStep || !guide.stepKey || !targetHref) return
    if (onTargetScreen) {
      reachedPlace.current = place
      return
    }
    if (reachedPlace.current === place || requestedPlace.current === place) return
    requestedPlace.current = place
    if (menuPickerStep && pathname === '/getting-started/rich-menu') router.replace(targetHref)
    else router.push(targetHref)
  }, [canOpenGuide, entryStep, guide.loading, guide.phase, guide.stepKey, menuPickerStep, pathname, place, targetHref, onTargetScreen, router])

  /* 店舗設定の完了は保存の合図で再取得し、実測を確認してから進める。 */
  const procedureSignal = procedure?.anchor
  const followupCanConfirm = guide.stepKey === 'followup' && (guide.procedureIndex === 2 || guide.procedureIndex === 3)
  useGuideSignal(
    (procedure?.trigger === 'event' || procedure?.trigger === 'valid') && procedureSignal !== 'followup.confirm' ? procedureSignal ?? null : null,
    canOpenGuide && guide.phase === 'active',
    () => { if (procedureSignal !== 'reception.save' && procedureSignal !== 'menu.save' && procedureSignal !== 'followup.save') advance() },
    procedureSignal === 'followup.start' ? accountId ?? undefined : undefined,
  )
  const refreshNow = useSetupMutationRefresh(accountId, first.refresh, pathname, first.markStale)
  useGuideSignal('followup.confirm', Boolean(canOpenGuide && accountId && followupCanConfirm && guide.phase === 'active'),
    () => advance(false, 4), accountId ?? undefined)
  useGuideSignal('accounts.connection', accountsGuideReady && Boolean(accountId), refreshNow, accountId ?? undefined)
  useGuideSignal('reception.menuPublished', Boolean(accountId && inPublishReview), advance, accountId ?? undefined)
  const alreadyPublished = first.progress?.bookingExposure?.publicReservationMenu === true
  const skipPublishPrompt = canOpenGuide && needsPublishReview && !inPublishReview && onTargetScreen && alreadyPublished
  useEffect(() => { if (skipPublishPrompt) advance() }, [skipPublishPrompt, advance])
  const offerPublishing = canOpenGuide && needsPublishReview && !inPublishReview && onTargetScreen && !alreadyPublished
  const reviewingTables = guide.stepKey === 'attributes' && guide.procedureIndex === 3
  const reviewingHours = guide.stepKey === 'hours'
  const showComplete = canOpenGuide && scripted && !guide.loading && guide.phase !== 'done' && Boolean(summary?.total && summary.done === summary.total) &&
    (first.arrived || guide.phase === 'active' || guide.phase === 'paused') && !offerPublishing && !skipPublishPrompt && !reviewingTables && !reviewingHours && !menuPickerStep
  const showReceive = canOpenGuide && firstMessageStep && accountId && !step.done && guide.phase === 'active' && pathname === '/' && !qrOpen
  const showMenuPicker = canOpenGuide && menuPickerStep && guide.phase === 'active' && pathname === '/' &&
    accountId && style.data?.styleSelected && !style.stale
  useEffect(() => {
    if (canOpenGuide && firstMessageStep && guide.phase === 'active' && pathname === '/' && qrOpen && !entryStep) {
      const next = new URLSearchParams(query)
      next.delete('qr')
      router.replace(next.size ? `/?${next}` : '/')
    }
  }, [canOpenGuide, entryStep, firstMessageStep, guide.phase, pathname, qrOpen, query, router])

  return (
    <GuideSharedProvider value={shared}>
      {children}
      <GuideOverlay
        active={canOpenGuide && guide.phase === 'active' && (onTargetScreen || leavingGuideScreen) && !offerPublishing && !skipPublishPrompt && !showReceive && !showComplete && !showMenuPicker}
        stepKey={guide.stepKey}
        stepLabel={step?.label ?? null}
        stepOrder={index >= 0 ? index + 1 : null}
        procedureIndex={guide.procedureIndex}
        onTargetScreen={!leavingGuideScreen}
        showOverlay={onTargetScreen}
        scripted={scripted}
        showProcedure={!inPublishReview}
        nextLabel={next?.label}
        segments={segments}
        onAdvanceProcedure={advance}
        onPause={pause}
      />
      {showMenuPicker && summary && style.data ? <GuideMenuPicker key={accountId} accountId={accountId}
        version={style.data.version} step={index + 1} total={summary.total} onLater={advance} onSaved={advance}
        onCreate={() => { pause(); router.push('/rich-menus/new') }} onReload={style.reload} /> : null}
      {showReceive && summary ? <GuideFirstMessage key={JSON.stringify([accountId, staffId])}
        accountId={accountId} accountName={account?.selectedAccount?.name}
        step={index + 1} total={summary.total} onReceived={first.refresh} onLater={pause} /> : null}
      {showComplete ? <GuideSetupComplete key={accountId} exposure={first.progress?.bookingExposure}
        onAcknowledge={async () => {
          const saved = await guide.complete?.()
          if (saved) first.dismissArrived()
          return saved === true
        }} onNavigate={href => router.push(href)} /> : null}
      {offerPublishing && accountId ? <GuidePublishMenu key={accountId} accountId={accountId}
        onLater={advance} onReview={href => router.push(href)} /> : null}
    </GuideSharedProvider>
  )
}
