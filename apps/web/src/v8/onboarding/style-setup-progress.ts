import { styleApi } from '@/lib/api/helpers/styles'
import { api, bookingApi, eventsApi } from '@/lib/api'
import { restaurantGoogleApi } from '@/lib/restaurant-google-api'
import { loadRestaurantSetupProgress, unknownRestaurantSetup } from './restaurant-setup-progress'
import type { AccountStyle } from '@line-crm/shared'
import type { StyleSetupProgress } from '@/v8/settings/public/getting-started-steps/index'

type Evidence = { complete: boolean | null; reason?: string }
const evidence = (complete: boolean | null, reason: string): Evidence => ({ complete, ...(complete === true ? {} : { reason }) })
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
const both = (...values: Array<boolean | null>): boolean | null => values.includes(false) ? false : values.includes(null) ? null : true
const either = (values: Array<boolean | null>): boolean | null => values.includes(true) ? true : values.includes(null) ? null : false
const read = async <T,>(load: () => Promise<T>): Promise<T | null> => { try { return await load() } catch { return null } }
const googleHoursEvidence = (accountId: string, response: Awaited<ReturnType<typeof restaurantGoogleApi.profile>> | null): Evidence => {
  if (!response) return evidence(null, 'Googleの営業時間を確認できませんでした')
  if (response.store.lineAccountId !== accountId) return evidence(null, '選択中の店舗の営業時間を確認できませんでした')
  return evidence(!response.closed && Object.values(response.profile.regularHours).some(periods => periods.length > 0),
    'Googleビジネスを接続し、営業時間を設定してください')
}
const loadGoogleHoursEvidence = async (accountId: string): Promise<Evidence> => {
  const connection = await read(() => restaurantGoogleApi.connection(accountId))
  if (!connection || connection.store.lineAccountId !== accountId) return evidence(null, 'Googleの接続状態を確認できませんでした')
  if (connection.connection.status !== 'connected' || !connection.connection.locationName) {
    return evidence(false, 'Googleビジネスを接続してください')
  }
  return googleHoursEvidence(accountId, await read(() => restaurantGoogleApi.profile(accountId)))
}

export function unknownStyleSetupProgress(style: AccountStyle, reason = '設定を確かめています'): StyleSetupProgress {
  if (style === 'restaurant') return unknownRestaurantSetup(reason)
  return { style, steps: Object.fromEntries(['attributes', 'friendAdd', 'scenario', 'hours'].map(key => [key, { complete: null, reason }])) }
}

/** 実設定のGETだけを読む。タグ・配信の済みや友だち総数を業種の設定へ代用しない。 */
export async function loadStyleSetupProgress(accountId: string, style: AccountStyle, storeId?: string | null): Promise<StyleSetupProgress> {
  if (style === 'standard') return { style, steps: { hours: await loadGoogleHoursEvidence(accountId) } }
  if (style === 'restaurant') {
    try { return await loadRestaurantSetupProgress(accountId, storeId) }
    catch { return unknownRestaurantSetup('店舗の設定を読み込めませんでした。もう一度読み直してください') }
  }
  if (style === 'salon' || style === 'consult') {
    const [menusResponse, staffResponse, accountResponse, googleHoursResponse] = await Promise.all([
      read(() => bookingApi.listMenus(accountId)), read(() => bookingApi.listStaff(accountId)),
      read(() => api.lineAccounts.get(accountId)),
      loadGoogleHoursEvidence(accountId),
    ])
    const menus = Array.isArray(menusResponse?.menus) ? menusResponse.menus.filter(menu => menu.is_active === 1) : null
    const staff = Array.isArray(staffResponse?.staff) ? staffResponse.staff.filter(person => person.is_active === 1) : null
    const hasMenus = menus === null ? null : menus.length > 0
    const hasStaff = staff === null ? null : staff.length > 0
    const linked = menus === null || staff === null ? null : either(menus.map(menu => Array.isArray(menu.assigned_staff) ? menu.assigned_staff.some(person => staff.some(active => active.id === person.id)) : null))
    const hours = googleHoursResponse.complete
    const account = accountResponse?.success && accountResponse.data.id === accountId ? accountResponse.data : null
    const bookingUrl = account && (account.liffId === null || typeof account.liffId === 'string') ? Boolean(account.liffId?.trim()) : null
    const slots = both(hasMenus, hasStaff, linked, hours)
    return { style, steps: {
      hours: googleHoursResponse,
      attributes: evidence(style === 'salon' ? hasMenus : slots, style === 'salon' ? menus === null ? 'メニューを読み込めていません' : '有効なメニューを登録してください' : slots === null ? '面談枠の設定を読み込めていません' : '担当者と面談できる時間を設定してください'),
      friendAdd: evidence(style === 'salon' ? hasStaff : bookingUrl, style === 'salon' ? staff === null ? '担当者を読み込めていません' : '有効な担当者を登録してください' : bookingUrl === null ? '予約ページを確認できていません' : 'LINEの予約ページを設定してください'),
      scenario: evidence(both(slots, bookingUrl), slots === null || bookingUrl === null ? '予約受付の設定を確認できていません' : '担当するメニュー・営業時間・予約ページを確認してください'),
    } }
  }
  if (style === 'lesson') {
    const [events, members, googleHours] = await Promise.all([read(() => eventsApi.listEvents(accountId, { limit: 100 })), read(() => styleApi.members(accountId)), loadGoogleHoursEvidence(accountId)])
    const items = events && Array.isArray(events.items) && Number.isSafeInteger(events.total) && events.total >= 0 ? events.items : null
    const withDates = items?.filter(event => validDate(event.next_slot_starts_at))
    const classes = items === null ? null : withDates!.length > 0 ? true : items.length === 0 && events!.total === 0 ? false : null
    const open = items === null ? null : items.some(event => event.is_published === 1 && (!event.lifecycle_status || event.lifecycle_status === 'published') && validDate(event.next_slot_starts_at) && Date.parse(event.next_slot_starts_at) > Date.now()) ? true : events!.total <= items.length ? false : null
    const registered = members?.success && Array.isArray(members.data) ? members.data.some(member => member.line_account_id === accountId && !member.ended_at && (!member.expires_at || validDate(member.expires_at) && Date.parse(member.expires_at) > Date.now())) : null
    return { style, steps: {
      hours: googleHours,
      attributes: evidence(classes, classes === false ? 'クラスを作って開催日時を決めてください' : 'クラスの開催日時を確認できていません'),
      friendAdd: evidence(registered, registered === false ? '会員を登録してください' : '会員の登録状況を読み込めていません'),
      scenario: evidence(open, open === false ? '開催日時を決めてクラスを公開してください' : 'クラスの受付状況を確認できていません'),
    } }
  }
  const connector = await read(() => api.ecCommerce.connector(accountId))
  const googleHours = await loadGoogleHoursEvidence(accountId)
  const data = connector?.success ? connector.data : null
  const connected = data && typeof data.configured === 'boolean' ? Boolean(data.configured && data.connector?.status === 'connected' && data.connector.secretConfigured) : null
  const events = data?.connector?.eventTypes
  const receivesOrders = both(connected, Array.isArray(events) ? events.includes('ec.order.confirmed') : null, validDate(data?.health?.lastSucceededAt) ? true : null)
  return { style, steps: {
    hours: googleHours,
    attributes: evidence(connected, connected === false ? 'ストアを接続してください' : 'ストアの接続状況を読み込めていません'),
    friendAdd: evidence(null, 'ストアの商品を確認できる情報がまだありません。EC連携で確認してください'),
    scenario: evidence(receivesOrders, receivesOrders === false ? '注文を受け取る設定を確認してください' : 'ストアからの注文の受け取りをまだ確認できていません'),
  } }
}
