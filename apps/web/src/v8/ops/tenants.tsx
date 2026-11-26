'use client'
import SegmentedControl from '@/components/shared/segmented'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { createPageReturnHref } from '@/components/shared/create-page'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { BadgeCheck, CreditCard, Hourglass, Pause, Plus } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { api, type OpsTenantRow, type OpsTenantSummary } from '@/lib/api'
import { formatDate, formatDateTime, PLAN_STATUS_LABEL, planLabel, tenantDetailHref, opsCall } from '@/components/ops/ops-ui'
import { describeApiFailure, isForbiddenOrRateLimited } from '@/components/shared/api-error-message'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import KpiCard from '@/components/shared/kpi-card'
import KpiBand from '@/components/shared/kpi-band'
import ListState from '@/components/shared/list-state'
import { OpsListPage, OpsListToolbar } from './list-page'
import { DataTable, TableHeadRow, Th, Td, Tr, NameCell, RowNameLink, DateCell } from '@/components/shared/table'
import StatusBadge, { type StatusBadgeTone } from '@/components/shared/status-badge'
import { TextField } from '@/components/shared/text-field'
import { OPS_READONLY_LOCK_REASON, useOpsReadOnlyState } from './use-ops-read-only'
import parts from './parts.module.css'
import styles from './tenants.module.css'
import { formatDate as polishFormatDate } from '@/lib/format'
import TruncatedText from '@/components/shared/truncated-text'
import { Field } from '@/components/shared/form-controls'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'

/**
 * 運営の契約先アカウント V8（絵の作る窓 ）。
 *
 * 動きは 管理画面（app/ops/tenants）と同じ口：/api/ops/tenants を検索語で読み、状態の札で絞る。
 * `?status=` で絞り込みを受け取る（ダッシュボードの要対応から来る）。
 * 契約先の名前から詳細へ。代理ログインは詳細の画面から行う。
 * 「契約先を作る」は書ける運営メンバーにだけ出す（閲覧のみの人には出さない）。
 */

function loadDescription(err: unknown): string | undefined {
  if (isForbiddenOrRateLimited(err)) return undefined
  if (err instanceof TypeError) return '通信できませんでした。ネットワークを確認してもう一度お試しください'
  return describeApiFailure(err, '読み込み', { scope: 'hq' })
}

const STATUS_FILTERS: Array<{ key: string; label: string }> = [
  { key: 'active', label: '契約中' },
  { key: 'trialing', label: 'トライアル' },
  { key: 'past_due', label: '決済失敗' },
  { key: 'suspended', label: '停止中' },
  { key: 'archived', label: '解約' },
]

/** 状態の札（利用の状態と請求の状態を1枚に：停止・解約が先、あとは請求）。 */
function tenantState(row: OpsTenantRow): { label: string; tone: StatusBadgeTone } {
  if (row.status === 'suspended') return { label: '停止中', tone: 'neutral' }
  if (row.status === 'archived') return { label: '解約', tone: 'neutral' }
  if (row.plan_status === 'trialing') return { label: 'トライアル', tone: 'info' }
  if (row.plan_status === 'past_due') return { label: '決済失敗', tone: 'danger' }
  if (row.plan_status === 'active') return { label: '契約中', tone: 'success' }
  if (row.plan_status === 'exempt') return { label: '課金対象外', tone: 'neutral' }
  if (row.plan_status === 'canceled') return { label: '請求解約', tone: 'neutral' }
  return { label: '確認が必要', tone: 'neutral' }
}

/** 10/4 の形。 */
function monthDay(value: string | null | undefined): string {
  return polishFormatDate(value, { style: 'list-day', fallback: '—' })
}

export default function OpsTenantsV8() {
  const router = useRouter()
  const [rows, setRows] = useState<OpsTenantRow[]>([])
  const [summary, setSummary] = useState<OpsTenantSummary | null>(null)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useListUrlValue('filter', '')
  const [loading, setLoading] = useState(true)
  const [listLoadError, setListLoadError] = useState<unknown>(null)
  const access = useOpsReadOnlyState()
  const lock = access === 'readonly' ? OPS_READONLY_LOCK_REASON : undefined
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState('')

  const load = useCallback(async () => {
    setListLoadError(null)
    try {
      const res = await api.ops.tenants({ q: q.trim() || undefined })
      if (!res.success) { setListLoadError(new Error(res.error || '読み込めませんでした')); return }
      setRows(res.data)
      setSummary(res.summary)
    } catch (caught) {
      setListLoadError(caught)
    }
  }, [q])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void load().finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [load])

  useEffect(() => {
    const status = new URLSearchParams(window.location.search).get('status') ?? ''
    if (STATUS_FILTERS.some((f) => f.key === status)) setFilter(status)
  }, [])

  const visible = rows.filter((row) => {
    if (!filter) return true
    if (filter === 'trialing') return row.plan_status === 'trialing'
    if (filter === 'past_due') return row.plan_status === 'past_due'
    if (filter === 'active') return row.plan_status === 'active' || row.plan_status === 'past_due'
    return row.status === filter
  })

  const closeCreate = () => {
    if (createBusy) return
    setCreating(false)
    setNewName('')
    setCreateError('')
  }

  const create = async () => {
    if (access !== 'writer') return
    if (!newName.trim()) { setCreateError('統括名を入力してください'); return }
    setCreateBusy(true)
    setCreateError('')
    const res = await opsCall(api.ops.createTenant(newName.trim()))
    setCreateBusy(false)
    if (!res.success) { setCreateError(res.error || '作成できませんでした。時間をおいて、もう一度お試しください。'); return }
    setNewName('')
    setCreating(false)
    router.push(createPageReturnHref('/ops/tenants', res.data.id))
  }

  const first = (fn: (row: OpsTenantRow) => boolean) => rows.find(fn)
  const trialEnd = rows.filter((row) => row.plan_status === 'trialing' && row.trial_ends_at).map((row) => row.trial_ends_at as string).sort()[0]
  const pastDue = first((row) => row.plan_status === 'past_due')
  const suspended = first((row) => row.status === 'suspended')
  const kpiLoading = loading && !summary

  return (
    <OpsListPage boardId="XWtYC" title="契約先アカウント" readOnly={access === 'readonly'} help="契約先を選ぶと詳細が開きます。代理ログインは既定で閲覧のみです。"
      actions={<Button variant="primary" lockedReason={lock} disabled={access === 'unknown'} onClick={() => { setCreateError(''); setCreating(true) }}><Plus aria-hidden="true" />契約先を作る</Button>}
        stats={<KpiBand>
          <KpiCard presentation="cell" icon={<BadgeCheck size={16} aria-hidden="true" />} title="契約中" value={summary ? summary.active : null} unit="社" detail="請求が生きている契約先（決済失敗を含む）" loading={kpiLoading} />
          <KpiCard presentation="cell" icon={<Hourglass size={16} aria-hidden="true" />} title="トライアル中" value={summary ? summary.trialing : null} unit="社" detail={trialEnd ? `期限 ${monthDay(trialEnd)}` : '期限切れ前に案内'} loading={kpiLoading} />
          <KpiCard presentation="cell" icon={<CreditCard size={16} aria-hidden="true" />} title="決済失敗" value={summary ? summary.pastDue : null} unit="社" detail={pastDue ? pastDue.name : 'Stripe で支払いが止まっている'} loading={kpiLoading} />
          <KpiCard presentation="cell" icon={<Pause size={16} aria-hidden="true" />} title="停止中" value={summary ? summary.suspended : null} unit="社" detail={suspended ? suspended.name : '運営が止めた契約先'} loading={kpiLoading} />
        </KpiBand>}
        toolbar={<OpsListToolbar
          search={{ value: q, onChange: setQ, placeholder: '統括名・メール・店舗名で探す', label: '契約先を探す' }}
          filters={<SegmentedControl aria-label="契約の状態" fit="content" value={filter} onClear={() => setFilter('')} onChange={setFilter} options={[
            { value: '', label: 'すべて', count: loading || listLoadError ? undefined : rows.length },
            ...STATUS_FILTERS.map((f) => ({ value: f.key, label: f.label })),
          ]} />}
        />}
      >
        {loading && rows.length === 0 ? <ListState permissionScope="hq" kind="loading" title="契約先を読み込んでいます" />
          : listLoadError && rows.length === 0 ? <ListState permissionScope="hq" kind="error" title="契約先を表示できませんでした" description={loadDescription(listLoadError)} error={listLoadError ?? undefined} onRetry={() => void load()} />
          : visible.length === 0 ? <ListState permissionScope="hq" kind="empty" title="該当する契約先がありません" description="検索の言葉や絞り込みを変えてください。" />
          : <DataTable aria-label="契約先" columnSizing="content" columnLayout={{ headHeight: 'var(--tpl-list-head-h)', rowHeight: 'var(--tpl-list-row-h)', gap: 'var(--space-16)', padding: '0 var(--tpl-list-inset)', collapseScope: 'page' }}>
            <thead><TableHeadRow data-table-layout="columns">
              <Th grow>統括名</Th><Th>プラン</Th><Th>状態</Th><Th align="right" collapseAt="narrow">店舗</Th><Th align="right" collapseAt="narrow">権限者</Th><Th>利用 / 請求</Th><Th collapseAt="narrow">契約日</Th><Th>最終ログイン</Th>
            </TableHeadRow></thead>
            <tbody>{visible.map((row) => {
              const state = tenantState(row)
              return <Tr data-table-layout="columns" key={row.id} href={tenantDetailHref(row.id)}>
                <NameCell grow name={<RowNameLink href={tenantDetailHref(row.id)} title={row.name}><TruncatedText value={String(row.name ?? '')} /></RowNameLink>} />
                <Td>{row.plan_status === 'trialing' && !row.plan_key ? 'トライアル' : planLabel(row.plan_key)}</Td>
                <Td title={`利用 ${row.status === 'suspended' ? '利用停止' : row.status === 'archived' ? '解約済み' : '利用中'}・請求 ${(Object.prototype.hasOwnProperty.call(PLAN_STATUS_LABEL, row.plan_status) ? PLAN_STATUS_LABEL[row.plan_status] : row.plan_status)}`}><StatusBadge tone={state.tone}>{state.label}</StatusBadge></Td>
                <Td align="right" data-list-number collapseAt="narrow">{row.account_count}</Td>
                <Td align="right" data-list-number collapseAt="narrow">{row.staff_count}</Td>
                <Td><span className={styles.billing}>
                  <span className={styles.billingMain}>{row.plan_status === 'trialing' ? 'トライアル' : planLabel(row.plan_key)}</span>
                  <span className={styles.billingSub} title={`トライアル期限 ${formatDateTime(row.trial_ends_at)}・次回請求 ${formatDateTime(row.current_period_ends_at)}`}>{row.trial_ends_at ? `期限 ${monthDay(row.trial_ends_at)}` : row.current_period_ends_at ? `次回 ${monthDay(row.current_period_ends_at)}` : emptyValue('unknown')}</span>
                </span></Td>
                <DateCell collapseAt="narrow"><span data-list-date-time>{formatDate(row.created_at).replace(/-/g, '/')}</span></DateCell>
                <DateCell title={formatDateTime(row.last_login_at)}><span data-list-date-time>{monthDay(row.last_login_at)}</span></DateCell>
              </Tr>
            })}</tbody>
          </DataTable>}

      <Dialog
        open={creating}
        designWidth={520}
        designTop={240}
        title="契約先を作る"
        confirmLabel="作る"
        cancelLabel="キャンセル"
        confirmIcon={<Plus size={16} aria-hidden="true" />}
        busy={createBusy}
        error={createError || undefined}
        designNode="i0FTN"
        onConfirm={() => create()}
        onCancel={closeCreate}
      >
        <div className={parts.dialogBody}>
          <Field label="統括名（会社名）" required><SaveErrorField names={["newName","new_name"]}><TextField value={newName} onChange={(event) => setNewName(event.target.value)} placeholder="musubo株式会社" maxLength={100} aria-label="統括名（会社名）" /></SaveErrorField></Field>
          <Notice tone="info">
            作ると、統括の最初の権限者へ招待を送れるようになります。プランは契約先の詳細で決めます。
          </Notice>
        </div>
      </Dialog>
    </OpsListPage>
  )
}
