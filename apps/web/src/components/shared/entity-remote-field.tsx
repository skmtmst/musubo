'use client'

import { jstDate, jstDateOffset } from '@/lib/jst-datetime'

import { useEffect, useRef, useState } from 'react'
import { api, bookingApi, eventsApi, type CommonActionResources } from '@/lib/api'
import { EntityPickerField, type EntityPickerItem } from './entity-picker'
import { useMaybeAccount, ENTITY_KINDS, useEntityFolders, toPickerItems, type EntityKind } from './entity-picker-data'
import ListState from './list-state'

export type RemoteEntityKind = 'form' | 'tracked_link' | 'booking_menu' | 'event' | 'tag' | 'scenario' | 'template' | 'webhook' | 'rich_menu' | 'friend_field' | 'conversion' | 'automation'
const RESOURCE_KEYS = { tag: 'tags', scenario: 'scenarios', template: 'templates', webhook: 'webhooks', rich_menu: 'richMenus' } as const

/** 既存の候補取得APIだけを使う。イベントは最後のページまで読む。 */
export async function loadEntityCandidates(kind: RemoteEntityKind, accountId: string): Promise<EntityPickerItem[]> {
  if (kind === 'tag') {
    const response = await api.tags.list({ accountId })
    if (!response.success) throw new Error('タグを読み込めませんでした')
    return toPickerItems('tag', response.data)
  }
  if (kind === 'friend_field') {
    const response = await api.friendFields.list(accountId)
    if (!response.success) throw new Error('友だち情報欄を読み込めませんでした')
    return response.data.map((row) => ({ id: row.id, name: row.name }))
  }
  if (kind === 'automation') {
    const response = await api.automations.list({ accountId })
    if (!response.success) throw new Error('ルールを読み込めませんでした')
    return response.data.map((row) => ({ id: row.id, name: row.name }))
  }
  if (kind === 'conversion') {
    const to = jstDate()
    const from = jstDateOffset(-365)
    const items: EntityPickerItem[] = []
    let cursor: string | undefined
    do {
      const response = await api.conversions.definitions({ lineAccountId: accountId, from, to, sort: 'name_asc', limit: 100, cursor })
      if (!response.success) throw new Error('成果地点を読み込めませんでした')
      items.push(...response.data.items.filter((row) => row.status !== 'stopped').map((row) => ({ id: row.id, name: row.name })))
      const next = response.data.pagination?.nextCursor ?? undefined
      if (next && next === cursor) throw new Error('候補の続きを読み込めませんでした')
      cursor = next
    } while (cursor)
    return items
  }
  if (kind === 'booking_menu') {
    const response = await bookingApi.listMenus(accountId)
    return response.menus.map((row) => ({ id: row.id, name: row.name }))
  }
  if (kind === 'event') {
    const rows: EntityPickerItem[] = []
    for (let page = 1; ; page += 1) {
      const response = await eventsApi.listEvents(accountId, { page, limit: 100 })
      if (!response.items.length && rows.length < response.total) throw new Error('候補を最後まで読み込めませんでした')
      rows.push(...response.items.map((row) => ({ id: row.id, name: row.name, folderId: row.folderId })))
      if (rows.length >= response.total || !response.items.length) return rows
    }
  }
  if (kind === 'tracked_link') {
    const response = await api.trackedLinks.list(accountId)
    if (!response.success) throw new Error('計測リンクを読み込めませんでした')
    return response.data.map((row) => ({ id: row.id, name: row.name }))
  }
  if (kind === 'form') {
    const response = await api.forms.list(accountId)
    if (!response.success) throw new Error('回答フォームを読み込めませんでした')
    return toPickerItems('form', response.data)
  }
  const response = await api.commonActions.resources(accountId)
  if (!response.success) throw new Error('候補を読み込めませんでした')
  const rows: CommonActionResources[typeof RESOURCE_KEYS[typeof kind]] = response.data[RESOURCE_KEYS[kind]]
  return toPickerItems(kind, rows)
}

/** IDを手入力していた欄を、同じIDを返す選ぶ窓にする。 */
export default function EntityRemoteField({ kind, label, value, onChange, accountId: givenAccountId, emptyLabel, disabled, id, valueMode = 'id' }: {
  kind: RemoteEntityKind
  label: string
  value: string
  onChange: (id: string) => void
  accountId?: string | null
  valueMode?: 'id' | 'name'
  emptyLabel?: string
  disabled?: boolean
  id?: string
}) {
  const account = useMaybeAccount()
  const accountId = givenAccountId ?? account?.selectedAccountId ?? null
  const key = `${accountId ?? ''}:${kind}`
  const currentKey = useRef(key)
  currentKey.current = key
  const request = useRef(0)
  useEffect(() => () => { request.current += 1 }, [])
  const [data, setData] = useState<{ key: string; rows: EntityPickerItem[]; status: 'loading' | 'ready' | 'error'; error?: unknown } | null>(null)
  const extraNouns = { tracked_link: '計測リンク', friend_field: '友だち情報欄', conversion: '成果地点', automation: 'ルール' }
  const entityKind = kind in ENTITY_KINDS ? kind as EntityKind : 'staff'
  const def: { noun: string; createHref?: string; createLabel?: string } = kind in extraNouns ? { noun: extraNouns[kind as keyof typeof extraNouns] } : ENTITY_KINDS[entityKind]
  const { folders, failed, load: loadFolders } = useEntityFolders(entityKind, accountId)
  const load = () => {
    if (!accountId) return
    const token = ++request.current
    setData({ key, rows: [], status: 'loading' })
    loadFolders()
    void loadEntityCandidates(kind, accountId).then((rows) => {
      if (request.current === token && currentKey.current === key) setData({ key, rows, status: 'ready' })
    }).catch((error: unknown) => {
      if (request.current === token && currentKey.current === key) setData({ key, rows: [], status: 'error', error })
    })
  }
  const current = data?.key === key ? data : null
  const rows = current?.status === 'ready' ? (valueMode === 'name' ? [...new Map(current.rows.map((row) => [row.name, { ...row, id: row.name }])).values()] : current.rows) : value ? [{ id: value, name: '設定済み（開いて確認）', disabled: true }] : []
  const state = !current || current.status === 'loading' ? <ListState kind="loading" />
    : current.status === 'error' ? <ListState kind="error" error={current.error} onRetry={load} /> : undefined
  return <EntityPickerField key={key} label={label} noun={def.noun} id={id} value={value} onChange={onChange}
    candidatesStatus={current?.status}
    createHref={def.createHref} createLabel={def.createLabel}
    items={emptyLabel ? [{ id: '', name: emptyLabel }, ...rows] : rows} folders={folders} foldersFailed={failed}
    disabled={disabled || !accountId} onOpen={load} state={state} placeholder={emptyLabel} />
}
