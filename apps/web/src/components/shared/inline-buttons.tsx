import type { ReactNode } from 'react'
import styles from './inline-buttons.module.css'

/** 欄の下に候補のボタンを折り返して並べる。 */
export function InlineButtons({ children }: { children: ReactNode }) {
  return <span className={styles.buttons}>{children}</span>
}
