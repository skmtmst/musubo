'use client'
import { useEffect, useRef, type KeyboardEvent } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import IconButton from '@/components/shared/icon-button'
import { CHAT_SEARCH_MAX_CHARS, type ChatSearch } from './use-chat-search'
import styles from './chat-search-bar.module.css'
import { formatNumber as polishFormatNumber } from '@/lib/format'
import SearchField from '@/components/shared/search-field'
import { ListToolbarFrame, ListToolbarSearchSlot } from '@/components/shared/list-toolbar'


/*
 * 会話の頭の下に差す「会話の中を探す」帯（V8.pen 枠  の f64Ok）。
 * 探す欄（緑の枠）・「n件中 m件目」・↑・↓・×。
 * Enter＝古い方（↑）、Shift+Enter＝新しい方（↓）、Esc＝閉じる。
 */

export function chatSearchCountText(search: Pick<ChatSearch, 'query' | 'status' | 'total' | 'index'>): string {
  if (!search.query.trim()) return ''
  if (search.status === 'loading') return '探しています…'
  if (search.status === 'error') return '探せませんでした'
  if (search.status !== 'ready') return ''
  if (search.total === 0) return '見つかりません'
  return `${polishFormatNumber(search.total)} 件中 ${polishFormatNumber((search.index + 1))} 件目`
}

export default function ChatSearchBar({ search, focusSeq = 0, busy = false }: {
  search: ChatSearch
  /** 増えたら探す欄へ入る（🔍・⌘F をもう一度押したとき） */
  focusSeq?: number
  /** 昔の吹き出しを読み込んでいる間 */
  busy?: boolean
}) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusSeq])

  const ready = search.status === 'ready' && search.total > 0
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      search.close()
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (event.shiftKey) search.newer()
      else search.older()
    }
  }
  const count = busy ? '読み込んでいます…' : chatSearchCountText(search)

  return (
    <ListToolbarFrame conversation role="search" aria-label="会話の中を探す" data-design-node="f64Ok">
      <ListToolbarSearchSlot flexible>
        <SearchField
          ref={inputRef}
          className={styles.field}
          value={search.query}
          maxLength={CHAT_SEARCH_MAX_CHARS}
          placeholder="会話の中を探す"
          aria-label="会話の中を探す"
          updateMode="immediate"
          onChange={search.setQuery}
          onKeyDown={onKeyDown}
        />
      </ListToolbarSearchSlot>
      <span className={styles.count} role="status" aria-live="polite">{count}</span>
      <IconButton
        aria-label="前の当たりへ（古い方）"
        disabled={!ready || busy || search.index <= 0}
        onClick={search.older}
      >
        <ChevronUp aria-hidden="true" />
      </IconButton>
      <IconButton
        aria-label="次の当たりへ（新しい方）"
        disabled={!ready || busy || search.index >= search.total - 1}
        onClick={search.newer}
      >
        <ChevronDown aria-hidden="true" />
      </IconButton>
      <IconButton aria-label="探すのをやめる" onClick={search.close}>
        <X aria-hidden="true" />
      </IconButton>
    </ListToolbarFrame>
  )
}
