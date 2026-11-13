'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { api, downloadApiFile, type CommonVarExportJob } from '@/lib/api'
import { isStepUpRequired, useStepUpGate } from '@/components/step-up-prompt'
import { describeApiFailure } from '@/components/shared/api-error-message'
import Button from '@/components/shared/button'
import Disclosure from '@/components/shared/disclosure'
import Notice from '@/components/shared/notice'
import StatusBadge from '@/components/shared/status-badge'
import { formatJstDateTime } from '@/lib/presentation'
import { onlyWhenVisible } from '@/lib/visible-polling'
import { formatNumber } from '@/lib/format'
import { Download } from 'lucide-react'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'

/*
 * ★V8 共通情報の「CSVで書き出す」。
 * 書き出し操作と状況を分け、操作は見出し、通知と履歴は一覧の案内口へ渡す。
 *
 * 共通情報の監査付きCSV出力（N-192）。
 *
 * 以前は画面に読み込めた最大200件を端末でCSV化していた。ここでは
 * サーバの台帳へ依頼を残し、全件をページングして書き出した成果物を
 * 期限つきでダウンロードする。状態は読込中・書き出し中・完了・失敗・
 * 期限切れの5つを言い分ける。
 */

/** 完了・失敗・期限切れに届くまで状態を聞き直す間隔。 */
const POLL_INTERVAL_MS = 1_200
/** 「最近の書き出し」に出す件数。 */
const RECENT_LIMIT = 5


function statusTone(status: CommonVarExportJob['status']) {
  switch (status) {
    case 'completed': return 'success' as const
    case 'failed': return 'danger' as const
    case 'expired': return 'warning' as const
    default: return 'info' as const
  }
}

function statusLabel(status: CommonVarExportJob['status']) {
  switch (status) {
    case 'queued': return '待機中'
    case 'running': return '書き出し中'
    case 'completed': return '完了'
    case 'failed': return '失敗'
    case 'expired': return '期限切れ'
  }
}

export function useVarsExportPanel({ accountId, folderId, ungrouped = false }: {
  accountId: string | null
  /** 絞り込み中のフォルダ。null は「すべて」。 */
  folderId: string | null
  /** 「未分類」だけを対象にする絞り込み。 */
  ungrouped?: boolean
}) {
  const saveErrors = useSaveFormErrors()
  const stepUp = useStepUpGate({ showActionInTitle: true, fullWidthPassword: true })
  const operationRef = useRef<symbol | null>(null)
  const operationContext = useRef(0)
  useEffect(() => {
    operationContext.current += 1
    operationRef.current = null
    setRequesting(false)
    stepUp.cancel()
    return () => {
      operationContext.current += 1
      operationRef.current = null
      stepUp.cancel()
    }
  }, [accountId, folderId, ungrouped, stepUp.cancel])

  const [jobs, setJobs] = useState<CommonVarExportJob[]>([])
  const [active, setActive] = useState<CommonVarExportJob | null>(null)
  const [dismissedJobId, setDismissedJobId] = useState<string | null>(null)
  const [requesting, setRequesting] = useState(false)
  const [error, setError] = useState('')
  /** 遅れて返った別アカウントの結果を映さないための世代番号。 */
  const generationRef = useRef(0)

  const refresh = useCallback(async (targetAccountId: string, generation: number) => {
    try {
      const res = await api.commonVars.listExports(targetAccountId)
      if (generationRef.current !== generation) return
      if (res.success) setJobs(res.data)
    } catch (saveFailure) {
      if (generationRef.current === generation) saveErrors.capture(saveFailure)

      /* 履歴が読めなくても書き出し自体は止めない */
    }
  }, [saveErrors])

  // アカウントが変わったら履歴を読み直し、進行中の表示をリセットする。
  useEffect(() => {
    const generation = generationRef.current + 1
    generationRef.current = generation
    setJobs([])
    setActive(null)
    setRequesting(false)
    setError('')
    if (!accountId) return
    void (async () => {
      try {
        const res = await api.commonVars.listExports(accountId)
        if (generationRef.current !== generation) return
        if (res.success) {
          setJobs(res.data)
          const latest = res.data[0]
          if (latest) setActive(latest)
        }
      } catch (saveFailure) {
        if (generationRef.current === generation) saveErrors.capture(saveFailure)

        /* 表示は一覧の下に出る補助。読めないときは何も出さない */
      }
    })()
  }, [accountId, saveErrors])

  // queued/running の間は状態を聞き直す。
  useEffect(() => {
    if (!active || (active.status !== 'queued' && active.status !== 'running')) return
    const generation = generationRef.current
    // 隠れたタブでは聞き直さない（V6R-S3-g）。
    const timer = window.setInterval(onlyWhenVisible(async () => {
      try {
        const res = await api.commonVars.exportDetail(active.id)
        if (generationRef.current !== generation) return
        if (res.success) {
          setActive(current => current?.id === active.id ? res.data : current)
          if (res.data.status !== 'queued' && res.data.status !== 'running' && accountId) {
            void refresh(accountId, generation)
          }
        }
      } catch (saveFailure) {
        if (generationRef.current === generation) saveErrors.capture(saveFailure)

        /* 一時的な通信障害では監視を止めない */
      }
    }), POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [active, accountId, refresh, saveErrors])

  const run = async (operation: (token?: string) => Promise<CommonVarExportJob | void>, action: string) => {
    if (!accountId || operationRef.current) return
    const id = Symbol()
    const context = operationContext.current
    const generation = generationRef.current
    const current = () => operationRef.current === id && operationContext.current === context
      && generationRef.current === generation
    operationRef.current = id
    setRequesting(true)
    setError('')
    saveErrors.reset()
    try {
      let result: CommonVarExportJob | void
      try {
        result = await operation()
      } catch (caught) {
        if (!current()) return
        if (!isStepUpRequired(caught)) throw caught
        const token = await stepUp.gate('data.export', action)
        if (!token || !current()) return
        result = await operation(token)
      }
      if (!current()) return
      if (result) {
        setActive(result)
        setDismissedJobId(null)
        void refresh(accountId, generation)
      }
    } catch (caught) {
      if (!current()) return
      const fieldFailure = saveErrors.capture(caught)
      if (!fieldFailure) setError(describeApiFailure(caught, '書き出し'))
      // 応答が分からない作成は再送せず、履歴だけを読み直す。
      void refresh(accountId, generation)
    } finally {
      if (current()) {
        operationRef.current = null
        setRequesting(false)
      }
    }
  }
  const start = () => {
    if (active?.status === 'queued' || active?.status === 'running') return
    const input = { accountId: accountId!, folderId: folderId ?? undefined, ungrouped: ungrouped || undefined }
    return run(async token => {
      const result = await (token ? api.commonVars.createExport(input, token) : api.commonVars.createExport(input))
      if (!result.success) throw new Error(result.error)
      return result.data
    }, '共通情報を書き出す')
  }
  const regenerate = (job: CommonVarExportJob) => {
    if (job.lineAccountId !== accountId || active?.status === 'queued' || active?.status === 'running') return
    return run(async token => {
      const result = await (token ? api.commonVars.regenerateExport(job.id, token) : api.commonVars.regenerateExport(job.id))
      if (!result.success) throw new Error(result.error)
      return result.data
    }, '共通情報をもう一度書き出す')
  }
  const download = (job: CommonVarExportJob) => {
    if (!job.downloadUrl || job.lineAccountId !== accountId) return
    const path = job.downloadUrl
    return run(async token => {
      await downloadApiFile(path, `common-vars-${job.id}.csv`, token ? { stepUpToken: token } : undefined)
    }, '共通情報のCSVをダウンロードする')
  }

  const running = active?.status === 'queued' || active?.status === 'running'

  const action = (
    <Button
      type="button"
      variant="secondary"
      widthReserve="idle"
      onClick={() => void start()}
      disabled={!accountId || requesting || running} busy={requesting && !active} busyLabel="書き出しを依頼しています…"><Download size={16} aria-hidden="true" />CSVで書き出す
    </Button>
  )
  const status = error || (active && active.id !== dismissedJobId) || jobs.length > 1 ? (
    <SaveErrorScope errors={saveErrors}>
      {error ? <Notice tone="danger" message={error} onClose={() => setError('')} /> : null}
      {!error && active && active.id !== dismissedJobId ? (
        <Notice
          tone={active.status === 'expired' ? 'warn' : active.status === 'failed' ? 'danger' : active.status === 'completed' ? 'success' : 'info'}
          role="status"
          data-testid="vars-export-status"
          onClose={() => setDismissedJobId(active.id)}
          action={<>
            {active.status === 'completed' && active.downloadUrl ? (
              <Button type="button" variant="text" disabled={requesting} onClick={() => void download(active)}>CSVをダウンロード</Button>
            ) : null}
            {active.status === 'completed' || active.status === 'failed' || active.status === 'expired' ? (
              <Button type="button" variant="text" disabled={requesting} onClick={() => void regenerate(active)}>もう一度書き出す</Button>
            ) : null}
          </>}
        >
          {active.status !== 'expired' ? <>{statusLabel(active.status)}{'：'}</> : null}
          {running ? <>{formatNumber(active.processedCount)} / {active.totalCount == null ? '…' : formatNumber(active.totalCount)}件</> : null}
          {active.status === 'completed' ? <>{formatNumber(active.rowCount ?? 0)} 件（{formatJstDateTime(active.expiresAt)}まで）</> : null}
          {active.status === 'failed' ? active.failureReason ?? '書き出せませんでした' : null}
          {active.status === 'expired' ? 'ダウンロード期限が切れました' : null}
        </Notice>
      ) : null}
      {jobs.length > 1 ? (
        <Disclosure className="w-full text-xs" appearance="inset" size="compact" title={`最近の書き出し（${formatNumber(jobs.length)} 件）`}>
          <ul className="border-hairline divide-hairline mt-1 divide-y rounded-control border">
            {jobs.slice(0, RECENT_LIMIT).map((job) => (
              <li key={job.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span>
                  {formatJstDateTime(job.createdAt)}・{job.createdByName}
                  {job.rowCount != null ? `・${formatNumber(job.rowCount)} 件` : ''}
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge tone={statusTone(job.status)} size="compact">
                    {statusLabel(job.status)}
                  </StatusBadge>
                  {job.status === 'completed' && job.downloadUrl ? (
                    <Button type="button" variant="text" disabled={requesting} onClick={() => void download(job)}>ダウンロード</Button>
                  ) : null}
                  {job.status === 'expired' ? (
                    <Button type="button" variant="text" disabled={requesting || running} onClick={() => void regenerate(job)}>再生成</Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </SaveErrorScope>
  ) : null
  return { action, status: stepUp.prompt ? <>{stepUp.prompt}{status}</> : status }
}
