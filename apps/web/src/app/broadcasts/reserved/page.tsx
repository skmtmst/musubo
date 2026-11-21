'use client'

import { cancelConflictMessage } from '@/v8/broadcast-detail/display'
import { isSaveConflict } from '@/components/shared/save-conflict'

import { useFeatureAccess } from '@/lib/use-feature-access'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { CalendarCheck2, Copy, Eye, List, Send } from 'lucide-react'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import NoteBar from '@/components/shared/note-bar'
import Notice from '@/components/shared/notice'
import { commonVarFailureNames, type CommonVarFailure } from '@/components/shared/common-var-test-failure'
import TargetMissing from '@/components/shared/target-missing'
import { notifyToast } from '@/components/shared/toast'
import { useAccount } from '@/contexts/account-context'
import { ApiError, api, type ApiBroadcast } from '@/lib/api'
import type { Tag } from '@line-crm/shared'
import { audienceSummary } from '@/lib/broadcast-summary'
import { formatDateTime, formatNumber } from '@/lib/format'
import { useStaffRole } from '@/lib/staff-role'
import ReservedV8 from '@/v8/broadcast-detail/reserved'

type AudienceEstimate = {
  audienceCount: number
  hiddenExcluded: number
  warnings: Array<{ level: 'info' | 'warning'; message: string }>
}

const TARGET_LABELS: Record<ApiBroadcast['targetType'], string> = {
  all: 'このアカウントの友だち全員',
  tag: '指定したタグが付いている友だち',
  segment: '詳細条件に合う友だち',
  'multi-account-dedup': '複数アカウントから重複を除いた友だち',
}

function formatJst(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return formatDateTime(date)
}

function formatJstSentence(value: string | null): string {
  if (!value) return '日時未設定'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '日時未設定'
  return formatDateTime(date)
}

function belongsToAccount(broadcast: ApiBroadcast, selectedAccountId: string | null): boolean {
  if (!selectedAccountId) return true
  if (broadcast.targetType === 'multi-account-dedup') {
    return broadcast.accountIds?.includes(selectedAccountId) ?? false
  }
  return broadcast.lineAccountId === selectedAccountId
}

function ReservedBroadcastContent() {
  /*
   * ★V8：上の帯のパンくずは「一斉配信 › 予約しました」。
   * 互換経路ではパンくずが描かれないので、渡しても見た目は変わらない。
   */
  usePageCrumbs([{ label: '一斉配信', href: '/broadcasts' }])
  usePageTitle('予約しました')
  const router = useRouter()
  const id = useSearchParams().get('id')
  const { selectedAccountId, selectedAccount, loading: accountLoading } = useAccount()
  // 閲覧のみ（夕18）：V8 の右の欄の操作を押せない形にする。
  const staffRole = useStaffRole()
  const canEdit = useFeatureAccess('broadcasts')
  const [broadcast, setBroadcast] = useState<ApiBroadcast | null>(null)
  const [estimate, setEstimate] = useState<AudienceEstimate | null>(null)
  // BROADCAST-15: 宛先の条件に出すタグ名・シナリオ名。一覧・詳細と同じ
  // audienceSummary を使うので、シナリオ指定を「タグ未指定」とは出さない。
  const [audienceNames, setAudienceNames] = useState<{
    tags: Tag[]
    scenarios: Array<{ id: string; name: string }>
  } | null>(null)
  const [notificationText, setNotificationText] = useState('')
  const [approverName, setApproverName] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  /*
   * 存在しない予約（404）と通信の失敗（503など）は別の案内にする（R582）。
   * 存在しないものに「もう一度読み込む」だけ出しても直らないし、
   * 通信の失敗に一覧へ戻る口だけ出しても続けられない。
   */
  const [notFound, setNotFound] = useState(false)
  /*
    予約の取消。**送信が始まったあとは戻せない**ので、押す前に何が起きるかを
    読ませ、押している間は受け付けない。取り消しても中身は消えず、下書きに
    戻るだけ——作り直しにならないことを先に言う。
  */
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelError, setCancelError] = useState('')
  const [cancelConflict, setCancelConflict] = useState(false)
  const cancelScopeKey = JSON.stringify([id, selectedAccountId])
  const cancelScope = useRef({ key: cancelScopeKey, generation: 0 })
  if (cancelScope.current.key !== cancelScopeKey) cancelScope.current = { key: cancelScopeKey, generation: cancelScope.current.generation + 1 }
  const cancelSnapshot = useRef<{ id: string; version: number | null; generation: number } | null>(null)
  const renderedCancelSnapshot = cancelSnapshot.current
  const [cancelled, setCancelled] = useState(false)
  const [actionBusy, setActionBusy] = useState<'test' | 'duplicate' | null>(null)
  const [actionError, setActionError] = useState('')
  const [missingVars, setMissingVars] = useState<CommonVarFailure[] | null>(null)
  useEffect(() => { setMissingVars(null) }, [id, selectedAccountId])
  const duplicateKey = useRef<string | null>(null)
  const requestGeneration = useRef(0)

  const load = useCallback(async () => {
    const generation = requestGeneration.current + 1
    requestGeneration.current = generation
    const isCurrent = () => requestGeneration.current === generation

    if (!id) {
      if (!isCurrent()) return
      setBroadcast(null)
      setLoading(false)
      return
    }

    setLoading(true)
    setNotFound(false)
    setEstimate(null)
    setApproverName(null)
    try {
      const result = await api.broadcasts.get(id)
      if (!isCurrent()) return
      if (!result.success) {
        setBroadcast(null)
        setNotFound(true)
        return
      }

      setBroadcast(result.data)
      // 宛先が絞り込みのときだけ、条件に出すタグ名・シナリオ名を取る。
      // 取れなくても予約の表示自体は出し続ける（型だけの表記に残る）。
      if (result.data.targetType === 'tag' || result.data.targetType === 'segment') {
        // R23横展開: この予約のアカウントの候補だけで名前を解決する。
        const audienceAccountId = result.data.lineAccountId
        void Promise.allSettled([
          api.tags.list(audienceAccountId ? { accountId: audienceAccountId } : undefined),
          api.scenarios.list(audienceAccountId ? { accountId: audienceAccountId } : undefined),
        ])
          .then(([tagsRes, scenariosRes]) => {
            if (!isCurrent()) return
            const tags = tagsRes.status === 'fulfilled' && tagsRes.value.success ? tagsRes.value.data : null
            const scenarios = scenariosRes.status === 'fulfilled' && scenariosRes.value.success ? scenariosRes.value.data : null
            if (!tags && !scenarios) return
            setAudienceNames({ tags: tags ?? [], scenarios: scenarios ?? [] })
          })
      }
      // 絵 : 承認待ちの予約は状態行に「承認：名前」を出す。
      // 名前が取れなくても予約の表示は出し続ける（「承認待ち」の表記に残る）。
      if (result.data.approvalStatus === 'pending' && result.data.lineAccountId) {
        void Promise.allSettled([
          api.broadcasts.approval.get(id),
          api.broadcasts.approval.candidates(result.data.lineAccountId),
        ]).then(([stateRes, candidatesRes]) => {
          if (!isCurrent()) return
          if (stateRes.status !== 'fulfilled' || !stateRes.value.success) return
          if (candidatesRes.status !== 'fulfilled' || !candidatesRes.value.success) return
          const approverId = stateRes.value.data.approval.approverStaffId
          const name = candidatesRes.value.data.find((c) => c.id === approverId)?.name
          if (name) setApproverName(name)
        })
      }
      /*
       * 通知設定と人数の再集計は互いに待たない。直列に待つと予約完了の
       * 表示が遅い。片方だけ取れないときも、もう片方は出す（#490 軽4）。
       */
      const notifyTask = result.data.lineAccountId
        ? api.broadcasts.notificationSettings(result.data.lineAccountId)
          .then((notifications) => {
            if (isCurrent() && notifications.success) setNotificationText(notifications.data.displayText)
          })
          .catch(() => {
            if (isCurrent()) setNotificationText('')
          })
        : Promise.resolve()
      // 完了した予約の取得と、現在人数の再集計は別の結果として扱う。
      // 人数だけ取れないときに予約そのものまで「表示できない」に戻さない。
      const estimateTask = api.broadcasts.preflight({
        targetType: result.data.targetType,
        targetTagId: result.data.targetTagId,
        segmentConditions: result.data.segmentConditions ?? null,
        lineAccountId: result.data.lineAccountId,
        accountIds: result.data.accountIds ?? undefined,
        messageContent: result.data.messageContent,
      })
        .then((preflight) => {
          if (isCurrent() && preflight.success) setEstimate(preflight.data)
        })
        .catch(() => {
          if (isCurrent()) setEstimate(null)
        })
      await Promise.all([notifyTask, estimateTask])
    } catch (err) {
      if (!isCurrent()) return
      setBroadcast(null)
      // 実Workerは存在しない予約を404で返す。汎用の通信失敗と混ぜない。
      if (err instanceof ApiError && err.status === 404) {
        setNotFound(true)
      } else {
        setNotFound(false)
      }
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void load()
    return () => {
      requestGeneration.current += 1
    }
  }, [load])

  /*
   * `?id=` なしで開くと読み込みが始まらない。対象未指定は失敗ではないので、
   * 落とさず予定へ戻して選び直させる（全ルート監査 A2、2026-09-25）。
   */
  if (!id) {
    return (
      <TargetMissing
        kind="unspecified"
        title="予約中の配信が指定されていません"
        description="配信予定から、確認する予約を選び直してください。"
        backHref="/broadcasts"
        backLabel="配信予定へ戻る"
      />
    )
  }
  if (accountLoading || loading) {
    return <ListState kind="loading" title="予約結果を確認しています" />
  }

  /*
   * R582: 対象なしは存在しない旨と配信予定への戻り口だけ。
   * 通信の失敗（503など）は同画面での再試行だけ。混ぜない。
   */
  if (notFound) {
    return (
      <TargetMissing
        kind="not-found"
        title="予約した配信が見つかりません"
        description="削除されたか、配信予定から選び直してください。"
        backHref="/broadcasts"
        backLabel="配信予定へ戻る"
      />
    )
  }

  if (!broadcast) {
    return (
      <TargetMissing
        kind="error"
        title="予約結果を表示できませんでした"
        description="通信が切れたか、サーバーが応えませんでした。しばらくしてから、もう一度読み込んでください。"
        onRetry={() => void load()}
      />
    )
  }

  if (!belongsToAccount(broadcast, selectedAccountId)) {
    return (
      <ListState
        kind="forbidden"
        title="選択中のアカウントの配信ではありません"
        description="上のアカウントを予約時のものへ切り替えてから、もう一度開いてください。"
        action={<Button href="/broadcasts">配信予定へ戻る</Button>}
      />
    )
  }

  // WEB317：この画面で取り消した直後は下書きに戻っている。取消の成功を「予約待ちではない」に戻さない。
  if ((broadcast.status !== 'scheduled' || !broadcast.scheduledAt) && !cancelled) {
    return (
      <ListState
        kind="error"
        title="予約状態を確認できませんでした"
        description="この配信は予約待ちではありません。配信詳細で現在の状態を確認してください。"
        action={<Button href={`/broadcasts/detail?id=${encodeURIComponent(broadcast.id)}`}>配信詳細を見る</Button>}
      />
    )
  }

  const bubbleCount = broadcast.messageBubbles?.length ?? (broadcast.messageContent ? 1 : 0)
  const audienceCount = estimate?.audienceCount ?? null
  // BROADCAST-15: 名前が取れたら一覧・詳細と同じ要約（タグ名・シナリオ名入り）を出す。
  // 取れるまでは従来の型だけの表記。逆方向へは戻らない。
  const audienceTarget = (broadcast.targetType === 'tag' || broadcast.targetType === 'segment') && audienceNames
    ? audienceSummary(
        broadcast,
        (tagId) => audienceNames.tags.find((t) => t.id === tagId)?.name ?? null,
        (scenarioId) => audienceNames.scenarios.find((s) => s.id === scenarioId)?.name ?? null,
      )
    : TARGET_LABELS[broadcast.targetType]
  const audienceLabel = `${audienceTarget}${audienceCount === null ? '' : ` ${formatNumber(audienceCount)}人`}`
  const scheduledLabel = formatJst(broadcast.scheduledAt)
  const scheduledSentenceLabel = formatJstSentence(broadcast.scheduledAt)

  const testSend = async () => {
    if (actionBusy) return
    const generation = cancelScope.current.generation
    setActionBusy('test')
    setActionError('')
    setMissingVars(null)
    try {
      const result = await api.broadcasts.testSend(broadcast.id)
      if (generation !== cancelScope.current.generation) return
      if (!result.success) throw new Error(result.error)
      notifyToast(`テスト送信が完了しました（成功 ${result.sent ?? 0}件・失敗 ${result.failed ?? 0}件）。`)
    } catch (error) {
      if (generation !== cancelScope.current.generation) return
      const names = commonVarFailureNames(error)
      if (names) setMissingVars(names)
      else setActionError('テスト送信できませんでした。テスト送信先の設定と配信内容を確認してください。')
    } finally {
      setActionBusy(null)
    }
  }

  const duplicateBroadcast = async () => {
    if (actionBusy) return
    setActionBusy('duplicate')
    setActionError('')
    setMissingVars(null)
    duplicateKey.current ??= crypto.randomUUID()
    try {
      const result = await api.broadcasts.create({
        title: `${broadcast.title}（複製）`,
        messageType: broadcast.messageType,
        messageContent: broadcast.messageContent,
        messageBubbles: broadcast.messageBubbles ?? undefined,
        targetType: broadcast.targetType,
        targetTagId: broadcast.targetTagId,
        lineAccountId: broadcast.lineAccountId,
        accountIds: broadcast.accountIds ?? undefined,
        dedupPriority: broadcast.dedupPriority ?? undefined,
        trackLinks: broadcast.trackLinks,
        segmentConditions: broadcast.segmentConditions ?? undefined,
        folderId: broadcast.folderId ?? null,
        measureOpens: broadcast.measureOpens,
      }, { idempotencyKey: duplicateKey.current })
      if (!result.success) throw new Error(result.error)
      router.push(`/broadcasts/detail?id=${encodeURIComponent(result.data.id)}`)
    } catch {
      setActionError('複製できませんでした。通信を確認して、もう一度お試しください。')
    } finally {
      setActionBusy(null)
    }
  }

  /*
   * 予約の取消の確定。口の返事をそのまま出さない——409（もう予約中ではない）も
   * 通信の失敗も、運用者にできることは同じ（読み直して確かめる）。
   * 管理画面・V8 どちらの確認ダイアログからもここを呼ぶ。
   */
  const confirmCancel = async () => {
    const snapshot = cancelSnapshot.current
    if (cancelling || cancelConflict || !canEdit || !snapshot || snapshot.version === null || snapshot !== renderedCancelSnapshot || snapshot.id !== id || snapshot.id !== broadcast.id || snapshot.generation !== cancelScope.current.generation) return
    setCancelling(true)
    setCancelError('')
    try {
      const res = await api.broadcasts.cancelReservation(snapshot.id, snapshot.version)
      if (snapshot !== cancelSnapshot.current || snapshot.generation !== cancelScope.current.generation) return
      if (!res.success) throw new Error(res.error)
      cancelSnapshot.current = null
      setBroadcast(res.data)
      setCancelled(true)
      setCancelOpen(false)
    } catch (cause) {
      if (snapshot !== cancelSnapshot.current || snapshot.generation !== cancelScope.current.generation) return
      if (isSaveConflict(cause)) {
        setCancelConflict(true)
        setCancelError(cancelConflictMessage(cause instanceof ApiError ? cause.data : undefined))
      } else setCancelError('予約を取り消せませんでした。すでに送信が始まっているかもしれません。状態を読み直してから、もう一度お試しください。')
    } finally {
      setCancelling(false)
    }
  }

  /* ★V8：見せ方は別の部品へ。読み込み・取消・複製・テスト送信は同じものを渡す。 */
  return (
      <ReservedV8
        broadcast={broadcast}
        estimate={estimate}
        audienceLabel={audienceTarget}
        approverName={approverName}
        accountName={selectedAccount?.name ?? 'LINE公式アカウント'}
        notificationText={notificationText}
        canEdit={canEdit}
        testSend={() => void testSend()}
        duplicate={() => void duplicateBroadcast()}
        actionBusy={actionBusy}
        actionError={actionError}
        missingVars={missingVars}
        clearActionError={() => setActionError('')}
        cancelOpen={cancelOpen && cancelSnapshot.current?.generation === cancelScope.current.generation && cancelSnapshot.current?.id === broadcast.id}
        openCancel={() => { setCancelError(broadcast.version == null ? '予約の版を確認できません。読み直してから、もう一度選んでください' : ''); setCancelConflict(broadcast.version == null); cancelSnapshot.current = { id: broadcast.id, version: broadcast.version ?? null, generation: cancelScope.current.generation }; setCancelOpen(true) }}
        closeCancel={() => { if (!cancelling) { cancelSnapshot.current = null; setCancelOpen(false); if (cancelConflict) { setCancelConflict(false); void load() } } }}
        cancelConflict={cancelConflict}
        reloadCancel={() => { cancelSnapshot.current = null; setCancelOpen(false); setCancelConflict(false); void load() }}
        confirmCancel={() => void confirmCancel()}
        cancelling={cancelling}
        cancelError={cancelError}
        cancelled={cancelled}
      />
    )
}

export default function ReservedBroadcastPage() {
  return (
    <Suspense fallback={<ListState kind="loading" title="予約結果を確認しています" />}>
      <ReservedBroadcastContent />
    </Suspense>
  )
}
