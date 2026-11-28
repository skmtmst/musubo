'use client'

import { ActivityTime } from '@/components/shared/activity-item'
import { useFeatureAccess } from '@/lib/use-feature-access'

/*
 * ★V8 友だち追加時の配信の実行の詳細（Pencil ・失敗あり）。
 *
 * 型の頭（戻る・題・説明）→ 線 → 左（失敗の帯・行ったこと）と右の欄（この追加について・トーク・設定）。
 * 白い板が 1100px を切ったら右の欄を左の下へ畳む。
 * 取得・もう一度実行・戻り先の引き継ぎ（R268・M010・M011）は `app/friend-add-settings/runs/detail/detail-v8.tsx`
 * から写した（import はしない）。動きの一覧は BEHAVIOR.md。
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { CheckCircle2, Clock, MessageCircle, RotateCcw, Settings2, XCircle } from 'lucide-react'
import { DetailPage } from '@/components/templates/detail-page'
import { CreateSummaryCard } from '@/components/templates/create-parts'
import Card from '@/components/shared/card'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import ListState from '@/components/shared/list-state'
import TargetMissing from '@/components/shared/target-missing'
import { useAccount } from '@/contexts/account-context'
import { api, type FriendAddRunDetail } from '@/lib/api'
import { useStaffRole } from '@/lib/staff-role'
import { describeFriendAddFailure } from '@/v8/friend-add/public/failure/index'
import { MESSAGE_TYPE_LABEL } from '@/v8/friend-add/public/flow/index'
import { DELIVERY_UNKNOWN_CODE, jstClock, jstShortDateTime, jstTitleDate, routingAction } from './status'
import styles from './detail.module.css'
import { LogEntryCopy } from '@/components/shared/log-entry-details'
import { LogRecordJson } from '@/v8/log-record'
import { emptyValue } from '@/components/shared/empty-value'
import { DetailLoading } from '@/components/templates/detail-page'
import Notice from '@/components/shared/notice'
import { withHonorific } from '@line-crm/shared'

type ActionRun = FriendAddRunDetail['actionRuns'][number]

/** 処理の種類の名前（設定の言葉が読めないとき）。 */
const ACTION_LABELS: Record<string, string> = Object.assign(Object.create(null), {
  tag: 'タグ操作',
  friend_field: '友だち情報の更新',
  support_mark: '対応マークの更新',
  scenario: 'シナリオ操作',
  common_var: '共通情報の更新',
  mile: 'マイル付与',
})

/** 失敗の帯の「〇〇ところで止まりました」。 */
const ACTION_STOPPED_AT: Record<string, string> = Object.assign(Object.create(null), {
  tag: 'タグを付けるところ',
  friend_field: '友だち情報を更新するところ',
  support_mark: '対応マークを付けるところ',
  scenario: 'シナリオを始めるところ',
  common_var: '共通情報を更新するところ',
  mile: 'マイルを付けるところ',
})

/** 設定の処理（`add_tag` など）と、実行した処理の種類（`tag` など）が同じ仲間か。 */
const CONFIGURED_KIND: Record<string, string> = { add_tag: 'tag', remove_tag: 'tag', start_scenario: 'scenario' }

function safeErrorMessage(code: string | null): string | null {
  if (!code) return null
  if (code === 'action_failed') return '処理を完了できませんでした。設定と対象データを確認して、もう一度実行してください。'
  return '処理を完了できませんでした。詳細は運用ログで確認してください。'
}

/** 「〜する／〜ける」を終わった形にする（成功した処理だけ）。読めない言い方はそのまま。 */
export function pastTense(label: string): string {
  if (label.endsWith('する')) return `${label.slice(0, -2)}した`
  if (/[けめえせてねべれげ]る$/.test(label)) return `${label.slice(0, -1)}た`
  return label
}

/**
 * 実行した処理の名前。`stableId` の末尾（`<版>:<番号>`）が設定の処理の番号で、種類が同じ仲間のときだけ
 * 設定の言葉（例：タグ「新規」を付ける）を使う。合わないときは種類の名前に倒す（違う処理の名前を出さない）。
 */
export function actionTitle(action: ActionRun, configured: unknown[] | undefined): string {
  const index = Number(action.stableId.split(':').pop())
  const config = Number.isInteger(index) ? configured?.[index] : undefined
  const fallback = Object.prototype.hasOwnProperty.call(ACTION_LABELS, action.type) ? ACTION_LABELS[action.type] : '処理'
  if (!config || typeof config !== 'object') return fallback
  const { type, label } = config as { type?: unknown; label?: unknown }
  if (typeof label !== 'string' || !label || typeof type !== 'string' || CONFIGURED_KIND[type] !== action.type) return fallback
  return action.status === 'completed' ? pastTense(label) : label
}

/**
 * JSON で見せる実行の記録。友だちの名前・ID と設定の中身（送る文面）は入れず、
 * 画面に出している状態・日時・経路・処理の結果だけにする。
 */
export function runRecord(detail: FriendAddRunDetail, actionRuns: ActionRun[]) {
  return {
    id: detail.id,
    status: detail.status,
    errorCode: detail.errorCode,
    friendKind: detail.friendKind,
    receivedAt: detail.receivedAt,
    processedAt: detail.processedAt,
    attribution: { status: detail.attribution.status, routeName: detail.attribution.routeName },
    rule: detail.rule ? { id: detail.rule.id, name: detail.rule.name, versionNumber: detail.rule.versionNumber } : null,
    actionRuns: actionRuns.map((action) => ({
      id: action.id, type: action.type, status: action.status, attemptCount: action.attemptCount,
      errorCode: action.errorCode, startedAt: action.startedAt, completedAt: action.completedAt, nextRetryAt: action.nextRetryAt,
    })),
  }
}

/** 記録ID は長いので頭と末尾だけ（全文は title）。 */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 7)}…${id.slice(-3)}` : id
}

export default function FriendAddRunDetailV8() {
  return (
    <Suspense fallback={<DetailLoading />}>
      <FriendAddRunDetailInner />
    </Suspense>
  )
}

function FriendAddRunDetailInner() {
  usePageTitle('友だち追加時配信・実行詳細')
  const searchParams = useSearchParams()
  const runId = searchParams.get('id') ?? ''
  /* 一覧から受け取った絞り込み・ページ位置を戻り先へ引き継ぐ（R268）。 */
  const listHref = useMemo(() => {
    const params = new URLSearchParams()
    for (const key of ['kind', 'status', 'attribution', 'rule_id', 'pages']) {
      const value = searchParams.get(key)
      if (value) params.set(key, value)
    }
    const query = params.toString()
    return `/friend-add-settings/runs${query ? `?${query}` : ''}`
  }, [searchParams])
  /* 板の頭の「← 〇〇へ」は 2026-10-08 に無くした。一覧へは上の帯のパンくずで戻る。 */
  usePageCrumbs([{ label: '友だち追加時の配信', href: '/friend-add-settings' }, { label: '実行結果', href: listHref }])
  const { selectedAccountId, loading: accountLoading } = useAccount()
  const role = useStaffRole()
  const canManage = useFeatureAccess('friendAdd')
  const [detail, setDetail] = useState<FriendAddRunDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [errorStatus, setErrorStatus] = useState<number | null>(null)
  const [missing, setMissing] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [notice, setNotice] = useState('')
  /* 処理の失敗が無い失敗（案内を送れなかった等）は、相手に新しく届くので確かめてから動かす。 */
  const [resendConfirmOpen, setResendConfirmOpen] = useState(false)
  const requestSequence = useRef(0)
  const contextKey = JSON.stringify([selectedAccountId, runId])
  const currentContext = useRef({ key: contextKey })
  if (currentContext.current.key !== contextKey) currentContext.current = { key: contextKey }
  const [retryReviewRequired, setRetryReviewRequired] = useState(false)

  const load = useCallback(async ({ quiet = false }: { quiet?: boolean } = {}) => {
    const requestId = ++requestSequence.current
    // アカウントを切り替えた直後は、前のアカウントの詳細を一瞬でも残さない。
    if (!quiet) { setDetail(null); setNotice(''); setRetrying(false); setResendConfirmOpen(false); setRetryReviewRequired(false) }
    if (!selectedAccountId || !runId) {
      setError('')
      setLoading(false)
      return
    }
    if (!quiet) setLoading(true)
    setError('')
    setErrorStatus(null)
    setMissing(false)
    try {
      const response = await api.friendAddRules.runDetail(selectedAccountId, runId)
      if (requestId !== requestSequence.current) return
      if (!response.success) {
        if (quiet) setNotice('最新の実行詳細を確認できませんでした。閉じて状態を読み直してください。')
        else setError('実行詳細を表示できませんでした。時間をおいて、もう一度お試しください。')
        return
      }
      setDetail(response.data)
    } catch (caught) {
      if (requestId !== requestSequence.current) return
      const failure = describeFriendAddFailure(caught, '実行詳細', 'load')
      if (failure.status === 404 && !quiet) {
        setMissing(true)
        return
      }
      if (quiet) setNotice(failure.message)
      else { setError(failure.message); setErrorStatus(failure.status) }
    } finally {
      if (requestId === requestSequence.current) setLoading(false)
    }
  }, [runId, selectedAccountId])

  useEffect(() => {
    if (!accountLoading) void load()
    return () => { requestSequence.current += 1 }
  }, [accountLoading, load])

  const retry = async () => {
    if (!selectedAccountId || !detail || retrying || retryReviewRequired) return
    const scope = currentContext.current
    setRetrying(true)
    setNotice('')
    try {
      const response = await api.friendAddRules.retryRun(selectedAccountId, detail.id)
      if (currentContext.current !== scope) return
      if (!response.success) {
        setNotice('失敗した処理を再試行できませんでした。状態を読み直してください。')
        return false
      }
      setResendConfirmOpen(false)
      setNotice(`${response.data.retried} 件の失敗処理を再試行しました。`)
      await load({ quiet: true })
      return true
    } catch (caught) {
      if (currentContext.current !== scope) return
      // M011：409 は応答が消えたあとの再送（実際は通っている）ことがあるので、読み直してから文を出す。
      const failure = describeFriendAddFailure(caught, '失敗した処理', 'retry')
      if (failure.status === 409) { setRetryReviewRequired(true); await load({ quiet: true }) }
      if (currentContext.current === scope) setNotice(failure.message)
      return false
    } finally {
      if (currentContext.current === scope) setRetrying(false)
    }
  }

  if (accountLoading || loading) return <DetailLoading label="実行詳細を読み込んでいます" />
  if (!runId) {
    return (
      <TargetMissing
        kind="unspecified"
        title="見る実行詳細が指定されていません"
        description="実行履歴の一覧から、見る記録を選び直してください。"
        backHref={listHref}
        backLabel="実行履歴の一覧へ戻る"
      />
    )
  }
  if (!selectedAccountId) {
    return <ListState kind="empty" title="LINEアカウントを選んでください" description="上部でLINEアカウントを選ぶと、その実行詳細を表示できます。" />
  }
  if (missing || (!error && !detail)) {
    return (
      <TargetMissing
        kind="not-found"
        title="この実行詳細は見つかりません"
        description="対象の記録が見つかりません。削除されたか、一覧から選び直してください。"
        backHref={listHref}
        backLabel="実行履歴の一覧へ戻る"
      />
    )
  }
  if (error || !detail) {
    if (errorStatus === 403) {
      return <ListState kind="forbidden" title="実行詳細を表示する権限がありません" description={error} onRetry={() => void load()} />
    }
    return (
      <TargetMissing
        kind="error"
        title="実行詳細を表示できませんでした"
        description={error || '通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。'}
        onRetry={() => void load()}
      />
    )
  }

  /* 形の違う応答は空として扱う（そのまま回すと画面ごと落ちる。全ルート監査 A1）。 */
  const actionRuns = Array.isArray(detail.actionRuns) ? detail.actionRuns : []
  const failedActions = actionRuns.filter((action) => action.status === 'failed')
  const firstFailed = actionRuns.findIndex((action) => action.status === 'failed')
  const displayName = detail.friend.displayName || '名前は未取得'
  const friendKindLabel = detail.friendKind === 'first_time' ? 'はじめて' : '再追加・ブロック解除'
  const routeName = detail.attribution.status === 'captured'
    ? detail.attribution.routeName || detail.attribution.reason || '選択した経路'
    : '経路が分からない'
  const ruleLabel = detail.rule ? `${detail.rule.name ?? '名前は未取得'}（第${detail.rule.versionNumber ?? emptyValue('unknown')}版）` : '使用ルールは未取得'
  const messageType = detail.rule?.definition?.messageType
  const messageLabel = messageType && Object.prototype.hasOwnProperty.call(MESSAGE_TYPE_LABEL, messageType) ? MESSAGE_TYPE_LABEL[messageType] : '案内'
  const deliveryUnknown = detail.errorCode === DELIVERY_UNKNOWN_CODE
  /* 案内を送らなかった記録（再追加で案内なし・送れなかった）は「案内を送った」を出さない。 */
  const messageSent = detail.status !== 'suppressed' && !deliveryUnknown && !(detail.status === 'failed' && failedActions.length === 0)
  const runFailed = detail.status === 'failed' || detail.status === 'partial_failed'
  const talkHref = !detail.friend.redacted ? `/chats?friend=${encodeURIComponent(detail.friend.id)}` : null
  const settingsHref = detail.rule ? `/friend-add-settings?view=edit&id=${encodeURIComponent(detail.rule.id)}` : null

  const bandTitle = deliveryUnknown ? '送達不明・要確認（自動では送り直しません）' : failedActions.length > 0
    ? `${firstFailed + (messageSent ? 2 : 1)}つ目の処理を完了できませんでした`
    : routingAction(detail.status, detail.errorCode)
  const bandNote = failedActions.length > 0
    ? `${messageSent ? '案内は届いています。' : ''}${Object.prototype.hasOwnProperty.call(ACTION_STOPPED_AT, actionRuns[firstFailed]?.type ?? '') ? ACTION_STOPPED_AT[actionRuns[firstFailed].type] : '処理のところ'}で止まりました。`
    : deliveryUnknown
      ? '届いたか分かりません。二重に届かないよう、自動では送り直しません。トークで確かめてください。'
      : '案内を送れませんでした。理由を確かめて、もう一度実行できます。'

  const summary = <>
    <CreateSummaryCard title="この追加について" variant="record" rows={[
      { label: '友だち', value: <span title={displayName}>{displayName}</span> },
      { label: '追加の種類', value: friendKindLabel },
      { label: '来た経路', value: <span title={routeName}>{routeName}</span> },
      { label: '動いた設定', value: <span title={ruleLabel}>{ruleLabel}</span> },
      { label: '受けた日時', value: jstShortDateTime(detail.receivedAt) },
      { label: '処理した日時', value: detail.processedAt ? jstShortDateTime(detail.processedAt) : 'まだ処理していません' },
      { label: '記録ID（お問い合わせ用）', value: <span className={styles.mono} title={detail.id}>{shortId(detail.id)}</span> },
    ]} />
    {talkHref || settingsHref ? (
      <div className={styles.sideActions}>
        {talkHref ? <Button href={talkHref}><MessageCircle size={16} aria-hidden="true" />トークを開く</Button> : null}
        {settingsHref ? <Button href={settingsHref}><Settings2 size={16} aria-hidden="true" />設定を開く</Button> : null}
      </div>
    ) : null}
  </>
  return (
    <DetailPage boardId="N43uVX" layout="record-detail" heightMode="content"
      title={`${withHonorific(displayName)}の友だち追加`}
      help={`${jstTitleDate(detail.receivedAt)} に追加・${friendKindLabel}`}
      summary={summary}
      summaryLabel="この追加について"
    >
      {failedActions.length > 0 || runFailed || deliveryUnknown ? (
        <Notice tone="danger" heading={<> {bandTitle} </>} action={<> {canManage && !deliveryUnknown && (failedActions.length > 0 || runFailed) ? (
            <Button
              variant="primary"
              disabled={retrying || retryReviewRequired}
              disabledReason={retryReviewRequired ? '最新の実行状態を確認してください。' : undefined}
              busy={retrying}
              busyLabel="再試行中…"
              onClick={() => { if (failedActions.length > 0) void retry(); else { setNotice(''); setResendConfirmOpen(true) } }}
            >
              <RotateCcw size={16} aria-hidden="true" />失敗した処理をもう一度
            </Button>
          ) : null}{retryReviewRequired ? <Button variant="text" size="inline" onClick={() => void load()}>最新の実行状態を確認する</Button> : null} </>} >{bandNote}</Notice>
      ) : null}

      <LogEntryCopy canCopy={canManage} entry={{ occurredAt: detail.processedAt ?? detail.receivedAt, target: displayName, status: routingAction(detail.status, detail.errorCode), reason: deliveryUnknown ? '届いたか分からないため、自動では送り直しません。' : runFailed ? safeErrorMessage(detail.errorCode) ?? '処理を完了できませんでした。' : '処理の記録を確認してください。' }} />
      <Card variant="form" contentPadding="var(--polish-space-section)" gap="var(--tpl-rule-row-gap)" aria-labelledby="friend-add-run-steps">
        <div className={styles.cardHead}>
          <h3 id="friend-add-run-steps" className={styles.cardTitle}>行ったこと</h3>
          <p className={styles.cardSub}>設定された処理を、省かずに行った順に出します</p>
        </div>
        <ol className={styles.steps}>
          {messageSent ? (
            <li data-state="ok"><Card layout="horizontal" padding="compact" gap="var(--tpl-rule-row-gap)" className={styles.step} data-state="ok">
              <CheckCircle2 size={20} className={styles.stepIcon} aria-hidden="true" />
              <span className={styles.stepIndex}>1</span>
              <span className={styles.stepText}>
                <span className={styles.stepTitle}>{`案内（${messageLabel}）を送った`}</span>
                <span className={styles.stepSub}>{`${jstClock(detail.processedAt ?? detail.receivedAt)}・LINE 受付済み`}</span>
              </span>
            </Card></li>
          ) : null}
          {actionRuns.map((action, index) => {
            const state = action.status === 'completed' ? 'ok' : action.status === 'failed' ? 'ng' : 'wait'
            const message = state === 'ng' ? safeErrorMessage(action.errorCode) : null
            const time = jstClock(action.completedAt ?? action.startedAt)
            return (
              <li key={action.id} data-state={state}><Card layout="horizontal" padding="compact" gap="var(--tpl-rule-row-gap)" className={styles.step} data-state={state} surface={state === 'ng' ? 'danger' : 'standard'}>
                {state === 'ok' ? <CheckCircle2 size={20} className={styles.stepIcon} aria-hidden="true" />
                  : state === 'ng' ? <XCircle size={20} className={`${styles.stepIcon} ${styles.failedIcon}`} aria-hidden="true" />
                    : <Clock size={20} className={`${styles.stepIcon} ${styles.waitIcon}`} aria-hidden="true" />}
                <span className={styles.stepIndex}>{index + (messageSent ? 2 : 1)}</span>
                <span className={styles.stepText}>
                  <span className={styles.stepTitle}>{actionTitle(action, detail.configuredActions)}</span>
                  {message || state === 'wait' ? <span className={`${styles.stepSub}${state === 'ng' ? ` ${styles.failedSub}` : ''}`}>
                    {message ?? `${time}・実行を待っています`}
                  </span> : <ActivityTime lineHeight="var(--tpl-fm2-rd-time-lh)">{action.attemptCount > 1 ? `${time}・${action.attemptCount} 回目` : time}</ActivityTime>}
                </span>
              </Card></li>
            )
          })}
        </ol>
        {detail.status === 'suppressed' && !deliveryUnknown ? <p className={styles.cardSub}>配信なし</p> : null}
        {actionRuns.length === 0 ? <p className={styles.cardSub}>追加の処理はありません。</p> : null}
      </Card>
      <LogRecordJson value={runRecord(detail, actionRuns)} label="この実行" canCopy={canManage} />
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
      <ConfirmDialog
        open={resendConfirmOpen}
        title="失敗した処理をもう一度行いますか？"
        description="届かなかった処理だけをもう一度行います。相手には新しく届きます。"
        confirmLabel="もう一度行う"
        busy={retrying}
        confirmDisabled={retryReviewRequired} confirmDisabledReason="閉じて最新の実行状態を確認してください。"
        error={notice || undefined} onSuccess={() => setResendConfirmOpen(false)} onConfirm={() => retry()}
        onCancel={() => { if (!retrying) { setResendConfirmOpen(false); if (retryReviewRequired) void load() } }}
      />
    </DetailPage>
  )
}
