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

type MediaLoadState =
  | { accountId: string; status: 'loading' }
  | { accountId: string; status: 'ready'; items: MediaItem[]; total: number }
  | { accountId: string; status: 'error'; error: string }

export function PostMediaPickerDialog({ target, accountId, onClose, onSelect }: {
  target: CropTarget
  accountId: string
  onClose: () => void
  onSelect: (item: MediaItem) => Promise<void>
}) {
  const [searchState, setSearchState] = useState({ accountId, input: '', query: '', page: 1 })
  const [selectedState, setSelectedState] = useState<{ accountId: string; item: MediaItem } | null>(null)
  const [loadState, setLoadState] = useState<MediaLoadState>({ accountId, status: 'loading' })
  const [selectError, setSelectError] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [retry, setRetry] = useState(0)
  const request = useRef(0)
  const accountRef = useRef(accountId)
  accountRef.current = accountId
  const applySeq = useRef(0)
  const confirmingRef = useRef(false)
  const aliveRef = useRef(true)

  const activeSearch = searchState.accountId === accountId
    ? searchState
    : { accountId, input: '', query: '', page: 1 }
  const { input, query, page } = activeSearch
  const selected = selectedState?.accountId === accountId ? selectedState.item : null

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      applySeq.current += 1
      confirmingRef.current = false
    }
  }, [])

  useEffect(() => {
    applySeq.current += 1
    confirmingRef.current = false
    setConfirming(false)
    setSelectError('')
  }, [accountId])

  useEffect(() => {
    const current = ++request.current
    setLoadState({ accountId, status: 'loading' })
    setSelectError('')
    api.media.list(accountId, {
      kind: 'image', query: query || undefined, sort: 'newest',
      limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
    }).then((response) => {
      if (request.current !== current) return
      if (!response.success) throw new ApiError(500, response.error)
      if (!Array.isArray(response.data?.items)) throw new ApiError(500, 'invalid_media_response')
      setLoadState({
        accountId,
        status: 'ready',
        items: response.data.items.filter((item) => item.kind === 'image' && (item.lineAccountId === accountId || item.lineAccountId == null)),
        total: response.data.total,
      })
    }).catch((cause) => {
      if (request.current !== current) return
      setLoadState({ accountId, status: 'error', error: errorMessage(cause, '登録メディアを読み込めませんでした。') })
    })
    return () => { request.current += 1 }
  }, [accountId, query, page, retry])

  const scopedLoad: MediaLoadState = loadState.accountId === accountId ? loadState : { accountId, status: 'loading' }
  const effectiveLoading = scopedLoad.status === 'loading'
  const loadError = scopedLoad.status === 'error' ? scopedLoad.error : ''
  const visibleItems = scopedLoad.status === 'ready' ? scopedLoad.items : []
  const visibleTotal = scopedLoad.status === 'ready' ? scopedLoad.total : null
  const error = loadError || selectError

  const search = () => {
    setSelectedState(null)
    setSearchState({ accountId, input, query: input.trim(), page: 1 })
  }
  const changePage = (next: number) => {
    setSelectedState(null)
    setSearchState((current) => ({
      ...(current.accountId === accountId ? current : { accountId, input: '', query: '', page: 1 }),
      page: next,
    }))
  }
  const applySelection = async () => {
    if (!selected || confirmingRef.current || confirming || effectiveLoading) return
    const item = selected
    const requestAccount = accountId
    const seq = ++applySeq.current
    confirmingRef.current = true
    setConfirming(true)
    setSelectError('')
    try {
      await onSelect(item)
    } catch (cause) {
      if (aliveRef.current && applySeq.current === seq && accountRef.current === requestAccount) {
        setSelectError(errorMessage(cause, '画像を読み込めませんでした。もう一度お試しください。'))
      }
    } finally {
      if (aliveRef.current && applySeq.current === seq && accountRef.current === requestAccount) {
        confirmingRef.current = false
        setConfirming(false)
      }
    }
  }

  const title = target === 'google' ? 'Google用画像を登録メディアから選ぶ' : 'Instagram用画像を登録メディアから選ぶ'
  const first = (page - 1) * PAGE_SIZE + 1
  const last = Math.min(page * PAGE_SIZE, visibleTotal ?? 0)
  const confirmDisabledReason = !confirming && !effectiveLoading && !selected ? '画像を選んでください。' : undefined

  return <Dialog
    open title={title} headerIcon={false} dirty={false}
    description="保存済みの画像を選ぶと、次に切り取り位置を確認できます。"
    designNode="post-media-picker" designWidth={850} exactDesignWidth
    designHeaderPadding="28px 24px 22px"
    designContentPadding="22px 24px 24px"
    busy={confirming} busyLabel="画像を読み込み中…"
    onCancel={onClose}
    footer={<DialogActions leadingAction={<span>選択後、切り取り位置を確認します。</span>}>

      <Button onClick={onClose} disabled={confirming}>キャンセル</Button>
      <Button variant="primary" onClick={() => void applySelection()} disabled={!selected || effectiveLoading || confirming} disabledReason={confirmDisabledReason} busy={confirming} busyLabel="画像を読み込み中…">切り取り位置を確認</Button>
    </DialogActions>}
  >
    <div className={styles.body}>
      <form className={styles.search} onSubmit={(event) => { event.preventDefault(); search() }}>
        <TextField aria-label="画像名で検索" placeholder="画像名で検索" value={input} onChange={(event) => setSearchState((current) => ({
          ...(current.accountId === accountId ? current : { accountId, input: '', query: '', page: 1 }),
          input: event.target.value,
        }))} />
        <Button type="submit" disabled={confirming}>検索</Button>
      </form>
      <div className={styles.listHeading}>
        <span>{visibleTotal === null ? '登録済みの画像 —件' : `登録済みの画像 ${visibleTotal}件`}</span>
        <span>表示順：新しい順</span>
      </div>
      {effectiveLoading ? <ListState kind="loading" title="登録メディアを読み込んでいます" /> : null}
      {!effectiveLoading && error ? <Notice tone="danger" action={!confirming && visibleTotal === null ? <Button onClick={() => setRetry((value) => value + 1)}>読み直す</Button> : undefined}>{error}</Notice> : null}
      {!effectiveLoading && !error && visibleItems.length === 0 ? <ListState kind="empty" title={query ? `「${query}」に合う画像がありません` : '選べる画像がありません'} description={query ? '別の名前で検索してください。' : '先に登録メディアへ画像を追加してください。'} /> : null}
      {!effectiveLoading && visibleItems.length > 0 ? <>
        <div className={styles.list} role="radiogroup" aria-label="登録メディアの画像">
          {visibleItems.map((item) => <button
            key={item.id} type="button" role="radio" aria-checked={selected?.id === item.id}
            className={styles.item} data-selected={selected?.id === item.id || undefined}
            onClick={() => setSelectedState({ accountId, item })} disabled={confirming}
          >
            <img src={api.media.contentUrl(item.id, accountId)} alt="" width={72} height={72} />
            <span className={styles.itemText}><strong title={item.filename}>{item.filename}</strong><small>画像 · {registeredAt(item.createdAt)} 登録</small></span>
            <span className={styles.radio} aria-hidden="true">{selected?.id === item.id ? '✓' : ''}</span>
          </button>)}
        </div>
        <div className={styles.pagination}>
          <span>{first}–{last} / {visibleTotal}件</span>
          <Pagination page={page} pageCount={Math.ceil((visibleTotal ?? 0) / PAGE_SIZE)} onPageChange={changePage} ariaLabel="登録メディアのページ送り" disabled={confirming} mode="cursor" />
        </div>
      </> : null}
    </div>
  </Dialog>
}
