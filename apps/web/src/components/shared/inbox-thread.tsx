import type { ReactNode } from 'react'
import { DelayedSkeleton, Skeleton } from './skeleton'
import { Bot } from 'lucide-react'
import styles from './inbox-thread.module.css'

export function InboxMessageDay({ first, children }: { first: boolean; children: ReactNode }) {
  return <div className={styles.day} data-first={first || undefined}>{children}</div>
}
export function InboxQuotedMessage({ children }: { children: ReactNode }) {
  return <div data-inbox-v6="quoted-message" className={styles.quoted}>{children}</div>
}
/** 媒体の取得・検索・引用の動きは画面が渡し、左右の会話の形は共通で持つ。 */
export function InboxMessage({ outgoing, last, time, onQuote, onCorrect, searchHit, senderName, autoLabel, sendStatus, children }: {
  outgoing: boolean; last: boolean; time: string; onQuote?: () => void
  /** 送ったあとは取り消せない。間違いは［訂正を送る］（入力欄に見本の文と元の文の引用が入る。送るのは人）。 */
  onCorrect?: () => void
  sendStatus?: 'sending' | 'sent'; searchHit?: string | null; senderName?: string | null; autoLabel?: string | null; children: ReactNode
}) {
  const actions = onQuote || onCorrect ? <span className={styles.actions}>{onQuote ? <button type="button" data-inbox-v6="quote-reply" className={styles.quoteBtn} onClick={onQuote}>引用</button> : null}{onCorrect ? <button type="button" data-inbox-v6="correct-message" className={styles.quoteBtn} onClick={onCorrect}>訂正を送る</button> : null}</span> : null
  const meta = <span className={styles.meta}>{outgoing ? actions : null}<span className={styles.delivery}><time>{time}</time>{outgoing && sendStatus ? <span role="status">{sendStatus === 'sending' ? '送信中…' : '送信済み'}</span> : null}</span>{!outgoing ? actions : null}</span>
  const bubble = <div className={outgoing ? styles.bubbleOut : styles.bubbleIn} data-search-hit={searchHit ?? undefined}>{children}</div>
  return <div className={outgoing ? styles.rowOut : styles.rowIn} data-last={last || undefined}>
    {outgoing ? <div className={styles.outCol}><div className={styles.outLine}>{meta}{bubble}</div>
      {senderName ? <span className={styles.sender} title={senderName}><span aria-hidden="true" className={styles.senderFace}>{senderName.charAt(0)}</span>{senderName} が送信</span>
        : <span className={styles.sender}><span aria-hidden="true" className={styles.senderBot}><Bot aria-hidden="true" /></span>{autoLabel ? `自動：${autoLabel}` : '自動で送信'}</span>}
    </div> : <>{bubble}{meta}</>}
  </div>
}

/** 相手を切り替えた初回だけ、300msを超えた待ち時間を会話の形で伝える。 */
export function InboxThreadLoading({ loading = true, children }: { loading?: boolean; children?: ReactNode }) {
  return <DelayedSkeleton loading={loading} skeleton={<div className={styles.loading} role="status" aria-label="会話を読み込んでいます" aria-busy="true"><div className={styles.loadingBubbles} aria-hidden="true">
      {[false, true, false].map((outgoing, index) => <div key={index} className={outgoing ? styles.rowOut : styles.rowIn}>
        <div className={outgoing ? styles.bubbleOut : styles.bubbleIn}>
          <Skeleton width="var(--tpl-inbox-skeleton-width)" height="var(--tpl-inbox-bubble-lh)" />
        </div>
      </div>)}
    </div></div>}>{children}</DelayedSkeleton>
}
