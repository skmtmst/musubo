'use client'

import { useEffect, useRef, useState } from 'react'
import type { MediaItem } from '@line-crm/shared'
import { api, ApiError } from '@/lib/api'
import Button from '@/components/shared/button'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import { TextField } from '@/components/shared/text-field'
import { errorMessage } from './format'
import type { CropTarget } from './post-image-crop'
import styles from './post-media-picker-dialog.module.css'

const PAGE_SIZE = 20
const DATE_FORMAT = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' })

function registeredAt(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : DATE_FORMAT.format(date)
}

export function PostMediaPickerDialog({ target, accountId, onClose, onSelect }: {
  target: CropTarget
  accountId: string
  onClose: () => void
  onSelect: (item: MediaItem) => Promise<void>
}) {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<MediaItem[]>([])
  const [total, setTotal] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<MediaItem | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [retry, setRetry] = useState(0)
  const request = useRef(0)

  useEffect(() => {
    const current = ++request.current
    setLoading(true)
    setError('')
    api.media.list(accountId, {
      kind: 'image', query: query || undefined, sort: 'newest',
      limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
    }).then((response) => {
      if (request.current !== current) return
      if (!response.success) throw new ApiError(500, response.error)
      setItems(response.data.items.filter((item) => item.kind === 'image' && (item.lineAccountId === accountId || item.lineAccountId == null)))
      setTotal(response.data.total)
    }).catch((cause) => {
      if (request.current !== current) return
      setItems([])
      setTotal(null)
      setError(errorMessage(cause, '登録メディアを読み込めませんでした。'))
    }).finally(() => {
      if (request.current === current) setLoading(false)
    })
    return () => { request.current += 1 }
  }, [accountId, query, page, retry])

  const search = () => {
    setSelected(null)
    setPage(1)
    setQuery(input.trim())
  }
  const changePage = (next: number) => {
    setSelected(null)
    setPage(next)
  }
  const applySelection = async () => {
    if (!selected || confirming) return
    setConfirming(true)
    setError('')
    try {
      await onSelect(selected)
    } catch (cause) {
      setError(errorMessage(cause, '画像を読み込めませんでした。もう一度お試しください。'))
    } finally {
      setConfirming(false)
    }
  }

  const title = target === 'google' ? 'Google用画像を登録メディアから選ぶ' : 'Instagram用画像を登録メディアから選ぶ'
  const first = (page - 1) * PAGE_SIZE + 1
  const last = Math.min(page * PAGE_SIZE, total ?? 0)

  return <Dialog
    open title={title} headerIcon={false} dirty={false}
    description="保存済みの画像を選ぶと、次に切り取り位置を確認できます。"
    designNode="post-media-picker" designWidth={850} exactDesignWidth
    designHeaderPadding="28px 24px 22px"
    designContentPadding="22px 24px 24px"
    busy={confirming} busyLabel="画像を読み込み中…"
    onCancel={onClose}
    footer={<DialogActions leadingAction="選択後、切り取り位置を確認します。">

      <Button onClick={onClose} disabled={confirming}>キャンセル</Button>
      <Button variant="primary" onClick={() => void applySelection()} disabled={!selected || loading || confirming} busy={confirming} busyLabel="画像を読み込み中…">切り取り位置を確認</Button>
    </DialogActions>}
  >
    <div className={styles.body}>
      <form className={styles.search} onSubmit={(event) => { event.preventDefault(); search() }}>
        <TextField aria-label="画像名で検索" placeholder="画像名で検索" value={input} onChange={(event) => setInput(event.target.value)} />
        <Button type="submit" disabled={confirming}>検索</Button>
      </form>
      <div className={styles.listHeading}>
        <span>{total === null ? '登録済みの画像 —件' : `登録済みの画像 ${total}件`}</span>
        <span>表示順：新しい順</span>
      </div>
      {loading ? <ListState kind="loading" title="登録メディアを読み込んでいます" /> : null}
      {error ? <Notice tone="danger" action={!confirming && total === null ? <Button onClick={() => setRetry((value) => value + 1)}>読み直す</Button> : undefined}>{error}</Notice> : null}
      {!loading && !error && items.length === 0 ? <ListState kind="empty" title={query ? `「${query}」に合う画像がありません` : '選べる画像がありません'} description={query ? '別の名前で検索してください。' : '先に登録メディアへ画像を追加してください。'} /> : null}
      {!loading && items.length > 0 ? <>
        <div className={styles.list} role="radiogroup" aria-label="登録メディアの画像">
          {items.map((item) => <button
            key={item.id} type="button" role="radio" aria-checked={selected?.id === item.id}
            className={styles.item} data-selected={selected?.id === item.id || undefined}
            onClick={() => setSelected(item)} disabled={confirming}
          >
            <img src={api.media.contentUrl(item.id, accountId)} alt="" width={72} height={72} />
            <span className={styles.itemText}><strong title={item.filename}>{item.filename}</strong><small>画像 · {registeredAt(item.createdAt)} 登録</small></span>
            <span className={styles.radio} aria-hidden="true">{selected?.id === item.id ? '✓' : ''}</span>
          </button>)}
        </div>
        <div className={styles.pagination}>
          <span>{first}–{last} / {total}件</span>
          <Pagination page={page} pageCount={Math.ceil((total ?? 0) / PAGE_SIZE)} onPageChange={changePage} ariaLabel="登録メディアのページ送り" disabled={confirming} mode="cursor" />
        </div>
      </> : null}
    </div>
  </Dialog>
}
