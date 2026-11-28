import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import { usePermissionLockReason } from '@/components/shared/use-permission-lock-reason'
import styles from '../../../app/rich-menus/new/create-v8.module.css'
import { MISSING_DEFAULT_PAGE_ERROR } from './hq-menu-seed'

/** リッチメニュー作成の上に出すお知らせ（最初に出す面の選び直し・失敗・完了・候補の整理）。 */
export function RichMenuCreateNotices({
  missingDefaultPage, pages, busy, canOperate, onSelectDefaultPage,
  error, onRetry, notice, onCloseNotice, pruneNotice, onClosePruneNotice,
}: {
  missingDefaultPage: boolean
  pages: ReadonlyArray<{ id: string; name: string }>
  busy: boolean
  canOperate: boolean
  onSelectDefaultPage: (pageId: string) => void
  error: string | null
  onRetry?: () => unknown
  notice: string
  onCloseNotice: () => void
  pruneNotice: string
  onClosePruneNotice: () => void
}) {
  const lockReason = usePermissionLockReason(canOperate, 'manager')
  return (
    <>
      {missingDefaultPage ? (
        <Notice
          tone="danger"
          message={MISSING_DEFAULT_PAGE_ERROR}
          className="mb-1"
          action={
            pages.length > 0 ? (
              <span className={styles.pageTools}>
                {pages.map((page) => (
                  <Button
                    key={page.id}
                    type="button"
                    variant="secondary"
                    size="compact"
                    disabled={busy || (!canOperate && !lockReason)}
                    lockedReason={!canOperate ? lockReason : undefined}
                    onClick={() => onSelectDefaultPage(page.id)}
                  >
                    {`${page.name}を最初に出す面にする`}
                  </Button>
                ))}
              </span>
            ) : undefined
          }
        />
      ) : null}
      {error && !(missingDefaultPage && error === MISSING_DEFAULT_PAGE_ERROR) ? (
        <Notice
          tone="danger"
          message={error}
          className="mb-1"
          action={
            onRetry ? (
              <Button type="button" onClick={onRetry} busyLabel="処理中…">
                もう一度読み込む
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {notice ? <Notice tone="success" message={notice} className="mb-1" onClose={onCloseNotice} /> : null}
      {pruneNotice ? <Notice tone="warn" message={pruneNotice} onClose={onClosePruneNotice} /> : null}
    </>
  )
}
