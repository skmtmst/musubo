'use client'

import { RotateCw } from 'lucide-react'
import type { DistributionResult } from '@/lib/hq-templates-api'
import Dialog from '@/components/shared/dialog'
import Button from '@/components/shared/button'
import TagPill, { type TagPillProps } from '@/components/shared/tag-pill'
import StatusBadge from '@/components/shared/status-badge'
import { failedStatus } from './folder-distribution'
import styles from './console.module.css'
import { formatNumber } from '@/lib/format'

export function resultSentence(store: DistributionResult['stores'][number]): string {
  if (store.status === 'pending' || store.status === 'staged') return '配っています'
  if (store.status !== 'succeeded') return '配布結果を確認できません。結果を再確認してください。'
  if (store.counts.aliased > 0) return store.createdName ? `同じ名前があったため「${store.createdName}」で作りました` : '同じ名前があったため、別名で作りました'
  if (store.counts.overwritten > 0) return '上書きしました'
  if (store.counts.created > 0) return '新しく作りました'
  if ((store.counts.reused ?? 0) > 0) return '今あるものを使いました'
  return '配りました'
}
export default function DistributionResultDialog({ open, title, summary, rows, tag, busy, onClose, onRetry, onRefresh }: {
  open: boolean; title: string; summary: string
  rows: Array<{ key: string; name: string; tag?: Pick<TagPillProps, 'name' | 'color'>; store: DistributionResult['stores'][number] }>
  tag?: Pick<TagPillProps, 'name' | 'color'>
  busy: boolean; onClose: () => void; onRetry: () => void
  onRefresh?: () => void
}) {
  const failures = rows.filter((row) => failedStatus(row.store.status))
  return <Dialog open={open} designNode="dEvJM" designWidth={720} designTop={220} title={title} designHeaderPadding="24px 24px 0"
    busy={busy} cancelLabel="閉じる" onCancel={onClose}
    {...(failures.length ? { confirmLabel: `失敗した ${formatNumber(failures.length)} 件をやり直す`, confirmIcon: <RotateCw size={16} />,
      onConfirm: onRetry } : {})}>
    {tag ? <TagPill {...tag} /> : null}
    <p className={styles.resultSummary}>{summary}</p>
    <div className={styles.resultList}>
      {rows.map(({ key, name, tag: rowTag, store }) => {
        const failed = failedStatus(store.status)
        const pending = store.status === 'pending' || store.status === 'staged'
        const resultTag = rowTag ?? tag
        const sentence = resultTag && store.status === 'succeeded' && store.counts.aliased > 0 && store.createdName
          ? <>同じ名前があったため「<TagPill name={store.createdName} color={resultTag.color} size="sm" />」で作りました</>
          : resultSentence(store)
        return <div key={key} className={styles.resultRow}>
          <span className={styles.resultName} title={name}>{rowTag ? <><TagPill {...rowTag} size="sm" /> · {store.accountName ?? name}</> : name}</span>
          <span className={styles.resultText}>{failed ? (store.reason || '配布できませんでした。アカウントの現在版を再確認してください。') : sentence}</span>
          <StatusBadge size="compact" tone={store.status === 'succeeded' ? 'success' : failed ? 'danger' : 'neutral'}>{store.status === 'succeeded' ? '成功' : failed ? '失敗' : pending ? '作成中' : '未確認'}</StatusBadge>
        </div>
      })}
    </div>
    {failures.length ? <p className={styles.resultBand}>{`失敗した ${formatNumber(failures.length)} 件だけやり直せます。各行の理由を直してから、やり直してください。`}</p> : null}
    {onRefresh ? <Button disabled={busy} onClick={onRefresh}>結果を再確認</Button> : null}
  </Dialog>
}
