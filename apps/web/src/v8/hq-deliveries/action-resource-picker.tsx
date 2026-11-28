'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import { EntityPickerDialog } from '@/components/shared/entity-picker'
import { searchHqTemplateResources } from '@/lib/api/helpers/hq-resource-search'
import type { HqActionResource } from './auto-reply-actions-model'

/** HQ-scoped names only. Never fall back to the selected store's candidate API. */
export default function HqActionResourcePicker({ kind, onConfirm, onCancel }: {
  kind: 'tag' | 'scenario'; onConfirm: (item: HqActionResource) => void; onCancel: () => void
}) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<HqActionResource[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const request = useRef(0)
  const load = useCallback(async (q: string, next?: string) => {
    const id = ++request.current
    setLoading(true); setError('')
    if (!next) { setItems([]); setCursor(null) }
    try {
      const result = await searchHqTemplateResources({ kind, q, limit: 30, cursor: next })
      if (id !== request.current) return
      if (!result.success || result.data.kind !== kind) throw new Error('Invalid candidates')
      setItems(previous => next ? [...previous, ...result.data.items.map(item => ({ ...item, kind }))] : result.data.items.map(item => ({ ...item, kind })))
      setCursor(result.data.nextCursor)
    } catch {
      if (id !== request.current) return
      setError('候補を読み込めませんでした。権限と接続を確認して、もう一度お試しください。')
    } finally { if (id === request.current) setLoading(false) }
  }, [kind])
  const invalidate = useCallback(() => { request.current++ }, [])
  useEffect(() => { void load(query); return invalidate }, [query, load, invalidate])
  return <EntityPickerDialog title={`${kind === 'tag' ? 'タグ' : 'シナリオ'}を選ぶ`} description="配布先では同じ名前の設定へ結び付けます。店名を確認してください。"
    items={items.map(item => ({ id: item.id, name: item.name, meta: item.accountName }))} query={query} onQueryChange={setQuery}
    state={loading ? <p role="status">候補を読み込み中…</p> : error && items.length === 0 ? <Notice tone="warn">{error}</Notice> : undefined}
    error={error || undefined} confirmDisabled={loading || Boolean(error)}
    listFooter={error ? <Button onClick={() => void load(query, cursor ?? undefined)}>再読込</Button> : cursor ? <Button disabled={loading} onClick={() => void load(query, cursor)}>さらに表示する</Button> : null}
    onCancel={onCancel} onConfirm={id => { const item = items.find(candidate => candidate.id === id); if (item && !loading && !error) onConfirm(item) }} />
}
