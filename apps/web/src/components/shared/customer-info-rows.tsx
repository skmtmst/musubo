import { Fragment, type ReactNode } from 'react'
import styles from './customer-info-panel.module.css'
import rowStyles from './customer-info-rows.module.css'

/** 顧客情報の読み取り用の行。編集の状態と保存は呼び出し元が持つ。 */
export function CustomerInfoRows({ rows, valueAlign = 'start' }: { rows: Array<{ label: string; value: ReactNode; emphasis?: boolean; key?: string }>; valueAlign?: 'start' | 'end' }) {
  return <dl className={rowStyles.rows} data-value-align={valueAlign}>{rows.map(({ label, value, emphasis, key }) => <Fragment key={key ?? label}><dt data-emphasis={emphasis || undefined}>{label}</dt><dd data-emphasis={emphasis || undefined}>{typeof value === 'string' || typeof value === 'number' ? <span className={styles.value} title={String(value)}>{value}</span> : value}</dd></Fragment>)}</dl>
}
