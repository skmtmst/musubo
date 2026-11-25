'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy } from 'lucide-react'
import { restaurantMenuLiffToken, restaurantMenuLiffUrl } from '@line-crm/shared'
import Button from '@/components/shared/button'
import CopyTextButton from '@/components/shared/copy-text-button'
import { Field } from '@/components/shared/form-controls'
import Select from '@/components/shared/select'
import TextLink from '@/components/shared/text-link'
import { restaurantTestApi, type RestaurantStore } from '@/lib/restaurant-test-api'

export const RESTAURANT_MENU_ACTION = 'restaurant_menu'
export const RESTAURANT_MENU_DRAFT_URL = 'https://liff.line.me/{{liff_id}}/?page=restaurant-menu'

type Props = {
  accountId: string
  liffId: string | null
  uri: string
  readOnly: boolean
  provisionOnSelect: boolean
  onUrl: (uri: string) => void
}

function reservationToken(url: string, liffId: string) {
  const link = new URL(url)
  if (link.searchParams.get('page') !== 'restaurant') throw new Error('INVALID_RESTAURANT_LINK')
  link.searchParams.set('page', 'restaurant-menu')
  const token = restaurantMenuLiffToken(link.href, liffId)
  if (!token) throw new Error('INVALID_RESTAURANT_LINK')
  return token
}

export default function RestaurantMenuAction({ accountId, liffId, uri, readOnly, provisionOnSelect, onUrl }: Props) {
  const [stores, setStores] = useState<RestaurantStore[] | null>(null)
  const [storeError, setStoreError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState(false)
  const [failedStore, setFailedStore] = useState<RestaurantStore | null>(null)
  const request = useRef(0)
  const saveUrl = useRef(onUrl)
  useEffect(() => { saveUrl.current = onUrl }, [onUrl])
  useEffect(() => () => { request.current += 1 }, [])

  useEffect(() => {
    if (!liffId) return
    let active = true
    setStores(null)
    setStoreError(false)
    void restaurantTestApi.listStores(accountId).then(({ data }) => {
      if (active) setStores(data.stores.filter(store => store.line_account_id === accountId && store.status === 'active'))
    }).catch(() => {
      if (active) setStoreError(true)
    })
    return () => { active = false }
  }, [accountId, liffId, attempt])

  const configure = useCallback(async (store: RestaurantStore) => {
    if (!liffId || readOnly) return
    const version = ++request.current
    setFailedStore(null)
    setPending(true)
    try {
      const token = store.reservation_token || reservationToken((await restaurantTestApi.reservationLink(accountId, store.id)).data.url, liffId)
      const url = restaurantMenuLiffUrl({ liffId, token })
      if (version !== request.current) return
      saveUrl.current(url)
      if (!store.reservation_token) {
        setStores(previous => previous?.map(item => item.id === store.id ? { ...item, reservation_token: token } : item) ?? null)
      }
    } catch {
      if (version === request.current) setFailedStore(store)
    } finally {
      if (version === request.current) setPending(false)
    }
  }, [accountId, liffId, readOnly])

  useEffect(() => {
    const onlyStore = stores?.length === 1 ? stores[0] : null
    if (uri === RESTAURANT_MENU_DRAFT_URL && onlyStore && (onlyStore.reservation_token || provisionOnSelect)) {
      void configure(onlyStore)
    }
  }, [configure, provisionOnSelect, stores, uri])

  const token = liffId ? restaurantMenuLiffToken(uri, liffId) : null
  const destination = token ? stores?.find(store => store.reservation_token === token) : null
  const options = stores?.map(store => ({ value: store.id, label: store.name })) ?? []
  const onlyStore = stores?.length === 1 ? stores[0] : null

  if (!liffId) {
    return <div className="space-y-2">
      <p className="text-ink-secondary text-xs">料理メニューを開くにはLIFFの設定が必要です。</p>
      {readOnly ? null : <TextLink inline href={`/accounts/detail?id=${encodeURIComponent(accountId)}`}>設定を開く</TextLink>}
    </div>
  }
  if (storeError) {
    return <div className="space-y-2">
      <p role="alert" className="text-ink-secondary text-xs">対象店舗を読み込めませんでした。</p>
      <Button variant="secondary" onClick={() => setAttempt(previous => previous + 1)}>もう一度読み込む</Button>
    </div>
  }
  if (!stores) return <p role="status" className="text-ink-secondary text-xs">対象店舗を読み込んでいます。</p>
  if (!stores.length) return <p className="text-ink-secondary text-xs">このLINEアカウントで公開できる店舗がありません。</p>

  return <div className="border-hairline min-w-0 space-y-3 border-t pt-3">
    <Field label="対象店舗" optional={false}>
      {!readOnly && stores.length > 1
        ? <Select aria-label="対象店舗" size="full" value={destination?.id ?? ''} disabled={pending}
            options={[{ value: '', label: '店舗を選ぶ', disabled: true }, ...options]}
            onChange={id => {
              const store = stores.find(item => item.id === id)
              if (store) void configure(store)
            }} />
        : <p className="text-ink text-sm font-semibold">{destination?.name ?? onlyStore?.name ?? '—'}</p>}
    </Field>
    {pending ? <p role="status" className="text-ink-secondary text-xs">URLを設定しています。</p> : null}
    {failedStore ? <p role="alert" className="text-danger text-xs">料理メニューのURLを設定できませんでした。</p> : null}
    {!readOnly && !pending && (failedStore || (onlyStore && !destination))
      ? <Button variant="secondary" onClick={() => {
          const store = failedStore ?? onlyStore
          if (store) void configure(store)
        }}>{failedStore ? 'もう一度設定する' : 'URLを設定する'}</Button>
      : null}
    {uri !== RESTAURANT_MENU_DRAFT_URL && !destination && !pending
      ? <p role="alert" className="text-danger text-xs">このURLの対象店舗を確認できません。店舗を選び直してください。</p>
      : null}
    {destination && !pending ? <Field label="料理メニューのURL" optional={false}>
      <div className="rounded-control bg-surface-pearl flex min-w-0 flex-wrap items-center gap-2 px-3 py-1">
        <span className="text-ink-secondary min-w-0 flex-1 truncate text-xs" title={uri}>{uri}</span>
        <CopyTextButton value={uri} variant="secondary" label="コピーする" aria-label="料理メニューのURLをコピーする" icon={<Copy size={16} aria-hidden />} />
      </div>
      <p className="text-ink-secondary mt-2 text-xs">メニュー管理で公開した内容が、このURLに表示されます。</p>
    </Field> : null}
  </div>
}
