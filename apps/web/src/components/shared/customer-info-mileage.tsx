import type { MileageSummary, MileageHistoryItem } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import Button from './button'
import { DelayedSkeleton, Skeleton } from './skeleton'
import styles from './customer-info-mileage.module.css'

export type CustomerMileageState =
  | { kind: 'loading' }
  | { kind: 'error' }
  /** 店でマイルを使っていない（機能がオフ）。取得失敗ではないので再試行は出さない。 */
  | { kind: 'disabled' }
  | { kind: 'data'; summary: MileageSummary; history: MileageHistoryItem[] }

/** 顧客情報の数と記録。取得・再試行・権限は呼び出す側で保つ。 */
export default function CustomerInfoMileage({ state, onRetry }: { state: CustomerMileageState; onRetry: () => void }) {
  if (state.kind === 'loading') return <DelayedSkeleton loading skeleton={<Skeleton width="100%" height="var(--tpl-fdt-mile-lh)" />} />
  if (state.kind === 'disabled') return <p className={styles.caption}>マイルは使っていません</p>
  if (state.kind === 'error') return <div className={styles.summary}>
    <p className={styles.error}>マイルを読み込めませんでした</p>
    <Button variant="text" size="inline" onClick={onRetry}>再試行する</Button>
  </div>
  return <div className={styles.summary}>
    <div className={styles.available}>
      <span className={styles.number}>{state.summary.available == null ? '—' : formatNumber(state.summary.available)}</span>
      <span className={styles.unit}>マイル</span>
      {state.summary.balanceSource !== 'ec' && state.summary.pending > 0 ? <span className={styles.caption}>確定待ち {formatNumber(state.summary.pending)}</span> : null}
    </div>
    <p className={styles.caption}>{state.summary.balanceSource === 'ec' ? 'ECと同期・履歴はmusubo側' : `${state.summary.programName}・利用可能`}</p>
    <div className={styles.history}>
      {state.history.length ? state.history.slice(0, 3).map(item => <div className={styles.entry} key={item.id}>
        <span className={styles.reason} title={item.reason ?? undefined}>{item.reason}</span>
        <span className={styles.amount} data-positive={item.amount > 0 || undefined}>{item.amount > 0 ? '+' : ''}{formatNumber(item.amount ?? 0)}</span>
      </div>) : <p className={styles.caption}>まだマイル履歴はありません</p>}
    </div>
  </div>
}
