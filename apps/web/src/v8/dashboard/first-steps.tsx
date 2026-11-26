'use client'

import { type ReactNode } from 'react'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import ListState from '@/components/shared/list-state'
import { SetupStepList, SetupStepRow, SetupStepLabel } from '@/components/shared/setup-step-row'
import Notice from '@/components/shared/notice'
import { classifyApiFailure, permissionDeniedMessage } from '@/components/shared/api-error-message'
import { lockUnless } from '@/components/shared/permission-lock'
import HelpTip from '@/components/shared/help-tip'
import TextLink from '@/components/shared/text-link'
import { DisclosureToggle } from '@/components/shared/disclosure'
import styles from './first-steps.module.css'
import { ProgressBar, StepMark } from '@/components/shared/progress'

import { isFirstStepsComplete, nextFirstStepKey, type FirstStepsGuide, type FirstStepsSummary } from './first-steps-model'

/* 状態・保存・実測は first-steps-model に置く。呼び出し元の入口を変えないため、ここから名前を通す。 */
export {
  firstStepsLegacyDismissedKey,
  firstStepsStorageKey,
  nextFirstStepKey,
  readFirstStepsFolded,
  shouldShowFirstSteps,
  shouldKeepFirstStepsVisible,
  summarizeFirstSteps,
  useFirstMessageArrived,
  useFirstSteps,
  waitingForFirstMessage,
} from './first-steps-model'
export type { FirstStepsGuide, FirstStepsSummary } from './first-steps-model'

/**
 * 9項目の一覧の下に置く再開の導線。
 * 承認済み Pen「はじめにやること08d_v04」(sL2CD/rvGC6) どおり
 * 「続きから進める」「最初から始める」を並べる。
 * 一時停止は案内の帯側で受けるので、ここには出さない（同じ操作を2か所に置かない）。
 */
export function FirstStepsGuideFooter({ guide }: { guide: FirstStepsGuide }) {
  const anchor = guide.pausedAnchor ?? guide.anchor
  if (!anchor || guide.phase === 'done') return null
  return (
    <div className={styles.guideFooter}>
      <Button size="compact" variant="primary" presentation="step-action" onClick={guide.phase === 'paused' ? guide.resume : guide.start}>続きから進める</Button>
      <Button size="compact" presentation="step-action" onClick={guide.restart ?? guide.start}>最初から始める</Button>
    </div>
  )
}

/*
  カードは「見出し → 手順 → 続きから/最初から」を表示する。
  「選んだ機能の設定」ブロックと「使い方の設定を開く」は置かない（利用者判断）。
*/
export function FirstStepsCard({ summary, folded, onToggle, onRecheck, onRetry, feedback, guide, readOnly = false, firstMessageInline = false, keepVisible = false }: { summary: FirstStepsSummary | null; folded: boolean; onToggle: () => void; onRecheck?: () => void; onRetry?: () => void; feedback?: ReactNode; guide?: FirstStepsGuide; readOnly?: boolean; firstMessageInline?: boolean; keepVisible?: boolean }) {
  const complete = isFirstStepsComplete(summary)
  if (isFirstStepsComplete(summary) && !keepVisible) return null
  const nextKey = summary ? nextFirstStepKey(summary) : null
  /* 再開の導線はガイド進行中だけ（承認済み Pen：通常 la9o6/FJ6Xd には無く、進行中 sL2CD/rvGC6 にだけある）。
     始めるのは各行の「開く」なので、まだ始めていない間はカードに同じ操作を増やさない。 */
  const guideVisible = Boolean(guide && summary && !complete && !readOnly && (guide.phase === 'active' || guide.phase === 'paused'))
  return (
    <Card as="section" className={styles.card} layout="vertical" contentPadding="var(--step-card-pad-block) var(--step-card-pad-inline)" gap="var(--step-card-gap)" aria-labelledby="first-steps-title" data-design-node="r3X34">
      <div className={styles.head}>
        <h2 id="first-steps-title" className={styles.title}>はじめにやること</h2>
        <HelpTip label="はじめにやることのチェックについて">チェックは設定の実データで自動判定。ガイドを使わなくても付きます</HelpTip>
        {summary ? <>
          <span className={styles.count}>{`${summary.done} / ${summary.total} 済み`}</span>
          <span className={styles.pips}><ProgressBar appearance="onboarding" value={summary.done} max={summary.total} label="はじめにやることの進み" /></span>
        </> : null}
        <span className={styles.spacer} />
        {onRetry && summary?.steps.some(step => step.state === 'unknown') ? <Button size="compact" onClick={onRetry}>設定を読み直す</Button> : null}
        {onRecheck ? <Button size="compact" onClick={onRecheck} title="最初の1通の自動の確かめを止めました">もう一度確かめる</Button> : null}
        {summary && !complete ? <DisclosureToggle open={!folded} controls="first-steps-list" onToggle={onToggle} subject="はじめにやること" /> : null}
      </div>
      {feedback}
      {summary && !complete ? <SetupStepList id="first-steps-list" columns={3} hidden={folded}>
        {summary.steps.map((step, index) => {
          /* 行の操作名は Pen v04 どおり「開く」1つに揃える。最終確認だけ受け取りを見る「確かめる」。 */
          const actionLabel = step.key === 'firstMessage' ? '確かめる' : '開く'
          return (
          <SetupStepRow key={step.key} done={step.done} next={step.key === nextKey}>
            <StepMark done={step.done} />
            <SetupStepLabel title={step.label} help={step.state === 'unknown' && step.reason ? <HelpTip label={`${step.label}の未確認の理由`}>{step.reason}</HelpTip> : undefined}>
              <span aria-hidden="true">{step.ordinal ?? index + 1}. </span><span>{step.label}</span>
              <span className="sr-only">{step.done ? '（済み）' : step.state === 'unknown' ? '（未確認）' : step.state === 'forbidden' ? '（権限がありません）' : '（まだ）'}</span>
            </SetupStepLabel>
            {(!step.done || step.key === 'hours') && (readOnly || step.state === 'forbidden') ? <><Button size="compact" lockedReason={lockUnless(false, 'manager')}>{actionLabel}</Button></> : !step.done && !step.href ? <span className={styles.count}>未確認</span> : step.done && step.key !== 'hours' ? null : step.done ? (
              /* 済みの段は案内が無いので、確かめ直すための行き先だけ残す。 */
              <TextLink tone="action" emphasis="row-step" href={step.href!} className={styles.link} aria-label={`${step.label}（${actionLabel}）`}>{actionLabel}</TextLink>
            ) : (
              /* まだの段はどれも、この行からその段のガイドを始める。 */
              <TextLink tone="action" emphasis="row-step" href={step.href!} className={styles.link} aria-label={`${step.label}を${actionLabel}`} onClick={(event) => {
                if (firstMessageInline && step.key === 'firstMessage' && guide?.startAt) {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
                  event.preventDefault()
                } else if (step.href?.startsWith('/?guide=')) {
                  return
                }
                guide?.startAt?.(step.key)
              }}>{actionLabel}</TextLink>
            )}
          </SetupStepRow>
          )
        })}
      </SetupStepList> : null}
      {guideVisible && !folded ? <FirstStepsGuideFooter guide={guide!} /> : null}
    </Card>
  )
}

/** 認可の失敗を通信障害と区別し、権限のない人に再試行を繰り返させない。 */
export function FirstStepsFeedback({ error, onRetry }: { error: unknown; onRetry: () => void }) {
 return classifyApiFailure(error) === 'forbidden'
  ? <Notice tone="info">{permissionDeniedMessage()}</Notice>
  : <ListState kind="error" title="はじめの設定の状態を確認できませんでした" error={error} onRetry={onRetry} />
}
