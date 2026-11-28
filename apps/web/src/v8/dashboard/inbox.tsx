'use client'

import { useStaffIdentity } from '@/lib/staff-role'
import { useListUrlParam, useListUrlValue } from '@/components/shared/list-url-state'
import Link from '@/components/shared/list-navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, fetchApi } from '@/lib/api'
import { inboxItemHref, type PendingInboxSummary } from '@/components/support/pending-inbox-card'
import Pagination from '@/components/shared/pagination'
import TruncatedText from '@/components/shared/truncated-text'
import { DataTable, TableHeadRow, Th, Tr, Td } from '@/components/shared/table'
import SectionHeader from './head'
import StatusBadge from '@/components/shared/status-badge'
import { STATE_TEXT } from '@/components/shared/not-connected'
import { formatTime } from '@/lib/format'
import { RetryLabel } from '@/components/shared/retry-label'
import { Loading, Tag } from './sections'
import styles from './dashboard.module.css'

/*
 * 対応が必要な受信（全アカウント）（ 段B）。
 * 取り方は 管理画面 の PendingInboxCard と同じ（`/api/support/inbox?status=open`・
 * 30秒ごと・画面に戻ったとき・担当者ごとの表示件数）。上の数の帯の
 * メール件数・最長待ちの出どころでもあるので、件数を親へ知らせる。
 */
type InboxItem = {
  id: string
  channel: 'line' | 'email'
  customerName: string
  preview: string
  lastIncomingAt: string
}

const PAGE_SIZE_OPTIONS = [5, 10, 15, 20]
const DEFAULT_PAGE_SIZE = 5
const PAGE_SIZE_STORAGE_PREFIX = 'lh_pending_inbox_page_size:'

/** 文字の入っていない内容（絵文字・スタンプだけ）。後ろに灰で「（絵文字）」と添える。 */
export function isEmojiOnly(text: string): boolean {
  const trimmed = text.trim()
  return trimmed !== '' && /^[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f\s]+$/u.test(trimmed) && !/^[\d#*\s]+$/.test(trimmed)
}

function elapsed(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000))
  if (minutes < 1) return 'たった今'
  if (minutes < 60) return `${minutes}分前`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}時間前` : `${Math.floor(hours / 24)}日前`
}

export function InboxSection({ onSummaryChange }: {
  onSummaryChange: (summary: PendingInboxSummary | null, ok?: boolean) => void
}) {
  const [summary, setSummary] = useState<PendingInboxSummary | null>(null)
  const [items, setItems] = useState<InboxItem[]>([])
  const [loadFailure, setLoadFailure] = useState<null | 'error' | 'forbidden'>(null)
  const [loading, setLoading] = useState(true)
  const [lastSuccessAt, setLastSuccessAt] = useState<Date | null>(null)
  const [page, setPage] = useListUrlValue('page', 1)
  const [urlPageSize] = useListUrlValue('pageSize', DEFAULT_PAGE_SIZE)
  const [pageSizeParam] = useListUrlParam('pageSize')
  const staffId = useStaffIdentity()?.id
  // 本人確認済みIDの表示設定だけ復元し、失効時は標準件数へ戻す。
  const personalPageSize = useMemo(() => {
    if (!staffId) return DEFAULT_PAGE_SIZE
    try {
      const raw = window.localStorage.getItem(PAGE_SIZE_STORAGE_PREFIX + staffId)
      const restored = raw === null ? NaN : Number(raw)
      return PAGE_SIZE_OPTIONS.includes(restored) ? restored : DEFAULT_PAGE_SIZE
    } catch { return DEFAULT_PAGE_SIZE }
  }, [staffId])
  // 明示URLを優先。本人の暗黙設定はURLへ書き込んで次の本人へ持ち越さない。
  const pageSize = pageSizeParam === '' ? personalPageSize : urlPageSize
  const loadSeq = useRef(0)
  const total = summary?.total ?? 0
  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      const response = await fetchApi<{ success: boolean; data: { items: InboxItem[]; summary: PendingInboxSummary } }>(
        `/api/support/inbox?status=open&limit=${pageSize}&offset=${(page - 1) * pageSize}`,
      )
      if (seq !== loadSeq.current) return
      if (response.success) {
        if (!response.data?.summary || !Number.isInteger(response.data.summary.total) || response.data.summary.total < 0 || !Array.isArray(response.data.items) || response.data.items.some((item) => !item || typeof item.id !== 'string' || !['line', 'email'].includes(item.channel) || typeof item.customerName !== 'string' || typeof item.preview !== 'string' || typeof item.lastIncomingAt !== 'string')) throw new Error('invalid_inbox_result')
        setSummary(response.data.summary)
        onSummaryChange(response.data.summary, true)
        setItems(response.data.items)
        setLoadFailure(null)
        setLastSuccessAt(new Date())
      } else {
        setLoadFailure('error')
        onSummaryChange(null, false)
      }
    } catch (caught) {
      if (seq !== loadSeq.current) return
      setLoadFailure(caught instanceof ApiError && caught.status === 403 ? 'forbidden' : 'error')
      onSummaryChange(null, false)
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [onSummaryChange, page, pageSize])

  useEffect(() => {
    if (page > pageCount) setPage(pageCount)
  }, [page, pageCount])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 30_000)
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  return (
    <>
      <SectionHeader title="対応が必要な受信（全アカウント）" href="/chats" linkLabel="受信箱へ" />
      {loadFailure && summary ? (
        <p role="status" className={styles.stale}>
          {`最新の状態に更新できませんでした。${lastSuccessAt ? `最終更新 ${formatTime(lastSuccessAt)} の内容を表示しています。` : ''}`}
          <button type="button" className={styles.inlineButton} onClick={() => void load()}><RetryLabel /></button>
        </p>
      ) : null}
      {loadFailure === 'forbidden' && !summary ? (
        <p className={styles.empty}>{`${STATE_TEXT.forbiddenView}。`}</p>
      ) : loadFailure && !summary ? (
        <p className={styles.empty}>
          {`データを${STATE_TEXT.error}。`}
          <button type="button" className={styles.inlineButton} onClick={() => void load()}><RetryLabel /></button>
        </p>
      ) : loading && !summary ? (
        <Loading label="対応が必要な受信" />
      ) : !summary || summary.total === 0 ? (
        <p className={styles.empty}>返信を待っている問い合わせはありません。</p>
      ) : (
        <><DataTable aria-label="対応が必要な受信" columnLayout={{ headHeight: 'var(--tpl-list-head-h)', rowHeight: 'var(--tpl-db-inbox-row-h)', rowGap: 'var(--polish-space-field)', gap: 'var(--tpl-db-col-gap)', padding: '0 var(--tpl-db-inbox-gap)', bodyTextSize: 'var(--text-body)' }}>
          <thead>
          <TableHeadRow data-table-layout="columns">
            <Th className={styles.colName}>お名前</Th>
            <Th grow>内容</Th>
            <Th className={styles.colWait}>待ち時間</Th>
            <Th className={styles.colState}>状態</Th>
          </TableHeadRow></thead>
          <tbody>{items.map((item) => (
            <Tr key={item.id} data-table-layout="columns">
              <Td className={styles.colName}>
                <span className={styles.route}>{item.channel === 'email' ? 'メール' : 'LINE'}</span>
                <Link href={inboxItemHref(item)} className={styles.inboxName} title={`${item.customerName}の受信箱を開く`}>
                  {item.customerName}
                </Link>
              </Td>
              <Td grow>{isEmojiOnly(item.preview)
                ? <span className={styles.inboxEmoji} title={`${item.preview}（絵文字）`}>{item.preview}<span className={styles.inboxEmojiNote}>（絵文字）</span></span>
                : <TruncatedText value={item.preview} />}</Td>
              <Td className={styles.colWait}><Tag tone="danger">{elapsed(item.lastIncomingAt)}</Tag></Td>
              <Td className={styles.colState}><StatusBadge tone="danger" size="compact">未対応</StatusBadge></Td>
            </Tr>
          ))}</tbody>
          </DataTable>
          {pageCount <= 1 && items.length < pageSize ? <p className={styles.note}>ほかに対応が必要な受信はありません</p> : null}
          {pageCount > 1 ? (
            <Pagination page={page} pageCount={pageCount} onPageChange={setPage} ariaLabel="受信一覧のページ送り" className={styles.inboxPager} />
          ) : null}</>
      )}
    </>
  )
}
