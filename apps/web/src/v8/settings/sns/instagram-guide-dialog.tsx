'use client'

/**
 * Instagram をつなぐ前の案内の窓。未接続の段の［Instagram をつなぐ］と、戻ったときの知らせの
 * ［もう一度つなぐ］から開く。確かめること3つを読んでから［Instagram へ進む］でログイン画面へ進む。
 *
 * 決まり：
 * - 窓は共通 Dialog に中身を入れるだけ。寸法は SNS の他の窓（slot-dialogs）と同じ変数を読む。
 * - 文言は instagram-guidance.ts だけが持つ。
 */

import Dialog from '@/components/shared/dialog'
import {
  INSTAGRAM_CONNECT_CHECKS,
  INSTAGRAM_GUIDE_LEAD,
  INSTAGRAM_PROCEED_LABEL,
} from './instagram-guidance'
import styles from './slot-dialogs.module.css'

export function InstagramGuideDialog({
  busy,
  error,
  onCancel,
  onProceed,
}: {
  busy?: boolean
  error?: string
  onCancel: () => void
  onProceed: () => void
}) {
  return (
    <Dialog
      open
      designWidth={560}
      designHeaderPadding="var(--tpl-e1-sns-slot-dlg-head-pad)"
      designContentPadding="var(--tpl-e1-sns-slot-dlg-body-pad)"
      designFooterPadding="var(--tpl-e1-sns-slot-dlg-foot-pad)"
      headerIcon={false}
      footerDivider={false}
      footerLeadFlexible={false}
      title="Instagram をつなぐ前に"
      cancelLabel="戻る"
      confirmLabel={INSTAGRAM_PROCEED_LABEL}
      busy={busy}
      busyLabel="処理中…"
      error={error}
      onCancel={onCancel}
      onConfirm={onProceed}
    >
      <div className={styles.body}>
        <p className={styles.desc}>{INSTAGRAM_GUIDE_LEAD}</p>
        <ol className={styles.checkList} aria-label="つなぐ前に確かめること">
          {INSTAGRAM_CONNECT_CHECKS.map((check) => (
            <li key={check.title} className={styles.checkItem}>
              <span className={styles.checkTitle}>{check.title}</span>
              <span className={styles.boxDetail}>{check.detail}</span>
            </li>
          ))}
        </ol>
      </div>
    </Dialog>
  )
}
