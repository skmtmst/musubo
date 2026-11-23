'use client'

import { useEffect, useRef, useState } from 'react'
import { api } from '@/lib/api'
import Button from './button'
import { EntityPickerField, type EntityPickerItem } from './entity-picker'

type Props = {
  accountId: string | null
  label: string
  id?: string
  names?: Record<string, string>
  disabled?: boolean
  error?: string
  maxSelected?: number
} & ({ multiple: true; value: string[]; onChange: (ids: string[], names: Record<string, string>) => void }
  | { multiple?: false; value: string; onChange: (id: string) => void })

/** 友だちは窓を開いてから検索。検索の続きと選んだ名前を同じアカウント内だけで保持する。 */
export default function FriendPickerField(props: Props) {
  return <ScopedFriendPicker key={props.accountId ?? ''} {...props} />
}

function ScopedFriendPicker(props: Props) {
  const [active, setActive] = useState(false)
  const [query, setQuery] = useState('')
  const [offset, setOffset] = useState(0)
  const [retry, setRetry] = useState(0)
  const [result, setResult] = useState<{ query: string; offset: number; items: EntityPickerItem[]; total: number }>()
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const names = useRef<Record<string, string>>({ ...props.names })
  useEffect(() => {
    if (!active || !props.accountId) return
    let current = true
    setLoading(true)
    setFailed(false)
    const timer = window.setTimeout(() => {
      void api.friends.list({ accountId: props.accountId!, search: query.trim(), limit: 20, offset: String(offset), includeTags: false }).then((response) => {
        if (!current) return
        if (!response.success) throw new Error('friends')
        const items = response.data.items.map((friend) => ({ id: friend.id, name: friend.displayName || '名前未登録' }))
        for (const item of items) names.current[item.id] = item.name
        setResult((previous) => ({ query, offset, items: offset && previous?.query === query ? [...new Map([...previous.items, ...items].map((item) => [item.id, item])).values()] : items, total: response.data.total }))
      }).catch(() => { if (current) setFailed(true) }).finally(() => { if (current) setLoading(false) })
    }, 250)
    return () => { current = false; window.clearTimeout(timer) }
  }, [active, props.accountId, query, offset, retry])
  const pending = active && (loading || (!failed && (result?.query !== query || result.offset !== offset)))
  const ids = props.multiple ? props.value : props.value ? [props.value] : []
  const visible = result?.query === query ? result.items : []
  const items = [...visible.map((item) => ({ ...item, keywords: query })),  ...ids.filter((id) => !visible.some((row) => row.id === id)).map((id) => ({ id, name: props.names?.[id] ?? names.current[id] ?? '設定済みの友だち', disabled: !names.current[id] && !props.names?.[id] }))]
  const common = {
    id: props.id, label: props.label, noun: '友だち', items, disabled: props.disabled || !props.accountId,
    invalid: Boolean(props.error), onOpen: () => setActive(true), query,
    onQueryChange: (value: string) => { setQuery(value); setOffset(0) },
    state: pending ? <p role="status">友だちを探しています…</p> : failed ? <div role="alert"><p>友だちを読み込めませんでした。</p><Button onClick={() => setRetry((value) => value + 1)}>もう一度読み込む</Button></div> : undefined,
    listFooter: result && result.total > result.items.length ? <Button disabled={pending} onClick={() => setOffset(result.items.length)}>続きを読み込む</Button> : undefined,
  }
  return <>
    {props.multiple ? <EntityPickerField {...common} multiple value={props.value} maxSelected={props.maxSelected} onChange={(ids) => props.onChange(ids, { ...props.names, ...names.current })} />
      : <EntityPickerField {...common} value={props.value} onChange={props.onChange} />}
    {props.error ? <p role="alert" className="text-caption">{props.error}</p> : null}
  </>
}
