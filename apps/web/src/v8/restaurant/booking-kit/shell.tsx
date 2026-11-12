'use client'

import { BoundaryBanner } from '@/v8/restaurant/common-a/public/boundary-banner'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { phoneReservationFailure } from './phone-error'
import { useStaffRole } from '@/lib/staff-role'
import { notifySaved } from '@/components/shared/toast'
import { type ComponentProps, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAccount } from '@/contexts/account-context'

import {
  restaurantTestApi,
  type ReservationQuery,
  type RestaurantSnapshot,
  type RestaurantStore,
} from '@/lib/restaurant-test-api'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import KpiBand from '@/components/shared/kpi-band'
import Card, { CardHeader } from '@/components/shared/card'
import Notice from '@/components/shared/notice'
import { PageContent, PageFrame, PageHeading } from '@/components/templates/page-frame'
import ListState from '@/components/shared/list-state'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge'
import styles from './shell.module.css'
import { useTableDefinition } from './use-table-definition'
import type { RestaurantTableDefinition } from './table-definition'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import EntitySelect from '@/components/shared/entity-select'

/*
 * ★V8 飲食店向け（テスト）の器 — 在庫・予約台帳・座席・メニューの4画面用。
 *
 * 板の頭（題・説明・右上に店舗を選ぶ欄）→ 検証環境の帯 → 中身。
 * 寸法は Pencil の板（メニュー管理  ほか）の書き出しから読む。
 * データの口は今の画面（app/restaurant-test/v8/shell.tsx）と同じ
 * restaurantTestApi.snapshot。src/v8 は古い画面を import できないので写した。
 */

export interface RestaurantV8Context {
  tableDefinition?: RestaurantTableDefinition
  data: RestaurantSnapshot
  /** 店舗を選ぶ欄で今選んでいる店舗（先頭が既定）。 */
  store: RestaurantStore | null
  selectedStoreId: string
  busy: boolean
  /** 書き込み操作の共通処理。成功したら取り直して帯を出す。 */
  mutate: (action: () => Promise<unknown>, success: string, options?: { rethrow?: (error: unknown) => boolean; onCommitted?: () => boolean; onRefreshFailure?: () => void; suppressSuccessToast?: boolean } | ((message: string) => void)) => Promise<boolean>
  reload: () => Promise<void>
}

/**
 * 帯を出さずに失敗として返すときの印。画面が自分で知らせ方を持つとき
 * （競合の帯など）に投げる。mutate は false を返すだけで、上の帯は出さない。
 */
export class QuietError extends Error {}

const statusLabel: Record<string, string> = {
  connected: '正常', active: '有効', invited: '招待中', suspended: '停止中', archived: 'アーカイブ', approved: '承認済', completed: '完了', visited: '来店済',
  confirmed: '予約確定', warning: '要確認', pending: '承認待ち', draft: '下書き', scheduled: '予約済', paused: '停止中',
  unreplied: '未返信', unconfigured: '未設定', disabled: '停止中', error: 'エラー', returned: '差戻し',
  seated: '来店中', cancelled: '取消', no_show: '無断キャンセル', preview_only: 'プレビューのみ',
}

export function statusTone(value: string): StatusBadgeTone {
  return ['connected', 'active', 'approved', 'completed', 'visited', 'confirmed', 'seated'].includes(value) ? 'success'
    : ['warning', 'pending', 'draft', 'scheduled', 'unreplied', 'returned'].includes(value) ? 'warning'
      : ['error', 'no_show'].includes(value) ? 'danger'
        : 'neutral'
}

/** 状態の札（点＋文字）。共通の StatusBadge を絵の寸法で使う。 */
export function Status({ value, label }: { value: string; label?: string }) {
  return <StatusBadge tone={statusTone(value)} className={styles.status}>{label ?? statusLabel[value] ?? value}</StatusBadge>
}

export { BoundaryBanner } from '@/v8/restaurant/common-a/public/boundary-banner'

/** 数の並び。compact は予約台帳の今日（小さい帯・数字20）。 */
export function StatRow({ children, compact = false, fusion = false }: { children: ReactNode; compact?: boolean; fusion?: boolean }) {
  const band = <KpiBand data-restaurant-fusion={fusion||undefined} density={compact ? 'compact' : undefined}>{children}</KpiBand>
  return fusion ? <PageContent layout="stats">{band}</PageContent> : band
}

/** 白い枠。題・説明・右端の操作を持つ。 */
export function Panel({ title, description, aside, flush = false, children,fusion=false, help }: {
  fusion?:boolean
  title: ReactNode
  description?: ReactNode
  aside?: ReactNode
  /** 題の横の「？」に入れる説明（決まり2: いつも同じ帯はここへ）。 */
  help?: ReactNode
  /** 表など枠いっぱいの中身のとき true（内側の余白を付けない）。 */
  flush?: boolean
  children: ReactNode
}) {
  return (
    <Card layout="vertical" surface="inset" overflow="hidden">
      <CardHeader size={fusion?'restaurant':'panel'} title={title} meta={description} action={aside} help={help} />
      {flush ? children : <div className={fusion?styles.panelBodyFusion:styles.panelBody}>{children}</div>}
    </Card>
  )
}

function EmptySetup() {
  return (
    <div className={styles.panel}>
      <div className={styles.stateBox}>
        <ListState kind="empty" title="店舗が登録されていません" description="統括から店舗を登録してください。" />
      </div>
    </div>
  )
}

export default function RestaurantShell({ initialStoreId = '', boardId, title, description, explanation, query, headAfter, bare = false, layout = 'standard', boundary = true, headSize, templateHeading = false, headingInset, hideSubtitle = false, readOnly, readOnlyNeed, children, renderPage }: {
  /** 指定店が存在しない場合は別の店へ切り替えない。 */
  initialStoreId?: string
  /** Pencil の板 ID。外枠へ付ける。 */
  boardId: string
  title: string
  /** 説明の行。店舗によって変わるとき（休業日・貸切の「然-NEN 本店 ・ 総数 26席」）は ctx から作る関数を渡す。 */
  description: string | ((ctx: RestaurantV8Context | null) => string)
  explanation?: ReactNode
  query?: ReservationQuery
  /**
   * 板の頭の右に置く物（予約台帳の見方の切り替え・主ボタンなど）。店舗を選ぶ欄は2つ目の引数で渡すので、
   * 並べる場所は画面が決める（予約台帳は狭い幅で欄ごと2行目へ折り返す）。
   */
  headAfter?: (ctx: RestaurantV8Context | null, storePicker: ReactNode) => ReactNode
  /** 板の頭と検証環境の帯を出さない（電話の予約を入れる  のように画面が自分の頭を持つとき）。 */
  bare?: boolean
  /**
   * 画面ごとの寸法の違い。ledger＝予約台帳（頭が狭い幅で2行に折り返す・店舗の欄が 180）、
   * ledgerTight＝予約台帳の今日（さらに段の間が 14）。
   */
  layout?: 'standard' | 'ledger' | 'ledgerTight'
  /**
   * 検証環境の帯を出すか（既定 true）。false のときは中身を段の間なしで置く（中身が自分で余白を持つ。
   * 予約枠・在庫の「休業日・貸切」タブ  は帯が無く、タブ・知らせ・本文が板の幅で続く）。
   */
  boundary?: boolean
  /** 板の頭の大きさ。compact は E 系の板（題 20・説明の行 20）。 */
  templateHeading?: boolean
  /** 既存の頭の内側余白。頭を持つ器の中では none を渡す。 */
  headingInset?: 'none'
  headSize?: 'compact'
  /** 題の下の説明の行を出さず「？」へ入れる（絵に説明の行が無い板。休業日・貸切 ）。 */
  hideSubtitle?: boolean
  /** 題下の共通権限帯。権限判定は呼び出し側で行う。 */
  readOnly?: ComponentProps<typeof PageHeading>['readOnlyBand']
  readOnlyNeed?: ComponentProps<typeof PageHeading>['readOnlyNeed']
  children?: (ctx: RestaurantV8Context) => ReactNode
  /** 保存状態を持つ子が、既存PageFrameの本文と下部操作を分けて置く場合。 */
  renderPage?: (ctx: RestaurantV8Context, heading: ReactNode, notice: ReactNode) => ReactNode
}) {
  usePageTitle(title)
  usePageCrumbs([{ label: 'ホーム', href: '/' }])
  const { selectedAccountId } = useAccount()
  const role = useStaffRole()
  const [snapshot, setSnapshot] = useState<RestaurantSnapshot | null>(null)
  const [selectedStoreId, setSelectedStoreId] = useState(initialStoreId)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  /* 取得失敗と未登録を混ぜない（今の画面と同じ決まり）。 */
  const [loadError, setLoadError] = useState<unknown>(null)

  /* 見方・絞り込みを続けて変えたとき、先に出した古い問い合わせの返事が後から来て新しい結果を上書きしないように、最後の1件だけを使う。 */
  const [savedButUnread, setSavedButUnread] = useState(false)
  const latest = useRef(0)
  const { begin, accept, tableDefinition } = useTableDefinition(selectedAccountId, snapshot)
  const load = useCallback(async () => {
    const ticket = ++latest.current
    const definitionRequest = begin(selectedAccountId)
    if (!selectedAccountId) { setSnapshot(null); setLoadError(null); setLoading(false); return false }
    setLoading(true)
    try {
      const res = await restaurantTestApi.snapshot(selectedAccountId, query)
      if (ticket !== latest.current) return false
      setSnapshot(res.data)
      accept(definitionRequest, res.data)
      setLoadError(null)
      setSavedButUnread(false)
      setSelectedStoreId((current) => (res.data.stores.some((item) => item.id === current)
        ? current
        : initialStoreId ? current || initialStoreId : res.data.stores[0]?.id || ''))
      return true
    } catch (caught) {
      if (ticket !== latest.current) return false
      setLoadError(caught)
      return false
    } finally {
      if (ticket === latest.current) setLoading(false)
    }
  }, [selectedAccountId, query, begin, accept, initialStoreId])
  useEffect(() => { void load() }, [load])

  const mutate = useCallback(async (action: () => Promise<unknown>, success: string, options?: { rethrow?: (error: unknown) => boolean; onCommitted?: () => boolean; onRefreshFailure?: () => void; suppressSuccessToast?: boolean } | ((message: string) => void)) => {
    setBusy(true)
    try {
      await action()
      if (typeof options !== 'function' && options?.onCommitted) {
        if (!options.onCommitted()) return true
        setNotice({ tone: 'success', text: '保存しました。最新の表示を読み込んでいます。' })
      }
      const refreshed = await load()
      if (refreshed) {
        if (typeof options !== 'function' && options?.onCommitted) setNotice(null)
        if (typeof options === 'function' || !options?.suppressSuccessToast) notifySaved(success)
      } else {
        setSavedButUnread(true)
        if (typeof options !== 'function') options?.onRefreshFailure?.()
      }
      return true
    } catch (error) {
      if (typeof options !== 'function' && options?.rethrow?.(error)) { setNotice(null); throw error }
      if (error instanceof QuietError) { setNotice(null); return false }
      const message = phoneReservationFailure(error, role) || describeApiFailure(error, '保存')
      if (typeof options === 'function') { setNotice(null); options(message) }
      else setNotice({ tone: 'error', text: message })
      return false
    } finally {
      setBusy(false)
    }
  }, [load, role])

  const store = useMemo(
    () => (selectedStoreId ? snapshot?.stores.find((item) => item.id === selectedStoreId) || null : null),
    [snapshot, selectedStoreId],
  )
  const missingRequestedStore = Boolean(snapshot && initialStoreId && selectedStoreId && !store)
  const ctx: RestaurantV8Context | null = snapshot?.organization && !missingRequestedStore
    ? { tableDefinition, data: snapshot, store, selectedStoreId, busy, mutate, reload: async () => { await load() } }
    : null

  const content = loading && !snapshot ? (
    <div className={styles.panel}><div className={styles.stateBox}><ListState kind="loading" /></div></div>
  ) : loadError !== null && !snapshot?.organization ? (
    <ListState kind="error" error={loadError} onRetry={() => void load()} />
  ) : missingRequestedStore ? (
    <ListState kind="empty" title="指定された店舗を確認できません" description="アカウントと店舗を確かめて、もう一度開いてください。" />
  ) : !ctx ? (
    <EmptySetup />
  ) : (
    children?.(ctx)
  )
  /* 86: 店の切り替えは［店舗：…］の選ぶ欄1つに統一。店が1つしか無い時は出さない。 */
  const storePicker = snapshot && snapshot.stores.length > 1 ? (
    <span className={templateHeading ? styles.fusionStore : styles.storePicker}>
      <SaveErrorField names={["selectedStoreId", "selected_store_id"]}>
        <EntitySelect compact size="full" aria-label="店舗" noun="店舗" valuePrefix="店舗：" value={selectedStoreId} onChange={setSelectedStoreId} options={snapshot.stores.map(item => ({ value: item.id, label: item.name }))} />
      </SaveErrorField>
    </span>
  ) : null
  const noticeBand = loadError !== null && snapshot?.organization ? <ListState kind="error" title={savedButUnread ? "保存しましたが、最新の表示を読み込めませんでした" : "最新の表示を読み込めませんでした"} error={loadError} onRetry={()=>void load()}/> : notice ? (
    <Notice role="status" tone={notice.tone === 'success' ? 'success' : 'danger'} message={notice.text} />
  ) : null

  if (bare) {
    return (
      <div data-design-node={boardId} className={styles.page} data-list-skeleton={layout === 'ledger' ? 'templates' : undefined}>
        {noticeBand}
        {content}
      </div>
    )
  }

  const heading = (
    <>
      {templateHeading ? <PageHeading
        inset="none"
        noticeRow="full"
        readOnlyBand={readOnly}
        readOnlyNeed={readOnlyNeed}
        title={title}
        /* 題の下の店名は出さない（店舗は右の欄で分かる・）。店舗で変わる説明の行（関数）だけ出す。 */
        subtitle={hideSubtitle || typeof description !== 'function' ? undefined : description(ctx)}
        help={typeof description === 'function' ? hideSubtitle ? description(ctx) : '日付や店舗を選んで、予約と卓の状態を確認できます。' : description}
        /* いつも出る説明は「この画面の説明」の帯へ。「？」に混ぜない。 */
        explanation={explanation}
        actions={headAfter ? headAfter(ctx, storePicker) : storePicker}
      /> : (
      <div className={`${styles.head} ${layout === 'standard' ? '' : styles.headLedger}`}>
        <div className={styles.headText}>
          <PageHeading inset={headingInset} readOnlyBand={readOnly} readOnlyNeed={readOnlyNeed} title={title} help={typeof description === 'function' ? description(ctx) : description} explanation={explanation} />

        </div>
        {headAfter ? headAfter(ctx, storePicker) : storePicker}
      </div>
      )}
    </>
  )
  if (ctx && renderPage) return renderPage(ctx, <div className={styles.page} data-restaurant-fusion={templateHeading || undefined}>{heading}</div>, noticeBand)
  const page = (
    <div data-design-node={boardId} data-restaurant-fusion={templateHeading||undefined} data-list-skeleton={layout === 'ledger' && !templateHeading ? 'templates' : undefined} className={styles.page}>
      {heading}
      <div className={`${styles.body} ${layout === 'ledgerTight' ? styles.bodyTight : ''} ${boundary ? '' : styles.bodyFlush}`}>
        {boundary ? <BoundaryBanner /> : null}
        {noticeBand}
        {content}
      </div>
    </div>
  )
  return templateHeading ? <PageFrame kind="restaurant" standalone>{page}</PageFrame> : page
}
