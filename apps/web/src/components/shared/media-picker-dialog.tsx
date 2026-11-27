'use client'

import { knownValue } from '@/lib/known-value'

import { useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react'
import type { MediaItem } from '@line-crm/shared'
import { api } from '@/lib/api'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import Pagination from '@/components/shared/pagination'
import ListState from '@/components/shared/list-state'
import { TextField } from '@/components/shared/text-field'
import { formatNumber } from '@/lib/format'
import { usePermissionLockTip } from './permission-lock-tip'

/** 1ページに並べる候補数。検索と併用するので多すぎない数に抑える。 */
export const MEDIA_PICKER_PAGE_SIZE = 20

const KIND_LABEL: Record<MediaItem['kind'], string> = {
  image: '画像',
  video: '動画',
  audio: '音声',
  file: 'ファイル',
}

type Phase = 'loading' | 'ready' | 'empty' | 'error'

function MediaOption({ lockedReason, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { lockedReason?: string }) {
  const lock = usePermissionLockTip<HTMLButtonElement>(lockedReason, props['aria-describedby'])
  return <><button {...props} ref={lock.ref} {...lock.handlers} style={props.disabled || lockedReason ? {
    opacity: 'var(--polish-disabled-opacity)', cursor: 'not-allowed', background: 'var(--color-canvas-sunken)',
  } : undefined} />{lock.node}</>
}

/**
 * 登録メディアを別の機能から選ぶ共通の窓（N-193 / N-205）。
 *
 * 今まで app/contents・v8/template-edit・v8/form-edit に3つの写しがあったのを、
 * ここ1つにまとめた。画像を入れる所（media-slot）の「登録メディアから選ぶ」から開く。
 *
 * - 名前検索とページ送りを併用できる（検索すると1ページ目へ戻る）。
 * - 読込中・0件・失敗を分けて出す。失敗は「読み直す」でやり直せる。
 * - アカウントを切り替えたあとに遅れて届いた古い応答は捨てる。
 *   返ってきた候補のうち別アカウントのものも画面へ出さない
 *   （共有メディア lineAccountId=null はどのアカウントでも使えるので残す）。
 */
export default function MediaPickerDialog({
  open,
  accountId,
  kind,
  title = '登録メディアから選ぶ',
  description,
  accountOnly = false,
  onClose,
  onSelect,
  disabled,
  lockedReason,
  canSelectNow,
}: {
  open: boolean
  accountId: string | null
  /** 絞り込む種別。未指定なら全部並べる。 */
  kind?: MediaItem['kind']
  title?: string
  description?: string
  /** 写真など、共有メディアを認めない保存先では選択肢も同じ境界へ絞る。 */
  accountOnly?: boolean
  onClose: () => void
  onSelect: (item: MediaItem) => void
  /** 本人未確定時などは理由を出さず選択だけを止め、読む操作は残す。 */
  disabled?: boolean
  lockedReason?: string
  /** 選択直前に確かめる。失効した処理を再開しないleaseを渡す。 */
  canSelectNow?: () => boolean
}) {
  const selectionBlocked = Boolean(disabled || canSelectNow?.() === false)
  /** いま有効な要求。開き直し・切替・検索で番号を進め、遅れた応答を捨てる。 */
  const requestRef = useRef(0)
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<MediaItem[]>([])
  const [total, setTotal] = useState(0)
  const [phase, setPhase] = useState<Phase>('loading')
  const [reloadKey, setReloadKey] = useState(0)

  // 開き直すたびに前の状態を捨てる。古い候補が一瞬見えるのを防ぐ。
  useEffect(() => {
    if (!open) return
    requestRef.current += 1
    setInput('')
    setQuery('')
    setPage(1)
    setItems([])
    setTotal(0)
    setPhase('loading')
  }, [open])

  useEffect(() => {
    if (!open) return
    if (!accountId) {
      requestRef.current += 1
      setItems([])
      setTotal(0)
      setPhase('empty')
      return
    }
    const request = ++requestRef.current
    const requestedAccount = accountId
    setPhase('loading')
    api.media
      .list(requestedAccount, {
        kind,
        query: query || undefined,
        limit: MEDIA_PICKER_PAGE_SIZE,
        offset: (page - 1) * MEDIA_PICKER_PAGE_SIZE,
      })
      .then((response) => {
        if (requestRef.current !== request) return
        if (!response.success) {
          setPhase('error')
          return
        }
        // 別アカウントの候補は出さない。共有（null）はどのアカウントでも使える。
        const scoped = response.data.items.filter(
          (item) => item.lineAccountId === requestedAccount || (!accountOnly && item.lineAccountId == null),
        )
        setItems(scoped)
        setTotal(response.data.total)
        setPhase(scoped.length === 0 ? 'empty' : 'ready')
      })
      .catch(() => {
        if (requestRef.current !== request) return
        setPhase('error')
      })
  }, [open, accountId, accountOnly, kind, query, page, reloadKey])

  const search = () => {
    setPage(1)
    setQuery(input.trim())
  }

  const pageCount = Math.ceil(total / MEDIA_PICKER_PAGE_SIZE)

  return (
    <Dialog
      open={open}
      title={title}
      description={description ?? '登録済みのメディアから選んで、この画面の設定へ反映します。'}
      onCancel={onClose}
    >
      <div className="space-y-3" data-qa-media-picker>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            search()
          }}
        >
          <TextField
            aria-label="メディア名で検索"
            placeholder="名前で探す"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            className="flex-1"
          />
          <Button type="submit">検索</Button>
        </form>

        {phase === 'loading' ? (
          <ListState kind="loading" title="メディアを読み込んでいます" />
        ) : phase === 'error' ? (
          <ListState
            kind="error"
            title="メディアを読み込めませんでした"
            description="通信状態を確認して、もう一度お試しください。"
            onRetry={() => setReloadKey((key) => key + 1)}
          />
        ) : phase === 'empty' ? (
          <ListState
            kind="empty"
            title={
              accountId
                ? query
                  ? `「${query}」に合うメディアが見つかりませんでした`
                  : '選べるメディアがまだありません'
                : 'LINE公式アカウントを選んでください'
            }
            description={
              accountId
                ? query
                  ? '検索語を変えてください。'
                  : '先に登録メディアへ追加してください。'
                : '上のバーで選ぶと、ここに並びます。'
            }
          />
        ) : (
          <>
            <ul
              className="border-hairline rounded-control max-h-72 divide-y divide-hairline overflow-y-auto border"
              role="listbox"
              aria-label="メディア候補"
            >
              {items.map((item) => (
                <li key={item.id}>
                  <MediaOption disabled={selectionBlocked} lockedReason={lockedReason}
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="hover:bg-canvas-sunken focus:bg-canvas-sunken flex w-full items-center gap-3 px-3 py-2 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
                    onClick={() => { if (!disabled && !lockedReason && canSelectNow?.() !== false) onSelect(item) }}
                  >
                    {item.kind === 'image' && accountId ? (
                      <img width={40} height={40}
                        src={api.media.contentUrl(item.id, accountId)}
                        alt=""
                        className="border-hairline h-10 w-10 shrink-0 rounded-control border object-cover"
                      />
                    ) : (
                      <span className="border-hairline text-ink-faint flex h-10 w-10 shrink-0 items-center justify-center rounded-control border text-nano">
                        {knownValue(KIND_LABEL, item.kind, '種類を確認できません')}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="text-ink block truncate text-sm" title={item.filename}>
                        {item.filename}
                      </span>
                      <span className="text-ink-faint block text-micro">{knownValue(KIND_LABEL, item.kind, '種類を確認できません')}</span>
                    </span>
                  </MediaOption>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between text-xs">
              <span className="text-ink-faint">
                {formatNumber(total)}件{query ? `（「${query}」で絞り込み中）` : ''}
              </span>
              <Pagination
                page={page}
                pageCount={pageCount}
                onPageChange={setPage}
                ariaLabel="メディア候補のページ送り"
              />
            </div>
          </>
        )}
      </div>
    </Dialog>
  )
}
