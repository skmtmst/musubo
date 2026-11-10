'use client'

import { jstDayStartIso } from '@/lib/jst-datetime'


/*
 * 「今日のお店」（E-1）が読む物をまとめて取る。
 *  - snapshot（店舗・卓・今日の予約の範囲）… 店舗と卓。
 *  - reservationsDay（選んでいる店の今日）… 今日の予約の表と数。30秒ごとに読み直す。
 *  - channels＋media-links … 予約サイト・グルメ媒体の一覧（名前と、設定で保存した店舗ページ・管理画面の URL）。
 *  - channel-close-tasks … 他の予約サイトの枠を閉じる知らせ。
 *  - openingHours … 営業時間（説明の行）。
 *  - Google の接続と未返信の口コミ。
 * どれかが読めなくても、読めた物だけで出す（読めなかった段は「読み込めませんでした」）。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { RestaurantChannelCloseTask, RestaurantOpeningDay } from '@line-crm/shared'
import { fetchApi } from '@/lib/api'
import { restaurantGoogleApi, type GoogleConnectionData, type GoogleReview } from '@/lib/restaurant-google-api'
import {
  restaurantTestApi,
  type RestaurantReservation,
  type RestaurantRotation,
  type RestaurantSnapshot,
  type RestaurantStore,
} from '@/lib/restaurant-test-api'
import { useTableDefinition } from '../booking-kit/use-table-definition'
import type { RestaurantTableDefinition } from '../booking-kit/table-definition'
import { toYmd } from '@/v8/restaurant/front-desk/public/slots/index'

/** 予約サイト・グルメ媒体の1行。リンク（店舗ページ・管理画面）は「予約サイト・グルメ媒体」の設定（media-links）で保存したもの。 */
export type StoreMedium = {
  code: string
  name: string
  storePageUrl?: string | null
  adminUrl?: string | null
}

type ChannelRow = { code: string; name: string; receiveMethod?: string; storePageUrl?: string | null; adminUrl?: string | null }

export type StoreToday = {
  accountId: string
  tableDefinition?: RestaurantTableDefinition
  snapshot: RestaurantSnapshot | null
  store: RestaurantStore | null
  today: RestaurantReservation[] | null
  rotation: RestaurantRotation | null
  media: StoreMedium[] | null
  closeTasks: RestaurantChannelCloseTask[] | null
  hours: RestaurantOpeningDay[] | null
  google: GoogleConnectionData | null
  latestReview: GoogleReview | null
  /** いちばん古い未返信の口コミ（「最長 N日前」）。 */
  oldestReview: GoogleReview | null
  loading: boolean
  error: unknown
  updatedAt: Date | null
  reload: () => Promise<void>
}

/** 受信の口だけの物（手入力・レストランボード・レス在庫）は媒体の一覧に出さない。 */
export function toMedia(rows: ChannelRow[]): StoreMedium[] {
  return rows
    .filter((row) => row.receiveMethod !== 'manual' && row.receiveMethod !== 'direct')
    .map((row) => ({ code: row.code, name: row.name, storePageUrl: row.storePageUrl ?? null, adminUrl: row.adminUrl ?? null }))
}

type MediaLinkRow = { code: string; name: string; pageUrl: string | null; loginUrl: string | null }

/**
 * 受け取りの一覧（channels）に、設定で保存した店舗ページ・管理画面の URL（media-links）を重ねる。
 * 受け取りの一覧に無いグルメ媒体（予約を受けない）も、URL があれば末尾に足す。
 */
export function mergeMediaLinks(media: StoreMedium[], links: MediaLinkRow[]): StoreMedium[] {
  const byCode = new Map(links.map((link) => [link.code, link]))
  const merged = media.map((m) => {
    const link = byCode.get(m.code)
    return link ? { ...m, name: link.name || m.name, storePageUrl: link.pageUrl ?? m.storePageUrl ?? null, adminUrl: link.loginUrl ?? m.adminUrl ?? null } : m
  })
  for (const link of links) {
    if (media.some((m) => m.code === link.code)) continue
    if (!link.pageUrl && !link.loginUrl) continue
    merged.push({ code: link.code, name: link.name, storePageUrl: link.pageUrl, adminUrl: link.loginUrl })
  }
  return merged
}

/** 店の媒体（名前＋保存した URL）。両方を確認し、取得失敗は呼び出し側へ渡す。 */
export async function loadStoreMedia(accountId: string, storeId: string): Promise<StoreMedium[]> {
  const [channels, links] = await Promise.all([
    fetchApi<{ success: true; data: ChannelRow[] }>(`/api/restaurant-test/channels?account_id=${encodeURIComponent(accountId)}&storeId=${encodeURIComponent(storeId)}`)
      .then((res) => toMedia(res.data)),
    Promise.resolve().then(() => restaurantTestApi.mediaLinks(accountId, storeId)).then((res) => res.data as MediaLinkRow[]),
  ])
  return mergeMediaLinks(channels, links)
}

export function useStoreToday(accountId: string | null): StoreToday {
  const [snapshot, setSnapshot] = useState<RestaurantSnapshot | null>(null)
  const [storeId, setStoreId] = useState('')
  const { begin, accept, tableDefinition } = useTableDefinition(accountId, snapshot)
  const [today, setToday] = useState<RestaurantReservation[] | null>(null)
  const [rotation,setRotation]=useState<RestaurantRotation|null>(null)
  const [media, setMedia] = useState<StoreMedium[] | null>(null)
  const [closeTasks, setCloseTasks] = useState<RestaurantChannelCloseTask[] | null>(null)
  const [hours, setHours] = useState<RestaurantOpeningDay[] | null>(null)
  const [google, setGoogle] = useState<GoogleConnectionData | null>(null)
  const [latestReview, setLatestReview] = useState<GoogleReview | null>(null)
  const [oldestReview, setOldestReview] = useState<GoogleReview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

  const range = useMemo(() => {
    const now = new Date()
    return { from: jstDayStartIso(now), to: jstDayStartIso(now, 1) }
  }, [])

  /* 店舗：選んでいる店舗（store-context）→ 無ければ先頭。 */
  const loadSnapshot = useCallback(async () => {
    const definitionRequest = begin(accountId)
    if (!accountId) { setSnapshot(null); setLoading(false); return }
    setLoading(true)
    try {
      const [snap, context] = await Promise.all([
        restaurantTestApi.snapshot(accountId, { from: range.from, to: range.to, limit: 500, offset: 0 }),
        restaurantTestApi.storeContext(accountId).catch(() => null),
      ])
      setSnapshot(snap.data)
      accept(definitionRequest, snap.data)
      const selected = context?.data.selectedStore?.id
      setStoreId(snap.data.stores.some((s) => s.id === selected) ? selected! : snap.data.stores[0]?.id ?? '')
      setError(null)
    } catch (caught) {
      setError(caught)
    } finally {
      setLoading(false)
    }
  }, [accountId, range, begin, accept])

  const loadStore = useCallback(async () => {
    if (!accountId || !storeId) return
    const day = toYmd(new Date())
    try {
      const [rotation, reservations, media, tasks] = await Promise.all([
        Promise.resolve().then(()=>restaurantTestApi.rotation(accountId,storeId,day)).then(r=>r.data).catch(()=>null),
        restaurantTestApi.reservationsDay(accountId, storeId, day),
        loadStoreMedia(accountId, storeId),
        restaurantTestApi.channelCloseTasks(accountId, storeId),
      ])
      if (!Array.isArray(reservations.data?.reservations) || !Array.isArray(tasks.data)) throw new Error('invalid_store_response')
      setRotation(rotation); setToday(reservations.data.reservations); setMedia(media); setCloseTasks(tasks.data)
      setError(null); setUpdatedAt(new Date())
    } catch (caught) { setError(caught) }

  }, [accountId, storeId])

  useEffect(() => { void loadSnapshot() }, [loadSnapshot])

  useEffect(() => {
    let current = true
    if (!accountId || !storeId) return
    void loadStore()
    const loadHours = () => restaurantTestApi.openingHours(accountId, storeId, toYmd(new Date()))
      .then((res) => { if (current) setHours(res.data.hours ?? null) })
      .catch(() => { if (current) setHours(null) })
    void loadHours()
    const timer = setInterval(() => { void loadStore(); void loadHours() }, 30_000)
    return () => { current = false; clearInterval(timer) }
  }, [accountId, storeId, loadStore])

  useEffect(() => {
    let current = true
    if (!accountId) return
    void restaurantGoogleApi.connection(accountId).then((res) => {
      if (!current) return
      setGoogle(res)
      if (res.connection.status === 'connected' && res.summary.unrepliedCount > 0) {
        void restaurantGoogleApi.listReviews(accountId, { filter: 'unreplied', order: 'newest', perPage: 1 })
          .then((list) => { if (current) setLatestReview(list.reviews[0] ?? null) })
          .catch(() => { /* 口コミが読めないときは件数だけ出す */ })
        void restaurantGoogleApi.listReviews(accountId, { filter: 'unreplied', order: 'oldest', perPage: 1 })
          .then((list) => { if (current) setOldestReview(list.reviews[0] ?? null) })
          .catch(() => { /* 古さが読めないときは札を出さない */ })
      }
    }).catch(() => { if (current) setGoogle(null) })
    return () => { current = false }
  }, [accountId])

  const store = snapshot?.stores.find((s) => s.id === storeId) ?? null

  const reload = useCallback(async () => { await loadSnapshot(); await loadStore() }, [loadSnapshot,loadStore])

  return { accountId: accountId ?? '', tableDefinition, snapshot, store, today, rotation, media, closeTasks, hours, google, latestReview, oldestReview, loading, error, updatedAt, reload }
}
