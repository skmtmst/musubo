'use client'

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import ListState from '@/components/shared/list-state'
import { SetupStepList, SetupStepRow, SetupStepLabel } from '@/components/shared/setup-step-row'
import Notice from '@/components/shared/notice'
import { classifyApiFailure, permissionDeniedMessage } from '@/components/shared/api-error-message'
import { lockUnless } from '@/components/shared/permission-lock'
import HelpTip from '@/components/shared/help-tip'
import TextLink from '@/components/shared/text-link'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { canManageRole } from '@/lib/staff-role'
import styles from './first-steps.module.css'
import { ProgressBar, StepMark } from '@/components/shared/progress'

import { useFirstRun } from '@/v8/onboarding/public/use-first-run/index'
import { doneCount, stepsForStyle, type StepResult, type StyleSetupProgress } from '@/v8/settings/public/getting-started-steps/index'
import { useStyleSetupProgress } from '@/v8/onboarding/public/style-setup-progress/index'
import type { AccountStyle } from '@line-crm/shared'

export type FirstStepsSummary = {
  steps: Array<{ key: string; ordinal?: string; label: string; href: string | null; link: string; done: boolean; state: StepResult['state']; reason?: string }>
  done: number
  total: number
}

/** 設定画面と同じ状態・権限・行き先を使い、別の完了条件を持たない。 */
export function summarizeFirstSteps(steps: ReadonlyArray<StepResult>, style: AccountStyle | null = null, progress?: StyleSetupProgress): FirstStepsSummary {
  const displaySteps = stepsForStyle(steps, style, progress)
  return { steps: displaySteps.map((step) => ({ key: step.key, ordinal: step.ordinal, label: step.title, href: step.action?.href ?? null, link: step.action ? (step.key === 'firstMessage' ? '確かめる →' : '開く →') : step.blockedReason ?? '状態を確認する', done: step.state === 'done', state: step.state, reason: step.state === 'unknown' ? step.next : undefined })), done: doneCount(displaySteps), total: displaySteps.length }
}

export function shouldShowFirstSteps(role: string | null, summary: FirstStepsSummary | null): boolean {
  return role !== null && summary !== null
}

export function firstStepsStorageKey(accountId: string): string {
  return `lh:v8:first-steps-folded:${accountId}`
}

/** 前の「閉じる」の印。押した人は畳んだ形で出す。 */
export function firstStepsLegacyDismissedKey(accountId: string): string {
  return `lh:v8:first-steps-dismissed:${accountId}`
}

/** 畳んでいるか。'1' 畳む・'0' 開く。印が無ければ前の「閉じる」を見る。 */
export function readFirstStepsFolded(accountId: string | null): boolean {
  if (!accountId || typeof window === 'undefined') return false
  try {
    const saved = window.localStorage.getItem(firstStepsStorageKey(accountId))
    if (saved === '1' || saved === '0') return saved === '1'
    return window.localStorage.getItem(firstStepsLegacyDismissedKey(accountId)) === '1'
  } catch { return false }
}

/** 最初の1通を待っている（友だち追加の時の配信は済み、最初の1通はまだ）。 */
export function waitingForFirstMessage(steps: ReadonlyArray<StepResult>): boolean {
  return steps.find((step) => step.key === 'friendAdd')?.state === 'done' && steps.find((step) => step.key === 'firstMessage')?.state === 'todo'
}

/**
 * 最初の1通が、この画面で見ている間に「まだ」から「済み」に変わったか。
 * 開いた時にもう済みだった人・別のアカウントへ移った直後は数えない（後から来た人には出さない）。
 */
export function useFirstMessageArrived(accountId: string | null, steps: ReadonlyArray<StepResult>, ready: boolean) {
  const seen = useRef<{ accountId: string | null; state: StepResult['state'] | null }>({ accountId: null, state: null })
  const [arrived, setArrived] = useState(false)
  useEffect(() => {
    if (!ready) return
    const state = steps.find((step) => step.key === 'firstMessage')?.state ?? null
    const before = seen.current
    seen.current = { accountId, state }
    if (before.accountId === accountId && before.state === 'todo' && state === 'done') setArrived(true)
  }, [accountId, steps, ready])
  useEffect(() => { setArrived(false) }, [accountId])
  return { arrived, dismiss: useCallback(() => setArrived(false), []) }
}

export function useFirstSteps(accountId: string | null, role: string | null, options: { qrOpen?: boolean; style?: AccountStyle | null; storeId?: string | null } = {}) {
  const enabled = Boolean(accountId) && role !== null
  const [folded, setFolded] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const state = useFirstRun(accountId, enabled, canManageRole(role) && (Boolean(options.qrOpen) || waiting))
  const style = options.style === undefined ? 'standard' : options.style
  const progress = useStyleSetupProgress(accountId, style, enabled, options.storeId)
  const displaySteps = stepsForStyle(state.steps, style, progress.progress)
  const summary = state.status === 'ready' && style ? summarizeFirstSteps(state.steps, style, progress.progress) : null
  /* 待つ帯（はじめにやること）が開いて見えている間だけ、最初の1通を待って読み直す。 */
  const visibleWaiting = canManageRole(role) && state.status === 'ready' && !folded && waitingForFirstMessage(state.steps)
  useEffect(() => { setWaiting(visibleWaiting) }, [visibleWaiting])
  const done = useFirstMessageArrived(accountId, state.steps, state.status === 'ready')
  useEffect(() => { setFolded(readFirstStepsFolded(accountId)) }, [accountId])
  const toggle = useCallback(() => {
    setFolded((current) => {
      const next = !current
      if (accountId) {
        try { window.localStorage.setItem(firstStepsStorageKey(accountId), next ? '1' : '0') } catch { /* 覚えられなくても今は畳む・開く */ }
      }
      return next
    })
  }, [accountId])
  return {
    status: !enabled ? 'idle' as const : state.status === 'loading' || progress.status === 'loading' ? 'loading' as const : state.status,
    summary: shouldShowFirstSteps(role, summary) ? summary : null, folded, toggle, error: state.error, reload: () => { state.reload(); progress.reload() },
    steps: displaySteps, progress: progress.progress, firstRun: state.firstRun, starter: state.starter, watchExpired: state.watchExpired, rewatch: state.rewatch,
    arrived: canManageRole(role) && done.arrived, dismissArrived: done.dismiss,
  }
}

/** 次にやる 1 つ。まだで、行き先があるうちの最初の段。 */
export function nextFirstStepKey(summary: FirstStepsSummary): string | null {
  return summary.steps.find((step) => !step.done && step.href)?.key ?? null
}

export function FirstStepsCard({ summary, folded, onToggle, onRecheck, onConfigure, onRetry, setupTasks, feedback, readOnly = false, configureAllowed = !readOnly }: { summary: FirstStepsSummary | null; folded: boolean; onToggle: () => void; onRecheck?: () => void; onConfigure?: () => void; onRetry?: () => void; setupTasks?: ReactNode; feedback?: ReactNode; readOnly?: boolean; configureAllowed?: boolean }) {
  const complete = Boolean(summary && summary.total > 0 && summary.done === summary.total && !setupTasks)
  const nextKey = summary ? nextFirstStepKey(summary) : null
  return (
    <Card as="section" layout="vertical" contentPadding="var(--space-16) var(--space-20)" gap="var(--tpl-d23-ob-gap)" aria-labelledby="first-steps-title" data-design-node="r3X34" actions={onConfigure ? <Button variant="primary" onClick={onConfigure} lockedReason={lockUnless(!readOnly && configureAllowed, 'manager')}>使い方の設定を開く</Button> : undefined}>
      <div className={styles.head}>
        <h2 id="first-steps-title" className={styles.title}>はじめにやること</h2>
        {summary ? <>
          <span className={styles.count}>{`${summary.done} / ${summary.total} 済み`}</span>
          <ProgressBar appearance="onboarding" value={summary.done} max={summary.total} label="はじめにやることの進み" />
        </> : null}
        <span className={styles.spacer} />
        {onRetry && summary?.steps.some(step => step.state === 'unknown') ? <Button size="compact" onClick={onRetry}>設定を読み直す</Button> : null}
        {onRecheck ? <Button size="compact" onClick={onRecheck} title="最初の1通の自動の確かめを止めました">もう一度確かめる</Button> : null}
        {summary && !complete ? <button type="button" className={styles.fold} onClick={onToggle} aria-expanded={!folded} aria-controls="first-steps-list">
          {folded ? '開く' : '畳む'}
          {folded ? <ChevronDown className={styles.foldIcon} aria-hidden="true" /> : <ChevronUp className={styles.foldIcon} aria-hidden="true" />}
        </button> : null}
      </div>
      {feedback}
      {setupTasks}
      {summary && !complete ? <SetupStepList id="first-steps-list" columns={3} hidden={folded}>
        {summary.steps.map((step, index) => (
          <SetupStepRow key={step.key} done={step.done} next={step.key === nextKey}>
            <StepMark done={step.done} />
            <SetupStepLabel title={step.label} help={step.state === 'unknown' && step.reason ? <HelpTip label={`${step.label}の未確認の理由`}>{step.reason}</HelpTip> : undefined}>
              <span aria-hidden="true">{step.ordinal ?? index + 1}. </span><span>{step.label}</span>
              <span className="sr-only">{step.done ? '（済み）' : step.state === 'unknown' ? '（未確認）' : step.state === 'forbidden' ? '（権限がありません）' : '（まだ）'}</span>
            </SetupStepLabel>
            {(!step.done || step.key === 'hours') && (readOnly || step.state === 'forbidden') ? <><Button size="compact" lockedReason={lockUnless(false, 'manager')}>開く</Button></> : !step.done && !step.href ? <span className={styles.count}>未確認</span> : step.done && step.key !== 'hours' ? null : (
              <>
                <TextLink tone="action" href={step.href!} className={styles.link} aria-label={`${step.label}（${step.link.replace(' →', '')}）`}>{step.link.replace(' →', '')}</TextLink>
              </>
            )}
          </SetupStepRow>
        ))}
      </SetupStepList> : null}
    </Card>
  )
}

/** 認可の失敗を通信障害と区別し、権限のない人に再試行を繰り返させない。 */
export function FirstStepsFeedback({ error, onRetry }: { error: unknown; onRetry: () => void }) {
 return classifyApiFailure(error) === 'forbidden'
  ? <Notice tone="info">{permissionDeniedMessage()}</Notice>
  : <ListState kind="error" title="はじめの設定の状態を確認できませんでした" error={error} onRetry={onRetry} />
}
