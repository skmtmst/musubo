'use client'

import { useFeatureAccess } from '@/lib/use-feature-access'
import { Suspense, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import type { Tag } from '@line-crm/shared'
import { ApiError, api, type ApiBroadcast, type BroadcastDisplayStatus, type BroadcastInsight, type BroadcastApprovalState } from '@/lib/api'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import Progress from '@/components/shared/progress'
import { Tabs } from '@/components/shared/tabs'
import TargetMissing from '@/components/shared/target-missing'
import BroadcastStatusRail, { isApprovalInvolved } from './broadcast-status-rail'
import BroadcastRecipients from './broadcast-recipients'
import BroadcastActivity from './broadcast-activity'
import {
  ApprovalBadge,
  ApprovalRequestFields,
  ApprovalStatusSection,
  ApproverSection,
  formatApprovalDateTime,
} from '@/components/broadcasts/broadcast-approval'
import type { BroadcastApprovalCandidate } from '@/lib/api'
import { useAccount } from '@/contexts/account-context'
import { audienceNamesNeeded, audienceNamesUsable, audienceSummary, messageTypeLabel } from '@/lib/broadcast-summary'
import { broadcastBelongsToSelectedAccount } from './broadcast-detail-account'
import { clickInsightDetail, formatBroadcastDateTime, openInsightDetail } from './broadcast-insight-display'
import { broadcastDetailCsv } from './broadcast-detail-export'
import StepUpPrompt, { isStepUpRequired, type StepUpRequest } from '@/components/step-up-prompt'
import { broadcastCsvFilename } from '@/components/broadcasts/broadcast-csv-filename'
import BroadcastMessagePreview from '@/components/broadcasts/broadcast-message-preview'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { formatNumber } from '@/lib/format'
import { useStaffRole } from '@/lib/staff-role'
import BroadcastDetailV8 from '@/v8/broadcast-detail/detail'

function BroadcastDetailInner() {
  const params = useSearchParams()
  const { selectedAccountId, selectedAccount, loading: accountLoading } = useAccount()
  const id = params.get('id') ?? ''
  const [broadcast, setBroadcast] = useState<ApiBroadcast | null>(null)
  /*
   * ★V8：上の帯のパンくずは「一斉配信 › 配信名」、画面名は配信名だけ。
   * 互換経路ではパンくずが描かれないので、渡しても見た目は変わらない。
   */
  usePageCrumbs([{ label: '一斉配信', href: '/broadcasts' }])
  usePageTitle(
    (broadcast ? broadcast.title : '一斉配信'),
  )
  // 閲覧のみ（夕18）：V8 の詳細で変える操作を押せない形にする。
  const staffRole = useStaffRole()
  const canEdit = useFeatureAccess('broadcasts')
  const [insight, setInsight] = useState<(BroadcastInsight & { suppressedByAudienceSize: boolean }) | null>(null)
  // 集計は配信本体とは別に取る。取れていないのか、取りに行って失敗したのかを
  // 「—」に混ぜると、待てば出るのか操作が要るのかを運用者が判断できない。
  const [insightState, setInsightState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'not-found' | 'error'>('loading')
  const [reloadToken, setReloadToken] = useState(0)
  /*
   * ★V8 ：ほかの人の更新に気づいたら帯で知らせる。
   * この画面は書き換えない（読み直すまで古い内容のまま）。
   */
  const [conflict, setConflict] = useState(false)
  const shownVersionRef = useRef<number | null>(null)
  const approvalTargetRef = useRef('')
  // BROADCAST-15: 宛先の条件に出すタグ名・シナリオ名。配信本体とは別に取る。
  // 読み込めないことと、宛先が消えていることは分けて出す。
  const [audienceNameState, setAudienceNameState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [audienceNames, setAudienceNames] = useState<{
    tags: Tag[]
    scenarios: Array<{ id: string; name: string }>
  }>({ tags: [], scenarios: [] })
  const contentRef = useRef<HTMLElement>(null)
  /*
   * 二者承認（m12a / 設計 A-2・A-3）。配信本体とは別に読む。
   * 取れなくても配信の詳細は出し続ける（承認の欄だけ出さない）。
   */
  const [approvalState, setApprovalState] = useState<BroadcastApprovalState | null>(null)
  const [approvalCandidates, setApprovalCandidates] = useState<BroadcastApprovalCandidate[]>([])
  const [approvalBusy, setApprovalBusy] = useState(false)
  const [approvalMessage, setApprovalMessage] = useState<string | null>(null)
  const [approvalStepUp, setApprovalStepUp] = useState<StepUpRequest | null>(null)
  // 承認の依頼を出し直すときの入力（差し戻し・期限切れのあと）。
  const [reApproverId, setReApproverId] = useState('')
  const [reApprovalNote, setReApprovalNote] = useState('')
  /*
   * 詳細のタブ（#816 概要・宛先・記録）。?tab= から開く。
   * 履歴に積まず置き換える（戻るで一覧へ戻れるように）。
   */
  const initialTab = params.get('tab')
  const [tab, setTab] = useState<'overview' | 'recipients' | 'activity'>(
    initialTab === 'recipients' || initialTab === 'activity' ? initialTab : 'overview',
  )
  const selectTab = (next: 'overview' | 'recipients' | 'activity') => {
    setTab(next)
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('tab', next)
      window.history.replaceState(null, '', url.toString())
    } catch {
      // URLが触れなくてもタブは切り替わる。
    }
  }

  const exportCsv = () => {
    if (!broadcast) return
    const csv = broadcastDetailCsv({
      title: broadcast.title,
      status: broadcast.status,
      sentAt: broadcast.sentAt,
      scheduledAt: broadcast.scheduledAt,
      totalCount: broadcast.totalCount,
      successCount: broadcast.successCount,
      delivered: insight?.delivered ?? null,
      uniqueImpression: insight?.uniqueImpression ?? null,
      uniqueClick: insight?.uniqueClick ?? null,
    }, formatBroadcastDateTime)
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = broadcastCsvFilename(broadcast.title, broadcast.id)
    link.click()
    URL.revokeObjectURL(url)
  }

  useEffect(() => {
    let active = true
    // WEB311：前の配信の承認操作の「処理中」を持ち越さない。
    setApprovalBusy(false)
    setApprovalMessage(null)
    setBroadcast(null)
    setInsight(null)
    setInsightState('loading')
    setLoadState('loading')
    if (!id || accountLoading) {
      return
    }
    if (!selectedAccountId) {
      setLoadState('not-found')
      return
    }
    setAudienceNameState('idle')
    void (async () => {
      try {
        const detail = await api.broadcasts.get(id)
        if (!active) return
        if (!detail.success || !broadcastBelongsToSelectedAccount(detail.data, selectedAccountId)) {
          setLoadState('not-found')
          return
        }

        setBroadcast(detail.data)
        // 今見せている版を覚える。ほかの人の更新は版のずれで見つける。
        shownVersionRef.current = detail.data.version ?? null
        setConflict(false)
        setLoadState('ready')

        // 二者承認の今の状態。取れなくても詳細は出す。
        setApprovalState(null)
        setApprovalMessage(null)
        void api.broadcasts.approval.get(id).then((approvalRes) => {
          if (!active) return
          if (approvalRes.success) {
            setApprovalState(approvalRes.data)
            // 承認する人・頼み直す人の名前を出すため、候補も読む。
            if (selectedAccountId) {
              void api.broadcasts.approval.candidates(selectedAccountId).then((candidatesRes) => {
                if (!active) return
                if (candidatesRes.success) setApprovalCandidates(candidatesRes.data)
              }).catch(() => undefined)
            }
          }
        }).catch(() => undefined)

        // 宛先が絞り込みのときだけ、条件に出すタグ名・シナリオ名を取る。
        // 取れなくても配信の詳細は出し続ける。
        const needsAudienceNames =
          detail.data.targetType !== 'all' && detail.data.targetType !== 'multi-account-dedup'
        if (needsAudienceNames) {
          setAudienceNameState('loading')
          // R23横展開: この配信のアカウントの候補だけで名前を解決する。
          void Promise.allSettled([
            api.tags.list({ accountId: selectedAccountId }),
            api.scenarios.list({ accountId: selectedAccountId }),
          ])
            .then(([tagsRes, scenariosRes]) => {
              if (!active) return
              const tags = tagsRes.status === 'fulfilled' && tagsRes.value.success ? tagsRes.value.data : null
              const scenarios = scenariosRes.status === 'fulfilled' && scenariosRes.value.success ? scenariosRes.value.data : null
              // WEB310：要る側が読めていないのに空の一覧で要約すると、
              // あるタグ・シナリオが「削除済み」と出る。要る側の失敗は失敗として出す。
              if (!audienceNamesUsable(audienceNamesNeeded(detail.data), { tags: Boolean(tags), scenarios: Boolean(scenarios) })) {
                setAudienceNameState('error')
                return
              }
              setAudienceNames({ tags: tags ?? [], scenarios: scenarios ?? [] })
              setAudienceNameState('ready')
            })
        }

        // 詳細画面は送信日が30日より前でも開く。期間集計ではなく、
        // この配信自身の保存済みインサイトを読む。
        try {
          const stats = await api.broadcasts.getInsight(id)
          if (!active) return
          if (stats.success && stats.data) {
            setInsight({
              ...stats.data,
              suppressedByAudienceSize:
                stats.data.uniqueImpression == null
                && (stats.data.delivered ?? 0) > 0
                && (stats.data.delivered ?? 0) < 20,
            })
            setInsightState('ready')
          } else if (stats.success) {
            // 200 で data が null。まだLINEから集計が返っていない。
            setInsightState('ready')
          } else {
            setInsightState('error')
          }
        } catch {
          // 配信本体は読めている。集計だけ落ちたことを、未取得と分けて出す。
          if (active) setInsightState('error')
        }
      } catch (error) {
        if (!active) return
        setLoadState(error instanceof ApiError && error.status === 404 ? 'not-found' : 'error')
      }
    })()
    return () => {
      active = false
    }
  }, [accountLoading, id, reloadToken, selectedAccountId])

  /*
   * 送信中は5秒ごとに配信を取り直し、進み具合と成功件数を更新する。
   * 送信中に開いた人が止まった数字を見続けないようにする。
   * 送り終わった・失敗した・画面を離れたら止める。
   */
  useEffect(() => {
    if (!id || broadcast?.status !== 'sending') return
    let active = true
    const timer = setInterval(() => {
      void (async () => {
        try {
          const detail = await api.broadcasts.get(id)
          if (!active || !detail.success) return
          if (detail.data.status !== 'sending') {
            // 状態が変わったら全体を取り直して集計も更新する。
            setReloadToken((value) => value + 1)
          }
          setBroadcast((prev) => (prev && prev.id === id ? detail.data : prev))
          // 送り途中は自分の進みで版が進む。ほかの人の更新と混ぜない。
          shownVersionRef.current = detail.data.version ?? shownVersionRef.current
        } catch {
          // 失敗は数えず、次の周期で取り直す。
        }
      })()
    }, 5000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [id, broadcast?.status])

  /*
   * ★V8 ：別のタブから戻ってきたら版だけ確かめる。
   * ずれていたら帯を出すだけで、画面は書き換えない。
   * 互換経路では付けない（通信も増やさない）。
   */
  useEffect(() => {
    if (!id || loadState !== 'ready') return
    const recheck = () => {
      if (document.visibilityState !== 'visible') return
      void (async () => {
        try {
          const detail = await api.broadcasts.get(id)
          if (!detail.success) return
          const shown = shownVersionRef.current
          const latest = detail.data.version ?? null
          if (shown !== null && latest !== null && latest !== shown) {
            setConflict(true)
          }
        } catch {
          // 取れなくても今の画面は残す。次の機会に確かめる。
        }
      })()
    }
    const onVisible = () => recheck()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', recheck)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', recheck)
    }
  }, [id, loadState])

  if (!id) {
    return (
      <TargetMissing
        kind="unspecified"
        title="見る配信が指定されていません"
        description="一覧から、見たい配信を選び直してください。"
        backHref="/broadcasts"
        backLabel="一斉配信の一覧へ戻る"
      />
    )
  }

  if (loadState === 'error') {
    return (
      <TargetMissing
        kind="error"
        title="配信を読み込めませんでした"
        description="通信が切れたか、サーバが応えませんでした。しばらくしてから、もう一度読み込んでください。"
        onRetry={() => setReloadToken((value) => value + 1)}
      />
    )
  }

  if (loadState === 'not-found' || (loadState === 'ready' && !broadcast)) {
    if (!selectedAccountId) {
      // アカウント未選択は対象の有無とは別の状態。他の画面と同じく ListState で出す。
      return (
        <ListState
          kind="empty"
          title="LINE公式アカウントを選んでください"
          description="選ぶと配信を確認できます。"
          action={<Button href="/broadcasts">一斉配信の一覧へ戻る</Button>}
        />
      )
    }
    return (
      <TargetMissing
        kind="not-found"
        title="この配信は見つかりません"
        description="このLINEアカウントで確認できる配信は見つかりませんでした。削除されたか、一覧から選び直してください。"
        accountName={selectedAccount?.name}
        backHref="/broadcasts"
        backLabel="一斉配信の一覧へ戻る"
      />
    )
  }

  const total = broadcast?.totalCount ?? 0
  const success = broadcast?.successCount ?? 0
  const failed = Math.max(0, total - success)
  const pct = (n: number, base: number) =>
    base > 0 ? `${Math.round((n / base) * 1000) / 10}%` : '—'

  // BROADCAST-15: 宛先の条件は一覧・配信詳細パネルと同じ audienceSummary。
  // 名前を読み込む間は「確認中」、読めないときは失敗と分かる言い方にする。
  const tagNameById = (tagId: string) => audienceNames.tags.find((t) => t.id === tagId)?.name ?? null
  const scenarioNameById = (scenarioId: string) =>
    audienceNames.scenarios.find((s) => s.id === scenarioId)?.name ?? null
  const audienceLabel = !broadcast
    ? ''
    : broadcast.targetType === 'all' || broadcast.targetType === 'multi-account-dedup'
      ? audienceSummary(broadcast, tagNameById)
      : audienceNameState === 'ready'
        ? audienceSummary(broadcast, tagNameById, scenarioNameById)
        : audienceNameState === 'error'
          ? '宛先の条件を確認できませんでした'
          : '宛先の条件を確認しています…'

  /*
   * 二者承認の操作（設計 A-2・A-3）。終わったら状態を読み直す。
   * 承認して送るは、承認のあと送る操作まで続ける。
   */
  /*
   * WEB311：承認の操作・読み直しの応答は、押したときの配信（とアカウント）に
   * 結びつける。途中で別の配信へ移ったら、前の配信の応答で今の承認の帯・
   * 文・押せる状態を書き換えない。要求そのものは押した配信の ID へ送る。
   */
  approvalTargetRef.current = `${selectedAccountId ?? ''}|${id}`
  const approvalTargetKey = () => approvalTargetRef.current
  const reloadApproval = async (target = approvalTargetKey()) => {
    if (!id) return
    try {
      const res = await api.broadcasts.approval.get(id)
      if (approvalTargetRef.current !== target) return
      if (res.success) setApprovalState(res.data)
    } catch {
      // 読み直しの失敗は黙って次へ。帯の文は古いまま残る。
    }
  }
  const runApprovalAction = async (
    action: () => Promise<{ success: boolean; error?: string }>,
  ) => {
    if (approvalBusy) return
    const target = approvalTargetKey()
    const moved = () => approvalTargetRef.current !== target
    setApprovalBusy(true)
    setApprovalMessage(null)
    try {
      const res = await action()
      if (moved()) return
      if (!res.success) {
        setApprovalMessage(res.error ?? '操作できませんでした。時間をおいて、もう一度お試しください。')
        return
      }
      await reloadApproval(target)
    } catch {
      if (moved()) return
      setApprovalMessage('操作できませんでした。状態を読み直してから、もう一度お試しください。')
    } finally {
      if (!moved()) setApprovalBusy(false)
    }
  }
  const handleApprovalCancel = () => void runApprovalAction(() => api.broadcasts.approval.cancel(id))
  const handleApprovalRemind = () => void runApprovalAction(() => api.broadcasts.approval.remind(id))
  const handleApprovalReject = (reason: string) =>
    void runApprovalAction(() => api.broadcasts.approval.reject(id, reason))
  const handleApprovalApprove = (stepUpToken?: string) =>
    void (async () => {
      if (approvalBusy) return
      const target = approvalTargetKey()
      const moved = () => approvalTargetRef.current !== target
      setApprovalBusy(true)
      setApprovalMessage(null)
      try {
        const approved = await api.broadcasts.approval.approve(id, broadcast?.version ?? 1, stepUpToken)
        if (moved()) return
        if (!approved.success) {
          setApprovalMessage(approved.error)
          return
        }
        // 予約なし（今すぐ送る分）は、承認のあと既存の送信の流れへ渡す。
        if (approved.data?.needsSend) {
          if (broadcast?.correctionOfBroadcastId && !approvalState) {
            setApprovalMessage('承認しました。送る人数を確認してから、もう一度送信してください。')
            await reloadApproval(target)
            return
          }
          const sent = await api.broadcasts.send(id, broadcast?.correctionOfBroadcastId && approvalState
            ? { expectedVersion: broadcast.version, confirmedRecipientCount: approvalState.gate.recipientCount }
            : undefined)
          if (moved()) return
          if (!sent.success) {
            setApprovalMessage(`承認しましたが、送信できませんでした。${sent.error}`)
            await reloadApproval(target)
            return
          }
          setReloadToken((value) => value + 1)
          return
        }
        await reloadApproval(target)
      } catch (caught) {
        if (moved()) return
        // 一斉配信の承認は大事な操作。本人確認を求められたら窓を立てる（V-1）。
        if (!stepUpToken && isStepUpRequired(caught)) {
          setApprovalStepUp({ purpose: 'broadcast.approval', action: '一斉配信を承認する', retry: (token) => Promise.resolve(handleApprovalApprove(token)) })
          return
        }
        setApprovalMessage('操作できませんでした。状態を読み直してから、もう一度お試しください。')
      } finally {
        if (!moved()) setApprovalBusy(false)
      }
    })()
  const handleApprovalRequest = () =>
    void (async () => {
      if (approvalBusy) return
      if (!reApproverId) {
        setApprovalMessage('承認をお願いする人を選んでください')
        return
      }
      const target = approvalTargetKey()
      const moved = () => approvalTargetRef.current !== target
      setApprovalBusy(true)
      setApprovalMessage(null)
      try {
        const requested = await api.broadcasts.approval.request(id, {
          approverStaffId: reApproverId,
          note: reApprovalNote.trim() || undefined,
        })
        if (moved()) return
        if (!requested.success) {
          setApprovalMessage(requested.error)
          return
        }
        setReApproverId('')
        setReApprovalNote('')
        await reloadApproval(target)
      } catch {
        if (moved()) return
        setApprovalMessage('依頼できませんでした。状態を読み直してから、もう一度お試しください。')
      } finally {
        if (!moved()) setApprovalBusy(false)
      }
    })()
  const approvalRequesterName = approvalState?.approval.requestedByStaffId
    ? (approvalCandidates.find((item) => item.id === approvalState.approval.requestedByStaffId)?.name ?? null)
    : null
  const approvalApproverName = approvalState?.approval.approverStaffId
    ? (approvalCandidates.find((item) => item.id === approvalState.approval.approverStaffId)?.name ?? null)
    : null
  const approvalMessageSummary = broadcast?.messageBubbles && broadcast.messageBubbles.length > 0
    ? `${formatNumber(broadcast.messageBubbles.length)}通`
    : null
  // 差し戻し・期限切れ・取り消しのあと、頼み直せる条件。
  const canReRequest = broadcast
    && approvalState
    && approvalState.gate.required
    && !approvalState.gate.singleOperator
    && (broadcast.status === 'draft' || broadcast.status === 'scheduled')
    && ['none', 'rejected', 'cancelled', 'expired'].includes(approvalState.approval.status)

  return (
    <div className="flex flex-col gap-4">
      {/* カード同士の縦の間隔はこの親の gap-4（16px）だけで作る。子ごとの mb/mt は付けない。 */}
      {/* ★V8 のパンくずは上の帯に出る（crumbs）。v7 だけ本文の戻り口を残す。 */}

      {/*
        ★V7 `x63W5x`：読み込み中は一覧の場所に ListState loading を1つ。
        素の「読み込み中...」は出さない。
      */}
      {loadState === 'loading' || !broadcast ? (
        <ListState kind="loading" title="配信を読み込んでいます" />
      ) : (
        <BroadcastDetailV8
          broadcast={broadcast}
          insight={insight}
          insightState={insightState}
          audienceLabel={audienceLabel}
          accountName={selectedAccount?.name ?? 'LINE公式アカウント'}
          tab={tab}
          onSelectTab={selectTab}
          recipients={<BroadcastRecipients broadcastId={broadcast.id} total={broadcast.totalCount} version={broadcast.version ?? 1} />}
          activity={<BroadcastActivity broadcastId={broadcast.id} formatDateTime={formatBroadcastDateTime} />}
          onExportCsv={exportCsv}
          onReload={() => setReloadToken((value) => value + 1)}
          conflict={conflict}
          onConflictReload={() => {
            setConflict(false)
            setReloadToken((value) => value + 1)
          }}
          canEdit={canEdit}
          contentRef={contentRef}
          approval={{
            state: approvalState,
            busy: approvalBusy,
            message: approvalMessage,
            requesterName: approvalRequesterName,
            approverName: approvalApproverName,
            candidates: approvalCandidates,
            messageSummary: approvalMessageSummary,
            canReRequest: Boolean(canReRequest),
            reApproverId,
            reApprovalNote,
            onApproverChange: setReApproverId,
            onNoteChange: setReApprovalNote,
            onRequest: handleApprovalRequest,
            onCancel: handleApprovalCancel,
            onRemind: handleApprovalRemind,
            onReject: handleApprovalReject,
            onApprove: () => void handleApprovalApprove(),
          }}
        />
      )}
      {/*
        書き出しはタブの中（#816 C）。下の追従バーは出さない。
        向こうの版にあった下のバーの書き出しは、概要タブの中の
        1つ（onExportCsv）に引っ越したので、ここでは出さない。
      */}
      {approvalStepUp && <StepUpPrompt request={approvalStepUp} onDone={() => setApprovalStepUp(null)} onClose={() => setApprovalStepUp(null)} />}
    </div>
  )
}

export default function BroadcastDetailPage() {
  // useSearchParams は Suspense の中でしか使えない（静的書き出しのため）。
  return (
    <Suspense fallback={<div className="text-ink-faint p-6 text-sm">読み込み中…</div>}>
      <BroadcastDetailInner />
    </Suspense>
  )
}
