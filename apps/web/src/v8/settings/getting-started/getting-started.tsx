'use client'

/*
 * ★V8 はじめの設定（Pencil ）。
 *
 * 白い板の頭（題と説明）→ 左に「設定の中のメニュー」→ 右に
 * 進み具合の帯・6段の表・下の2枚（いま止まっている理由・気をつけること）。
 * データの口は今の画面（app/getting-started/page.tsx）と同じ：
 * はじめの設定の口（`'v8'` の6段）と、段2を確かめる機能設定の実物。
 */
import { Check } from 'lucide-react'
import { useAccount } from '@/contexts/account-context'
import { useFirstRun } from '@/v8/onboarding/public/use-first-run/index'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import { useSharedGuide } from '@/v8/onboarding/public/guide-shared/index'
import { guideProcedureTotal } from '@/v8/onboarding/public/guide-script/index'
import { useAccountStyle, STALE_STYLE_TEXT } from '@/hooks/use-account-style'
import { useStyleSetupProgress } from '@/v8/onboarding/public/style-setup-progress/index'
import Notice from '@/components/shared/notice'
import { lockUnless } from '@/components/shared/permission-lock'
import { usePageTitle } from '@/components/shell/page-chrome'
import { SettingsPage } from '@/components/templates'
import SettingsInnerNav from '@/components/layout/settings-inner-nav'
import Button from '@/components/shared/button'
import HelpTip from '@/components/shared/help-tip'
import Card, { CardHeader } from '@/components/shared/card'
import { ProgressBar } from '@/components/shared/progress'
import { GridTable, GridRow, GridCell } from '@/components/shared/grid-table'
import TruncatedText from '@/components/shared/truncated-text'
import ListState from '@/components/shared/list-state'
import StatusBadge from '@/components/shared/status-badge'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import {
  type StepResult,
  doneCount,
  progressHeadline,
  stoppedReasons,
  stepsForStyle,
} from './steps'
import frame from '../sa-frame.module.css'
import styles from './getting-started.module.css'

/** 板の下の「気をつけること」（絵の2行）。 */
const CARE_LINES = ['・手順は飛ばしても使えます', '・あとからこの画面に戻れます（設定 › はじめの設定）'] as const

/** 管理者以上だけ開ける行き先（`/recipes` は入口の権限門と一致させる）。 */
function isManagerOnlyHref(href: string | undefined): boolean {
  return Boolean(href && (href === '/recipes' || href.startsWith('/recipes/')))
}

function canOpenStep(step: StepResult, role: string | null): boolean {
  if (!role || role === 'viewer' || !step.action || step.state === 'forbidden') return false
  return !isManagerOnlyHref(step.action.href) || canManageRole(role)
}

export default function GettingStartedV8() {
  usePageTitle('はじめの設定')
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const role = useStaffRole()
  const shared = useSharedGuide()
  const profile = useAccountStyle(selectedAccountId)
  const sharedSetup = selectedAccountId && role !== null && shared?.setup?.accountId === selectedAccountId ? shared.setup : undefined
  const ownFirstRun = useFirstRun(selectedAccountId, !accountLoading && !sharedSetup)
  const ownProgress = useStyleSetupProgress(selectedAccountId, profile.data?.style ?? null, !accountLoading && !sharedSetup)
  const firstRun = sharedSetup?.run ?? ownFirstRun
  const progress = sharedSetup?.progress ?? ownProgress
  const steps = stepsForStyle(firstRun.steps, profile.data?.style ?? null, progress.progress)
  const revalidating = Boolean(firstRun.revalidating || progress.revalidating)
  const revalidationError = firstRun.revalidationError ?? progress.revalidationError ?? null
  const progressReady = !profile.data?.style || (progress.status === 'ready' && progress.progress?.style === profile.data.style)
  const status = firstRun.status !== 'ready' || !selectedAccountId
    ? firstRun.status
    : revalidating
      ? 'loading'
      : revalidationError !== null
        ? 'error'
        : profile.status === 'ready' && progressReady
          ? 'ready'
          : profile.status === 'error'
            ? 'error'
            : 'loading'
  const loadError = firstRun.error ?? revalidationError ?? profile.error
  const reload = () => { firstRun.reload(); progress.reload(); profile.reload() }
  const firstMessage = steps.find(step => step.key === 'firstMessage')
  const sendReason = lockUnless(Boolean(role && role !== 'viewer' && firstMessage?.action), role === 'viewer' ? 'viewer' : 'feature')

  const reasons = stoppedReasons(steps)
  const done = doneCount(steps)
  const firstPending = steps.find(step => step.state !== 'done' && canOpenStep(step, role))
  const nextKey = role && role !== 'viewer' ? firstPending?.key : null
  const guideMatchesAccount = !shared?.setup || shared.setup.accountId === selectedAccountId
  const needsReview = shared?.guide.stepKey === 'richMenu' ||
    (shared?.guide.stepKey === 'attributes' && shared.guide.procedureIndex === 3) ||
    shared?.guide.stepKey === 'hours' ||
    (shared?.guide.stepKey === 'scenario' && shared.guide.procedureIndex === 2)
  const savedPausedStep = steps.find(step => step.key === shared?.guide.stepKey)
  const fallbackResumeKey = savedPausedStep?.action && savedPausedStep.state !== 'forbidden' &&
    (savedPausedStep.state !== 'done' || (profile.data?.style === 'restaurant' && needsReview))
    ? savedPausedStep.key
    : firstPending?.key ?? null
  const resumeKey = shared?.summary ? shared.guide.pausedAnchor?.key ?? null : fallbackResumeKey
  const pausedStep = resumeKey ? steps.find(step => step.key === resumeKey) : undefined
  const samePausedStep = Boolean(pausedStep && pausedStep.key === shared?.guide.stepKey)
  const pausedTotal = samePausedStep && profile.data?.style === 'restaurant' ? guideProcedureTotal(pausedStep?.key ?? null) : 0
  const ordinal = pausedStep ? (['', '①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨'][Number(pausedStep.ordinal)] ?? pausedStep.ordinal) : ''
  const pausedLabel = !pausedStep
    ? '開店準備ガイドを一時停止しています。'
    : samePausedStep
      ? `${ordinal} ${pausedStep.title}${pausedTotal ? `・手順 ${Math.min(Math.max(shared?.guide.procedureIndex ?? 1, 1), pausedTotal)}/${pausedTotal}` : ''}で停止中`
      : shared?.guide.stepKey
        ? `${ordinal} ${pausedStep.title}から再開できます`
        : '開店準備ガイドを一時停止しています。'

  return (
    <div className={frame.screen}>
      <SettingsPage layout="accounts" heightMode="content"
        boardId="xuJ7D"
        title="はじめの設定"
        help="musubo を使いはじめるまでの手順です。選んだスタイルに合わせて、残りの設定を確認できます。"
        navigation={<SettingsInnerNav inline />}
        notice={<>{role === 'viewer' ? <ReadOnlyNotice /> : null}{profile.stale ? <Notice tone="warn">{STALE_STYLE_TEXT}</Notice> : null}</>}
      >
        {status !== 'ready' ? (
          <ListState
            kind={status === 'error' ? 'error' : 'loading'}
            error={status === 'error' ? loadError : undefined}
            onRetry={reload}
          />
        ) : (
          <>
            {shared?.guide.phase === 'paused' && guideMatchesAccount && canManageRole(role) && Boolean(resumeKey) ? <Notice tone="info" actionLayout="stack-on-narrow" action={<Button onClick={shared.guide.resume}>ガイドを再開</Button>}><TruncatedText value={pausedLabel} /></Notice> : null}
            <div className={styles.progress} role="note">
              <strong className={styles.progressText}>{progressHeadline(steps)}</strong>
              <ProgressBar className={styles.bar} value={100 * done / Math.max(steps.length, 1)} label="はじめの設定の進み具合" />
            </div>

            <Card padding="rows" overflow="hidden">
              <GridTable label="はじめの設定の順路" framed={false} design={{ columns: "max-content minmax(0, 1fr) max-content", gap: "var(--polish-space-card)", rowPadding: "var(--polish-space-card)", fontSize: "var(--text-body)" }}>
                {steps.map((step) => <StepRow key={step.key} step={step} role={role} next={step.key === nextKey} />)}
              </GridTable>
            </Card>

            <Card id="first-message" variant="form" aria-label="最初の1通の確認方法">
              <CardHeader size="stacked" title="最初の1通の確認方法"
                help={<HelpTip label="最初の1通の判定と確認方法">QRからは友だち追加時の配信を受け取ります。シナリオは「まとめてテストを送る」で自分をテスト受信者に選びます。完了は友だち追加時の配信かシナリオの1通目の送信記録で判定します。送らずに判定するテストと受信箱の手動返信は完了に数えません。</HelpTip>}
                action={<Button size="compact" aria-label="受信後に状態を読み直す" onClick={reload}>読み直す</Button>}
              />
              <p className={styles.cardLine}>QRから友だち追加するか、シナリオを選んで自分にテスト送信してください。受け取ったらLINEで本文を確かめてください。</p>
              {role ? <div className={styles.messageActions}>
                <Button href={profile.data?.style === 'restaurant' ? '/?guide=firstMessage' : '/?qr=base'} lockedReason={sendReason}>友だち追加のQRを開く</Button>
                <Button href="/scenarios" lockedReason={sendReason}>シナリオを選んでテスト送信する</Button>
              </div> : null}
            </Card>

            <div className={styles.bottom}>
              {reasons.length > 0 ? (
                <Card variant="form" className={styles.card} aria-label="いま止まっている理由">
                  <CardHeader size="stacked" title="いま止まっている理由" />
                  {reasons.map((line) => <p key={line} className={styles.cardLine}>{line}</p>)}
                </Card>
              ) : null}
              <Card variant="form" className={styles.card} aria-label="気をつけること">
                <CardHeader size="stacked" title="気をつけること" />
                <p className={styles.cardLine}>
                  {CARE_LINES[0]}
                  <br />
                  {CARE_LINES[1]}
                </p>
              </Card>
            </div>
          </>
        )}
      </SettingsPage>
    </div>
  )
}

/** 1段。済みは緑の丸と札、まだは番号の丸と行き先のボタン。権限で押せない段は灰色のボタンと共通の理由。 */
function StepRow({ step, role, next }: { step: StepResult; role: string | null; next: boolean }) {
  const managerOnly = isManagerOnlyHref(step.action?.href)
  const allowed = canOpenStep(step, role)
  const reason = role ? lockUnless(allowed, role === 'viewer' ? 'viewer' : managerOnly && !canManageRole(role) ? 'manager' : 'feature') : undefined
  const done = step.state === 'done'
  return (
    <GridRow className={styles.stepRow} data-step-state={step.state}>
      <GridCell><span className={`${styles.mark} ${done ? styles.markDone : ''}`} aria-label={done ? '済み' : `手順${step.ordinal}`}>{done ? <Check size={16} aria-hidden="true" /> : step.ordinal}</span></GridCell>
      <GridCell><div className={styles.stepBody}>
        <strong className={styles.stepTitle}><span className={done ? styles.stepDoneTitle : undefined}><TruncatedText value={step.title} /></span>{next ? <StatusBadge tone="success" size="compact" dot={false}>次はここ</StatusBadge> : null}</strong>
        <span className={styles.stepSub}><TruncatedText value={step.sub} /></span>
      </div></GridCell>
      <GridCell align="right">
        {done ? <StatusBadge tone="success" size="compact">済み</StatusBadge> : step.action || step.state === 'forbidden' ? (
          role && step.action ? <Button href={step.action.href} lockedReason={reason} variant={next && allowed ? 'primary' : 'secondary'} presentation="row-action" textTone={next && allowed ? undefined : step.state === 'stalled' ? 'accent' : 'ink'}>{step.action.label}</Button>
            : <Button disabled={!role} lockedReason={reason} presentation="row-action" textTone={step.state === 'stalled' ? 'accent' : 'ink'}>{step.action?.label ?? '設定を開く'}</Button>
        ) : <span className={styles.stepBlocked}>{step.blockedReason}</span>}
      </GridCell>
    </GridRow>
  )
}
