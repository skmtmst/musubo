'use client'

import { useMemo, useSyncExternalStore } from 'react'
import { CircleCheck, TriangleAlert } from 'lucide-react'
import Button from '@/components/shared/button'
import { RowStatusActions } from '@/components/shared/row-actions'
import Card, { CardHeader } from '@/components/shared/card'
import HelpTip from '@/components/shared/help-tip'
import Notice from '@/components/shared/notice'
import { ProgressBar, StepMark } from '@/components/shared/progress'
import StatusBadge from '@/components/shared/status-badge'
import ListState from '@/components/shared/list-state'
import { SetupStepList, SetupStepRow, SetupStepLabel } from '@/components/shared/setup-step-row'
import { PERMISSION_LOCK_REASON, permissionLockReason } from '@/components/shared/permission-lock'
import { readPermissionSessionSnapshot, SESSION_SNAPSHOT_CHANGED } from '@/lib/session-snapshot'
import { classifyApiFailure, permissionDeniedMessage } from '@/components/shared/api-error-message'
import { PREPARING_WORD, usePreparingDialog } from '@/components/shared/preparing-dialog'
import { FEATURES, featureHref, sampleMenuFor, featureName, summarizeSetup, setupWarningsForStyle, type SetupSummary, type TodoRow } from './model'
import type { StyleSetupData } from './use-style-setup'
import styles from './setup-card.module.css'

/*
 * 警告の帯と「はじめにやること」（★V8 修正案 Bdfxm。決まり  追記）。
 * - 中身が決まっていないのにリッチメニューにボタンがある物は、リッチメニューの見本の画面の帯で知らせる
 *   （押すとその設定の画面へ）。ホームには出さない（承認済み Pen「はじめにやること08d_v04」）。
 * - はじめにやること：済んだ数／全部・進みの線・［質問の続きを開く］。あとで設定した質問・止めている
 *   自動の送信・見本の画像のまま、を 1 行ずつ。最後に済んだ物の 1 行。
 */

export function setupSummary(data: StyleSetupData | null, includeComplete = false): SetupSummary | null {
  if (!data) return null
  const summary = summarizeSetup(data.state, data.warnings, data.items)
  return summary.rows.length > 0 || includeComplete ? summary : null
}

const subscribeSession = (listener: () => void) => {
  window.addEventListener(SESSION_SNAPSHOT_CHANGED, listener)
  return () => window.removeEventListener(SESSION_SNAPSHOT_CHANGED, listener)
}

/** 標準と業種のホームで、同じ復旧理由と権限に応じた入口を出す。 */
export function ReservationFormRepairNotices({notices,role}:{notices?:readonly {message:string;href:string}[];role:string|null}){
  const session = useSyncExternalStore(subscribeSession, readPermissionSessionSnapshot, () => null)
  const readOnlyImpersonation = session?.impersonation?.mode === 'read'
  const canRepair = !readOnlyImpersonation && (role === 'owner' || role === 'admin')
  const lockReason = role === null
    ? undefined
    : readOnlyImpersonation
      ? PERMISSION_LOCK_REASON.impersonation
      : permissionLockReason(role, canRepair, 'manager')
  return <>{notices?.map(item=><Notice key={item.href} tone="warn" action={<Button {...(canRepair?{href:item.href}:role===null?{disabled:true}:{})} lockedReason={lockReason}>予約フォームを直す →</Button>}>{item.message}</Notice>)}</>
}

/** 警告の帯（Bdfxm の「帯/注意（行き先つき）」）。機能ごとに 1 本。ホーム（dashboard・style-dashboard）では呼ばない。 */
export function SetupWarningBands({ data, configureAllowed = true, role }: { data: StyleSetupData; configureAllowed?: boolean; role?: string | null }) {
  const preparing = usePreparingDialog()
  const seen = new Set<string>()
  const warnings = setupWarningsForStyle(data.state.style, data.warnings).filter((warning) => (seen.has(warning.feature) ? false : (seen.add(warning.feature), true)))
  if (warnings.length === 0) return null
  const tiles = sampleMenuFor(data.state.style).tiles
  return (
    <>
      {warnings.map((warning) => {
        const button = tiles.find((tile) => tile.feature === warning.feature)?.label ?? featureName(warning.feature)
        return (
          <Notice key={warning.feature} tone="warn" appearance="soft" action={FEATURES[warning.feature]?.preparing ? <Button lockedReason={permissionLockReason(role, configureAllowed, 'manager')} onClick={() => { if (configureAllowed) preparing.open(FEATURES[warning.feature]!.preparing!) }}>{`${featureName(warning.feature)}を設定する`}</Button> : <Button lockedReason={permissionLockReason(role, configureAllowed, 'manager')} href={featureHref(warning.feature, warning.href, data.state.style)}>{`${featureName(warning.feature)}を設定する`}</Button>}>
            {`リッチメニューに「${button}」のボタンがありますが、${featureName(warning.feature)}がまだ設定されていません。お客さまには「${PREPARING_WORD}」と出ています。`}
          </Notice>
        )
      })}
      {preparing.dialog}
    </>
  )
}

export function SetupCard({ summary, onOpenStep }: { summary: SetupSummary; onOpenStep: (step: string | number) => void }) {
  return (
    <Card layout="vertical" contentPadding="var(--sc-pad)" gap="var(--sc-gap)" className={styles.card} aria-labelledby="setup-card-title" data-design-node="Bdfxm">
      <div className={styles.head}>
        <h2 id="setup-card-title" className={styles.title}>使い方の設定</h2>
        <HelpTip label="使い方の設定の説明">選んだ機能だけの設定です。「はじめの設定」の完了条件とは別に、あとで設定する物や動かす前の確認を表示します。</HelpTip>
        <span className={styles.spacer} />
        <span className={styles.count}>{`${summary.done} / ${summary.total} 済み`}</span>
        <Button onClick={() => onOpenStep(summary.nextStep)}>質問の続きを開く</Button>
      </div>
      <ProgressBar appearance="quota" value={summary.done} max={summary.total} label="使い方の設定の進み" />
      <SetupTasks summary={summary} onOpenStep={onOpenStep} />
    </Card>
  )
}
/** 同じ手順カードへ差し込み、質問で後回しにした設定への操作を保つ。 */
export function SetupTasks({ summary, onOpenStep, heading = false, configureAllowed = true, role }: { summary: SetupSummary; onOpenStep: (step: string | number) => void; heading?: boolean; configureAllowed?: boolean; role?: string | null }) {
  const preparing = usePreparingDialog()
  const openSummary = () => { if (configureAllowed) onOpenStep('summary') }
  const doneText = useMemo(() => {
    const names = summary.doneNames.slice(0, 3).join('・')
    return `済み ${summary.done}件（${names}${summary.doneNames.length > 3 ? ' ほか' : ''}）`
  }, [summary])
  return <>
      {heading ? <>
        <CardHeader title="選んだ機能の設定" headingLevel={3} size="content"
          help={<HelpTip label="選んだ機能の設定の説明">質問で後回しにした設定や、動かす前の確認です。上の進みは基本の手順の済み数です。</HelpTip>} />
      </> : null}
      <SetupStepList>
        {summary.rows.map((row) => <SetupRow key={row.key} row={row} onOpenStep={onOpenStep} onPreparing={preparing.open} configureAllowed={configureAllowed} role={role} onView={openSummary} />)}
      </SetupStepList>
      {summary.done > 0 ? (
        <p className={styles.done}>
          {heading ? null : <><CircleCheck aria-hidden="true" className={styles.doneIcon} /><span className={styles.doneText}>{doneText}</span></>}
          <span className={styles.spacer} />
          <Button variant="text" lockedReason={configureAllowed ? undefined : '中身はオーナーか管理者が見られます'} onClick={() => { if (configureAllowed) onOpenStep(0) }}>設定を確認する</Button>
        </p>
      ) : null}
      {preparing.dialog}
  </>
}

export function SetupTasksUnavailable({ error, onRetry }: { error?: unknown; onRetry: () => void }) {
  const forbidden = error && classifyApiFailure(error) === 'forbidden'
  return <>
    <CardHeader title="選んだ機能の設定" headingLevel={3} size="content" />
    {forbidden ? <Notice tone="info">{permissionDeniedMessage()}</Notice> : <ListState kind={error ? 'error' : 'loading'} title={error ? '選んだ機能の設定を確認できませんでした' : '選んだ機能の設定を確認しています'} error={error} onRetry={error ? onRetry : undefined} />}
  </>
}

function SetupRow({ row, onOpenStep, onPreparing, configureAllowed, role, onView }: { row: TodoRow; onOpenStep: (step: string | number) => void; onPreparing: (feature: string) => void; configureAllowed: boolean; role?: string | null; onView: () => void }) {
  const readAction = row.action.step === 'summary'
  const reason = readAction ? configureAllowed ? undefined : '中身はオーナーか管理者が見られます' : permissionLockReason(role, configureAllowed, 'manager')
  return (
    <SetupStepRow data-alert={row.alert || undefined}>
      {row.alert ? <TriangleAlert aria-hidden="true" className={`${styles.rowIcon} ${styles.alertIcon}`} /> : <StepMark done={false} />}
      <SetupStepLabel title={row.title} note={row.note}>{row.title}</SetupStepLabel>
      <RowStatusActions status={<StatusBadge tone={row.badge.tone} dot>{row.badge.label}</StatusBadge>}>
      {readAction ? <Button presentation="row-action" lockedReason={reason} onClick={onView}>{row.action.label}</Button> : row.action.preparing
        ? <Button presentation="row-action" lockedReason={reason} textTone={row.alert ? 'accent' : 'ink'} onClick={() => { if (configureAllowed) onPreparing(row.action.preparing!) }}>{row.action.label}</Button>
        : row.action.href
          ? <Button presentation="row-action" lockedReason={reason} textTone={row.alert ? 'accent' : 'ink'} href={row.action.href}>{row.action.label}</Button>
          : <Button presentation="row-action" lockedReason={reason} textTone={row.alert ? 'accent' : 'ink'} onClick={() => { if (configureAllowed) onOpenStep(row.action.step ?? 0) }}>{row.action.label}</Button>}
      </RowStatusActions>
    </SetupStepRow>
  )
}
