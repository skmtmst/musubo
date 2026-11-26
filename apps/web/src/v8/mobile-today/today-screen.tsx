'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import MobileScreen from '@/components/mobile/mobile-screen'
import { useMobileShell } from '@/components/mobile/mobile-shell'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import StatusBadge from '@/components/shared/status-badge'
import { MobileCard, MobileCardList, MobileSection } from '@/components/templates'
import { useAccount } from '@/contexts/account-context'
import { useAccountStyle } from '@/hooks/use-account-style'
import { bookingApi } from '@/lib/api'
import { formatTime } from '@/lib/format'
import { jstDate } from '@/lib/jst-datetime'
import { useFeatureVisibility } from '@/lib/use-feature-visibility'
import { restaurantTestApi } from '@/lib/restaurant-test-api'
import styles from './today.module.css'

type Item = { id: string; startsAt: string; name: string; detail: string; status: string; visited: boolean; departed: boolean; hold: boolean }
type Result = { accountId: string; rows: Item[]; limited: boolean } | { accountId: string; failed: true } | { accountId: string; noStore: true }
function stateOf(row: Item): { label: string; tone: 'neutral' | 'success' | 'caution' | 'danger' } {
  if (row.departed) return { label: '退店済み', tone: 'neutral' }
  if (row.visited || row.status === 'seated' || row.status === 'visited') return { label: '来店済み', tone: 'success' }
  if (row.hold) return { label: '押さえ', tone: 'neutral' }
  if (row.status === 'requested' || row.status === 'pending') return { label: '承認待ち', tone: 'caution' }
  if (row.status === 'confirmed') return { label: '予約中', tone: 'neutral' }
  if (row.status === 'completed') return { label: '完了', tone: 'neutral' }
  if (row.status === 'no_show') return { label: '無断キャンセル', tone: 'danger' }
  if (row.status === 'cancelled') return { label: '取消', tone: 'neutral' }
  return { label: '状況を確認', tone: 'neutral' }
}
export default function MobileTodayScreen() {
  return <MobileScreen title="今日" permission="/booking/bookings"><TodayBody /></MobileScreen>
}
function TodayBody() {
  const { selectedAccountId } = useAccount()
  const shell = useMobileShell()
  const style = useAccountStyle(selectedAccountId)
  const styleKind = style.data?.style
  const features = useFeatureVisibility(selectedAccountId)
  const featureEnabled = styleKind === 'restaurant' ? features.enabled('restaurant_test') : features.enabled('booking')
  const [result, setResult] = useState<Result | null>(null)
  const sequence = useRef(0)
  const allowed = shell.ready && shell.canView('/booking/bookings')
  const load = useCallback(async () => {
    if (!selectedAccountId || !allowed || !styleKind || style.stale || features.status !== 'ready' || !featureEnabled) return
    const id = selectedAccountId, request = ++sequence.current, date = jstDate(new Date())
    setResult(null)
    try {
      let rows: Item[], limited = false
      if (styleKind === 'restaurant') {
        const storesResponse = await restaurantTestApi.listStores(id)
        if (!storesResponse.success || !Array.isArray(storesResponse.data?.stores)) throw new Error('stores unavailable')
        const stores = storesResponse.data.stores.filter(store => store.line_account_id === id && store.status !== 'archived')
        if (!stores.length) { if (sequence.current === request) setResult({ accountId: id, noStore: true }); return }
        const days = await Promise.all(stores.map(store => restaurantTestApi.reservationsDay(id, store.id, date)))
        if (days.some(day => !day.success || !Array.isArray(day.data?.reservations))) throw new Error('reservations unavailable')
        rows = days.flatMap((day, index) => day.data.reservations.filter(row => !['cancelled', 'rejected', 'expired'].includes(row.status)).map(row => ({
          id: `${stores[index].id}-${row.id}`, startsAt: row.starts_at, name: row.customer_name || '名前未登録',
          detail: [stores[index].name, `${row.guest_count}人`, row.course_name].filter(Boolean).join('・'),
          status: row.status, visited: Boolean(row.arrived_at), departed: Boolean(row.departed_at), hold: row.status === 'pending' && Boolean(row.hold_expires_at),
        }))).sort((a, b) => a.startsAt.localeCompare(b.startsAt))
      } else {
        const data = await bookingApi.getToday(id, { date, mode: 'staff' })
        if (!Array.isArray(data.timeline)) throw new Error('timeline unavailable')
        limited = data.timeline.length >= 200
        rows = data.timeline.map(row => ({
          id: `${row.kind}-${row.id}`, startsAt: row.starts_at, name: row.customer_name || '名前未登録',
          detail: row.kind === 'seat' ? [row.store_name, `${row.guest_count}人`, row.course_name].filter(Boolean).join('・') : [row.menu_name, row.staff_name].filter(Boolean).join('・'),
          status: row.status, visited: row.visit_mark?.kind === 'visited', departed: false, hold: false,
        }))
      }
      if (sequence.current === request) setResult({ accountId: id, rows, limited })
    } catch { if (sequence.current === request) setResult({ accountId: id, failed: true }) }
  }, [selectedAccountId, allowed, styleKind, style.stale, features.status, featureEnabled])
  useEffect(() => {
    void load()
    let day = jstDate(new Date())
    const refreshDay = () => { const next = jstDate(new Date()); if (next !== day) { day = next; void load() } }
    const timer = window.setInterval(refreshDay, 60_000)
    window.addEventListener('focus', refreshDay)
    return () => { sequence.current += 1; window.clearInterval(timer); window.removeEventListener('focus', refreshDay) }
  }, [load])
  if (style.status === 'error' || style.stale) return <ListState kind="error" title="表示の設定を読み込めませんでした" onRetry={style.reload} />
  if (features.status === 'error') return <ListState kind="error" title="利用できる機能を読み込めませんでした" description="画面を開き直してください。" />
  if (style.status !== 'ready' || features.status !== 'ready') return <ListState kind="loading" title="表示の設定を読み込んでいます" />
  if (!featureEnabled) return <ListState kind="empty" title="このアカウントでは予約機能を利用できません" description="利用できる機能を確認してください。" />
  const current = result?.accountId === selectedAccountId ? result : null
  if (!current) return <ListState kind="loading" title="今日の予約を読み込んでいます" />
  if ('noStore' in current) return <ListState kind="empty" title="このアカウントの店舗はまだありません" description="店舗の設定を確認してください。" />
  if ('failed' in current) return <ListState kind="error" title="今日の予約を読み込めませんでした" onRetry={() => { void load() }} />
  if (!current.rows.length) return <ListState kind="empty" emptyPreset="readonly" title="今日の予約はありません" />
  return <MobileSection title="今日の予約" count={current.limited ? null : current.rows.length} action={current.limited ? <Button href="/booking/bookings" variant="text" size="compact">先頭200件・PC で確認</Button> : null}>
    <MobileCardList label="今日の予約">
      {current.rows.map(row => { const state = stateOf(row); return <MobileCard key={row.id}>
        <div className={styles.row}>
          <div className={styles.heading}><time dateTime={row.startsAt}>{formatTime(row.startsAt)}</time><StatusBadge size="compact" tone={state.tone}>{state.label}</StatusBadge></div>
          <strong className={styles.name} title={row.name}>{row.name}</strong>
          <span className={styles.detail}>{row.detail}</span>
        </div>
      </MobileCard> })}
    </MobileCardList>
  </MobileSection>
}
