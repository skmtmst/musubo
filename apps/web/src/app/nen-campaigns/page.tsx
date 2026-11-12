'use client'

import { useDetailPanelUrl } from '@/components/shared/detail-panel'

import { useCallback, useEffect, useRef, useState } from 'react'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import { usePageTitle } from '@/components/shell/page-chrome'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { useAccount } from '@/contexts/account-context'
import {
  api,
  ApiError,
  type NenCampaignSetting,
  type NenColumn,
  type NenColumnMetrics,
  type NenDeliveryDetail,
  type NenDeliveryList,
  type NenFlowMetrics,
} from '@/lib/api'
import { describeApiFailure } from '@/components/shared/api-error-message'
import type { ColumnDeliveryPlan, FriendOption, NenCoupon, NenKpis, NenTab } from '@/v8/nen-campaigns/display'
import NenCampaignsV8 from '@/v8/nen-campaigns/list'
import { defaultScheduleLocal, jstMonthRange } from './nen-period'

type Notice = { tone: 'success' | 'error'; text: string }

const TABS: NenTab[] = ['auto', 'columns', 'history', 'paused']
const EMPTY_ERRORS: Record<NenTab, string> = { auto: '', columns: '', history: '', paused: '' }

/** テスト送信の失敗理由。送信先の問題（未登録・友だち解除）は直し方まで言う。 */
function testSendFailureText(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError && (caught.code === 'test_recipient_unavailable' || caught.status === 404)) {
    return 'テスト送信先が登録されていないか、友だち追加されていません。「設定 › アカウント」の「テスト送信先」で登録し、そのLINEで友だち追加されているか確認してください。'
  }
  return `${fallback}通信の状態を確認して、もう一度お試しください。`
}

function isTab(value: string | null): value is NenTab {
  return value !== null && (TABS as string[]).includes(value)
}

/**
 * NEN配信。★管理画面 37-6（`z4q1K`）／37-6-A（`u66A0`）。
 *
 * 数値カード（今月・先月・開封・注文・届かなかった）は月の範囲で実口から取る。
 * タブごとに必要なものだけ取り、失敗はそのタブの帯で示す（点検 #512 の中3）。
 */
export default function NenCampaignsPage() {
  usePageTitle('NEN配信')
  const { selectedAccountId } = useAccount()
  const accountScope = useRef({ id: selectedAccountId, generation: 0 })
  if (accountScope.current.id !== selectedAccountId) accountScope.current = { id: selectedAccountId, generation: accountScope.current.generation + 1 }
  const [loadedAccountScope, setLoadedAccountScope] = useState<number | null>(null)
  const selectedAccountIdRef = useRef(selectedAccountId)
  selectedAccountIdRef.current = selectedAccountId
  const [tab, setTab] = useState<NenTab>('auto')
  const [settings, setSettings] = useState<NenCampaignSetting[]>([])
  const [columns, setColumns] = useState<NenColumn[]>([])
  // コラム一覧は口の既定200件で打ち切られる。全体件数を保持し、一覧へ出す（#935 N-300）。
  const [columnsTotal, setColumnsTotal] = useState<number | null>(null)
  /* WEB231（V8）：200本より先のコラムを続けて読む。アカウントが変わったら足さない。 */
  const loadMoreColumns = async () => {
    if (!selectedAccountId) return
    const accountId = selectedAccountId
    const res = await api.nenCampaigns.columns(accountId, { offset: columns.length, limit: 200 })
    if (!res.success) throw new Error('load_more_failed')
    if (accountId !== selectedAccountIdRef.current) return
    setColumns((current) => [...current, ...res.data.filter((item) => !current.some((known) => known.id === item.id))])
    setColumnsTotal(res.pagination?.total ?? columnsTotal)
  }
  const [friends, setFriends] = useState<FriendOption[]>([])
  const [kpis, setKpis] = useState<NenKpis | null>(null)
  const [flowMetrics, setFlowMetrics] = useState<NenFlowMetrics | null>(null)
  const [columnMetrics, setColumnMetrics] = useState<NenColumnMetrics | null>(null)
  const [deliveryList, setDeliveryList] = useState<NenDeliveryList | null>(null)
  const [deliveryDetail, setDeliveryDetail] = useState<NenDeliveryDetail | null>(null)
  const [coupon, setCoupon] = useState<NenCoupon>({ isEnabled: true, codePrefix: 'NENBDAY', benefitLabel: 'お誕生日月限定クーポン', discountAmount: 500, validityDays: 31, leapYearPolicy: 'feb28' })
  const [couponOpen, setCouponOpen] = useState(false)
  const [savingCoupon, setSavingCoupon] = useState(false)
  const [saving, setSaving] = useState<string | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const [previewCampaignKey, setPreviewCampaignKey] = useDetailPanelUrl('campaign')
  const [selectedColumnId, setSelectedColumnId] = useDetailPanelUrl('column')
  const [audienceCount, setAudienceCount] = useState<number | null>(null)
  const [plan, setPlan] = useState<ColumnDeliveryPlan>(() => ({ when: 'now', scheduledAt: defaultScheduleLocal(new Date()) }))
  const [introDraft, setIntroDraft] = useState('')
  const [savingColumnId, setSavingColumnId] = useState<string | null>(null)
  const [testFriendId, setTestFriendId] = useState('')
  const [notice, setNotice] = useState<Notice | null>(null)
  const [loading, setLoading] = useState(true)
  const [tabErrors, setTabErrors] = useState<Record<NenTab, string>>(EMPTY_ERRORS)
  const loadSequence = useRef(0)
  const loadedTabs = useRef<Set<NenTab>>(new Set())
  const tabRef = useRef<NenTab>(tab)
  tabRef.current = tab

  /*
    数値カード帯はどのタブでも同じ4枚（★管理画面 37-6）。今月と先月を月の範囲で取る。
    自動配信・停止中・コラムは同じ取得で足りる。送った履歴だけ別に取る。
  */
  const loadTab = useCallback(async (next: NenTab) => {
    const sequence = ++loadSequence.current
    const generation = accountScope.current.generation
    setLoading(true)
    if (!selectedAccountId) {
      setSettings([]); setColumns([]); setColumnsTotal(null); setKpis(null)
      setFlowMetrics(null); setColumnMetrics(null); setDeliveryList(null); setDeliveryDetail(null)
      setTabErrors(EMPTY_ERRORS)
      loadedTabs.current.clear()
      setLoading(false); return
    }
    const fail = (message: string) => {
      if (sequence !== loadSequence.current) return
      setTabErrors((current) => ({ ...current, [next]: message }))
      setLoading(false)
    }
    const done = () => {
      if (sequence !== loadSequence.current) return
      setTabErrors((current) => ({ ...current, [next]: '' }))
      loadedTabs.current.add(next)
      setLoading(false)
    }
    /*
      数の帯とタブの件数（設定・コラム・今月の数）。どのタブでも同じものを使う。
      読めたら true。読めないときは false（帯は「—」のまま）。
    */
    const loadShared = async (): Promise<boolean> => {
      const now = new Date()
      const thisMonth = jstMonthRange(now)
      const lastMonth = jstMonthRange(now, -1)
      const [settingRes, columnRes, flowRes, columnMetricRes, thisMonthRes, lastMonthRes, couponRes] = await Promise.all([
        api.nenCampaigns.settings(selectedAccountId),
        api.nenCampaigns.columns(selectedAccountId),
        api.nenCampaigns.flowMetrics(selectedAccountId, { from: thisMonth.from, to: thisMonth.to }),
        api.nenCampaigns.columnMetrics(selectedAccountId, { from: thisMonth.from, to: thisMonth.to }),
        api.nenCampaigns.deliveries(selectedAccountId, { from: thisMonth.from, to: thisMonth.to, limit: 1 }),
        api.nenCampaigns.deliveries(selectedAccountId, { from: lastMonth.from, to: lastMonth.to, limit: 1 }),
        api.nenCampaigns.birthdayCoupon(selectedAccountId),
      ])
      if (sequence !== loadSequence.current || generation !== accountScope.current.generation) return false
      if (!settingRes.success || !columnRes.success || !flowRes.success || !columnMetricRes.success || !thisMonthRes.success || !lastMonthRes.success) return false
      setSettings(settingRes.data); setColumns(columnRes.data)
      setLoadedAccountScope(generation)
      setColumnsTotal(columnRes.pagination?.total ?? columnRes.data.length)
      setFlowMetrics(flowRes.data); setColumnMetrics(columnMetricRes.data)
      if (couponRes.success) setCoupon(couponRes.data)
      const openable = columnMetricRes.data.columns.filter((column) => column.articleOpened.state === 'available' && column.sent > 0)
      const opened = openable.reduce((sum, column) => sum + (column.articleOpened.value ?? 0), 0)
      const sentColumns = openable.reduce((sum, column) => sum + column.sent, 0)
      const unmet = thisMonthRes.data.summary.unmetReasons ?? {}
      setKpis({
        monthLabel: thisMonth.label,
        sentThisMonth: thisMonthRes.data.summary.sent,
        sentLastMonth: lastMonthRes.data.summary.sent,
        openRate: sentColumns > 0 ? Math.round((opened / sentColumns) * 100) : null,
        orders: flowRes.data.summary.associatedConversions,
        orderAmount: flowRes.data.summary.associatedConversionAmount,
        undelivered: thisMonthRes.data.summary.failed,
        blocked: unmet.blocked ?? 0,
        unfollowed: unmet.unfollowed ?? 0,
      })
      // 数値カードは全タブで共通なので、自動配信・停止中・コラムの3つをまとめて読み込み済みにする。
      for (const shared of ['auto', 'columns', 'paused'] as NenTab[]) loadedTabs.current.add(shared)
      setTabErrors((current) => ({ ...current, auto: '', columns: '', paused: '' }))
      return true
    }
    try {
      if (next === 'history') {
        /*
          URLで送った履歴を直接開いたときは、共通の数の帯がまだ無い。履歴と一緒に読む
          （★V8-B  は履歴でも帯に数が出る）。帯が読めなくても履歴は出す。
        */
        const [deliveryRes] = await Promise.all([
          api.nenCampaigns.deliveries(selectedAccountId, { limit: 20 }),
          loadedTabs.current.has('auto') ? Promise.resolve(true) : loadShared().catch(() => false),
        ])
        if (sequence !== loadSequence.current) return
        if (!deliveryRes.success) return fail('送った履歴を読み込めませんでした。')
        setDeliveryList(deliveryRes.data); done()
        return
      }
      if (!(await loadShared())) {
        if (sequence !== loadSequence.current) return
        return fail(next === 'columns' ? 'コラムの情報を読み込めませんでした。' : '自動配信の情報を読み込めませんでした。')
      }
      done()
    } catch { fail('情報を読み込めませんでした。通信を確認してください。') }
  }, [selectedAccountId])

  const loadTabRef = useRef(loadTab)
  loadTabRef.current = loadTab
  useEffect(() => {
    loadedTabs.current.clear()
    void loadTab(tabRef.current)
  }, [loadTab])
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get('tab')
    if (isTab(requested) && requested !== 'auto') {
      setTab(requested)
      void loadTabRef.current(requested)
    }
    // 初回だけURLの指定タブを開く。loadTabはref経由で最新のものを使う。
  }, [])
  /*
    テスト送信先の候補。実口（getTestRecipient）は「設定 › アカウント › テスト送信先」に登録され、
    かつ友だち追加中の人にしか送らない。登録されていない友だちを候補に並べると、押しても届かず
    理由も分からないので、登録済みの人だけを出す。ログインユーザーも登録していれば含まれる。
  */
  useEffect(() => {
    setFriends([]); setTestFriendId('')
    if (!selectedAccountId) return
    let cancelled = false
    api.accountSettings.getTestRecipients(selectedAccountId).then((result) => {
      if (cancelled || !result.success) return
      const list = result.data.map((friend) => ({ id: friend.id, displayName: friend.displayName }))
      setFriends(list); setTestFriendId((current) => list.some((friend) => friend.id === current) ? current : list[0]?.id || '')
    }).catch(() => undefined)
    return () => { cancelled = true }
  }, [selectedAccountId])

  // コラムを選ぶと、紹介文の下書きと「送る相手」の人数をそのコラムに合わせる。
  const selectedColumn = columns.find((column) => column.id === selectedColumnId) ?? null
  useEffect(() => {
    setIntroDraft(selectedColumn?.introText ?? '')
    setAudienceCount(null)
    if (!selectedAccountId || !selectedColumn) return
    let cancelled = false
    api.nenCampaigns.columnAudience(selectedAccountId, selectedColumn.targetMode, selectedColumn.targetTagId)
      .then((result) => { if (!cancelled && result.success) setAudienceCount(result.data.count) })
      .catch(() => undefined)
    return () => { cancelled = true }
    // 選び直したときだけ取り直す（同じコラムの一覧再読込では人数を取り直さない）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccountId, selectedColumn?.id, selectedColumn?.targetMode, selectedColumn?.targetTagId])

  /*
   * #935 N-301: 紹介文の入力途中で画面を離れると内容が消えていた。
   * ブラウザ離脱・画面内リンク・戻る操作・別コラムへの選び直しを止めて確認する。
   */
  const introDirty = selectedColumn !== null && introDraft !== (selectedColumn.introText ?? '')
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({
    dirty: introDirty,
    busy: savingColumnId !== null,
    handlesLocalLink: (destination) => destination.searchParams.has('column'),
  })
  const [pendingColumnSelect, setPendingColumnSelect] = useState<{ id: string | null } | null>(null)
  const selectColumn = (id: string | null) => {
    if (introDirty && id !== selectedColumnId) {
      setPendingColumnSelect({ id })
      return
    }
    setSelectedColumnId(id)
  }

  const updateDraft = (key: string, patch: Partial<NenCampaignSetting>) => setSettings((current) => current.map((item) => item.campaignKey === key ? { ...item, ...patch } : item))
  // 停止・再開だけは専用の口を使い、本文などは送り直さない。保存済み本文が
  // 上限を超えていても停止は必ずできる必要がある（#659差し戻し2点目）。
  const toggleSetting = async (setting: NenCampaignSetting) => {
    if (!selectedAccountId) return
    const nextEnabled = !setting.isEnabled
    setSaving(setting.campaignKey); setNotice(null)
    try {
      const result = await api.nenCampaigns.setEnabled(selectedAccountId, setting.campaignKey, nextEnabled, setting.updatedAt)
      updateDraft(setting.campaignKey, { isEnabled: nextEnabled, ...(result.data?.updatedAt ? { updatedAt: result.data.updatedAt } : {}) })
      setNotice({ tone: 'success', text: `${setting.label}を${nextEnabled ? '動かしました' : '止めました'}。` })
      return true
    } catch (caught) {
      /*
       * M501: 混雑（429）の案内は共通部品に任せる。画面で状態を見分けて
       * 文言を書き分けず、失敗そのままを渡す（Retry-After は口が返さない
       * ため、共通部品の「少し待ってから」の案内を使う）。
       */
      setNotice({
        tone: 'error',
        text: describeApiFailure(caught, `${setting.label}の切り替え`, {
          forbidden: `${setting.label}を切り替える権限がありません。権限を確認してください。`,
        }),
      })
      return false
    }
    finally { setSaving(null) }
  }
  const testSend = async (setting: NenCampaignSetting) => {
    if (!selectedAccountId || !testFriendId) { setNotice({ tone: 'error', text: 'テスト送信先を選択してください。' }); return }
    setTesting(setting.campaignKey)
    try { await api.nenCampaigns.testSend({ campaignKey: setting.campaignKey, accountId: selectedAccountId, friendId: testFriendId }); setNotice({ tone: 'success', text: `${setting.label}をテスト送信しました。LINEを確認してください。` }) }
    catch (caught) { setNotice({ tone: 'error', text: testSendFailureText(caught, 'テスト送信できませんでした。') }) } finally { setTesting(null) }
  }
  const deliverColumn = async (column: NenColumn, scheduledAt: string | undefined, confirmation: { recipientCount: number; confirmationToken: string }) => {
    if (!selectedAccountId) return
    setNotice(null)
    try {
      const result = await api.nenCampaigns.deliverColumn(column.id, { accountId: selectedAccountId, scheduledAt, ...confirmation })
      if (!result.success) throw new Error(result.error)
      // #935 N-303: 同じ相手へ二度は入らない。0人なら「入れた」と言わず実態を伝える。
      setNotice({ tone: 'success', text: result.data.queued === 0
        ? `「${column.title}」はすでに配信待ちに入っているか、いま送れる相手がいません。`
        : scheduledAt ? `「${column.title}」を${result.data.queued}人分 予約しました。` : `「${column.title}」を${result.data.queued}人分 配信待ちに入れました。` })
      void loadTab('columns')
      return true
    } catch (caught) {
      const currentCount = caught instanceof ApiError && caught.data && typeof caught.data === 'object' && 'recipientCount' in caught.data ? (caught.data as { recipientCount?: unknown }).recipientCount : null
      setNotice({ tone: 'error', text: caught instanceof ApiError && caught.code === 'past_datetime'
        ? '予約日時が過去になっています。いまより先の日時を選び直してください。'
        : caught instanceof ApiError && caught.status === 409
          ? `配信内容または対象が変わりました。${typeof currentCount === 'number' && Number.isSafeInteger(currentCount) && currentCount >= 0 ? `現在の対象は${currentCount.toLocaleString('ja-JP')}人です。` : ''}画面を読み直して確認してください。`
          : 'コラムを配信予約できませんでした。コラムの配信が停止中でないか確認してください。' })
      return false
    }
  }
  const saveColumnMessage = async (column: NenColumn) => {
    if (!selectedAccountId || !introDraft.trim()) { setNotice({ tone: 'error', text: '紹介文を入力してください。' }); return }
    setSavingColumnId(column.id)
    try {
      // M507: 開いたときの版を添える。ほかの人が先に保存していたら409で止まる。
      const saved = await api.nenCampaigns.updateColumnMessage(selectedAccountId, column.id, introDraft, column.updatedAt)
      // 版を成功応答の新しい版へ進める。入力は残したままにする。
      setColumns((current) => current.map((item) => item.id === column.id
        ? { ...item, introText: introDraft, updatedAt: saved.data?.updatedAt ?? item.updatedAt }
        : item))
      setNotice({ tone: 'success', text: `「${column.title}」の紹介文を保存しました。` })
    } catch (caught) {
      // M507: 競合時は最新の紹介文を読み直し、入力は残したまま比べながら
      // 保存し直せるようにする。
      if (caught instanceof ApiError && caught.status === 409 && caught.code === 'VERSION_CONFLICT') {
        const latest = (caught.data as { latest?: { introText?: string; updatedAt?: string } } | null)?.latest
        if (latest) {
          setColumns((current) => current.map((item) => item.id === column.id
            ? { ...item, introText: latest.introText ?? item.introText, updatedAt: latest.updatedAt ?? item.updatedAt }
            : item))
        } else {
          await loadTab('columns')
        }
        setNotice({ tone: 'error', text: 'ほかの人が先に紹介文を保存しました。最新の内容を確認してから、もう一度保存してください。入力した内容はそのまま残っています。' })
        return
      }
      setNotice({ tone: 'error', text: 'コラムの紹介文を保存できませんでした。' })
    } finally { setSavingColumnId(null) }
  }
  /*
    ★管理画面 37-6-A「ECのコラムを取り込む」。EC で保存されたコラムは Webhook で自動的に届く。
    ここでは、宛先（LINEアカウント）が決まらずに未割り当てのまま残っている分を、
    選択中のアカウントへ割り当てて一覧に出す。
  */
  const [importing, setImporting] = useState(false)
  const importColumns = async () => {
    if (!selectedAccountId || importing) return
    setImporting(true); setNotice(null)
    try {
      const result = await api.nenCampaigns.importColumns(selectedAccountId)
      if (!result.success) throw new Error(result.error)
      setNotice({ tone: 'success', text: result.data.imported > 0
        ? `ECのコラムを${result.data.imported}本 取り込みました。`
        : '新しいコラムはありません。ECでコラムを保存すると自動でここに届きます。' })
      await loadTab('columns')
    } catch { setNotice({ tone: 'error', text: 'ECのコラムを取り込めませんでした。通信の状態を確認して、もう一度お試しください。' }) }
    finally { setImporting(false) }
  }
  /*
   * M506: 複製中はボタンを押せなくし、要求キーで二重押し・再送を1本に収める。
   * キーは複製元ごとに持ち回り、成功したら捨てる（次の複製は別の試行）。
   */
  const [duplicatingColumnId, setDuplicatingColumnId] = useState<string | null>(null)
  const duplicateKeysRef = useRef<Record<string, string>>({})
  const duplicateColumn = async (column: NenColumn) => {
    if (!selectedAccountId || duplicatingColumnId) return
    setDuplicatingColumnId(column.id)
    const requestKey = duplicateKeysRef.current[column.id]
      ?? (duplicateKeysRef.current[column.id] = crypto.randomUUID())
    try {
      const result = await api.nenCampaigns.duplicateColumn(column.id, selectedAccountId, { idempotencyKey: requestKey })
      if (!result.success) throw new Error()
      delete duplicateKeysRef.current[column.id]
      setNotice({ tone: 'success', text: result.replayed ? `「${column.title}」の複製は既にありました。複製を開きました。` : `「${column.title}」を下書きへ複製しました。` })
      await loadTab('columns')
      setSelectedColumnId(result.data.id)
    }
    catch { setNotice({ tone: 'error', text: 'コラムを複製できませんでした。' }) }
    finally { setDuplicatingColumnId(null) }
  }
  const testColumn = async (column: NenColumn) => {
    if (!selectedAccountId || !testFriendId) { setNotice({ tone: 'error', text: 'テスト送信先を選択してください。' }); return }
    setTesting(column.id)
    try { await api.nenCampaigns.testColumn(column.id, selectedAccountId, testFriendId); setNotice({ tone: 'success', text: `「${column.title}」をテスト送信しました。LINEを確認してください。` }) }
    catch (caught) { setNotice({ tone: 'error', text: testSendFailureText(caught, 'コラムをテスト送信できませんでした。') }) } finally { setTesting(null) }
  }
  const sendPendingNow = async () => {
    if (!selectedAccountId) return
    /*
      送る件数は一覧の窓付き集計(summary.pending)ではなく、口と同じ決めごとの
      overview.jobs.pending(未来ぶん)を使う(点検 #512 の中2)。窓が違う数を
      送ると、変わっていないのに409で失敗する。
    */
    try {
      const overviewRes = await api.nenCampaigns.overview(selectedAccountId)
      if (!overviewRes.success) throw new Error()
      const result = await api.nenCampaigns.sendPendingNow(selectedAccountId, overviewRes.data.jobs.pending)
      if (!result.success) throw new Error()
      setNotice({ tone: 'success', text: `${result.data.queued}件を今すぐ送る待ち行列へ移しました。` }); await loadTab('history')
    }
    catch { setNotice({ tone: 'error', text: '待っている配信の件数が変わりました。読み直して確認してください。' }) }
  }
  const saveCoupon = async () => {
    if (!selectedAccountId || savingCoupon) return
    // 空欄は 0 になるので、汎用エラー(400)になる前に具体的な直し方を出す。
    if (!Number.isInteger(coupon.discountAmount) || coupon.discountAmount < 1 || coupon.discountAmount > 100000) {
      setNotice({ tone: 'error', text: '割引の額は1〜100,000円の整数で入力してください。' })
      return
    }
    if (!Number.isInteger(coupon.validityDays) || coupon.validityDays < 1 || coupon.validityDays > 365) {
      setNotice({ tone: 'error', text: '使える日数は1〜365日の整数で入力してください。' })
      return
    }
    if (!/^[A-Z0-9-]{3,10}$/.test(coupon.codePrefix)) {
      setNotice({ tone: 'error', text: 'クーポンの頭の文字は半角大文字・数字・-で3〜10文字にしてください。' })
      return
    }
    setSavingCoupon(true)
    try { await api.nenCampaigns.updateBirthdayCoupon(selectedAccountId, coupon); setNotice({ tone: 'success', text: 'お誕生日クーポン設定を保存しました。' }); setCouponOpen(false) }
    catch { setNotice({ tone: 'error', text: 'クーポン設定を保存できませんでした。' }) }
    finally { setSavingCoupon(false) }
  }
  const showDelivery = async (id: string) => {
    if (!selectedAccountId) return
    if (deliveryDetail?.id === id) { setDeliveryDetail(null); return }
    try {
      const result = await api.nenCampaigns.delivery(id, selectedAccountId)
      if (!result.success) throw new Error()
      setDeliveryDetail(result.data)
    } catch { setNotice({ tone: 'error', text: '配信時の内容を表示できませんでした。' }) }
  }
  // 検索語はサーバー側の履歴全体へ効く。ページ送り・状態チップの切替でも消えないよう
  // ここに保持し、新しい検索(q を明示)が来たときだけ差し替える。
  const [historyQuery, setHistoryQuery] = useState('')
  const changeDeliveryView = async (status?: string, cursor?: string, q?: string) => {
    if (!selectedAccountId) return
    const effectiveQuery = q === undefined ? historyQuery : q
    try {
      const result = await api.nenCampaigns.deliveries(selectedAccountId, { limit: 20, status, q: effectiveQuery || undefined, cursor })
      if (!result.success) throw new Error()
      setDeliveryList(result.data); setDeliveryDetail(null); setHistoryQuery(effectiveQuery)
    } catch { setNotice({ tone: 'error', text: '送った履歴を更新できませんでした。' }) }
  }
  const retryDelivery = async (id: string, expectedVersion: number, reason: string) => {
    if (!selectedAccountId || !reason.trim()) { setNotice({ tone: 'error', text: '再送する理由を入力してください。' }); return }
    try {
      const result = await api.nenCampaigns.retryDelivery(id, { lineAccountId: selectedAccountId, expectedVersion, reason: reason.trim() })
      if (!result.success) throw new Error()
      setNotice({ tone: 'success', text: '配信を再送待ちへ戻しました。' }); setDeliveryDetail(null); await loadTab('history')
    } catch { setNotice({ tone: 'error', text: '配信を再送待ちへ戻せませんでした。状態を更新して確認してください。' }) }
  }
  const changeTab = (next: NenTab) => {
    setTab(next)
    setNotice(null)
    window.history.replaceState(window.history.state, '', next === 'auto' ? '/nen-campaigns' : `/nen-campaigns?tab=${next}`)
    if (!loadedTabs.current.has(next)) void loadTab(next)
  }

  if (loading && loadedTabs.current.size === 0) return <ListState kind="loading" />

  /*
    ヘッダー操作。★管理画面 37-6 の「配信を追加」は、自動配信の種類が実キー固定（追加口が無い）
    ため置かない。コラムは ★管理画面 37-6-A どおり「ECのコラムを取り込む」（未割り当て分の割り当て）。
    #618: 一覧に件数があっても未選択でも届くよう、新規作成入口「コラムを書く」
    （/nen-campaigns/columns/new・日時あり下書き保存）をヘッダーに置く。
  */
  const headerAction = tab === 'columns' ? (
    <span className="flex flex-wrap items-center justify-end gap-2">
      <Button href="/nen-campaigns/columns/new" variant="primary">コラムを書く</Button>
      <Button type="button" disabled={importing || !selectedAccountId} onClick={() => void importColumns()} busy={importing} busyLabel="取り込んでいます…">ECのコラムを取り込む</Button>
    </span>
  )
    : tab === 'history' ? <Button type="button" disabled={!deliveryList?.summary.pending} onClick={() => void sendPendingNow()}>待っているものを今すぐ送る</Button>
      : null

  /*
   * #935 N-301: 紹介文の入力途中で画面を離れる／別コラムへ移るときの確認。
   * 管理画面・v8 のどちらの見た目でも同じ確認を出す（v8 にだけ無く、移動が黙って止まっていた：監査 WEB-315）。
   */
  const leaveDialogs = (
    <>
      <UnsavedLeaveDialog
        open={leaveTarget !== null}
        subject="入力した紹介文"
        cancelLabel="書き続ける"
        onConfirm={confirmLeave}
        onCancel={cancelLeave}
      />
      <ConfirmDialog
        open={pendingColumnSelect !== null}
        title="入力した紹介文が保存されていません"
        description="このまま別のコラムへ移ると、入力した紹介文は消えます。移りますか？"
        confirmLabel="保存せずに移る"
        cancelLabel="書き続ける"
        onConfirm={() => {
          const target = pendingColumnSelect
          setPendingColumnSelect(null)
          if (target) setSelectedColumnId(target.id)
        }}
        onCancel={() => setPendingColumnSelect(null)}
      />
    </>
  )

  return (
    <>
      <NenCampaignsV8
        topAction={headerAction}
        tab={tab} onTabChange={changeTab} settings={settings} columns={columns} kpis={kpis}
        tabError={tabErrors[tab]} onRetryTab={() => loadTab(tab)}
        kpisFailed={kpis === null && (tabErrors.auto !== '' || tabErrors.columns !== '' || tabErrors.paused !== '')}
        flowMetrics={flowMetrics} columnMetrics={columnMetrics} deliveryList={deliveryList} deliveryDetail={deliveryDetail}
        friends={friends} testFriendId={testFriendId} onTestFriendChange={setTestFriendId} accountId={selectedAccountId} currentAccountData={loadedAccountScope === accountScope.current.generation}
        loading={loading} notice={notice}
        saving={saving} testing={testing}
        previewCampaignKey={previewCampaignKey} onPreviewCampaign={setPreviewCampaignKey}
        onToggleSetting={(setting) => toggleSetting(setting)} onTestSend={(setting) => void testSend(setting)}
        coupon={coupon} couponOpen={couponOpen} onCouponOpenChange={setCouponOpen} onCouponChange={setCoupon} onSaveCoupon={() => void saveCoupon()} savingCoupon={savingCoupon}
        selectedColumnId={selectedColumnId} onSelectColumn={selectColumn} audienceCount={audienceCount}
        columnsTotal={columnsTotal}
        onLoadMoreColumns={loadMoreColumns}
        plan={plan} onPlanChange={setPlan}
        introDraft={introDraft} onIntroChange={setIntroDraft} onSaveIntro={(column) => void saveColumnMessage(column)} savingColumnId={savingColumnId}
        onPreviewColumn={(column) => api.nenCampaigns.previewColumnDelivery(selectedAccountId!, column.id).then(result => { if (!result.success) throw new Error(result.error); return result.data })}
        onDeliverColumn={(column, scheduledAt, confirmation) => deliverColumn(column, scheduledAt, confirmation)}
        onDuplicateColumn={(column) => void duplicateColumn(column)} duplicatingColumnId={duplicatingColumnId} onTestColumn={(column) => void testColumn(column)}
        onShowDelivery={(id) => void showDelivery(id)} onRetryDelivery={(id, version, reason) => void retryDelivery(id, version, reason)}
        onChangeDeliveryView={(status, cursor, q) => void changeDeliveryView(status, cursor, q)}
      />
      {leaveDialogs}
    </>
  )
}
