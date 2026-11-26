import type { ReactNode } from 'react'
import StickyBar from '@/components/shared/sticky-bar'
import styles from './page-templates.module.css'

/** 型が保存帯の置き場所と追従を持つ。画面は操作と状態だけを渡す。 */
export function PageFooter({ actions, destructive, status, presentation, shadowInset }: { actions: ReactNode; destructive?: ReactNode; status?: ReactNode; presentation?: 'distribution'; shadowInset?: boolean }) {
  return <div className={styles.footer} data-template-region="footer" data-shadow-inset={shadowInset || undefined}><StickyBar actions={actions} destructive={destructive} status={status} presentation={presentation} /></div>
}
