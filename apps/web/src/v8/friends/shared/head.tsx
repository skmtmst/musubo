'use client'

import { PageHeading } from '@/components/templates/page-frame'
import { PageExplanationBody, PageExplanationProvider, PageExplanationToggle } from '@/components/shared/page-explanation'

/*
 * ★V8 友だちの段の頭。
 * - FriendsTabs：タブの並び（ の「タブの段」・下に細い線）
 * - FriendsSectionHead：管理の画面（重複検出・統合ユーザー・UID移行・CSV）の頭
 *   （・・・ の「板の頭」：題／説明／タブ／タブの説明。
 *   板の頭の「← 友だちへ」は 2026-10-08 に無くした。戻るのは上の帯のパンくず）
 */
import Link from '@/components/shared/list-navigation'
import type { ReactNode } from 'react'
import { FRIENDS_CSV_TAB_LABEL, FRIENDS_TABS, FRIENDS_TAB_NOTES, type FriendsTabKey } from './nav'
import styles from './head.module.css'

export function FriendsTabs({ current, line = true, action }: { current: FriendsTabKey; line?: boolean; action?: ReactNode }) {
  return (
    <div className={line ? `${styles.tabRow} ${styles.tabRowLine}` : styles.tabRow}>
      <nav className={styles.tabs} aria-label="友だちの画面">
        {FRIENDS_TABS.map((tab) => (
          <Link
            key={tab.key}
            href={tab.href}
            className={tab.key === current ? `${styles.tab} ${styles.tabCurrent}` : styles.tab}
            aria-current={tab.key === current ? 'page' : undefined}
          >
            {tab.label}
          </Link>
        ))}
        {/* CSV はタブから行けないが、今いる所は示す（B9）。行き先ではないので押せない。 */}
        {current === 'csv' ? <span className={`${styles.tab} ${styles.tabCurrent}`} aria-current="page">{FRIENDS_CSV_TAB_LABEL}</span> : null}
      </nav>
      {action ? <div className={styles.tabAction}>{action}</div> : null}
    </div>
  )
}

export function FriendsSectionHead({
  current,
  description,
  action,
  title = '友だち',
  note,
  tabs = true,
}: {
  current: FriendsTabKey
  description: ReactNode
  /** タブの行の右端（絵の「表示中をCSVで書き出す」など）。 */
  action?: ReactNode
  title?: ReactNode
  /** タブの下の1行。省くとタブごとの決まった文。null で出さない。 */
  note?: ReactNode | null
  tabs?: boolean
}) {
  const noteText = note === undefined
    ? (typeof current === 'string' && Object.prototype.hasOwnProperty.call(FRIENDS_TAB_NOTES, current)
        ? FRIENDS_TAB_NOTES[current]
        : undefined)
    : note
  return (
    <PageExplanationProvider pageKey={`friends:${current}`}>
      <PageHeading title={title} help={description} explanationToggle={noteText ? <PageExplanationToggle /> : undefined} tabs={<>
        {tabs ? <FriendsTabs current={current} line={false} action={action} /> : null}
        {noteText ? <PageExplanationBody keepMounted>{noteText}</PageExplanationBody> : null}
      </>} />
    </PageExplanationProvider>
  )
}
