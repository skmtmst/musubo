'use client'

/*
 * 回答フォームタブ（ の 5.）。その人の回答を新しい順に、1回答＝1枚のカードで。
 * 項目名は回答時点の質問定義（fields の label）で出し、定義に無いキーは
 * 「（現在は使われていない項目）」を添える（FRIEND-24）。
 */
import { ClipboardList } from 'lucide-react'
import Button from '@/components/shared/button'
import FormFileAttachments from '@/components/shared/form-file-attachments'
import ListRange from '@/components/ui/list-range'
import { formatDateTime } from '@/lib/format'
import type { FriendDetailState } from './use-friend-detail'
import styles from './detail.module.css'
import { DetailLoading } from '@/components/templates/detail-page'
import Notice from '@/components/shared/notice'
import ListState from '@/components/shared/list-state'

export default function FormsTab({ data }: { data: FriendDetailState }) {
  const { submissions, submissionsStatus, submissionsTotal, submissionsNextCursor, submissionsLoadingMore, submissionsMoreError } = data

  if (submissionsStatus === 'loading' || submissionsStatus === 'idle') {
    return <div className={styles.pane}><DetailLoading /></div>
  }
  if (submissionsStatus === 'error') {
    return (
      <ListState kind="error" title="回答を読み込めませんでした。" description="" action={<><Button onClick={() => data.loadSubmissions()} busyLabel="処理中…">もう一度読み込む</Button></>} />
    )
  }
  if (submissions.length === 0) {
    return <div className={styles.pane}><p className={styles.paneNote}>フォームの回答はまだありません。</p></div>
  }

  return (
    <div className={styles.pane}>
      {typeof submissionsTotal === 'number' && submissionsTotal > submissions.length ? (
        <p className={styles.secNote}><ListRange total={submissionsTotal} first={1} last={submissions.length} /></p>
      ) : null}
      {submissions.map((s) => {
        const named = (s.fields ?? []).filter((f) => f && typeof f.name === 'string' && typeof f.label === 'string')
        const labelByName = new Map(named.map((f) => [f.name, f.label]))
        const keys = [...new Set(named.map((f) => f.name).filter((name) => Object.prototype.hasOwnProperty.call(s.data ?? {}, name)))]
        const orphans = Object.keys(s.data ?? {}).filter((k) => !labelByName.has(k))
        return (
          <article key={s.id} className={styles.card}>
            <div className={styles.cardHead}>
              <span className={styles.formIcon}><ClipboardList size={16} aria-hidden /></span>
              <h3 className={styles.cardTitle} title={s.formName}>{s.formName}</h3>
              <span className={styles.time}>{formatDateTime(s.createdAt)}</span>
            </div>
            <dl className={styles.answers}>
              {keys.map((k) => (
                <div key={k} className={styles.answer}><dt>{labelByName.get(k)}</dt><dd><FormFileAttachments value={s.data[k]} /></dd></div>
              ))}
              {orphans.map((k) => (
                <div key={k} className={styles.answer}>
                  <dt title={`項目キー: ${k}`}>{k}<span className={styles.orphan}>（現在は使われていない項目）</span></dt>
                  <dd><FormFileAttachments value={s.data[k]} /></dd>
                </div>
              ))}
            </dl>
          </article>
        )
      })}
      {submissionsNextCursor ? (
        <div className={styles.centered}>
          {/* 続きを読めなかったら、その場に黄色の文＋さらに読み込むを残す（絵の注記）。 */}
          {submissionsMoreError ? <Notice tone="danger" className={styles.warnTextNoticePlacement} >続きを読み込めませんでした。</Notice> : null}
          <Button onClick={() => void data.loadSubmissions(submissionsNextCursor)} disabled={submissionsLoadingMore} busy={submissionsLoadingMore} busyLabel="読み込んでいます…">さらに読み込む</Button>
        </div>
      ) : null}
    </div>
  )
}
