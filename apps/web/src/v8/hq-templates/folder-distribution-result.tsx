'use client'

import { ProgressBar } from '@/components/shared/progress'
import Dialog from '@/components/shared/dialog'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import TagPill from '@/components/shared/tag-pill'
import { folderDisplayColor } from '@/components/shared/folder-dot'
import StatusBadge from '@/components/shared/status-badge'
import type { HqTemplateFolder } from '@line-crm/shared'
import type { HqAccount } from '@/lib/hq-templates-api'
import { failedStatus, folderResultRows, settledResult, type FolderRun } from './folder-distribution'
import DistributionResultDialog from './distribution-result-dialog'
import styles from './console.module.css'
import { formatNumber } from '@/lib/format'

export default function FolderDistributionResult({ name, runs, accounts, folders = [], busy, error, onBack, onRefresh, onRetry, onRecheck }: {
  name: string; runs: FolderRun[]; accounts: HqAccount[]; folders?: HqTemplateFolder[]; busy: boolean; error: string
  onBack: () => void; onRefresh: () => void; onRetry: () => void; onRecheck: () => void
}) {
  const rows = folderResultRows(runs)
  const successes = rows.filter((row) => row.store?.status === 'succeeded')
  const failures = rows.filter((row) => row.store && failedStatus(row.store.status))
  const finished = successes.length + failures.length
  const unresolved = runs.some((run) => run.runId && !settledResult(run.result))
  const unsubmitted = rows.filter((row) => !row.store && !row.runId).length
  const done = finished === rows.length && !unresolved
  const accountName = (id: string) => accounts.find((account) => account.id === id)?.name ?? id
  const colorOf = (id: string | null | undefined) => {
    const folder = folders.find((folder) => folder.id === id)
    return folder ? folderDisplayColor(folder) : null
  }
  const displayRows = rows.filter((row) => row.store).map((row) => ({ key: `${row.template.id}:${row.accountId}`, name: row.template.template_type === 'tag' ? row.store?.accountName ?? accountName(row.accountId) : `${row.template.name} · ${row.store?.accountName ?? accountName(row.accountId)}`, tag: row.template.template_type === 'tag' ? { name: row.template.name, color: colorOf(row.template.folder_id) } : undefined, store: row.store! }))
  if (done) return <DistributionResultDialog open title={`配った結果：フォルダ「${name}」`} summary={`${new Set(rows.map((row) => row.accountId)).size} アカウントへ配りました。成功 ${successes.length}・失敗 ${failures.length}。${successes.length ? '成功した所はもう使えます。' : ''}`}
    rows={displayRows} busy={busy} onClose={onBack} onRetry={onRetry} onRefresh={onRefresh} />
  return <Dialog open designWidth={720} title={`アカウントへ配る：フォルダ「${name}」`} busy={busy} onCancel={() => { if (!unresolved) onBack() }} footer={<></>}>
    <div className={styles.distributionNotice}>{error ? <Notice tone="danger" message={error} /> : null}</div>
    <section className={styles.progressPanel} aria-label="配布の進み具合">
      <h2>配布の進み具合</h2>
      <div className={styles.progressRow} role="status"><ProgressBar appearance="quota" className={styles.progressBar} value={finished} max={rows.length} label="配布の進み" /><strong>{`${finished} / ${rows.length}`}</strong></div>
      <p className={styles.note}>{`ひな形 ${new Set(rows.map((row) => row.template.id)).size} 件・成功 ${successes.length}・失敗 ${failures.length}。${unresolved ? '結果が未確認の行は、再配布せず結果を再確認してください。' : ''}`}</p>
      <div className={styles.resultList}>
        {rows.map((row) => <div className={styles.resultRow} key={`${row.template.id}:${row.accountId}`}>
          <span className={styles.resultName} title={row.template.name}>{row.template.template_type === 'tag' ? <TagPill name={row.template.name} color={colorOf(row.template.folder_id)} size="sm" /> : row.template.name}</span>
          <span className={styles.resultText}>{row.store?.accountName ?? accountName(row.accountId)}{row.store?.reason ? `：${row.store.reason}` : ''}</span>
          <StatusBadge size="compact" tone={row.store?.status === 'succeeded' ? 'success' : row.store && failedStatus(row.store.status) ? 'danger' : 'neutral'}>{row.store?.status === 'succeeded' ? '成功' : row.store && failedStatus(row.store.status) ? '失敗' : row.store ? '作成中' : '待っています'}</StatusBadge>
        </div>)}
      </div>
    </section>
    <div className={`${styles.footer} ${styles.folderResultFooter}`}>
      <Button disabled={busy || unresolved} onClick={onBack}>ひな形一覧へ</Button>
      <Button disabled={busy} onClick={onRefresh}>結果を再確認</Button>
      {failures.length ? <Button variant="primary" disabled={busy || unresolved || unsubmitted > 0} disabledReason={!busy ? unresolved ? '先に結果を再確認してください。' : unsubmitted > 0 ? '先に未配布分を再確認してください。' : undefined : undefined} onClick={onRetry}>{`失敗した ${formatNumber(failures.length)} 件だけ再確認`}</Button> : null}
      {unsubmitted > 0 ? <Button variant="primary" disabled={busy || unresolved} onClick={onRecheck}>未配布分を再確認</Button> : null}
    </div>

  </Dialog>
}
