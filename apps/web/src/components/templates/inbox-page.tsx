import type { HTMLAttributes, ReactNode, Ref } from 'react'
import { PageFrame, PageHeading, type PageHeadingProps } from './page-frame'
import styles from './page-templates.module.css'
export interface InboxPageProps {
  boardId?: string; standalone?: boolean; heading?: PageHeadingProps
  list?: ReactNode; conversationHeader?: ReactNode; children: ReactNode; composer?: ReactNode
  summary?: ReactNode; summaryToggle?: ReactNode
  composed?: boolean; elementRef?: Ref<HTMLDivElement>; narrowMode?: 'list' | 'detail'; narrowBack?: ReactNode
}
export function InboxPage({ boardId, standalone, heading, list, conversationHeader, children, composer, summary, summaryToggle, composed, elementRef, narrowMode, narrowBack }: InboxPageProps) {
  return <PageFrame kind="inbox" boardId={boardId} standalone={standalone} elementRef={elementRef}>
    {heading ? <PageHeading {...heading} /> : null}
    {summaryToggle ? <div className={styles.asideToggle}>{summaryToggle}</div> : null}
    {narrowMode === 'detail' ? <div className={styles.inboxBack}>{narrowBack}</div> : null}
    <div className={styles.inbox} data-template-region="body" data-inbox-narrow={narrowMode}>
      {composed ? children : <>
      <div className={styles.inboxList} data-template-region="list">{list}</div>
      <div className={styles.conversation} data-template-region="conversation">
        {conversationHeader ? <div className={styles.conversationHeader} data-template-region="conversation-header">{conversationHeader}</div> : null}<div className={styles.messages}>{children}</div><div className={styles.composer}>{composer}</div>
      </div>
      {summary ? <aside className={styles.inboxSummary} data-template-region="summary">{summary}</aside> : null}
      </>}
    </div>
  </PageFrame>
}

type RegionProps = HTMLAttributes<HTMLDivElement> & { ref?: Ref<HTMLDivElement> }
export function InboxListPane({ selected, ...props }: RegionProps & { selected: boolean }) {
  return <div {...props} className={styles.inboxList} data-inbox-v4="conversation-list" data-selected={selected || undefined} />
}
export function InboxConversationPane({ selected, ...props }: RegionProps & { selected: boolean }) {
  return <div {...props} className={styles.conversation} data-inbox-v4="talk-pane" data-selected={selected || undefined} />
}
export function InboxMessages(props: RegionProps) {
  return <div {...props} className={styles.inboxMessages} data-inbox-thread-scroller="" />
}
export function InboxComposer(props: RegionProps) {
  return <div {...props} className={styles.inboxComposer} data-inbox-v4="composer" />
}
export function InboxSummaryPane({ wide, ...props }: HTMLAttributes<HTMLElement> & { ref?: Ref<HTMLElement>; wide: boolean }) {
  return <aside {...props} className={styles.inboxSummaryPane} data-inbox-v4="customer-panel" data-wide={wide || undefined} />
}
