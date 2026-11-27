'use client'

/* app/settings/use-feature-settings.ts から写した（src/v8 は @/app を読めない）。動きは同じ。区分の数の言い方だけ ★V8 の絵に合わせた。 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { notifyToast } from '@/components/shared/toast'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { useAccount } from '@/contexts/account-context'
import { useAccountStyle } from '@/hooks/use-account-style'
import { api, ApiError, fetchApi, type AnalyticsUsageOverview } from '@/lib/api'
import { clearFeatureSettingsCache, loadFeatureSettings } from '@/lib/feature-settings-cache'
import { createAccountRequestGuard } from './account-request-guard'
import {
  FEATURE_SETTINGS_UPDATED_EVENT,
  groupEnabledCount,
  groupFeatureCount,
  itemOrderFromGroups,
  moveItemWithinGroup,
  withRestaurantMenuFeatures,
  restaurantHiddenIds,
  visibleFeatureGroups,
  type FeatureGroup,
  type FeatureItem,
  type MenuItemOrder,
} from '@/lib/feature-settings'
import {
  CATALOG_DEFAULT_FEATURES,
  FEATURE_SETTINGS_CONFLICT_MESSAGE,
  applyItemOrder,
  featureSettingsAreDirty,
  featureSettingsErrorMessage,
  featureSettingsSaveConflictMessage,
  normalizeFeatureSettings,
  splitFeatureGroups,
} from './feature-settings-view'
import { formatDay, formatNumber } from '@/lib/format'
import { formatDate as polishFormatDate } from '@/lib/format'
import { FEATURE_IDS, restaurantDefaultFeatures } from '@line-crm/shared'


export type UsageCategory = AnalyticsUsageOverview['data']['categories'][number]
export type FeatureUsage = AnalyticsUsageOverview['data']['features'][number]

/**
 * オフ前の影響確認(票643)の応答。件数と対象種別だけを持ち、
 * 稼働中の行そのもの(宛先・内容)はサーバから出さない。
 */
export type FeatureImpactItem = {
  kind: 'published' | 'scheduled' | 'dependent'
  targetType: string
  count: number
}

export type FeatureImpactGroup = {
  feature: string
  items: FeatureImpactItem[]
  blocking: boolean
}

type FeatureImpactResponse = {
  success: boolean
  error: string
  data: {
    version: number
    impacts: FeatureImpactGroup[]
    requiresConfirmation: boolean
    impactToken: string | null
  }
}

type FeatureSaveResponse = {
  success: boolean
  error: string
  data: { version: number }
}

/*
 * オン／オフを持たない項目だけが使う、分類ごとの利用数バッジ。
 * 切り替えられる機能（keys を持つ行）は共有カタログの featureId で
 * 機械照合する features 側を見る。ここに残るのは「タグ」だけ。
 */
const USAGE_ITEM_IDS_BY_KEY: Record<string, string[]> = {
  friend_attributes: ['friend-attributes'],
}

/** 最終利用の日付だけを短く出す。時刻はバッジに入らないのでタイトルへ残す。 */
export function shortUsageDate(value: string): string {
  return polishFormatDate(value, { style: 'list-day', fallback: '—' })
}

export function groupSummary(group: FeatureGroup, features: Record<string, boolean>) {
  const total = groupFeatureCount(group)
  if (total === 0) return '消せません（並びだけ変えられる）'
  const enabled = groupEnabledCount(group, features)
  return `${total} 件中 ${enabled} 件オン`
}

/**
 * 機能設定の状態と操作。管理画面・V8 のどちらの描画からも同じ口で使う。
 * 動き（保存・競合・影響確認・離脱の番兵）はここに1つだけ置く。
 */
export function useFeatureSettings() {
  const { selectedAccountId } = useAccount()
  const accountStyle = useAccountStyle(selectedAccountId)
  const restaurantStyle = accountStyle.status === 'ready' && accountStyle.data?.style === 'restaurant'
  const defaultFeatures = restaurantStyle ? withRestaurantMenuFeatures(restaurantDefaultFeatures()) : CATALOG_DEFAULT_FEATURES
  const [savedFeatures, setSavedFeatures] = useState<Record<string, boolean>>(CATALOG_DEFAULT_FEATURES)
  const [features, setFeatures] = useState<Record<string, boolean>>(CATALOG_DEFAULT_FEATURES)
  const [savedItemOrder, setSavedItemOrder] = useState<MenuItemOrder>({})
  const [itemOrder, setItemOrder] = useState<MenuItemOrder>({})
  const [savedFavorites, setSavedFavorites] = useState<string[]>([])
  const [favorites, setFavorites] = useState<string[]>([])
  const [specializedFeatureKeys, setSpecializedFeatureKeys] = useState<string[]>([])
  const [usageCategories, setUsageCategories] = useState<UsageCategory[]>([])
  /** 全任意機能の利用状況（N-448）。共有カタログの featureId で照合する。 */
  const [usageFeatures, setUsageFeatures] = useState<FeatureUsage[]>([])
  /** 利用数の取得に失敗したときだけ出す「読み直す」の印。 */
  const [usageFailed, setUsageFailed] = useState(false)
  const [ordering, setOrdering] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  /** GET で受けた版。保存時に送り返し、競合(409)を検出する。 */
  const [settingsVersion, setSettingsVersion] = useState(0)
  const [error, setError] = useState('')
  /** ★V8 ：ほかの管理者が先に保存した。編集中身は残して帯で知らせる。 */
  const [conflict, setConflict] = useState(false)
  /*
   * 監査 D019: 読み込みに失敗したら初期値のスイッチ一覧を本物の設定の
   * ように出さない。失敗の印だけにして、偽の設定を触らせない。
   */
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadErrorStatus, setLoadErrorStatus] = useState<number | undefined>(undefined)
  /**
   * 変更理由。サーバーが必須化しており、保存と同じ単位で監査へ残る。
   * 保存成功・取り消し・アカウント切替で空に戻す。
   */
  const [reason, setReason] = useState('')
  /**
   * オフ前の影響確認(票643)。止まる仕事があるときだけ開く。
   * トークンは保持せず、押すたびに取り直してから保存する。
   */
  const [impactOpen, setImpactOpen] = useState(false)
  const [impactGroups, setImpactGroups] = useState<FeatureImpactGroup[]>([])
  const [impactBusy, setImpactBusy] = useState(false)
  const [impactError, setImpactError] = useState('')
  /** 既定値へ初期化する前の確認。保存済み設定へ戻す操作には使わない。 */
  const [resetToDefaultsOpen, setResetToDefaultsOpen] = useState(false)
  /**
   * 世代guard。アカウントが変わったら古い応答を捨てる。
   * Aの応答をBの画面へ混ぜないし、Aの版でBへ保存しない。
   */
  const accountGuard = useMemo(() => createAccountRequestGuard(), [])
  const accountRef = useRef(selectedAccountId)
  const savingRef = useRef(false)
  const impactBusyRef = useRef(false)

  /** 並び順を当てたあとの区分。画面も見え方の欄もこれを見る。 */
  const groups = useMemo(() => {
    return applyItemOrder(
      visibleFeatureGroups({ specializedFeatureKeys, includeRestaurantTest: true, restaurantStyle }),
      itemOrder,
    )
  }, [itemOrder, specializedFeatureKeys, restaurantStyle])

  const currentOrder = useMemo(() => itemOrderFromGroups(groups), [groups])
  const savedGroups = useMemo(() => applyItemOrder(
    visibleFeatureGroups({ specializedFeatureKeys, includeRestaurantTest: true, restaurantStyle }),
    savedItemOrder,
  ), [savedItemOrder, specializedFeatureKeys, restaurantStyle])
  const dirty = featureSettingsAreDirty({
    savedFeatures,
    features,
    savedOrder: itemOrderFromGroups(savedGroups),
    currentOrder,
    savedFavorites,
    favorites,
  })

  /*
   * 未保存の変更がある間、画面を離れる操作を止める共通の番兵（DETAIL-04系）。
   * ブラウザ離脱・画面内リンク・戻る操作を同じ確認対話へ寄せる。
   */
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty, busy: saving })

  useEffect(() => {
    if (accountRef.current !== selectedAccountId) {
      accountRef.current = selectedAccountId
      accountGuard.advance()
      savingRef.current = false
      impactBusyRef.current = false
      // Aの未保存状態をBへ持ち込まない。Bの値は load が改めて確定する。
      setSavedFeatures(CATALOG_DEFAULT_FEATURES)
      setFeatures(CATALOG_DEFAULT_FEATURES)
      setSavedItemOrder({})
      setItemOrder({})
      setSavedFavorites([])
      setFavorites([])
      setSettingsVersion(0)
      setSpecializedFeatureKeys([])
      setUsageCategories([])
      setUsageFeatures([])
      setUsageFailed(false)
      setOrdering(false)
      setSaving(false)
      setConflict(false)
      setError('')
      setLoadFailed(false)
      setLoadErrorStatus(undefined)
      setImpactOpen(false)
      setImpactGroups([])
      setImpactBusy(false)
      setImpactError('')
      setResetToDefaultsOpen(false)
      cancelLeave()
      setReason('')
    }
  }, [selectedAccountId, accountGuard, cancelLeave])

  /**
   * 利用数だけ後から読む。設定の表示を重い集計で待たせない。
   *
   * 集計が8系統の数え直しで重いため、以前は設定と一緒に待っていた。
   * 先に設定を出して、数は届き次第バッジに足す。失敗しても設定は
   * 触れるままにし、バッジの「読み直す」から取り直せる。
   */
  const loadUsage = useCallback(async () => {
    if (!selectedAccountId) return
    const ticket = accountGuard.issue(selectedAccountId)
    setUsageFailed(false)
    try {
      // 利用数は任意の補助情報。分析がオフでも機能設定本体を閉じない。
      const usageResponse = await api.analytics.usageOverview(selectedAccountId, undefined, { suppressFeatureDisabledEvent: true })
      if (!accountGuard.isCurrent(ticket, selectedAccountId)) return
      if (usageResponse?.success) {
        setUsageCategories(usageResponse.data.data.categories)
        setUsageFeatures(usageResponse.data.data.features ?? [])
      } else {
        setUsageFailed(true)
      }
    } catch {
      if (!accountGuard.isCurrent(ticket, selectedAccountId)) return
      setUsageFailed(true)
    }
  }, [selectedAccountId, accountGuard])

  const load = useCallback(async () => {
    if (!selectedAccountId) {
      setSavedFeatures(CATALOG_DEFAULT_FEATURES)
      setFeatures(CATALOG_DEFAULT_FEATURES)
      setSavedItemOrder({})
      setItemOrder({})
      setSavedFavorites([])
      setFavorites([])
      setSettingsVersion(0)
      setSpecializedFeatureKeys([])
      setUsageCategories([])
      setUsageFeatures([])
      cancelLeave()
      setLoadFailed(false)
      setLoadErrorStatus(undefined)
      setLoading(false)
      return
    }
    const ticket = accountGuard.issue(selectedAccountId)
    setLoading(true)
    setError('')
    setLoadFailed(false)
    setLoadErrorStatus(undefined)
    try {
      // サイドバーと同じ答えを共有する。保存の合図で捨てられる。
      const response = await loadFeatureSettings(selectedAccountId)
      if (!accountGuard.isCurrent(ticket, selectedAccountId)) return
      if (!response.success) {
        setError(response.error)
        setLoadFailed(true)
        return
      }
      const next = restaurantStyle
        ? withRestaurantMenuFeatures(normalizeFeatureSettings(response.data.features), response.data.restaurantHiddenItemIds)
        : normalizeFeatureSettings(response.data.features)
      setSavedFeatures(next)
      setFeatures(next)
      const nextOrder = response.data.sidebarItemOrder ?? {}
      setSavedItemOrder(nextOrder)
      setSettingsVersion(response.data.version ?? 0)
      setItemOrder(nextOrder)
      setSavedFavorites(response.data.favoriteItemIds ?? [])
      setFavorites(response.data.favoriteItemIds ?? [])
      setSpecializedFeatureKeys(response.data.specializedFeatureKeys ?? [])
      // 設定を先に出し、利用数は後から足す（表示を集計で待たせない）。
      void loadUsage()
    } catch (error) {
      if (!accountGuard.isCurrent(ticket, selectedAccountId)) return
      const status = error instanceof ApiError ? error.status : undefined
      setError(featureSettingsErrorMessage(status, 'load'))
      setLoadFailed(true)
      setLoadErrorStatus(status)
    } finally {
      if (accountGuard.isCurrent(ticket, selectedAccountId)) setLoading(false)
    }
  }, [selectedAccountId, loadUsage, accountGuard, cancelLeave, restaurantStyle])

  useEffect(() => { void load() }, [load])

  const usageByItemId = useMemo(() => {
    const result = new Map<string, UsageCategory>()
    for (const category of usageCategories) {
      for (const itemId of USAGE_ITEM_IDS_BY_KEY[category.key] ?? []) {
        if (category.key !== 'friend_attributes') { result.set(itemId, category); continue }
        const tags = category.breakdown?.find(item => item.key === 'tags')
        const unknown = { value: null, state: 'unavailable' as const, reason: 'タグの内訳を確認できません。もう一度読み込んでください' }
        result.set(itemId, { ...category, label: 'タグ', created: tags?.created ?? unknown,
          inUse: tags?.inUse ?? unknown, unused: tags?.unused ?? unknown })
      }
    }
    return result
  }, [usageCategories])

  /** 共有カタログの featureId → 利用状況。切り替えられる全機能を機械照合する。 */
  const usageByFeatureId = useMemo(() => {
    const result = new Map<string, FeatureUsage>()
    for (const entry of usageFeatures) result.set(entry.featureId, entry)
    return result
  }, [usageFeatures])

  const groupColumns = useMemo(() => {
    return splitFeatureGroups(groups, 3)
  }, [groups])

  /*
   * WEB191：保存中は切り替えを受け付けない。保存後の読み直しはサーバー値で
   * features を置き換えるので、保存中に押した変更は黙って消える。
   */
  const toggleItem = (item: FeatureItem, next: boolean) => {
    if (saving) return
    if (item.required || item.keys.length === 0) return
    setFeatures((current) => {
      const changed = { ...current }
      for (const key of item.keys) changed[key] = next
      return changed
    })
  }

  const toggleFavorite = (itemId: string) => {
    if (saving || !restaurantStyle) return
    setFavorites((current) => current.includes(itemId)
      ? current.filter((id) => id !== itemId)
      : [...current, itemId])
  }

  const toggleGroup = (group: FeatureGroup, next: boolean) => {
    if (saving) return
    setFeatures((current) => {
      const changed = { ...current }
      for (const item of group.items) {
        if (item.required) continue
        for (const key of item.keys) changed[key] = next
      }
      return changed
    })
  }

  /**
   * 1つ上／下へ動かす。**区分をまたいでは動かせない。**
   *
   * またげるようにすると「受信箱を配信の中へ」といった並びが作れてしまい、
   * サイドバーの見出しと中身が合わなくなる。
   */
  const moveItem = (groupId: string, itemId: string, direction: -1 | 1) => {
    const group = groups.find((item) => item.id === groupId)
    if (!group) return
    const ids = group.items.map((item) => item.id)
    setItemOrder((current) => ({ ...current, [groupId]: moveItemWithinGroup(ids, itemId, direction) }))
  }

  /** 並び替えの下書きを動かす。確定するまで本番の itemOrder は触らない。 */
  const moveItemInOrder = (order: MenuItemOrder, groupId: string, itemId: string, direction: -1 | 1): MenuItemOrder => {
    const group = groups.find((item) => item.id === groupId)
    if (!group) return order
    const ids = applyItemOrder([group], order)[0].items.map((item) => item.id)
    return { ...order, [groupId]: moveItemWithinGroup(ids, itemId, direction) }
  }

  /** 最後に取得または保存成功した、現在のアカウントの状態へだけ戻す。 */
  const discardChanges = () => {
    if (loading || saving) return
    setFeatures({ ...savedFeatures })
    setItemOrder({ ...savedItemOrder })
    setFavorites([...savedFavorites])
    setReason('')
    setError('')
    notifyToast('保存済みの機能設定に戻しました。')
  }

  /** 既定値を下書きへ入れる。ここではAPIを呼ばず、保存を押すまでサーバーは変えない。 */
  const resetToDefaults = () => {
    if (loading || saving) return
    setFeatures({ ...defaultFeatures })
    setItemOrder({})
    setFavorites([])
    setError('')
    notifyToast('初期値を下書きに入れました。保存すると反映されます。')
    setResetToDefaultsOpen(false)
  }

  /** 機能の目印→表示名。確認ダイアログで内部IDを出さないために使う。 */
  const featureLabelByKey = useMemo(() => {
    const labels = new Map<string, string>()
    for (const group of groups) {
      for (const item of group.items) {
        for (const key of item.keys) {
          if (!labels.has(key)) labels.set(key, item.label)
        }
      }
    }
    return labels
  }, [groups])

  /** 最新の保存済み状態を読み直す。編集中身は残す。 */
  const reloadSaved = useCallback(async () => {
    if (!selectedAccountId) return
    const ticket = accountGuard.issue(selectedAccountId)
    try {
      const latest = await api.featureSettings.get(selectedAccountId)
      if (!accountGuard.isCurrent(ticket, selectedAccountId)) return
      if (latest.success) {
        setSavedFeatures(restaurantStyle
          ? withRestaurantMenuFeatures(normalizeFeatureSettings(latest.data.features), latest.data.restaurantHiddenItemIds)
          : normalizeFeatureSettings(latest.data.features))
        setSavedItemOrder(latest.data.sidebarItemOrder ?? {})
        setSavedFavorites(latest.data.favoriteItemIds ?? [])
        setSettingsVersion(latest.data.version ?? 0)
      }
    } catch {
      // 読み直しに失敗しても編集中身は残す。
    }
  }, [selectedAccountId, accountGuard, restaurantStyle])

  /**
   * オフ前の影響確認(票643)。変更案だけ送り、保存はしない。
   * 版が古ければ読み直して null を返す(呼び出し側は保存へ進まない)。
   * 途中でアカウントが変わったら捨てて null を返す。
   */
  const checkImpact = useCallback(async () => {
    if (!selectedAccountId) return null
    const ticket = accountGuard.issue(selectedAccountId)
    try {
      const impact = await fetchApi<FeatureImpactResponse>(
        `/api/settings/features/impact?account_id=${encodeURIComponent(selectedAccountId)}`,
        {
          method: 'POST',
          body: JSON.stringify({ features: Object.fromEntries(FEATURE_IDS.map((id) => [id, features[id]])), expectedVersion: settingsVersion }),
        },
      )
      if (!accountGuard.isCurrent(ticket, selectedAccountId)) return null
      if (!impact.success) {
        setError(impact.error)
        return null
      }
      return impact.data
    } catch (error) {
      if (!accountGuard.isCurrent(ticket, selectedAccountId)) return null
      // ほかの管理者が先に保存したときは、編集中身は残したまま
      // 最新を読み直し、内容を確認してもう一度保存してもらう。
      // 読み込めていないときの409は競合ではなく本当の理由にする（D019）。
      if (error instanceof ApiError && error.status === 409) {
        await reloadSaved()
        if (!accountGuard.isCurrent(ticket, selectedAccountId)) return null
        setError(loadFailed
          ? featureSettingsSaveConflictMessage({ loadFailed, loadForbidden: loadErrorStatus === 403 })
          : FEATURE_SETTINGS_CONFLICT_MESSAGE)
        return null
      }
      setError(featureSettingsErrorMessage(error instanceof ApiError ? error.status : undefined, 'save'))
      return null
    }
  }, [selectedAccountId, features, settingsVersion, reloadSaved, accountGuard, loadFailed, loadErrorStatus])

  const persist = async (impactToken?: string): Promise<boolean> => {
    if (!selectedAccountId) return false
    const ticket = accountGuard.issue(selectedAccountId)
    setSaving(true)
    setError('')
    try {
      const response = await fetchApi<FeatureSaveResponse>(
        `/api/settings/features?account_id=${encodeURIComponent(selectedAccountId)}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            features: Object.fromEntries(FEATURE_IDS.map((id) => [id, features[id]])),
            sidebarItemOrder: currentOrder,
            ...(restaurantStyle ? { favoriteItemIds: favorites } : {}),
            ...(restaurantStyle ? { restaurantHiddenItemIds: restaurantHiddenIds(features) } : {}),
            expectedVersion: settingsVersion,
            reason: reason.trim(),
            ...(impactToken ? { impactToken } : {}),
          }),
        },
      )
      // 途中でアカウントが変わったら、応答を捨てて保存へ進まない。
      if (!accountGuard.isCurrent(ticket, selectedAccountId)) return false
      if (!response.success) {
        setError(response.error)
        return false
      }
      /*
       * 保存したつもりの値をそのまま確定しない。サーバーが正した値
       * （無効環境の飲食店テストなど）を、そのままオン表示にすると
       * 読み直すまで誤った状態を見せる。サーバ値を読み直して確定する。
       */
      try {
        // 保存した直後なので使い回しの答えは捨て、必ず取り直す。
        clearFeatureSettingsCache(selectedAccountId)
        const latest = await loadFeatureSettings(selectedAccountId)
        if (!accountGuard.isCurrent(ticket, selectedAccountId)) return false
        if (latest.success) {
          const serverFeatures = restaurantStyle
            ? withRestaurantMenuFeatures(normalizeFeatureSettings(latest.data.features), latest.data.restaurantHiddenItemIds)
            : normalizeFeatureSettings(latest.data.features)
          setSavedFeatures(serverFeatures)
          setFeatures(serverFeatures)
          const serverOrder = latest.data.sidebarItemOrder ?? {}
          setSavedItemOrder(serverOrder)
          setItemOrder(serverOrder)
          setSavedFavorites(latest.data.favoriteItemIds ?? [])
          setFavorites(latest.data.favoriteItemIds ?? [])
          setSettingsVersion(latest.data.version ?? response.data.version)
          setSpecializedFeatureKeys(latest.data.specializedFeatureKeys ?? [])
        } else {
          setSettingsVersion(response.data.version)
          setSavedFeatures({ ...features })
          setSavedItemOrder(currentOrder)
          setItemOrder(currentOrder)
          setSavedFavorites([...favorites])
        }
      } catch {
        // WEB190：読み直しの失敗でも、途中でアカウントが変わっていたら
        // 前のアカウントの版・中身を今の画面へ書かない。
        if (!accountGuard.isCurrent(ticket, selectedAccountId)) return false
        setSettingsVersion(response.data.version)
        setSavedFeatures({ ...features })
        setSavedItemOrder(currentOrder)
        setItemOrder(currentOrder)
        setSavedFavorites([...favorites])
      }
      setReason('')
      setConflict(false)
      notifyToast('機能設定を保存しました。サイドメニューにも反映されています。')
      window.dispatchEvent(new CustomEvent(FEATURE_SETTINGS_UPDATED_EVENT, { detail: { accountId: selectedAccountId } }))
      return true
    } catch (error) {
      if (!accountGuard.isCurrent(ticket, selectedAccountId)) return false
      // 確認後に稼働中が変わったときは、最新の影響で確認し直す。
      // 編集中身は残したまま、ダイアログを開き直す。
      if (error instanceof ApiError && error.status === 409
        && error.code === 'IMPACT_CONFIRMATION_REQUIRED') {
        const data = error.data as { impacts?: FeatureImpactGroup[] } | undefined
        if (data?.impacts) {
          setImpactGroups(data.impacts)
          setImpactError('状態が変わったため、内容を確認し直してください。')
          setImpactOpen(true)
        } else {
          setError(featureSettingsErrorMessage(error.status, 'save'))
        }
        await reloadSaved()
        return false
      }
      // ほかの管理者が先に保存したときは、編集中身は残したまま
      // 最新を読み直し、内容を確認してもう一度保存してもらう。
      // 読み込めていないときの409は競合ではなく本当の理由にする（D019）。
      if (error instanceof ApiError && error.status === 409) {
        await reloadSaved()
        if (!accountGuard.isCurrent(ticket, selectedAccountId)) return false
        setConflict(true)
        setError(loadFailed
          ? featureSettingsSaveConflictMessage({ loadFailed, loadForbidden: loadErrorStatus === 403 })
          : FEATURE_SETTINGS_CONFLICT_MESSAGE)
        return false
      }
      setError(featureSettingsErrorMessage(error instanceof ApiError ? error.status : undefined, 'save'))
      return false
    } finally {
      if (accountGuard.isCurrent(ticket, selectedAccountId)) setSaving(false)
    }
  }

  /**
   * 保存ボタン。オフに変わる機能があるときだけ先に影響確認し、
   * 止まる仕事があるときは確認ダイアログを開いて止める。
   */
  const save = async () => {
    if (!selectedAccountId || !dirty || saving || savingRef.current) return
    // サーバーが理由なしの保存を400にする。往復させる前にここで止める。
    if (!reason.trim()) {
      setError('変更理由を入力してください')
      return
    }
    const ticket = accountGuard.issue(selectedAccountId)
    const offKeys = Object.keys(features).filter(
      (key) => savedFeatures[key] === true && features[key] === false,
    )
    if (offKeys.length === 0) {
      savingRef.current = true
      try {
        return await persist()
      } finally {
        if (accountGuard.isCurrent(ticket, selectedAccountId)) {
          savingRef.current = false
        }
      }
    }
    savingRef.current = true
    setSaving(true)
    setError('')
    try {
      const data = await checkImpact()
      if (!accountGuard.isCurrent(ticket, selectedAccountId)) return false
      if (!data) return false
      if (data.requiresConfirmation) {
        setImpactGroups(data.impacts)
        setImpactError('')
        setImpactOpen(true)
        return true
      }
      return await persist()
    } finally {
      if (accountGuard.isCurrent(ticket, selectedAccountId)) {
        savingRef.current = false
        setSaving(false)
      }
    }
  }

  /**
   * 確認ダイアログの「確認して保存」。押すたびに影響を取り直し、
   * その場のトークンで保存する。トークンの持ち回しはしない。
   */
  const confirmImpactSave = async () => {
    if (impactBusy || impactBusyRef.current || !selectedAccountId) return
    const ticket = accountGuard.issue(selectedAccountId)
    impactBusyRef.current = true
    setImpactBusy(true)
    setImpactError('')
    try {
      const data = await checkImpact()
      if (!accountGuard.isCurrent(ticket, selectedAccountId)) return
      if (!data) {
        setImpactError('確認を取り直せませんでした。閉じてもう一度保存してください。')
        return
      }
      if (!data.requiresConfirmation || !data.impactToken) {
        setImpactOpen(false)
        await persist()
        return
      }
      setImpactGroups(data.impacts)
      setImpactOpen(true)
      const ok = await persist(data.impactToken)
      if (!accountGuard.isCurrent(ticket, selectedAccountId)) return
      if (ok) setImpactOpen(false)
    } finally {
      if (accountGuard.isCurrent(ticket, selectedAccountId)) {
        impactBusyRef.current = false
        setImpactBusy(false)
      }
    }
  }

  const impactSummary = (group: FeatureImpactGroup) => group.items
    .map((item) => `${item.targetType} ${formatNumber(item.count)} 件`)
    .join('、')

  return {
    selectedAccountId,
    features,
    itemOrder,
    favorites,
    savedFavorites,
    toggleFavorite,
    setSavedFavorites,
    setItemOrder,
    savedFeatures,
    groups,
    currentOrder,
    dirty,
    ordering,
    setOrdering,
    loading,
    saving,
    error,
    setError,
    conflict,
    setConflict,
    reloadSaved,
    loadFailed,
    loadErrorStatus,
    reason,
    setReason,
    impactOpen,
    setImpactOpen,
    impactGroups,
    impactBusy,
    impactError,
    setImpactError,
    resetToDefaultsOpen,
    setResetToDefaultsOpen,
    usageByItemId,
    usageByFeatureId,
    usageFailed,
    groupColumns,
    leaveTarget,
    confirmLeave,
    cancelLeave,
    setSavedFeatures,
    setSavedItemOrder,
    load,
    loadUsage,
    toggleItem,
    toggleGroup,
    moveItem,
    moveItemInOrder,
    discardChanges,
    resetToDefaults,
    featureLabelByKey,
    save,
    confirmImpactSave,
    impactSummary,
  }
}
