'use client'

import { useListUrlValue } from '@/components/shared/list-url-state'
import { useMemo, useState } from 'react'
import { Download, RotateCw } from 'lucide-react'
import { api, type AdConversionLog } from '@/lib/api'
import { useStaffRole } from '@/lib/staff-role'
import { formatNumber } from '@/lib/format'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import Button from '@/components/shared/button'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import { INFLOW_TABLE_LAYOUT } from './table-layout'
import ListState from '@/components/shared/list-state'
import Pagination from '@/components/shared/pagination'
import ListToolbar from '@/components/shared/list-toolbar'
import Select from '@/components/shared/select'
import EntitySelect from '@/components/shared/entity-select'
import StatusBadge from '@/components/shared/status-badge'
import { notifyToast } from '@/components/shared/toast'
import { AD_LOG_PAGE_SIZE, adDateTime, adLogStatus, adPlatformLabel, useAdLogs } from './ad-shared'
import adsStyles from './ads.module.css'
import styles from './ad-pages.module.css'
import { DetailPage } from '@/components/templates'
import { csvFileName } from '@/lib/csv-file-name'
import { emptyValue, EmptyCell } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'

/*
 * ★V8 広告への送信履歴（Pencil ・`/inflow-links?tab=connections&view=history`）。
 *
 * 2026-10-07 src/v8 に一から書いた（今の V8 は 18%）。頭は広告連携と同じ形。
 * 本文（間14）：道具の段（探す・状態・媒体・件数）→ 表（いつ・何の成果／媒体／流入元／状態／次の予定／操作）→ 注。
 * 呼ぶ口：媒体の一覧・送信記録のページ（今と同じ）、断られた1件のやり直し `POST /api/ad-platforms/logs/:id/retry`（F-22・owner）。
 * BEHAVIOR.md の「広告への送信履歴」。
 */

const STATUS_OPTIONS = [
  { value: 'all', label: 'すべての状態' },
  { value: 'sent', label: '送れたもの' },
  { value: 'pending', label: '待っているもの' },
  { value: 'failed', label: '断られたもの' },
]

/** 書き出し（今の画面と同じ列。個人を特定する値・クリックの目印は書き出さない）。 */
export function adLogsCsv(logs: AdConversionLog[]): string {
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
  const rows = logs.map((log) => [
    log.createdAt,
    log.eventName,
    log.clickIdType ?? '経路不明',
    adLogStatus(log.status).label,
  ].map((value) => quote(value)).join(','))
  return ['"日時","成果","クリックの種類","状態"', ...rows].join('\n')
}

export default function AdHistoryV8() {
  usePageTitle('広告への送信履歴')
  usePageCrumbs([
    { label: 'ホーム', href: '/' },
    { label: '流入と計測', href: '/inflow-links' },
    { label: '広告とのつなぎ', href: '/inflow-links?tab=connections' },
  ])
  const role = useStaffRole()
  /* やり直し（POST …/retry）は owner だけ。ほかの人には押せない「やり直す」を置かない。 */
  const canRetry = role === 'owner'
  const [page, setPage] = useListUrlValue('page', 1)
  const [status, setStatus] = useState('all')
  const [query, setQuery] = useListUrlValue('q', '')
  const [media, setMedia] = useState('all')
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [retryError, setRetryError] = useState('')
  const model = useAdLogs({ page, status, query })

  const mediaOptions = useMemo(() => [
    { value: 'all', label: 'すべて' },
    ...model.platforms.map((platform) => ({ value: platform.id, label: adPlatformLabel(platform) })),
  ], [model.platforms])
  /* 媒体は口に絞り込みが無いので、読めたページの中で絞る。 */
  const visible = media === 'all' ? model.logs : model.logs.filter((log) => log.adPlatformId === media)
  const pageCount = Math.max(1, Math.ceil(model.total / AD_LOG_PAGE_SIZE))
  const firstFailed = visible.find((log) => log.status === 'failed' && log.errorMessage)

  const exportLogs = () => {
    const blob = new Blob([`﻿${adLogsCsv(visible)}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = csvFileName("広告への送信履歴")
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const retry = async (log: AdConversionLog) => {
    if (retryingId) return
    setRetryingId(log.id)
    setRetryError('')
    try {
      const res = await api.adPlatforms.retryLog(log.id)
      if (!res.success) {
        setRetryError(res.error ?? '広告への送信をやり直せませんでした')
      } else {
        if (res.data.status === 'failed') setRetryError('やり直しましたが、また断られました。広告側の接続設定を確かめてください。')
        else notifyToast(res.data.status === 'pending' ? 'やり直しを送信待ちに入れました' : '広告へ送り直しました', { tone: 'success' })
      }
      await model.reload()
    } catch {
      setRetryError('広告への送信をやり直せませんでした。通信状態を確かめて、もう一度お試しください。')
    } finally {
      setRetryingId(null)
    }
  }

  if (!model.selectedAccountId) {
    return <ListState kind="empty" title="LINEアカウントを選択してください" description="選んだLINEアカウントの送信履歴だけを表示します。" />
  }

  let body
  if (model.loading && model.logs.length === 0) {
    body = <ListState kind="loading" title="広告への送信履歴を読み込んでいます" />
  } else if (model.failed) {
    body = (
      <ListState
        kind="error"
        title="広告への送信履歴を表示できませんでした"
        description="送信の記録は消えていません。読み直して、もう一度お試しください。"
        onRetry={() => void model.reload()}
      />
    )
  } else if (visible.length === 0) {
    body = <ListState kind="empty" title="条件に合う送信履歴はありません" description="成果と広告のクリックが結びつき、送信処理が始まるとここに並びます。" />
  } else {
    body = (
      <DataTable aria-label="広告への送信履歴" columnLayout={INFLOW_TABLE_LAYOUT}><thead>
        <TableHeadRow data-table-layout="columns">
          <Th className={styles.colWhen} grow>いつ・何の成果</Th>
          <Th className={styles.colMedia}>媒体</Th>
          <Th className={styles.colSource} collapseAt="narrow">流入元</Th>
          <Th className={styles.colStatus}>状態</Th>
          <Th className={styles.colNext} collapseAt="narrow">次の予定</Th>
          <Th className={styles.colOps} showActionLabel>操作</Th>
        </TableHeadRow></thead><tbody>
        {visible.map((log) => {
          const state = adLogStatus(log.status)
          const platform = model.platforms.find((item) => item.id === log.adPlatformId)
          return (
            <Tr key={log.id} data-row-id={log.id} data-table-layout="columns">
              <Td className={styles.colWhen} grow>
                <span className={styles.whenMain} title={log.eventName}>{log.eventName}</span>
                <span className={styles.whenSub}>{adDateTime(log.createdAt)}</span>
              </Td>
              <Td className={styles.colMedia}><span className={styles.cellText}>{adPlatformLabel(platform)}</span></Td>
              {/* 流入元は送信記録の口が返さないので「—」。 */}
              <Td className={styles.colSource} collapseAt="narrow"><EmptyCell /></Td>
              <Td className={styles.colStatus}>
                <StatusBadge tone={state.tone} size="compact" title={log.status === 'failed' && log.errorMessage ? `断られた理由：${log.errorMessage}` : undefined}>{state.label}</StatusBadge>
              </Td>
              <Td className={styles.colNext} collapseAt="narrow">
                <span className={styles.cellFaint}>{log.status === 'pending' ? '送信待ち' : emptyValue('unknown')}</span>
              </Td>
              <Td className={styles.colOps}>
                {log.status === 'failed' && canRetry ? (
                  <Button onClick={() => void retry(log)} busy={retryingId === log.id} busyLabel="やり直しています…" disabled={retryingId !== null}>
                    <RotateCw size={16} aria-hidden="true" />やり直す
                  </Button>
                ) : <EmptyCell />}
              </Td>
            </Tr>
          )
        })}
      </tbody></DataTable>
    )
  }

  return (
    <DetailPage boardId="p0kA3" contentPadding="0 var(--tpl-head-pad-side)" title={<>広告への送信履歴</>}
        help={<>成果と広告のクリックが結びつき、送信処理が始まるとここに並びます。</>}
        actions={<><Button onClick={exportLogs} disabled={model.loading || model.failed || visible.length === 0} disabledReason={model.loading ? '送信履歴を読み込んでいます。' : model.failed ? '送信履歴を読み直してください。' : visible.length === 0 ? '書き出す送信履歴がありません。' : undefined}><Download size={16} aria-hidden="true" />CSVで書き出す</Button></>}>
      <div className={adsStyles.body}>
        <ListToolbar
          search={{ value: query, onChange: (value) => { setQuery(value); setPage(1) }, placeholder: '成果・クリックの種類で探す' }}
          filters={<>
            <SaveErrorField names={["status"]}><Select aria-label="送信状態" label="送信状態" value={status} onChange={(value) => { setStatus(value); setPage(1) }} options={STATUS_OPTIONS} width={160} /></SaveErrorField>
            <SaveErrorField names={["media"]}><EntitySelect aria-label="媒体" noun="媒体" valuePrefix="媒体：" value={media} onChange={setMedia} options={mediaOptions} width={160} /></SaveErrorField>
            <span className={styles.toolsCount}>{`${formatNumber(model.total)} 件中 ${formatNumber(visible.length)} 件`}</span>
          </>}
        />
        {retryError ? <Notice tone="danger" className={adsStyles.errorNoticePlacement} >{retryError}</Notice> : null}
        {body}
        {pageCount > 1 ? (
          <div className={styles.pager}>
            <span className={styles.toolsCount}>{`全 ${formatNumber(model.total)} 件`}</span>
            <Pagination page={Math.min(page, pageCount)} pageCount={pageCount} onPageChange={setPage} ariaLabel="送信履歴のページ送り" />
          </div>
        ) : null}
        <p className={adsStyles.notice}>
          {firstFailed
            ? `断られた理由：${firstFailed.errorMessage}。やり直しても同じ目印を使うため、2重には数えられません。`
            : 'やり直しても同じ目印を使うため、2重には数えられません。'}
        </p>
      </div>
    </DetailPage>
  )
}
