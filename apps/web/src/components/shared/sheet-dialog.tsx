'use client'

import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import styles from './sheet-dialog.module.css'

/*
  ボトムシート型の窓の所有部品。
  窓の役割（role="dialog" / aria-modal / 題との結び付け）と、
  掴み手・頭（印＋題＋一言）の形をここが持つ。

  寸法と見た目は画面が --sheet-* のカスタムプロパティで渡す。
  画面ごとに違う中身（一覧・足など）は children に入れる。
*/

export type SheetDialogProps = Omit<
  ComponentPropsWithoutRef<'div'>,
  'role' | 'aria-modal' | 'aria-labelledby' | 'children'
> & {
  /** 題の id。読み上げが窓と題を結び付けるために使う。 */
  titleId: string
  title: ReactNode
  /** 題の下の一言。無い窓もある。 */
  description?: ReactNode
  /** 題の左に置く印（丸い札・絵記号など）。画面が作って渡す。 */
  mark?: ReactNode
  children?: ReactNode
}

export function SheetDialog({ titleId, title, description, mark, children, className, ...rest }: SheetDialogProps) {
  return (
    <div
      {...rest}
      className={className ? `${styles.surface} ${className}` : styles.surface}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div className={styles.grabber}><span className={styles.grabberBar} /></div>

      <div className={styles.header}>
        {mark}
        <div className={styles.headerText}>
          <h2 id={titleId} className={styles.title}>{title}</h2>
          {description ? <p className={styles.description}>{description}</p> : null}
        </div>
      </div>

      {children}
    </div>
  )
}

export default SheetDialog
