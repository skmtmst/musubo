'use client'
import { DetailContent, DetailField, DetailSection, DetailInlineEdit, DetailNumber, DetailSectionTitle } from '@/components/shared/detail-content'

import { describeApiFailure } from '@/components/shared/api-error-message'
import { DRAWER_TABS } from './drawer-tabs'
import { Tabs } from '@/components/shared/tabs'
import { useUrlTab } from '@/lib/use-url-tab'
import { notifySaved } from '@/components/shared/toast'
import CopyTextButton from '@/components/shared/copy-text-button'
import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { useUnsavedGuard, type UnsavedLeaveTarget } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { Check, Copy, PauseCircle, Pencil } from 'lucide-react'
import { api, type AffiliateAccountSettlementPreview, type ConversionApprovalItem } from '@/lib/api'
import { formatNumber } from '@/lib/format'
import InlineEdit from '@/components/shared/inline-edit'
import Button from '@/components/shared/button'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
import Checkbox from '@/components/shared/checkbox'
import { Field } from '@/components/shared/form-controls'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Drawer from '@/components/shared/drawer'
import { notifyToast } from '@/components/shared/toast'
import {
  asReportV2,
  currentSettlementPeriod,
  distributionUrl,
  formatDate,
  formatMonthDayTime,
  formatYen,
  listAllConversionApprovals,
  personName,
  planText,
  type AffiliateLink,
  type AffiliateListRow,
  type ReportV2,
} from './display'
import { AffiliatePaymentConfirmDialog } from './dialogs'
import { StatusPill } from './parts'
import styles from './affiliate-drawer.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import NumberInput from '@/components/shared/number-field'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { affiliateEditValues, type AffiliateEditSource } from './create-conflict'

/*
 * ★V8 アフィリエイターの詳細の引き出し（板 。右から出る 620px）。
 * 「成果を見る」・名前・`?affiliate=` で開く。上のタブで 概要・内訳・友だち・支払い。
 *
 * 動きは app/affiliates/v8-drawer.tsx から写した（集計・紹介リンク・紹介で増えた友だち・
 * 今回の締めの見込み・報酬の約束の保存）。絵にある「認めるのを待っている成果」
 * （断る・認める）と「支払いを確定する」は、成果承認・支払いのタブと同じ口を使う。
 * 世代番号で、別の人へ開き直した途中に届いた古い応答を捨てる。
 */

const JOURNEY_PAGE_SIZE = 30

interface JourneySummary {
  friendId: string
  displayName: string | null
  addedAt: string
  refCode: string | null
  conversionCount: number
}

type SettlementLine = AffiliateAccountSettlementPreview['affiliates'][number]

export default function AffiliateDrawer({
  affiliate,
  accountId,
  readonly,
  startInEdit,
  linkBaseUrl,
  onClose,
  onChanged,
  onStopRequest,
}: {
  affiliate: AffiliateListRow
  accountId: string | null
  readonly: boolean
  /** 「編集」から開いたとき、支払いのタブの報酬の約束を最初から開く。 */
  startInEdit: boolean
  linkBaseUrl: string | null
  onClose: () => void
  onChanged: () => void
  onStopRequest: (id: string, name: string) => void
}) {
  const saveErrors = useSaveFormErrors()
  const period = useMemo(() => currentSettlementPeriod(), [])
  const [tab, setTab] = useUrlTab(DRAWER_TABS.map(t => t.key), startInEdit ? 'payment' : 'summary', 'affiliates')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [report, setReport] = useState<ReportV2 | null>(null)
  const [links, setLinks] = useState<AffiliateLink[]>([])
  const [pending, setPending] = useState<ConversionApprovalItem[]>([])
  const [pendingError, setPendingError] = useState(false)
  /* WEB209：5000件で読むのを止めたときは、一部だけと書く。 */
  const [pendingTruncated, setPendingTruncated] = useState(false)
  const [deciding, setDeciding] = useState<string | null>(null)
  const [journeys, setJourneys] = useState<JourneySummary[]>([])
  const [journeyState, setJourneyState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [journeyMore, setJourneyMore] = useState(false)
  const [journeyLoadingMore, setJourneyLoadingMore] = useState(false)
  const [settlement, setSettlement] = useState<SettlementLine | null>(null)
  const [settlementState, setSettlementState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null)
  const settlementFormId = useId()
  const [savingSettlement, setSavingSettlement] = useState(false)
  const [settlementDirty, setSettlementDirty] = useState(false)
  const [nameDirty, setNameDirty] = useState(false)
  const [nameSaving, setNameSaving] = useState(false)
  const [nameReset, setNameReset] = useState(0)
  const depth = useContext(OverlayDepthContext)
  const pendingLeave = useRef<UnsavedLeaveTarget | null>(null)
  const localActions = useRef(new WeakSet<() => void>())
  const guard = useUnsavedGuard({ dirty: settlementDirty || nameDirty || savingSettlement || nameSaving, busy: savingSettlement || nameSaving, onDiscard: () => {
    setNameDirty(false)
    setNameReset(token => token + 1)
    const target = pendingLeave.current
    if (target?.kind !== 'action' || !localActions.current.has(target.run)) onClose()
  } })
  pendingLeave.current = guard.leaveTarget
  const protectLocal = (action: () => void) => { localActions.current.add(action); guard.guarded(action) }
  const [editing, setEditing] = useState(startInEdit)
  const [paymentOpen, setPaymentOpen] = useState(false)
  const journeyCursor = useRef<{ beforeAt: string; beforeId: string } | null>(null)

  /* 世代番号。引き出しを開き直したら古い応答を捨てる。 */
  const genRef = useRef(0)
  const idRef = useRef<string | null>(null)
  const isCurrent = useCallback((id: string, gen: number) => genRef.current === gen && idRef.current === id, [])

  const loadDetail = useCallback(async (id: string, gen: number) => {
    setLoading(true)
    setError(false)
    try {
      const [reportRes, linksRes] = await Promise.all([
        api.affiliates.reportV2(id, { startDate: period.periodFrom, endDate: period.periodTo }),
        api.affiliates.links(id),
      ])
      if (!isCurrent(id, gen)) return
      setReport(reportRes.success ? asReportV2(reportRes.data) : null)
      setLinks(linksRes.success && Array.isArray(linksRes.data) ? (linksRes.data as unknown as AffiliateLink[]) : [])
      if (!reportRes.success || !linksRes.success) setError(true)
    } catch {
      if (isCurrent(id, gen)) setError(true)
    }
    if (isCurrent(id, gen)) setLoading(false)
  }, [isCurrent, period])

  const loadPending = useCallback(async (id: string, gen: number) => {
    setPendingError(false)
    try {
      const all = await listAllConversionApprovals('pending')
      if (!isCurrent(id, gen)) return
      setPending(all.items.filter((item) => item.affiliateId === id))
      setPendingTruncated(all.truncated)
    } catch {
      if (isCurrent(id, gen)) setPendingError(true)
    }
  }, [isCurrent])

  const loadJourneys = useCallback(async (id: string, gen: number) => {
    setJourneyState('loading')
    try {
      const res = await api.affiliates.journeys(id, { limit: JOURNEY_PAGE_SIZE })
      if (!isCurrent(id, gen)) return
      if (res.success && Array.isArray(res.data)) {
        setJourneys(res.data)
        journeyCursor.current = res.nextCursor ?? null
        setJourneyMore(Boolean(res.nextCursor))
        setJourneyState('ready')
      } else {
        setJourneyState('error')
      }
    } catch {
      if (isCurrent(id, gen)) setJourneyState('error')
    }
  }, [isCurrent])

  const loadMoreJourneys = useCallback(async (id: string, gen: number) => {
    const cursor = journeyCursor.current
    if (journeyLoadingMore || !cursor) return
    setJourneyLoadingMore(true)
    try {
      const res = await api.affiliates.journeys(id, { limit: JOURNEY_PAGE_SIZE, beforeAt: cursor.beforeAt, beforeId: cursor.beforeId })
      if (!isCurrent(id, gen)) return
      if (res.success && Array.isArray(res.data)) {
        setJourneys((prev) => {
          const seen = new Set(prev.map((j) => j.friendId))
          return [...prev, ...res.data.filter((j) => !seen.has(j.friendId))]
        })
        journeyCursor.current = res.nextCursor ?? null
        setJourneyMore(Boolean(res.nextCursor))
      }
    } catch {
      /* 続きが読めないときは「さらに読み込む」を残す */
    }
    setJourneyLoadingMore(false)
  }, [isCurrent, journeyLoadingMore])

  /* 支払い：この人の今回の締め対象（無ければ無いと書く）。 */
  const loadSettlement = useCallback(async (id: string, gen: number) => {
    if (!accountId) {
      setSettlement(null)
      setSettlementState('error')
      return
    }
    setSettlementState('loading')
    try {
      const res = await api.affiliates.settlementPreview(accountId, period)
      if (!isCurrent(id, gen)) return
      if (!res.success || !Array.isArray(res.data.affiliates)) {
        setSettlementState('error')
        return
      }
      const mine = res.data.affiliates.find((item) => item.affiliateId === id) ?? null
      setSettlement(mine)
      setSettlementState('ready')
    } catch (saveFailure) {
      saveErrors.capture(saveFailure);

      if (isCurrent(id, gen)) setSettlementState('error')
    }
  }, [accountId, isCurrent, period, saveErrors]);


  const reloadAll = useCallback(() => {
    genRef.current += 1
    idRef.current = affiliate.id
    const gen = genRef.current
    void loadDetail(affiliate.id, gen)
    void loadPending(affiliate.id, gen)
    void loadJourneys(affiliate.id, gen)
    void loadSettlement(affiliate.id, gen)
  }, [affiliate.id, loadDetail, loadJourneys, loadPending, loadSettlement])

  useEffect(() => { reloadAll() }, [reloadAll])

  const decide = useCallback(async (item: ConversionApprovalItem, status: 'approved' | 'rejected') => {
    setDeciding(item.eventId)
    try {
      const res = status === 'approved'
        ? await api.conversionApprovals.approve(item.eventId, 'pending')
        : await api.conversionApprovals.reject(item.eventId, 'pending')
      if (!res.success) {
        notifyToast(res.code === 'VERSION_CONFLICT' || res.code === 'STATUS_CONFLICT'
          ? 'ほかの人が先に決めました。読み直しました。'
          : '決められませんでした。もう一度お試しください。')
      } else {
        notifyToast(status === 'approved' ? '成果を認めました。次の締めで報酬に入ります。' : '成果を断りました。報酬には入りません。')
        onChanged()
      }
    } catch {
      notifyToast('決められませんでした。もう一度お試しください。')
    } finally {
      setDeciding(null)
      reloadAll()
    }
  }, [onChanged, reloadAll])

  const subLine = [
    `紹介コード ${affiliate.code}`,
    planText(affiliate),
    affiliate.payoutCycle ? `締め ${affiliate.payoutCycle}` : null,
    affiliate.friendId ? 'LINE の友だちと結びつけ済み' : 'LINE の友だちとは結びついていません',
  ].filter(Boolean).join('・')

  const rewardDetail = report
    ? affiliate.commissionRate > 0
      ? `売上 ${formatYen(report.revenue)} の ${affiliate.commissionRate}%`
      : `認めた ${formatNumber(report.conversionsApproved)} 件の合計`
    : '読み込めませんでした'
  const monthReward = report
    ? affiliate.commissionRate > 0 ? (report.revenue * affiliate.commissionRate) / 100 : report.confirmedReward
    : null

  const summary = (
    <div className={styles.stack}>
      <DetailSection>
        <DetailField label="今月の成果" note={report ? `認めた ${formatNumber(report.conversionsApproved)}・待ち ${formatNumber(report.conversionsPending)}` : '読み込めませんでした'}><DetailNumber value={report?.conversions} unit="件" /></DetailField>
        <DetailField label="今月の報酬" note={rewardDetail}><DetailNumber value={null} text={monthReward == null ? '—' : formatYen(monthReward)} unit="" /></DetailField>
        {/* 引き出しの幅（3つ並び）では「支払いを確定していない報酬」が切れるので短く言う（tnTn9）。 */}
        <DetailField label="支払い前の報酬" note={settlementState === 'ready' ? `認めた ${formatNumber(settlement?.conversionCount ?? 0)} 件分` : settlementState === 'loading' ? '読み込んでいます' : '読み込めませんでした'}><DetailNumber value={null} text={settlementState === 'ready' ? formatYen(settlement?.amount ?? 0) : '—'} unit="" /></DetailField>
      </DetailSection>

      <section className={styles.section} aria-label="発行ずみの紹介リンク">
        <div className={styles.sectionHead}>
          <DetailSectionTitle>発行ずみの紹介リンク</DetailSectionTitle>
        </div>
        {links.length === 0 ? (
          <p className={styles.empty}>{error ? '紹介リンクを読み込めませんでした。' : 'まだ紹介リンクはありません。'}</p>
        ) : (
          <div className={styles.list}>
            {links.map((link) => {
              const url = distributionUrl(link.ref_code, linkBaseUrl)
              const shown = url.replace(/^https?:\/\//, '') || link.ref_code
              const count = typeof link.conversions === 'number' ? `成果 ${formatNumber(link.conversions)} 件` : `クリック ${formatNumber(link.click_count)}`
              return (
                <div key={link.id} className={styles.listRow}>
                  <span className={styles.listText}>
                    <span className={styles.listName}>{link.offer_name ?? link.label ?? link.ref_code}{link.is_active ? '' : '（止めている）'}</span>
                    <span className={styles.listSub} title={url}>{`${shown}・${count}`}</span>
                  </span>
                  <CopyTextButton variant="secondary" label="コピーする" value={distributionUrl(link.ref_code, linkBaseUrl) ?? ""} icon={<Copy size={16} aria-hidden />} aria-label="紹介リンクをコピー" />
                </div>
              )
            })}
          </div>
        )}
      </section>

      <section className={styles.section} aria-label="認めるのを待っている成果">
        <div className={styles.sectionHead}>
          <DetailSectionTitle>認めるのを待っている成果</DetailSectionTitle>
        </div>
        {pendingTruncated && !pendingError ? (
          <p className={styles.empty}>件数が多いため、一部だけを出しています。</p>
        ) : null}
        {pendingError ? (
          <p className={styles.empty}>認めるのを待っている成果を読み込めませんでした。</p>
        ) : pending.length === 0 && !pendingTruncated ? (
          <p className={styles.empty}>認めるのを待っている成果はありません。</p>
        ) : pending.length === 0 ? (
          <p className={styles.empty}>読み込んだ範囲には、この人の待っている成果はありません。</p>
        ) : (
          <div className={styles.list}>
            {pending.map((item) => (
              <div key={item.eventId} className={styles.listRow}>
                <span className={styles.listText}>
                  <span className={styles.listName}>{`${item.conversionPointName ?? '成果'} ${item.value == null ? '' : formatYen(item.value)}`.trim()}</span>
                  <span className={styles.listSub}>{`${formatMonthDayTime(item.createdAt)}・${item.offerName ?? '案件なし'}`}</span>
                </span>
                {readonly ? null : (
                  <span className={styles.listActions}>
                    <Button type="button" disabled={deciding !== null} onClick={() => { void decide(item, 'rejected') }}>断る</Button>
                    <Button type="button" disabled={deciding !== null} onClick={() => { void decide(item, 'approved') }}>
                      <Check size={16} aria-hidden="true" /> 認める
                    </Button>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <DetailSection title="成果の付け方">
        <p className={styles.cardText}>
          付けた：最後に開いたリンク・数える期間は案件ごとの決まり。リンクを開いた記録が期間内に無い成果は、誰にも付けません。
        </p>
      </DetailSection>
    </div>
  )

  const breakdown = !report ? (
    <ListState
      kind="error"
      title="この期間の集計を読み込めませんでした"
      description="選んだ期間にこの人の成果が1件も無いか、集計が読めませんでした。リンクと成果の記録は消えていません。"
      onRetry={reloadAll}
    />
  ) : (
    <>
      <section className={styles.section} aria-label="案件ごとの内訳">
        <DetailSectionTitle>案件ごとの内訳</DetailSectionTitle>
        {report.byOffer.length === 0 ? <p className={styles.empty}>今月は案件ごとの成果がありません。</p> : (
          <div className={styles.list}>
            {report.byOffer.map((offer) => (
              <div key={offer.offerId} className={styles.listRow}>
                <span className={styles.listText}>
                  <span className={styles.listName}>{offer.offerName}</span>
                  <span className={styles.listSub}>{`1件 ${formatYen(offer.rewardAmount)}・認めた ${formatNumber(offer.conversionsApproved)}・待っている ${formatNumber(offer.conversionsPending)}`}</span>
                </span>
                <span className={styles.listValue}>{formatYen(offer.confirmedReward)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      <section className={styles.section} aria-label="成果地点ごとの内訳">
        <DetailSectionTitle>成果地点ごとの内訳</DetailSectionTitle>
        {report.conversionsByPoint.length === 0 ? <p className={styles.empty}>今月は成果がありません。</p> : (
          <div className={styles.list}>
            {report.conversionsByPoint.map((point) => (
              <div key={point.conversionPointId} className={styles.listRow}>
                <span className={styles.listText}>
                  <span className={styles.listName}>{point.name}</span>
                  <span className={styles.listSub}>{`${formatNumber(point.count)} 件`}</span>
                </span>
                <span className={styles.listValue}>{formatYen(point.value)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
      <p className={styles.note}>{`クリック ${formatNumber(report.clicks)}・友だち追加 ${formatNumber(report.friendAdds)}・認めなかった ${formatNumber(report.conversionsRejected)}`}</p>
      {report.duplicateFlags.length > 0 ? (
        <Notice tone="warn" message={`同じ友だちの重複が ${formatNumber(report.duplicateFlags.length)} 件あります。成果承認で中身を確かめてください。`} />
      ) : null}
    </>
  )

  const friends = journeyState === 'loading' ? (
    <ListState kind="loading" title="紹介で増えた友だちを読み込んでいます" />
  ) : journeyState === 'error' ? (
    <ListState
      kind="error"
      title="紹介で増えた友だちを読み込めませんでした"
      description="記録は消えていません。"
      onRetry={() => { void loadJourneys(affiliate.id, genRef.current) }}
    />
  ) : journeys.length === 0 ? (
    <p className={styles.empty}>この人の紹介で増えた友だちはまだいません。</p>
  ) : (
    <section className={styles.section} aria-label="紹介で増えた友だち">
      <DetailSectionTitle>{`紹介で増えた友だち（${formatNumber(journeys.length)} 人${journeyMore ? 'ほか' : ''}）`}</DetailSectionTitle>
      <div className={styles.list}>
        {journeys.map((journey) => {
          const duplicate = report?.duplicateFlags.some((flag) => flag.friendId === journey.friendId)
          return (
            <div key={journey.friendId} className={styles.listRow}>
              <span className={styles.listText}>
                <span className={styles.listName}>{personName(journey.displayName)}</span>
                <span className={styles.listSub}>{`${formatDate(journey.addedAt)} に追加・リンク ${journey.refCode ?? emptyValue('unknown')}`}</span>
              </span>
              {duplicate ? <StatusPill tone="warn">重複の疑い</StatusPill> : null}
              <span className={styles.listValue}>{`${formatNumber(journey.conversionCount)} 件`}</span>
            </div>
          )
        })}
      </div>
      {journeyMore ? (
        <Button type="button" disabled={journeyLoadingMore} onClick={() => { void loadMoreJourneys(affiliate.id, genRef.current) }}>
          {journeyLoadingMore ? '読み込んでいます' : 'さらに読み込む'}
        </Button>
      ) : null}
    </section>
  )

  const payment = (
    <>
      <section className={styles.section} aria-label="今回の締め">
        <DetailSectionTitle>今回の締め</DetailSectionTitle>
        {settlementState === 'loading' ? (
          <p className={styles.empty}>読み込んでいます。</p>
        ) : settlementState === 'error' ? (
          <p className={styles.empty}>今回の締めを読み込めませんでした。</p>
        ) : settlement ? (
          <DetailSection>
            <DetailField label="今回の金額" note={null}><DetailNumber value={null} text={formatYen(settlement.amount)} unit="" /></DetailField>
            <DetailField label="成果" note={null}><DetailNumber value={settlement.conversionCount} unit="件" /></DetailField>
            <DetailField label="振込先" note={null}><DetailNumber value={null} text={settlement.bankProfileRegistered ? '登録済み' : emptyValue('unconfigured')} unit="" /></DetailField>
          </DetailSection>
        ) : (
          <p className={styles.empty}>この人には、今回締められる報酬がありません。</p>
        )}
      </section>
      {editing && !readonly ? (
        <SettlementEditor
          key={affiliate.id}
          formId={settlementFormId}
          onDirtyChange={setSettlementDirty}
          onBusyChange={setSavingSettlement}
          affiliate={affiliate}
          onSaved={() => {
            setEditing(false)
            onChanged()
          }}
        />
      ) : (
        <DetailSection title="支払いの取り決め">
          <p className={styles.cardText}>
            {`連絡先 ${affiliate.email ?? emptyValue('none')}・確定までの保留 ${affiliate.holdDays == null ? emptyValue('none') : `${affiliate.holdDays}日`}・支払いサイクル ${affiliate.payoutCycle ?? emptyValue('none')}・成果が出たら本人へ${affiliate.notifyOnConversion ? '知らせる' : '知らせない'}`}
          </p>
        </DetailSection>
      )}
    </>
  )

  return (
    <SaveErrorScope errors={saveErrors}><>
      <Drawer open title={affiliate.name} description={subLine} width="editor" heightMode="viewport" layout="inset" initialFocus="panel" dirty={settlementDirty || nameDirty} busy={paymentOpen || savingSettlement || nameSaving} onClose={onClose}
        status={<StatusPill tone={affiliate.isActive ? 'active' : 'neutral'}>{affiliate.isActive ? '計測中' : '停止中'}</StatusPill>}
        toolbar={<Tabs label="詳細の中身" items={DRAWER_TABS.map(item => ({ label: item.label, current: tab === item.key, onClick: () => { if (item.key !== tab) protectLocal(() => { if (settlementDirty) setEditing(false); setTab(item.key) }) } }))} />}
        actions={{ primary: (editing && tab === 'payment' && !readonly ? <Button variant="primary" type="submit" form={settlementFormId} busy={savingSettlement} busyLabel="保存しています">取り決めを保存する</Button> : <Button type="button" variant="primary" disabled={!accountId || settlementState !== 'ready' || !settlement} title={settlement ? undefined : '今回締められる報酬がありません'} onClick={() => setPaymentOpen(true)}>
                <Check size={16} aria-hidden="true"/>
                支払いを確定する
              </Button>),
    secondary: (<Button variant="secondary" type="button" disabled={savingSettlement} onClick={() => protectLocal(() => { setTab('payment'); setEditing((current) => !current) })}>
                <Pencil size={16} aria-hidden/>{editing ? '編集をやめる' : '編集する'}
              </Button>),
    menuItems: [...([{ allowed: !readonly, id: 'stop-referral', label: '紹介を止める', tone: 'danger' as const, disabled: !affiliate.isActive, onSelect: () => protectLocal(() => { onClose(); onStopRequest(affiliate.id, affiliate.name) }) }])], primaryAllowed: !readonly, secondaryAllowed: !readonly }}
      >
<DetailContent>
<DetailField label="紹介者の名前"><DetailInlineEdit allowed={!(readonly)} value={affiliate.name} label="紹介者の名前を直す" maxLength={100} preserveDirtyOnBlur onDirtyChange={setNameDirty} onSavingChange={setNameSaving} resetToken={nameReset} onSave={async (next) => {
          if (!next.trim()) throw new Error('名前を入力してください')
          const response = await api.affiliates.update(affiliate.id, { name: next.trim(), expected: affiliateEditValues(affiliate) })
          if (!response.success) throw new Error('名前を保存できませんでした。もう一度お試しください。')
          notifyToast('名前を保存しました'); onChanged()
        }} /></DetailField>
        {loading ? (
            <ListState kind="loading" title="詳細を読み込んでいます" />
          ) : <>{tab === 'summary' ? summary : tab === 'breakdown' ? breakdown : tab === 'friends' ? friends : null}
            <div hidden={tab !== 'payment'}>{payment}</div></>}

</DetailContent>
</Drawer>
      <OverlayDepthContext.Provider value={depth + 1}><UnsavedLeaveDialog open={guard.leaveTarget !== null} subject="編集内容" busy={savingSettlement || nameSaving} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} /></OverlayDepthContext.Provider>
      {accountId ? (
        <AffiliatePaymentConfirmDialog
          target={paymentOpen ? { id: affiliate.id, name: affiliate.name } : null}
          accountId={accountId}
          settlement={settlement}
          periodTo={period.periodTo}
          onClose={() => setPaymentOpen(false)}
          onConfirmed={() => { onChanged(); reloadAll() }}
        />
      ) : null}
    </></SaveErrorScope>
  )
}

/** 報酬の約束（連絡先・保留日数・支払いサイクル・知らせる）。写し元：tabs.tsx の SettlementEditor。 */
function SettlementEditor({
  formId,
  onDirtyChange,
  onBusyChange,
  affiliate,
  onSaved,
}: {
  formId: string
  onDirtyChange: (dirty: boolean) => void
  onBusyChange: (busy: boolean) => void
  affiliate: AffiliateEditSource & { id: string }
  onSaved: () => void
}) {
  const saveErrors = useSaveFormErrors()

  const [rewardMode, setRewardMode] = useState<'none' | 'fixed' | 'rate'>(affiliate.rewardMode ?? (affiliate.commissionRate > 0 ? 'rate' : 'fixed'))
  const [rate, setRate] = useState(String(affiliate.commissionRate))
  const [email, setEmail] = useState(affiliate.email ?? '')
  const [holdDays, setHoldDays] = useState(affiliate.holdDays == null ? '' : String(affiliate.holdDays))
  const [payoutCycle, setPayoutCycle] = useState(affiliate.payoutCycle ?? '')
  const [notify, setNotify] = useState(affiliate.notifyOnConversion ?? false)
  const initial = useRef(JSON.stringify({ rewardMode, rate, email, holdDays, payoutCycle, notify }))
  const dirty = initial.current !== JSON.stringify({ rewardMode, rate, email, holdDays, payoutCycle, notify })
  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange(false), [onDirtyChange])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<'email' | 'hold', string>>>({})
  const emailRef = useRef<HTMLInputElement>(null)
  const holdRef = useRef<HTMLInputElement>(null)

  const save = async () => {
    if (saving) return
    setError(null)
    if (rewardMode === 'rate' && (!rate.trim() || !Number.isFinite(Number(rate)) || Number(rate) < 0 || Number(rate) > 100)) {
      saveErrors.apply({ rate: '報酬率は0から100の間で入力してください' })
      return
    }
    const errors: typeof fieldErrors = {}
    if (email.trim() && emailRef.current?.validity.typeMismatch) errors.email = 'メールアドレスを確認してください'
    if (holdDays.trim() && (!Number.isInteger(Number(holdDays)) || Number(holdDays) < 0 || Number(holdDays) > 365)) errors.hold = '保留期間は0日から365日の整数で入力してください'
    setFieldErrors(errors)
    if (errors.email || errors.hold) {
      requestAnimationFrame(() => {
        const el = errors.email ? emailRef.current : holdRef.current
        el?.focus()
        el?.scrollIntoView?.({ block: 'center' })
      })
      return
    }
    setSaving(true)
    onBusyChange(true)
    setError(null)
    try {
      const res = await api.affiliates.update(affiliate.id, {
        rewardMode,
        commissionRate: rewardMode === 'rate' ? Number(rate) : 0,
        email: email.trim() || null,
        holdDays: holdDays.trim() === '' ? null : Number(holdDays),
        payoutCycle: payoutCycle.trim() || null,
        notifyOnConversion: notify,
        expected: affiliateEditValues(affiliate),
      })
      if (!res.success) {
        setError(res.error)
        return
      }
      notifySaved('支払いの取り決めを保存しました。')
      onSaved()
    } catch (e) {
      const fieldFailure = saveErrors.capture(e)

      { if (!fieldFailure)

      setError(describeApiFailure(e, '保存')) }
    } finally {
      setSaving(false)
      onBusyChange(false)
    }
  }

  return (
    <SaveErrorScope errors={saveErrors}><DetailSection title="支払いの取り決め"><form id={formId} inert={saving} noValidate onSubmit={event => { event.preventDefault(); void save() }}>
      <div className={styles.fields}>
        <SaveErrorField names={["rewardMode","reward_mode"]}><Select aria-label="報酬の方式" value={rewardMode} onChange={(value) => setRewardMode(value as typeof rewardMode)} options={[
          { value: 'none', label: '報酬なし（計測のみ）' },
          { value: 'fixed', label: '成果1件ごとに定額' },
          { value: 'rate', label: '売上に対する割合' },
        ]} /></SaveErrorField>
        {rewardMode === 'rate' ? <SaveErrorField names={["rate"]}><NumberInput aria-label="報酬の割合（%）" type="number" min={0} max={100} step="0.1" value={rate} onChange={(e) => setRate(e.target.value)} /></SaveErrorField> : null}
        <Field label="連絡先" htmlFor="af-settlement-email" error={fieldErrors.email}>
          <SaveErrorField names={["email"]}><TextField id="af-settlement-email" ref={emailRef} type="email" value={email} onChange={(event) => { setEmail(event.target.value); setFieldErrors((old) => ({ ...old, email: undefined })) }} placeholder="partner@example.com" /></SaveErrorField>
        </Field>
        <Field label="確定までの保留（日）" htmlFor="af-settlement-hold" error={fieldErrors.hold}>
          <SaveErrorField names={["holdDays","hold_days"]}><NumberInput unit="日" id="af-settlement-hold" ref={holdRef} type="number" min={0} max={365} value={holdDays} onChange={(event) => { setHoldDays(event.target.value); setFieldErrors((old) => ({ ...old, hold: undefined })) }} placeholder="なし" /></SaveErrorField>
        </Field>
        <Field label="支払いサイクル" htmlFor="af-settlement-cycle">
          <SaveErrorField names={["payoutCycle","payout_cycle"]}><TextField id="af-settlement-cycle" value={payoutCycle} onChange={(event) => setPayoutCycle(event.target.value)} placeholder="例：月末締め翌月末払い" maxLength={100} /></SaveErrorField>
        </Field>
      </div>
      <SaveErrorField names={["notify","notifyOnConversion"]}><Checkbox checked={notify} onCheckedChange={setNotify}>成果が出たときに本人へ知らせる</Checkbox></SaveErrorField>
      <p className={styles.note}>保留日数と支払いサイクルは取り決めの記録です。報酬の計算そのものには使いません。</p>
      {error ? <Notice tone="danger" message={error} /> : null}
    </form></DetailSection></SaveErrorScope>
  )
}
