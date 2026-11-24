'use client'

import { BoundaryBanner } from './boundary-banner'
import { requestUnsavedAction } from '@/lib/unsaved-action'
import { describeApiFailure } from '@/components/shared/api-error-message'

import { notifySaved } from '@/components/shared/toast'
import { type ComponentProps, type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { useAccount } from '@/contexts/account-context'
import { clearApiReadCache } from '@/lib/api/transport/read-cache'
import {
  restaurantTestApi,
  type ReservationQuery,
  type RestaurantSnapshot,
  type RestaurantStore,
} from '@/lib/restaurant-test-api'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { PageFrame, PageHeading } from '@/components/templates/page-frame'
import ListState from '@/components/shared/list-state'
import Select from '@/components/shared/select'
import styles from './frame.module.css'
import StoreFilterTabs from '@/components/shared/store-filter-tabs'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import Notice from '@/components/shared/notice'

/*
 * ★V8 飲食店向け（テスト）の器（担当 a：ダッシュボード・承認・組織・LINE来店フォロー・Googleビジネス）。
 *
 * Pencil の飲食店向けの板（店舗ダッシュボード CHz31 ほか）は、どれも同じ形：
 *   板の頭（題 22/32・説明 13/19・右上に店舗を選ぶ欄 210×36）
 *   → 中身（上16・左右24・下24、段の間16）：検証環境の帯 → 板ごとの中身。
 * 板の頭の寸法は型（PageFrame・PageHeading）が持つ。ここは取得と置き場だけ。
 *
 * データの口は今の画面（app/restaurant-test/v8/shell.tsx）と同じ
 * restaurantTestApi.snapshot。取得失敗と未登録を混ぜない（D024）。
 */

export interface RestaurantContext {
  data: RestaurantSnapshot
  /** 店舗を選ぶ欄で今選んでいる店舗（「すべての店舗」のときは null）。 */
  store: RestaurantStore | null
  selectedStoreId: string
  busy: boolean
  /** 書き込みの共通処理。成功したら取り直して帯を出す。 */
  mutate: (action: () => Promise<unknown>, success: string) => Promise<boolean>
  reload: () => Promise<void>
}

/** 店舗を選ぶ欄（絵の「選ぶ欄」：幅210・高さ36）。 */
export const STORE_PICKER_WIDTH = 210

export { BoundaryBanner } from './boundary-banner'

/** 板の頭と中身の並び（取得を持たない画面でも使う）。 */
export function RestaurantPage({ boardId, title, description, descriptionAs, descriptionSize, subtitle, picker, actions, readOnly, readOnlyNeed, headPadTop, headTextGap, titleSize, bodyPadTop, bodyGap, children }: {
  boardId: string
  title: string
  description: string
  /*
   * 説明の出し方。渡さないときは今までどおり題の隣の「?」の中（HelpTip）。
   * `'text'` は絵のとおり題のすぐ下へ 1 行で出す（絵 kDQHr・OzHLO・h7OeT）。
   */
  descriptionAs?: 'text'
  /** 説明を本文の大きさ（13/20）にする。渡さないときは補足の 12/19 のまま。 */
  descriptionSize?: 'body'
  /** 題の下の1行（店名・状態など）。渡すと説明は「?」の中のまま、この行を題の下に出す。 */
  subtitle?: ReactNode
  picker?: ReactNode
  /** 店舗を選ぶ欄の右に並べる板の操作（主のボタンなど）。 */
  actions?: ReactNode
  /** 題下の共通権限帯。権限判定は呼び出し側で行う。 */
  readOnly?: ComponentProps<typeof PageHeading>['readOnlyBand']
  readOnlyNeed?: ComponentProps<typeof PageHeading>['readOnlyNeed']
  /** 頭の上の余白を絵の値にする。渡さないときは共通の 24 のまま。 */
  headPadTop?: number
  /** 題と説明の間を絵の値にする。渡さないときは共通の 8 のまま。 */
  headTextGap?: number
  /** 題を絵の小さい題（18/700/27）にする。渡さないときは 22/700/32 のまま。 */
  titleSize?: 'sub'
  /** 中身の上の余白を絵の値にする。渡さないときは共通の 16 のまま。 */
  bodyPadTop?: number
  /** 中身の段の間を絵の値にする。渡さないときは共通の 16 のまま。 */
  bodyGap?: number
  children: ReactNode
}) {
  const bodyStyle = bodyPadTop === undefined && bodyGap === undefined
    ? undefined
    : ({
      ...(bodyPadTop === undefined ? null : { '--rt-body-pad-top': `${bodyPadTop}px` }),
      ...(bodyGap === undefined ? null : { '--rt-body-gap': `${bodyGap}px` }),
    } as CSSProperties)
  return (
    <PageFrame kind="list" boardId={boardId}>
      <PageHeading
        title={title}
        noticeRow="full"
        readOnlyBand={readOnly}
        readOnlyNeed={readOnlyNeed}
        subtitle={descriptionAs === 'text' ? description : subtitle}
        subtitleSize={descriptionSize}
        help={descriptionAs === 'text' ? undefined : description}
        padTop={headPadTop}
        textGap={headTextGap}
        titleSize={titleSize}
        actions={picker || actions ? <>{picker}{actions}</> : undefined}
      />
      <div
        className={styles.body}
        data-body-pad-top={bodyPadTop === undefined ? undefined : ''}
        style={bodyStyle}
      >
        {children}
      </div>
    </PageFrame>
  )
}

export default function RestaurantFrame({
  boardId,
  title,
  description,
  query,
  allStores = false,
  initialStoreId = '',
  bannerNote,
  bodyPadTop,
  bodyGap,
  pickerAs = 'select',
  banner = true,
  subtitle,
  actions,
  readOnly,
  readOnlyNeed,
  children,
}: {
  /** Pencil の板 ID（例 `CHz31`）。外枠へ付ける。 */
  boardId: string
  title: string
  description: string
  /** 台帳の画面が渡す絞り込み。ダッシュボードは「今日以降の有効予約」。 */
  query?: ReservationQuery
  /** 店舗を選ぶ欄の先頭に「すべての店舗」を足す（全店を見る画面）。 */
  allStores?: boolean
  initialStoreId?: string
  bannerNote?: string
  /** 中身の上の余白を絵の値にする。渡さないときは共通の 16 のまま。 */
  bodyPadTop?: number
  /** 中身の段の間を絵の値にする。渡さないときは共通の 16 のまま。 */
  bodyGap?: number
  /** 店舗を選ぶ形。86: 既定は絵の「店舗：〇〇 ▾」の選ぶ欄（幅210・融合の板 ）。 */
  pickerAs?: 'tabs' | 'select'
  /** 検証環境の帯を出すか。融合の板は帯を描かないので false。 */
  banner?: boolean
  /** 題の下の1行。選んでいる店舗から作る。 */
  subtitle?: (store: RestaurantStore | null) => ReactNode
  /** 店舗を選ぶ欄の右の操作。読み込み前は null を受け取る。 */
  actions?: (ctx: RestaurantContext | null) => ReactNode
  readOnly?: ComponentProps<typeof PageHeading>['readOnlyBand']
  readOnlyNeed?: ComponentProps<typeof PageHeading>['readOnlyNeed']
  children: (ctx: RestaurantContext) => ReactNode
}) {
  usePageTitle(title)
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const { selectedAccountId } = useAccount()
  const [snapshot, setSnapshot] = useState<RestaurantSnapshot | null>(null)
  const [selectedStoreId, setSelectedStoreId] = useState(initialStoreId)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)

  const load = useCallback(async () => {
    if (!selectedAccountId) { setSnapshot(null); setLoadError(null); setLoading(false); return }
    setLoading(true)
    try {
      const res = await restaurantTestApi.snapshot(selectedAccountId, query)
      setSnapshot(res.data)
      setLoadError(null)
      setSelectedStoreId((current) => (allStores && current === '') || res.data.stores.some((item) => item.id === current)
        ? current
        : res.data.stores[0]?.id || '')
    } catch (caught) {
      setLoadError(caught)
    } finally {
      setLoading(false)
    }
  }, [selectedAccountId, query, allStores])
  useEffect(() => { void load() }, [load])

  const mutate = useCallback(async (action: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try {
      await action()
      await load()
      notifySaved(success)
      return true
    } catch (error) {
      setNotice({ tone: 'error', text: describeApiFailure(error, '保存') })
      return false
    } finally {
      setBusy(false)
    }
  }, [load])

  const store = useMemo(
    () => (selectedStoreId ? snapshot?.stores.find((item) => item.id === selectedStoreId) || null : null),
    [snapshot, selectedStoreId],
  )

  /* 86: 店が1つしか無い時は選ぶ欄を出さない（「すべての店舗」を足す画面は選ぶ意味があるので出す）。 */
  const picker = snapshot && (snapshot.stores.length > 1 || (allStores && snapshot.stores.length > 0)) ? pickerAs === 'select' ? (
    <SaveErrorField names={["selectedStoreId","selected_store_id"]}><EntitySelect
      aria-label="店舗"
      noun="店舗"
      valuePrefix="店舗"
      width={STORE_PICKER_WIDTH}
      value={selectedStoreId}
      onChange={next=>requestUnsavedAction(()=>{ if (next !== selectedStoreId) clearApiReadCache(); setSelectedStoreId(next) })}
      options={[
        ...(allStores ? [{ value: '', label: '店舗：すべての店舗' }] : []),
        ...snapshot.stores.map((item) => ({ ...entityOptionMetadata(item), value: item.id, label: `店舗：${item.name}` })),
      ]}
    /></SaveErrorField>
  ) : (
    <SaveErrorField names={["selectedStoreId","selected_store_id"]}><StoreFilterTabs

      value={selectedStoreId}
      onChange={next=>requestUnsavedAction(()=>{ if (next !== selectedStoreId) clearApiReadCache(); setSelectedStoreId(next) })}
      options={[
        ...(allStores ? [{ value: '', label: '店舗：すべての店舗' }] : []),
        ...snapshot.stores.map((item) => ({ ...entityOptionMetadata(item), value: item.id, label: `店舗：${item.name}` })),
      ]}
    /></SaveErrorField>
  ) : null

  const ready = snapshot?.organization && !loading
    ? { data: snapshot, store, selectedStoreId, busy, mutate, reload: load }
    : null
  return (
    <RestaurantPage
      boardId={boardId}
      readOnly={readOnly}
      readOnlyNeed={readOnlyNeed}
      title={title}
      description={description}
      subtitle={subtitle ? subtitle(store) : undefined}
      picker={picker}
      actions={actions ? actions(ready) : undefined}
      bodyPadTop={bodyPadTop}
      bodyGap={bodyGap}
    >
      {banner ? <BoundaryBanner note={bannerNote} /> : null}
      {notice ? (
        <Notice tone={notice.tone === "success" ? "success" : "danger"} role="status">
          {notice.text}
        </Notice>
      ) : null}
      {loading ? (
        <div className={styles.stateBox}><ListState kind="loading" /></div>
      ) : loadError !== null && !snapshot?.organization ? (
        <ListState kind="error" error={loadError} onRetry={() => void load()} />
      ) : !snapshot?.organization ? (
        <div className={styles.stateBox}>
          <ListState kind="empty" title="店舗が登録されていません" description="統括から店舗を登録してください。" />
        </div>
      ) : (
        children(ready ?? { data: snapshot, store, selectedStoreId, busy, mutate, reload: load })
      )}
    </RestaurantPage>
  )
}
