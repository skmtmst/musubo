'use client'

import { jstDate } from '@/lib/jst-datetime';
import { Inbox, Download, RotateCw } from 'lucide-react';

import { formatNumber } from '@/lib/format';
import { usePageTitle } from '@/components/shell/page-chrome';
import { useNarrowViewport } from '@/lib/use-narrow-viewport';
import { PageFrame, PageHeading } from '@/components/templates/page-frame';
import { PageExplanationProvider, PageExplanationToggle, PageExplanationBody } from '@/components/shared/page-explanation';
import Button from '@/components/shared/button'
import KpiCard from '@/components/shared/kpi-card'
import KpiBand from '@/components/shared/kpi-band'
import ListState from '@/components/shared/list-state'
import Pagination from '@/components/shared/pagination'
import SegmentedControl from '@/components/shared/segmented'
import StatusBadge from '@/components/shared/status-badge'
import SearchField from '@/components/shared/search-field'
import { ActionCell, DataTable, TableHeadRow, Th, Tr, Td, RowNameLink } from '@/components/shared/table';
import { loadFailureCopy, isForbidden } from '@/components/shared/api-error-message';
import { FriendsTabs } from '../shared/head';
import { FRIENDS_TAB_NOTES } from '../shared/nav';
import { csvExportLine } from '../list/csv-export';
import { CANDIDATE_PAGE_SIZE, useDuplicatesData } from './use-duplicates-data';
import { candidateStatusWord, confidenceWord, STATUS_FILTERS, confidenceTone, slashDateTime, statusTone } from './words';
import styles from './list.module.css'
import { csvFileName } from '@/lib/csv-file-name';
import { emptyValue, EmptyCell } from '@/components/shared/empty-value';
import Card from '@/components/shared/card'

/*
 * ★V8 重複検出（Pencil 、1152 は 、状態の見本帳は ）。/friends?tab=duplicates。
 *
 * データの口は今と同じ（/api/duplicates/stats・/api/identity-candidates・再検出）。
 * 見せ方：頭（← 友だちへ・タブ・表示中をCSVで書き出す）→ 案内の帯 → 数4つ →
 * 探す・状態の札・見直した時刻・もう一度見直す → 重複の候補（比べて決める）→ アカウントごとの重なり。
 */

function validNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

export default function DuplicatesListV8() {
  usePageTitle('友だち')
  const d = useDuplicatesData()
  /* 1152 の板は探す欄が狭いので、案内の文を短くする（メールでも探せるのは同じ）。 */
  const narrow = useNarrowViewport()

  const pageCount = validNonNegInt(d.candidateTotal) && d.candidateTotal > 0
    ? Math.max(1, Math.ceil(d.candidateTotal / CANDIDATE_PAGE_SIZE))
    : 1
  const filtering = !d.unfilteredCandidates
  const counts = d.statusCounts
  const deliveryCount = !isForbidden(d.statsFailure) && validNonNegInt(d.data?.overlappingDeliveryCount)
    ? d.data.overlappingDeliveryCount
    : null

  const exportVisible = () => {
    const header = ['候補A', '候補B', '確からしさ', '一致した根拠', 'アカウント', '状態', '最終更新']
    const rows = d.candidates.map((candidate) => [
      candidate.left.label,
      candidate.right.label,
      confidenceWord(candidate.confidence.label),
      candidate.evidenceSummary.join('・'),
      [candidate.left.lineAccountName, candidate.right.lineAccountName].filter(Boolean).join(' ／ '),
      candidateStatusWord(candidate.status),
      slashDateTime(candidate.reviewedAt ?? candidate.detectedAt),
    ])
    const csv = [header, ...rows].map((row) => csvExportLine(row)).join('\n')
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = csvFileName("重複した友だち")
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const kpis = [
    {
      key: 'candidates', title: '重複の候補',
      valueText: counts !== null ? `${formatNumber(Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0))}` : d.duplicateTotalText.replace(/組$/, ''),
      unit: '組',
      detail: counts !== null ? `未確認 ${formatNumber(counts.pending ?? 0)}` : d.duplicateDetail,
      help: counts !== null ? `保留 ${formatNumber(counts.deferred ?? 0)}・別人 ${formatNumber(counts.different ?? 0)} を含みます。` : undefined,
    },
    {
      key: 'linked', title: '結び付けた',
      valueText: counts !== null ? formatNumber(counts.linked ?? 0) : emptyValue('unknown'),
      unit: '組',
      detail: counts !== null ? 'これまで' : '読み込めませんでした',
      help: '統合ユーザーに結び付けた組の数です。',
    },
    {
      key: 'deliveries', title: '重なって届いた配信',
      valueText: deliveryCount !== null ? formatNumber(deliveryCount) : emptyValue('unknown'),
      unit: '通',
      detail: isForbidden(d.statsFailure) ? '集計を見る権限がありません' : deliveryCount !== null ? d.statsFailure ? '前回取得した配信実績' : '配信実績から集計' : d.loading ? '読み込んでいます' : '配信実績は未取得です',
      help: '同じ配信が統合ユーザーの複数の友だちに届いたとき、1人分を除いた余分な通数です。配信の回数や人数ではありません。',
    },
    {
      key: 'weak', title: '根拠が足りない',
      valueText: d.lowConfidenceCount !== null ? formatNumber(d.lowConfidenceCount) : emptyValue('unknown'),
      unit: '組',
      detail: d.lowConfidenceCount !== null ? '名前だけ一致' : '読み込めませんでした',
      help: '名前やプロフィール画像だけが一致していて、決め手が無い組です。',
    },
  ]

  const statsCopy = d.statsFailure ? loadFailureCopy(d.statsFailure, '集計') : null

  return (
    <PageExplanationProvider pageKey="friends:duplicates"><PageFrame kind="list" boardId="hn6Y8">
      <PageHeading
        title="友だち"
        help="同じ人が別のアカウント・別の友だちとして登録されていないかを見ます"
        explanationToggle={<PageExplanationToggle />}
        tabs={<FriendsTabs current="duplicates" line={false} action={(
          <Button type="button" variant="secondary" onClick={exportVisible} disabled={d.candidates.length === 0}>
            <Download size={16} aria-hidden="true" />
            表示中をCSVで書き出す
          </Button>
        )} />}
      />
      <div className={styles.body}>
        {/* 決まり2: 結び付け方の説明は帯にせず、題の横の「？」へ入れる。 */}
        <PageExplanationBody inset="notice">{FRIENDS_TAB_NOTES.duplicates}自動では結び付けません。確定済みID・連携UID・メール／電話の一致は強い根拠、名前やプロフィール画像だけの一致は参考です。結び付けても元の友だちと履歴は残ります。</PageExplanationBody>

        <KpiBand gridClassName="grid grid-cols-4">
          {kpis.map((kpi) => (
            <KpiCard
              key={kpi.key}
              presentation="band"
              icon={<Inbox size={16} />}
              title={kpi.title}
              value={null}
              valueText={kpi.valueText}
              unit={kpi.unit}
              /* 絵 ：数のあとに単位（18 組）。 */
              valueTextWithUnit={Boolean(kpi.unit)}
              detail={kpi.detail}
              help={kpi.help}
            />
          ))}
        </KpiBand>

        {statsCopy && (!d.data || isForbidden(d.statsFailure)) ? (
          <p className={styles.notice} role="status">
            {`${statsCopy.title}。${statsCopy.description}候補一覧は取得済みの内容を表示しています。`}
            {statsCopy.retryable ? <button type="button" className={styles.linkButton} onClick={() => void d.load()}>もう一度</button> : null}
          </p>
        ) : d.error ? (
          <p className={styles.notice} role="status">
            {d.error}
            <button type="button" className={styles.linkButton} onClick={() => void d.load()}>もう一度</button>
          </p>
        ) : null}

        <div className={styles.tools}>
          <div className={styles.search}>
            <SearchField aria-label="名前・メール・電話で探す" value={d.query} onChange={d.setQuery} onClear={() => d.setQuery('')} placeholder={narrow ? '名前・電話で探す' : '名前・メール・電話で探す'} />
          </div>
          <SegmentedControl
            aria-label="状態で絞り込む"
            value={d.status}
            onChange={(next) => d.setStatus(next)}
            options={STATUS_FILTERS.map((filter) => ({ value: filter.value, label: filter.label }))}
          />
          <span className={styles.spacer} />
          {d.data?.computedAt ? <span className={styles.reviewed}>{`${slashDateTime(d.data.computedAt)} に見直した`}</span> : null}
          <Button type="button" variant="secondary" onClick={() => void d.detect()} disabled={d.refreshing} busy={d.refreshing} busyLabel="見直し中…">
            <RotateCw size={16} aria-hidden="true" />
            もう一度見直す
          </Button>
        </div>

        <Card variant="records" padding="roomy" aria-labelledby="dup-candidates-title">
          <h3 id="dup-candidates-title" className={styles.panelTitle}>重複の候補</h3>
          <DataTable className={styles.table}>
            <colgroup>
              <col />
              <col className={styles.colConfidence} />
              <col className={styles.colEvidence} />
              <col className={styles.colAccount} />
              <col className={styles.colStatus} />
              <col className={styles.colAction} />
            </colgroup>
            <thead>
              <TableHeadRow>
                <Th>候補</Th>
                <Th>確からしさ</Th>
                <Th>一致した根拠</Th>
                <Th>アカウント</Th>
                <Th>状態</Th>
                <Th><span className="sr-only">操作</span></Th>
              </TableHeadRow>
            </thead>
            <tbody>
              {d.candidateError ? (
                <tr><td colSpan={6} className={styles.stateCell}>
                  <ListState kind="error" title="重複の候補を読み込めませんでした" description="数の帯は「—」のまま、探す・絞り込みはそのまま使えます。" onRetry={() => void d.loadCandidates()} />
                </td></tr>
              ) : d.candidatesLoading && d.candidates.length === 0 ? (
                <tr><td colSpan={6} className={styles.stateCell}><ListState kind="loading" title="読み込んでいます" /></td></tr>
              ) : d.candidates.length === 0 ? (
                <tr><td colSpan={6} className={styles.stateCell}>
                  {filtering ? (
                    <div className={styles.empty}>
                      <ListState kind="empty" title="条件に合う候補はありません" description="「未確認」「保留」「結び付けた」「別人」や検索を外すと、すべて出ます" />
                      <Button type="button" variant="secondary" onClick={d.clearFilters}>条件を外す</Button>
                    </div>
                  ) : (
                    <div className={styles.empty}>
                      {/* 「もう一度見直す」は右上にあるので、ここには重ねない（2026-10-08 オーナー「下を消す」）。 */}
                      <ListState kind="empty" title="重複の候補はありません" description="同じ人が別の友だちとして登録されていそうなときに、ここに出ます。" />
                    </div>
                  )}
                </td></tr>
              ) : d.candidates.map((candidate) => {
                const href = `/friends/identity-candidates?id=${encodeURIComponent(candidate.id)}`
                const accounts = [candidate.left.lineAccountName, candidate.right.lineAccountName].filter(Boolean).join(' ／ ') || emptyValue('unknown')
                const evidence = candidate.evidenceSummary.length ? candidate.evidenceSummary.join('・') : '根拠を確認'
                return (
                  <Tr key={candidate.id} className={styles.row} data-row-id={candidate.id}>
                    <Td>
                      <RowNameLink href={href} className={styles.pair} title={`${candidate.left.label} ↔ ${candidate.right.label}`}>
                        {`${candidate.left.label} ↔ ${candidate.right.label}`}
                      </RowNameLink>
                    </Td>
                    <Td>
                      <span className={confidenceTone(candidate.confidence.label) === 'ok' ? `${styles.pill} ${styles.pillOk}` : `${styles.pill} ${styles.pillMuted}`}>
                        {confidenceWord(candidate.confidence.label)}
                      </span>
                    </Td>
                    <Td className={styles.td}><span className={styles.cellText} title={evidence}>{evidence}</span></Td>
                    <Td className={styles.td}><span className={styles.cellText} title={accounts}>{accounts}</span></Td>
                    <Td className={styles.td}>
                      <StatusBadge tone={statusTone(candidate.status) === 'ok' ? 'success' : statusTone(candidate.status) === 'warn' ? 'warning' : 'neutral'} title={`最終更新 ${slashDateTime(candidate.reviewedAt ?? candidate.detectedAt)}`}>
                        {candidateStatusWord(candidate.status)}
                      </StatusBadge>
                    </Td>
                    <ActionCell>
                      <Button href={href} variant="secondary">比べて決める</Button>
                    </ActionCell>
                  </Tr>
                )
              })}
            </tbody>
          </DataTable>
          {d.candidateTotal > 0 && !d.candidateError ? (
            <div className={styles.pager}>
              <span className={styles.pagerCount}>{`${formatNumber(d.candidateTotal)}組`}</span>
              <Pagination page={d.page} pageCount={pageCount} onPageChange={d.setPage} disabled={d.candidatesLoading} ariaLabel="重複候補のページ" />
            </div>
          ) : null}
        </Card>

        {d.data ? (
          <Card variant="records" padding="roomy" aria-labelledby="dup-accounts-title">
            <div className={styles.panelHead}>
              <h3 id="dup-accounts-title" className={styles.panelTitle}>アカウントごとの重なり</h3>
              <p className={styles.panelSub}>同じIDの登録を数えたものです。上の確認対象の候補の組数とは別の集計です。</p>
            </div>
            {d.data.perAccount.length === 0 ? (
              <p className={styles.panelSub}>アカウントが登録されていません。</p>
            ) : (
              <DataTable>
                <colgroup>
                  <col />
                  <col className={styles.colNum} />
                  <col className={styles.colNum} />
                  <col className={styles.colNumLast} />
                </colgroup>
                <thead>
                  <TableHeadRow>
                    <Th>アカウント</Th>
                    <Th>友だち</Th>
                    <Th>うち重複</Th>
                    <Th>重複の割合</Th>
                  </TableHeadRow>
                </thead>
                <tbody>
                  {d.data.perAccount.map((row) => {
                    const validRate = typeof row.dupRate === 'number' && Number.isFinite(row.dupRate) && row.dupRate >= 0
                    const rate = validRate ? Math.round(row.dupRate * 100) : null
                    return (
                      <Tr key={row.accountId} className={styles.rowCompact}>
                        <Td><span className={styles.cellText} title={row.accountName}>{row.accountName}</span></Td>
                        <Td>{validNonNegInt(row.friends) ? formatNumber(row.friends) : emptyValue('unknown')}</Td>
                        <Td>{validNonNegInt(row.dups) ? formatNumber(row.dups) : emptyValue('unknown')}</Td>
                        <Td><span className={rate !== null && rate >= 10 ? styles.rateHigh : undefined}>{rate !== null ? `${rate}%` : emptyValue('unknown')}</span></Td>
                      </Tr>
                    )
                  })}
                </tbody>
              </DataTable>
            )}
          </Card>
        ) : null}

        {d.data && d.data.perAccount.length >= 2 && Array.isArray(d.data.pairwiseOverlap) ? (
          <Card variant="records" padding="roomy" aria-labelledby="dup-matrix-title">
            <div className={styles.panelHead}>
              <h3 id="dup-matrix-title" className={styles.panelTitle}>アカウント間 重複マトリクス</h3>
              <p className={styles.panelSub}>同じ人が両方にいる数</p>
            </div>
            <DataTable>
              <thead>
                <TableHeadRow>
                  <Th>行 ＼ 列</Th>
                  {d.data.perAccount.map((col) => <Th key={col.accountId} title={col.accountName}>{col.accountName}</Th>)}
                </TableHeadRow>
              </thead>
              <tbody>
                {d.data.perAccount.map((row) => (
                  <Tr key={row.accountId} className={styles.rowCompact}>
                    <Td><span className={styles.cellText} title={row.accountName}>{row.accountName}</span></Td>
                    {d.data!.perAccount.map((col) => {
                      if (row.accountId === col.accountId) return <Td key={col.accountId}><EmptyCell /></Td>
                      const pair = d.data!.pairwiseOverlap!.find((p) => p && p.fromAccountId === row.accountId && p.toAccountId === col.accountId)
                      return <Td key={col.accountId}>{pair === undefined ? formatNumber(0) : validNonNegInt(pair.overlap) ? formatNumber(pair.overlap) : emptyValue('unknown')}</Td>
                    })}
                  </Tr>
                ))}
              </tbody>
            </DataTable>
          </Card>
        ) : null}
      </div>
    </PageFrame></PageExplanationProvider>
  )
}
