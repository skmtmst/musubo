'use client'
import { useUrlTab } from '@/lib/use-url-tab'
import type { FormRequirement } from '@/lib/form-requirement'
import { LogIn } from 'lucide-react'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import { useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api, type OpsTenantDetail } from '@/lib/api'
import { AUDIT_ACTION_LABEL, PLAN_STATUS_LABEL, ROLE_LABEL, formatDate, formatDateTime, planLabel, opsCall } from '@/components/ops/ops-ui'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Dialog from '@/components/shared/dialog'
import ListState from '@/components/shared/list-state'
import StatusBadge from '@/components/shared/status-badge'
import TargetMissing from '@/components/shared/target-missing'
import { Tabs } from '@/components/shared/tabs'
import { TextField } from '@/components/shared/text-field'
import { formatNumber, formatDate as polishFormatDate } from '@/lib/format'
import { OpsHead } from './shell'
import { PageFrame } from '@/components/templates/page-frame'
import { DashboardColumns } from '@/components/templates/dashboard-page'
import Card from '@/components/shared/card'
import SectionHeader from '@/components/shared/section-header'
import { OPS_READONLY_LOCK_REASON, useOpsReadOnlyState } from './use-ops-read-only'
import parts from './parts.module.css'
import styles from './tenant-detail.module.css'
import TruncatedText from '@/components/shared/truncated-text'
import { Field } from '@/components/shared/form-controls'
import { emptyValue } from '@/components/shared/empty-value'
import { DetailLoading } from '@/components/templates/detail-page'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'
import { GridTable, GridHeadRow, GridRow, GridCell, GridNameCell } from '@/components/shared/grid-table'
import TenantOverviewStats from './tenant-overview-stats'

/**
 * 運営の契約先の詳細 V8（絵の停止の窓 ）。
 *
 * 動きは 管理画面（app/ops/tenants/detail）と同じ口：`?id=` で /api/ops/tenants/:id を読む。
 * 代理ログイン（閲覧のみ・確認つき）・停止・アーカイブ・再開（名前と理由の確認つき）。
 * 閲覧のみの運営メンバーには、状態を変えるボタンを出さない。
 */

const TABS = [
  { key: 'overview', label: '概要' },
  { key: 'accounts', label: '店舗' },
  { key: 'members', label: '権限者' },
  { key: 'audit', label: '監査' },
] as const
type TabKey = (typeof TABS)[number]['key']
type StatusTarget = 'suspended' | 'archived' | 'active'

const AUDIT_WORD: Record<string, string> = {
  'impersonation.start': '代理ログイン（閲覧）',
  'impersonation.write': '代理ログイン（書き込み）',
  'pii.reveal': '個人情報の表示',
  'tenant.status.change': '契約先の停止',
}

function auditWord(action: string): string {
  const word = Object.prototype.hasOwnProperty.call(AUDIT_WORD, action) ? AUDIT_WORD[action] : undefined
  const fallback = Object.prototype.hasOwnProperty.call(AUDIT_ACTION_LABEL, action) ? AUDIT_ACTION_LABEL[action]?.label : undefined
  return word ?? fallback ?? action
}

function shortDateTime(value: string | null | undefined): string {
  return polishFormatDate(value, { style: 'list', fallback: '—' })
}

export default function OpsTenantDetailV8() {
  return (
    <Suspense fallback={<DetailLoading label="契約先を読み込んでいます" />}>
      <DetailContent />
    </Suspense>
  )
}

function DetailContent() {
  const searchParams = useSearchParams()
  const id = searchParams.get('id') ?? ''
  const routeScope = useRef({ id, generation: 0 })
  if (routeScope.current.id !== id) routeScope.current = { id, generation: routeScope.current.generation + 1 }
  const [detail, setDetail] = useState<OpsTenantDetail | null>(null)
  const [tab, setTab] = useUrlTab(TABS.map(t => t.key), 'overview')
  const [error, setError] = useState('')
  const [statusDialog, setStatusDialog] = useState<{ target: StatusTarget; generation: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [impersonateConfirm, setImpersonateConfirm] = useState(false)
  const access = useOpsReadOnlyState()
  const lock = access === 'readonly' ? OPS_READONLY_LOCK_REASON : undefined
  const unknown = access === 'unknown'

  const load = useCallback(async () => {
    if (!id) { setError('契約先が指定されていません'); return }
    const res = await opsCall(api.ops.tenant(id))
    if (!res.success) { setError(res.error || '読み込めませんでした'); return }
    setDetail(res.data)
  }, [id])

  useEffect(() => { void load() }, [load])

  const impersonate = async () => {
    if (!detail || busy) return
    setBusy(true)
    const res = await opsCall(api.ops.impersonation.start(detail.tenant.id))
    setBusy(false)
    if (!res.success) { setError(res.error || '代理ログインを始められませんでした'); return }
    setImpersonateConfirm(false)
    window.location.assign('/hq')
  }

  if (!id) {
    return (
      <PageFrame kind="detail" boardId="Oub6x" standalone>
        <TargetMissing kind="unspecified" title="見る契約先が指定されていません" description="契約先アカウントの一覧から、見る契約先を選び直してください。" backHref="/ops/tenants" backLabel="契約先の一覧へ戻る" />
      </PageFrame>
    )
  }

  if (!detail) {
    return (
      <PageFrame kind="detail" boardId="Oub6x" standalone>
        <OpsHead title="契約先アカウント" />
        <div className={parts.panel}>
          {error
            ? <ListState permissionScope="hq" kind="error" title="契約先を表示できませんでした" description={error} onRetry={() => void load()} />
            : <DetailLoading label="契約先を読み込んでいます" />}
        </div>
      </PageFrame>
    )
  }

  const { tenant, accounts, members, audit } = detail
  const owner = members.find((m) => m.role === 'owner' && m.email) ?? members.find((m) => m.email)
  const billing = tenant.plan_status === 'trialing' && tenant.trial_ends_at
    ? `トライアル（${formatDate(tenant.trial_ends_at)} まで）`
    : `${PLAN_STATUS_LABEL[tenant.plan_status] ?? tenant.plan_status}${tenant.current_period_ends_at ? `・次回 ${formatDate(tenant.current_period_ends_at)}` : ''}`

  return (
    <PageFrame kind="detail" boardId="Oub6x" standalone>
      <OpsHead
        title={tenant.name}
        description={`${planLabel(tenant.plan_key)}・${PLAN_STATUS_LABEL[tenant.plan_status] ?? tenant.plan_status}・${formatDate(tenant.created_at).replace(/-/g, '/')} から`}
        band={<TenantOverviewStats detail={detail} />}
        actions={(
          <>
            {tenant.status === 'active' ? <Button lockedReason={lock} disabled={unknown} onClick={() => setStatusDialog({ target: 'archived', generation: routeScope.current.generation })}>アーカイブ</Button> : null}
            <Button onClick={() => setImpersonateConfirm(true)} disabled={busy || tenant.status === 'archived'}><LogIn aria-hidden="true" />代理ログイン（閲覧のみ）</Button>
            {tenant.status === 'active'
              ? <Button variant="danger" lockedReason={lock} disabled={unknown} onClick={() => setStatusDialog({ target: 'suspended', generation: routeScope.current.generation })}>停止</Button>
              : <Button lockedReason={lock} disabled={unknown} onClick={() => setStatusDialog({ target: 'active', generation: routeScope.current.generation })}>再開</Button>}
          </>
        )}
      />
      <div className={parts.stack}>
        {error ? <Notice tone="danger" className={parts.alertNoticePlacement} >{error}</Notice> : null}
        <div className={parts.tabs}>
          <Tabs
            label="契約先の中身"
            items={TABS.map((t) => ({
              label: t.key === 'accounts' ? `店舗 ${accounts.length}` : t.key === 'members' ? `権限者 ${members.length}` : t.label,
              current: tab === t.key,
              onClick: () => setTab(t.key),
            }))}
          />
        </div>

        {tab === 'overview' ? (
          <DashboardColumns layout="cards">{[
            <Card key="information" aria-label="契約先の情報" contentPadding="var(--polish-space-section)" layout="vertical" gap="normal">
              <SectionHeader title="契約先の情報" />
              <dl className={styles.kvs}>
                <Kv k="統括名" v={tenant.name} />
                <Kv k="メール" v={owner ? `${owner.email}（${ROLE_LABEL[owner.role] ?? owner.role}）` : emptyValue('unknown')} />
                <Kv k="登録日" v={formatDate(tenant.created_at)} />
                <Kv k="最終ログイン" v={formatDateTime(tenant.last_login_at)} />
              </dl>
            </Card>,
            <Card key="subscription" aria-label="契約の状況" contentPadding="var(--polish-space-section)" layout="vertical" gap="normal">
              <SectionHeader title="契約の状況" />
              <dl className={styles.kvs}>
                <Kv k="プラン" v={planLabel(tenant.plan_key)} />
                <Kv k="請求" v={<span title={`次回の請求日 ${formatDate(tenant.current_period_ends_at)}・トライアル ${tenant.trial_ends_at ? `${formatDate(tenant.trial_ends_at)} まで` : emptyValue('none')}`}>{billing}</span>} />
                <Kv k="使用量" v={`店舗 ${accounts.filter((a) => !a.archived_at).length}・権限者 ${members.filter((m) => m.is_active).length}・請求の詳細は Stripe`} />
              </dl>
            </Card>
          ]}</DashboardColumns>
        ) : null}

        {tab === 'accounts' || tab === 'overview' ? (
          <Card  aria-label="店舗（LINE公式アカウント）" contentPadding="var(--polish-space-section)" layout="vertical" gap="normal">
            <SectionHeader title="店舗（LINE公式アカウント）" />
            {accounts.length === 0 ? (
              <ListState permissionScope="hq" kind="empty" title="店舗がありません" description="この契約先にはまだ LINE 公式アカウントがつながっていません。" />
            ) : (
              <GridTable label="店舗" framed={false} design={{ columns: 'minmax(0, 1fr) var(--tpl-rt-col-130) var(--tpl-op-ann-state-w) var(--tpl-rt-col-130)', gap: 'var(--polish-space-card)', rowPadding: '0', fontSize: 'var(--polish-text-body)' }}>
                <GridHeadRow>
                  <GridCell role="columnheader">名前</GridCell>
                  <GridCell role="columnheader">接続状態</GridCell>
                  <GridCell role="columnheader" align="right">友だち数</GridCell>
                  <GridCell role="columnheader">状態</GridCell>
                </GridHeadRow>
                {accounts.map((a) => (
                  <GridRow key={a.id}>
                    <GridNameCell folder={false} name={<TruncatedText value={String(a.name ?? '')} />} />
                    <GridCell>{a.archived_at || !a.is_active ? <StatusBadge tone="neutral">止めている</StatusBadge> : <StatusBadge tone="success">接続中</StatusBadge>}</GridCell>
                    <GridCell align="right">{a.archived_at ? '—' : formatNumber(a.friend_count)}</GridCell>
                    <GridCell>{a.archived_at ? <StatusBadge tone="neutral">アーカイブ</StatusBadge> : a.is_active ? <StatusBadge tone="success">有効</StatusBadge> : <StatusBadge tone="neutral">停止中</StatusBadge>}</GridCell>
                  </GridRow>
                ))}
              </GridTable>
            )}
          </Card>
        ) : null}

        {tab === 'members' ? (
          <Card  aria-label="権限者" contentPadding="var(--polish-space-section)" layout="vertical" gap="normal">
            <SectionHeader title="権限者" />
            {members.length === 0 ? (
              <ListState permissionScope="hq" kind="empty" title="権限者がいません" description="この契約先にはまだ権限者が登録されていません。" />
            ) : (
              <GridTable label="権限者" framed={false} design={{ columns: 'minmax(0, 1fr) minmax(0, 1fr) var(--tpl-rt-col-130) var(--tpl-op-mem-state-w) var(--tpl-op-dt-at-w)', gap: 'var(--polish-space-card)', rowPadding: '0', fontSize: 'var(--polish-text-body)' }}>
                <GridHeadRow>
                  <GridCell role="columnheader">名前</GridCell>
                  <GridCell role="columnheader">メール</GridCell>
                  <GridCell role="columnheader">役割</GridCell>
                  <GridCell role="columnheader">状態</GridCell>
                  <GridCell role="columnheader">最終ログイン</GridCell>
                </GridHeadRow>
                {members.map((m) => (
                  <GridRow key={m.id}>
                    <GridNameCell folder={false} name={<TruncatedText value={String(m.name ?? '')} />} />
                    <GridCell><TruncatedText value={m.email ?? '—'} /></GridCell>
                    <GridCell><span className={styles.shortText}>{ROLE_LABEL[m.role] ?? m.role}{m.access_level === 'read_only' ? '（閲覧）' : ''}</span></GridCell>
                    <GridCell>{m.is_active ? <StatusBadge tone="success">有効</StatusBadge> : <StatusBadge tone="neutral">停止中</StatusBadge>}</GridCell>
                    <GridCell><span className={styles.shortText}>{shortDateTime(m.last_login_at)}</span></GridCell>
                  </GridRow>
                ))}
              </GridTable>
            )}
          </Card>
        ) : null}

        {tab === 'audit' || tab === 'overview' ? (
          <Card  aria-label="運営の操作（監査）" contentPadding="var(--polish-space-section)" layout="vertical" gap="normal">
            <SectionHeader title="運営の操作（監査）" />
            {audit.length === 0 ? (
              <ListState permissionScope="hq" kind="empty" title="運営の操作はまだありません" description="運営がこの契約先に対して行った操作が、ここに残ります。" />
            ) : (
              <GridTable label="運営の操作" framed={false} design={{ columns: 'var(--tpl-op-dt-at-w) var(--tpl-op-ann-state-w) calc(var(--tpl-op-dt-what-w) + 64px) minmax(0, 1fr)', gap: 'var(--polish-space-card)', rowPadding: '0', fontSize: 'var(--polish-text-body)' }}>
                <GridHeadRow>
                  <GridCell role="columnheader">日時</GridCell>
                  <GridCell role="columnheader">運営者</GridCell>
                  <GridCell role="columnheader">操作</GridCell>
                  <GridCell role="columnheader">理由</GridCell>
                </GridHeadRow>
                {audit.map((row) => (
                  <GridRow key={row.id}>
                    <GridCell><span className={styles.shortText} title={formatDateTime(row.created_at)}>{shortDateTime(row.created_at)}</span></GridCell>
                    <GridCell><TruncatedText value={String(row.staff_name ?? '')} /></GridCell>
                    <GridCell><TruncatedText value={auditWord(row.action)} /></GridCell>
                    <GridCell><TruncatedText value={row.reason ?? emptyValue('unknown')} /></GridCell>
                  </GridRow>
                ))}
              </GridTable>
            )}
          </Card>
        ) : null}
      </div>

      {statusDialog && statusDialog.generation === routeScope.current.generation && tenant.id === id ? (
        <StatusDialog
          key={`${id}-${routeScope.current.generation}`}
          tenantId={tenant.id}
          target={statusDialog.target}
          tenantName={tenant.name}
          accounts={accounts.map(account => ({ id: account.id, name: account.name }))}
          routeScope={routeScope}
          generation={routeScope.current.generation}
          onClose={() => setStatusDialog(null)}
          onDone={() => { setStatusDialog(null); void load() }}
        />
      ) : null}
      {impersonateConfirm ? (
        <ConfirmDialog
          open
          title={`「${tenant.name}」に代理ログインする`}
          description="閲覧のみで始まります。契約先のデータを扱います。操作はすべて記録されます。"
          confirmLabel="代理ログインを始める"
          busy={busy}
          error={error || undefined}
          onConfirm={() => impersonate()}
          onCancel={() => { if (!busy) setImpersonateConfirm(false) }}
        />
      ) : null}
    </PageFrame>
  )
}

function Kv({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className={styles.kv}>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  )
}

/** 停止・アーカイブ・再開。名前の打ち直しと4文字以上の理由がそろうまで押せない。 */
function StatusDialog({ tenantId, target, tenantName, accounts, routeScope, generation, onClose, onDone }: { tenantId: string; target: StatusTarget; tenantName: string; accounts: { id: string; name: string }[]; routeScope: React.RefObject<{ id: string; generation: number }>; generation: number; onClose: () => void; onDone: () => void }) {
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const [reason, setReason] = useState('')
  const [confirmName, setConfirmName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const label = target === 'suspended' ? '停止する' : target === 'archived' ? 'アーカイブする' : '再開する'
  const needsName = target !== 'active'
  const nameRequirement: FormRequirement = { required: needsName, check: value => !needsName || value === tenantName ? null : '契約先の名前をそのまま入力してください' }
  const reasonRequirement: FormRequirement = { required: true, check: value => value.trim().length >= 4 ? null : '理由を4文字以上で入力してください' }
  const problem = nameRequirement.check(confirmName) ?? reasonRequirement.check(reason)
  const dialogAccess = useOpsReadOnlyState()
  const accountNames = accounts.slice(0, 3).map(account => account.name || '不明').join('、')
  const accountSummary = accountNames || 'なし'
  const accountLabel = `LINEアカウント（${accounts.length}件）${accounts.length > 3 ? `・ほか${accounts.length - 3}件` : ''}`

  const submit = async () => {
    if (!active.current || routeScope.current.generation !== generation || routeScope.current.id !== tenantId || dialogAccess !== 'writer') return
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    setError('')
    const res = await opsCall(api.ops.changeTenantStatus(tenantId, { status: target, reason: reason.trim(), confirmName: needsName ? confirmName : undefined }))
    setBusy(false)
    if (!res.success) { setError(res.error || '変更できませんでした。時間をおいて、もう一度お試しください。'); return }
    onDone()
  }

  return (
    <Dialog
      open
      designWidth={540}
      designTop={200}
      title={`${tenantName} を${label}`}
      tone={needsName ? 'destructive' : 'default'}
      confirmation
      confirmLabel={label}
      confirmLockedReason={dialogAccess === 'readonly' ? OPS_READONLY_LOCK_REASON : undefined}
      confirmDisabled={dialogAccess === 'unknown'}
      busy={busy}
      error={error || undefined}
      designNode={target === 'suspended' ? 'okXoi' : undefined}
      onConfirm={() => submit()}
      onCancel={() => { active.current = false; onClose() }}
    >
      <div className={parts.dialogBody}>
        <OperationTargetSummary accounts={[]} externalTarget={{ label: accountLabel, name: accountSummary }} />
        <p className={parts.note}>{`契約先：${tenantName}（1件）`}</p>
        <Notice tone={needsName ? "warn" : "info"}>
          {target === 'suspended'
            ? '停止すると、この契約先の権限者はログインできなくなります。配信も止まります。'
            : target === 'archived'
              ? 'アーカイブすると一覧から外れます。データは消えません。'
              : '再開すると、権限者がまたログインできるようになります。'}
        </Notice>
        {needsName ? (
          <Field label="確認のため、契約先の名前をそのまま入力" requirement={nameRequirement}><SaveErrorField names={["confirmName","confirm_name"]}><TextField value={confirmName} onChange={(event) => setConfirmName(event.target.value)} placeholder={tenantName} /></SaveErrorField></Field>
        ) : null}
        <Field label="理由（4文字以上）" requirement={reasonRequirement}><SaveErrorField names={["reason"]}><TextField value={reason} onChange={(event) => setReason(event.target.value)} placeholder="支払いの遅れが3か月続いたため" aria-label="理由（4文字以上）" /></SaveErrorField></Field>
      </div>
    </Dialog>
  )
}
