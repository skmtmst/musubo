'use client'

import ListToolbar from '@/components/shared/list-toolbar'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Gift } from 'lucide-react'
import type { BookingPassPlan, BookingPassPlanSummary } from '@line-crm/shared'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import Dialog from '@/components/shared/dialog'
import EmptyList from '@/components/shared/empty-list'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Pagination from '@/components/shared/pagination'
import PageSizeSelect from '@/components/shared/page-size-select'
import { RowMenu } from '@/components/shared/row-actions'
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import { ActionCell, DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import TruncatedText from '@/components/shared/truncated-text'
import { notifySaved } from '@/components/shared/toast'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { bookingApi } from '@/lib/api'
import { bookingPassPlansApi } from '@/lib/api/helpers/gap3'
import { bookingPassNoticesApi, type PassNoticeSettings } from '@/lib/api/helpers/booking-pass-notices'
import Toggle from '@/components/shared/toggle'
import { formatNumber } from '@/lib/format'
import { KIND_LABEL, STATUS_LABEL, countLabel, failureText, periodLabel, yen } from './words'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import styles from './passes.module.css'
import { EmptyCell } from '@/components/shared/empty-value'

/*
 * ★V8 予約設定のタブ「回数券・月謝」（B2-1 `uGfHo`）。数の帯・探す欄・表・行末の「…」。
 * 種類を作る・直す・販売を始める・やめるのは管理者だけ（閲覧のみの人には作るボタンも「…」の操作も置かない）。
 * 「今月の更新」の数はまだ取れないので、持っている人の数を出す。オンラインの購入・定期課金は後の段。
 */

type Summary = BookingPassPlanSummary
type Status = 'loading' | 'ready' | 'error'
type Kind = '' | 'ticket' | 'monthly'
type Holder = { id: string; friend_id: string; display_name: string | null; remaining: number | null; expires_at: string | null; status: string }

const KIND_OPTIONS = [
  { value: '', label: '種類：すべて' },
  { value: 'ticket', label: '種類：回数券' },
  { value: 'monthly', label: '種類：月謝' },
]
const md = (value?: string | null) => (value ? `${value.slice(0, 4)}/${Number(value.slice(5, 7))}/${Number(value.slice(8, 10))}` : '—')

export default function PassesTabV8({ accountId, canEdit }: { accountId: string; canEdit: boolean }) {
  const router = useRouter()
  const [status, setStatus] = useState<Status>('loading')
  const [error, setError] = useState<unknown>(null)
  const [plans, setPlans] = useState<BookingPassPlan[]>([])
  const [total, setTotal] = useState(0)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [holdersCount, setHoldersCount] = useState<Record<string, number>>({})
  const [menuNames, setMenuNames] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<Kind>('')
  const [pageSize, setPageSize] = useState<10 | 20 | 50>(20)
  const [page, setPage] = useState(1)
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState<{ plan: BookingPassPlan; action: 'start' | 'stop' } | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [holdersOf, setHoldersOf] = useState<BookingPassPlan | null>(null)
  const [noticeOf, setNoticeOf] = useState<BookingPassPlan | null>(null)
  const current = useRef(accountId)
  const requestSequence = useRef(0)
  const errors = useSaveFormErrors()
  current.current = accountId

  const load = useCallback(async () => {
    const requestId = ++requestSequence.current
    setStatus('loading')
    try {
      const response = await bookingPassPlansApi.list(accountId, query.trim(), (page - 1) * pageSize, pageSize, kind || undefined)
      if (!response.success) throw new Error('plans_failed')
      if (current.current !== accountId || requestSequence.current !== requestId) return
      const items = response.data.items
      setPlans(items)
      setTotal(response.data.total)
      setSummary(response.data.summary)
      setStatus('ready')
      const counts = await Promise.allSettled(items.map((plan) => bookingPassPlansApi.holders(accountId, plan.id, 0, 10)))
      if (current.current !== accountId || requestSequence.current !== requestId) return
      const next: Record<string, number> = {}
      counts.forEach((item, index) => { if (item.status === 'fulfilled' && item.value.success) next[items[index].id] = item.value.data.total })
      setHoldersCount(next)
    } catch (reason) {
      if (current.current !== accountId || requestSequence.current !== requestId) return
      setError(reason)
      setStatus('error')
    }
  }, [accountId, query, kind, page, pageSize])

  useEffect(() => {
    const timer = window.setTimeout(() => { void load() }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  useEffect(() => {
    let alive = true
    void bookingApi.listMenus(accountId).then((response) => {
      if (!alive) return
      const map: Record<string, string> = {}
      for (const menu of response.menus ?? []) map[menu.id] = menu.name
      setMenuNames(map)
    }).catch(() => undefined)
    return () => { alive = false }
  }, [accountId])

  const runPending = async () => {
    if (!pending) return
    const { plan, action } = pending
    setBusyId(plan.id)
    setNotice('')
    try {
      const response = action === 'start'
        ? await bookingPassPlansApi.start(accountId, plan.id, plan.version)
        : await bookingPassPlansApi.stop(accountId, plan.id, plan.version)
      if (!response.success) throw new Error('failed')
      notifySaved(action === 'start' ? `「${plan.name}」の販売を始めました。` : `「${plan.name}」の販売をやめました。持っている人の券は、そのまま使えます。`)
      setPending(null)
      await load()
      return true
    } catch (reason) {
      if (!errors.capture(reason)) setNotice(failureText(reason, action === 'start' ? '販売を始める' : '販売をやめる'))
      return false
    } finally {
      setBusyId(null)
    }
  }

  const duplicate = async (plan: BookingPassPlan) => {
    setBusyId(plan.id)
    setNotice('')
    try {
      const response = await bookingPassPlansApi.create(accountId, {
        kind: plan.kind, name: `${plan.name}（コピー）`, price: plan.price, count: plan.count, monthlyLimit: plan.monthlyLimit,
        validDays: plan.validDays, menuIds: plan.menuIds, allowWithoutPass: plan.allowWithoutPass,
      }, crypto.randomUUID())
      if (!response.success) throw new Error('failed')
      notifySaved('複製しました。下書きとして入っています。')
      await load()
    } catch (reason) {
      if (!errors.capture(reason)) setNotice(failureText(reason, '複製する'))
    } finally {
      setBusyId(null)
    }
  }

  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(page * pageSize, total)

  const stats = (
    <KpiBand>
      <KpiCard presentation="band" title="販売中" value={summary?.onSale ?? null} unit="種類" detail="いま売っている券" />
      <KpiCard presentation="band" title="持っている人" value={summary?.holders ?? null} unit="人" detail="使える券がある人" />
      <KpiCard presentation="band" title="期限が近い" value={summary?.expiringIn30d ?? null} unit="枚" detail="30 日以内" />
      <KpiCard
        presentation="band" title="引き落としの失敗" value={summary?.billingFailed ?? null} unit="件"
        detail={summary ? `実課金は未接続（試験：失敗${summary.billingSimulationFailed}・正常解約${summary.billingSimulationCancelled}）` : status === 'error' ? '読み込めませんでした' : '読み込んでいます'}
        detailLayout="qualifier"
        help="試験の内訳は券の件数で、復旧済みの請求失敗を除き、解約した券は正常解約として数えます。実課金は未接続なので「—」と表示し、試験の結果と正常解約を実際の引き落とし失敗に含めません。"
        helpDisplay="question"
      />
    </KpiBand>
  )

  const toolbar = (
    <ListToolbar search={{ placeholder: '名前で探す', label: '名前で探す', value: query, onChange: (value) => { setPage(1); setQuery(value) } }}
      filters={<Select aria-label="種類で絞り込む" value={kind} options={KIND_OPTIONS} onChange={(value) => { setPage(1); setKind(value as Kind) }} />}
      trailing={<PageSizeSelect value={pageSize} onChange={(next) => { setPage(1); setPageSize(next as 10 | 20 | 50) }} />} />
  )

  const body = status === 'loading' && plans.length === 0 ? (
    <ListState kind="loading" title="回数券・月謝を読み込んでいます" />
  ) : status === 'error' ? (
    <ListState kind="error" error={error} onRetry={() => void load()} />
  ) : plans.length === 0 ? (
    <EmptyList
      icon={<Gift aria-hidden="true" />}
      title="まだ回数券・月謝がありません"
      description="回数券や月謝を作ると、お客さまが券で予約できます。回数券・月謝は、お客さまごとに入れます。店頭で売った物・紙の回数券の引き継ぎは、友だちの詳細の「予約」タブから手で入れられます。"
      create={{ label: '回数券・月謝を作る', href: '/booking/passes/new' }}
      canCreate={canEdit}
      filtered={Boolean(query.trim()) || kind !== ''}
      onClearFilters={() => { setQuery(''); setKind(''); setPage(1) }}
      filteredDescription="名前や種類の絞り込みを外すと、すべて出ます"
    />
  ) : (
    <DataTable>
      <thead>
        <TableHeadRow>
          <Th grow>名前</Th>
          <Th collapseAt="narrow">種類</Th>
          <Th>回数</Th>
          <Th>期限</Th>
          <Th align="right">値段</Th>
          <Th collapseAt="narrow">使える予約</Th>
          <Th align="right">持っている人</Th>
          <Th>状態</Th>
          <Th>操作</Th>
        </TableHeadRow>
      </thead>
      <tbody>
        {plans.map((plan) => {
          const names = plan.menuIds.map((id) => menuNames[id]).filter(Boolean)
          const usable = plan.menuIds.length === 0 ? 'すべての予約' : names.length === 0 ? `${formatNumber(plan.menuIds.length)} 件` : names.length > 2 ? `${names.slice(0, 2).join('・')} ほか ${names.length - 2}` : names.join('・')
          const holders = holdersCount[plan.id]
          return (
            <Tr key={plan.id} data-row-id={plan.id}>
              <Td grow><span className={styles.name}><TruncatedText value={plan.name} /></span></Td>
              <Td collapseAt="narrow">{KIND_LABEL[plan.kind]}</Td>
              <Td>{countLabel(plan)}</Td>
              <Td>{periodLabel(plan)}</Td>
              <Td align="right">{yen(plan.price)}</Td>
              <Td collapseAt="narrow"><TruncatedText value={usable} /></Td>
              <Td align="right">{holders === undefined ? <EmptyCell /> : `${formatNumber(holders)} 人`}</Td>
              <Td><StatusBadge tone={plan.status === 'on_sale' ? 'success' : 'neutral'}>{STATUS_LABEL[plan.status]}</StatusBadge></Td>
              <ActionCell>
                <span className={styles.menuBox}>
                  <RowMenu
                    label={`${plan.name}の操作`}
                    open={menuId === plan.id}
                    onOpenChange={(next) => setMenuId(next ? plan.id : null)}
                    items={[
                      { id: 'holders', label: '持っている人を見る', onSelect: () => setHoldersOf(plan) },
                      ...(canEdit ? [
                        ...(plan.status === 'draft' ? [{ id: 'edit', label: '編集する', onSelect: () => router.push(`/booking/passes/new?id=${encodeURIComponent(plan.id)}`) }] : []),
                        ...(plan.status === 'draft' || plan.status === 'stopped' ? [{ id: 'start', label: '販売を始める', disabled: busyId === plan.id, onSelect: () => { setNotice(''); setPending({ plan, action: 'start' }) } }] : []),
                        ...(plan.status === 'on_sale' ? [{ id: 'stop', label: '販売をやめる', disabled: busyId === plan.id, onSelect: () => { setNotice(''); setPending({ plan, action: 'stop' }) } }] : []),
                        { id: 'notices', label: '残り・期限の知らせ', onSelect: () => setNoticeOf(plan) },
                        { id: 'duplicate', label: '複製', disabled: busyId === plan.id, onSelect: () => void duplicate(plan) },
                      ] : []),
                    ]}
                  />
                </span>
              </ActionCell>
            </Tr>
          )
        })}
      </tbody>
    </DataTable>
  )

  return (
    <SaveErrorScope errors={errors}><section className={styles.panel} aria-label="回数券・月謝">
      <Notice tone="info" compact message="回数券・月謝は、お客さまごとに入れます（店頭で売った物・紙の回数券の引き継ぎは、友だちの詳細の「予約」タブから）。" />
      {stats}
      {notice ? <Notice tone="danger" message={notice} /> : null}
      {toolbar}
      {body}
      {status === 'ready' && total > 0 ? (
        <div className={styles.pager}>
          <span className={styles.pagerCount}>{`${formatNumber(total)} 件中 ${first}〜${last} 件`}</span>
          <Pagination page={page} pageCount={pageCount} onPageChange={setPage} />
        </div>
      ) : null}
      <ConfirmDialog
        open={pending !== null}
        title={pending ? (pending.action === 'start' ? `「${pending.plan.name}」の販売を始めますか？` : `「${pending.plan.name}」の販売をやめますか？`) : ''}
        description={pending?.action === 'start'
          ? '始めると、種類・回数・値段・使える予約は変えられません。お客さまに券を付けられるようになります。'
          : 'やめると、新しく券を付けられなくなります。持っている人の券は、そのまま使えます。'}
        confirmLabel={pending?.action === 'start' ? '販売を始める' : '販売をやめる'}
        busy={pending !== null && busyId === pending.plan.id}
        error={notice || undefined} onSuccess={() => setPending(null)} onConfirm={() => runPending()}
        onCancel={() => setPending(null)}
      />
      {noticeOf ? <NoticeDialog accountId={accountId} plan={noticeOf} onClose={() => setNoticeOf(null)} /> : null}
      {holdersOf ? <HoldersDialog accountId={accountId} plan={holdersOf} onClose={() => setHoldersOf(null)} /> : null}
    </section></SaveErrorScope>
  )
}

function HoldersDialog({ accountId, plan, onClose }: { accountId: string; plan: BookingPassPlan; onClose: () => void }) {
  const [status, setStatus] = useState<Status>('loading')
  const [items, setItems] = useState<Holder[]>([])
  const [total, setTotal] = useState(0)

  useEffect(() => {
    let alive = true
    bookingPassPlansApi.holders(accountId, plan.id, 0, 20)
      .then((response) => {
        if (!alive) return
        if (!response.success) throw new Error('holders_failed')
        setItems(response.data.items as Holder[])
        setTotal(response.data.total)
        setStatus('ready')
      })
      .catch(() => { if (alive) setStatus('error') })
    return () => { alive = false }
  }, [accountId, plan.id])

  return (
    <Dialog open title={`${plan.name}を持っている人`} confirmLabel="閉じる" onConfirm={onClose} onCancel={onClose}>
      <div className={styles.dialogBody}>
        {status === 'loading' ? <ListState kind="loading" title="読み込んでいます" /> : null}
        {status === 'error' ? <ListState kind="error" onRetry={() => undefined} /> : null}
        {status === 'ready' && items.length === 0 ? <p className={styles.note}>まだ持っている人はいません。</p> : null}
        {status === 'ready' && items.length > 0 ? (
          <div>
            {items.map((item) => (
              <div key={item.id} className={styles.holderRow}>
                <span className={styles.name}>{item.display_name || '（名前なし）'}</span>
                <span className={styles.sub}>{`${plan.kind === 'ticket' ? `残り ${item.remaining ?? '—'} 回` : '月謝'}・${md(item.expires_at)} まで`}</span>
              </div>
            ))}
            {total > items.length ? <p className={styles.sub}>{`ほか ${formatNumber(total - items.length)} 人`}</p> : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  )
}

/** 残り 1 回・期限の 14 日前の知らせ（試験運転：LINE へは送らず、送る予定を記録するだけ）。 */
function NoticeDialog({ accountId, plan, onClose }: { accountId: string; plan: BookingPassPlan; onClose: () => void }) {
  const [settings, setSettings] = useState<PassNoticeSettings | null>(null)
  const [remainingOne, setRemainingOne] = useState(false)
  const [expiry, setExpiry] = useState(false)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const errors = useSaveFormErrors()
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    bookingPassNoticesApi.settings(accountId, plan.id)
      .then((response) => {
        if (!alive) return
        if (!response.success) throw new Error('settings_failed')
        setSettings(response.data); setRemainingOne(response.data.remainingOne); setExpiry(response.data.expiry14Days); setStatus('ready')
      })
      .catch(() => { if (alive) setStatus('error') })
    return () => { alive = false }
  }, [accountId, plan.id, attempt])

  const save = async () => {
    if (!settings) return
    setBusy(true); setMessage('')
    try {
      const response = await bookingPassNoticesApi.save(accountId, plan.id, { remainingOne, expiry14Days: expiry, expectedVersion: settings.version })
      if (!response.success) throw new Error('save_failed')
      notifySaved('知らせの設定を保存しました。')
      onClose()
    } catch (reason) {
      if (!errors.capture(reason)) setMessage('保存できませんでした。ほかの人が先に変えたかもしれません。開き直してもう一度お試しください。')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SaveErrorScope errors={errors}><Dialog open title={`${plan.name}の残り・期限の知らせ`} confirmLabel="保存する" busy={busy} confirmDisabled={status !== 'ready'} onConfirm={() => void save()} onCancel={onClose}>
      <div className={styles.dialogBody}>
        {status === 'loading' ? <ListState kind="loading" title="読み込んでいます" /> : null}
        {status === 'error' ? <ListState kind="error" onRetry={() => { setStatus('loading'); setAttempt((n) => n + 1) }} /> : null}
        {status === 'ready' ? (
          <>
            {message ? <Notice tone="danger" message={message} /> : null}
            <p className={styles.note}>今は試験運転です。LINE へは送らず、送る予定だけを記録します。</p>
            <span className={styles.picked}><Toggle checked={remainingOne} onChange={setRemainingOne} label="残りが 1 回になったら知らせる" /><span>残りが 1 回になったら知らせる</span></span>
            <span className={styles.picked}><Toggle checked={expiry} onChange={setExpiry} label="期限の 14 日前に知らせる" /><span>期限の 14 日前に知らせる</span></span>
          </>
        ) : null}
      </div>
    </Dialog></SaveErrorScope>
  )
}
