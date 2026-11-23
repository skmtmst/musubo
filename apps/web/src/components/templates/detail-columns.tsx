'use client'

import { useId, type ReactNode } from 'react'
import Button from '@/components/shared/button'
import styles from './page-templates.module.css'
import detailStyles from '@/components/shared/detail-content.module.css'

/** 詳細の本文と補助欄。狭い板では補助欄を畳み、操作は開いて使う。 */
export function DetailColumns({ children, aside, asideLabel, expanded, onExpandedChange, presentation, variant, toggleLabel, showToggle = true, asideLayout }: {
  asideLayout?: 'detail'
  variant?: 'restaurant-inventory' | 'restaurant-tables' | 'restaurant-ledger' | 'analysis-history' | 'style-dashboard' | 'style-roster' | 'followup-editor'
  children: ReactNode
  aside: ReactNode
  asideLabel: string
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  toggleLabel?: ReactNode
  showToggle?: boolean
  /** 補助欄自体がカードの枠を持つ板。既定の仕切り線は付けない。 */
  presentation?: 'card' | 'notification' | 'analysis'
}) {
  const asideId = useId()
  return <div className={styles.detailColumns} data-detail-columns={variant} data-presentation={presentation} data-has-aside={aside ? true : undefined}>
    {aside && showToggle ? <div className={styles.detailColumnToggle}>
      <Button aria-expanded={expanded} aria-controls={asideId} onClick={() => onExpandedChange(!expanded)}>{toggleLabel ?? asideLabel}</Button>
    </div> : null}
    <div className={styles.detailColumnMain}>{children}</div>
    {aside ? <aside id={asideId} className={`${styles.detailColumnAside} ${detailStyles.surface}`} aria-label={asideLabel} data-expanded={expanded || undefined} data-detail-layout={asideLayout}>{aside}</aside> : null}
  </div>
}
