'use client'

import { requiredText } from '@/lib/form-requirement'
const inviteEmailRequirement = requiredText('招待する人のメールアドレスを入れてください')
import { useUrlTab } from '@/lib/use-url-tab'
import { UserPlus } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type OpsMember } from '@/lib/api'
import { opsCall } from '@/components/ops/ops-ui'
import NoticeLineAccountCard from '@/components/ops/notice-line-account-card'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import ListState from '@/components/shared/list-state'
import StatusBadge from '@/components/shared/status-badge'
import { Field } from '@/components/shared/form-controls'
import { TextField } from '@/components/shared/text-field'
import { OPS_READONLY_LOCK_REASON } from './use-ops-read-only'
import type { ActionMenuItem } from '@/components/shared/action-menu'
import { PageFrame } from '@/components/templates/page-frame'
import parts from './parts.module.css'
import styles from './members.module.css'
import { formatDate as polishFormatDate, formatDateTime } from '@/lib/format'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import Notice from '@/components/shared/notice'
import { GridTable, GridHeadRow, GridRow, GridCell, GridNameCell } from '@/components/shared/grid-table'
import TruncatedText from '@/components/shared/truncated-text'
import { RowActions } from '@/components/shared/row-actions'
import { SelfSecurity } from '@/v8/settings/staff'
import SegmentedControl from '@/components/shared/segmented'
import Pagination from '@/components/shared/pagination'
import SearchField from '@/components/shared/search-field'
import { ListToolbarFrame, ListToolbarRow } from '@/components/shared/list-toolbar'

/**
 * 運営のメンバー管理 V8（絵の停止の窓 ）。
 *
 * 動きは 管理画面（app/ops/members）と同じ口：一覧（/api/ops/members）・招待・再送・
 * 停止／再開。自分自身の行には操作を置かない。閲覧のみの運営メンバー
 * （/api/ops/me の readOnly）には、招待も行の「…」も押せない形＋理由で出す
 * （決まり：隠さず灰色＋理由）。役割が分かるまでは理由なしの押せない形。
 */

type PendingAction = { member: OpsMember; kind: 'stop' | 'resume' | 'cancel' }

/** 行の「…」の中身。閲覧のみは押せない形＋理由、役割が分かるまでは理由なしの押せない形。 */
function memberRowItems(m: OpsMember, access: 'unknown' | 'readonly' | 'writer', invited: boolean, onResend: () => void, onPending: (kind: 'stop' | 'resume' | 'cancel') => void): ActionMenuItem[] {
  const items: ActionMenuItem[] = invited ? [
    { id: 'resend', label: '招待を再送する', onSelect: onResend },
    { id: 'cancel', label: '取り消す', tone: 'danger', onSelect: () => onPending('cancel') },
  ] : [{ id: 'state', label: m.isActive ? '停止する' : '再開する', tone: m.isActive ? 'danger' : undefined, onSelect: () => onPending(m.isActive ? 'stop' : 'resume') }]
  if (access === 'readonly') return items.map(({ onSelect: _onSelect, ...item }) => ({ ...item, disabled: false, lockedReason: OPS_READONLY_LOCK_REASON }))
  if (access === 'unknown') return items.map((item) => ({ ...item, disabled: true }))
  return items
}

export default function OpsMembersV8() {
  const [members, setMembers] = useState<OpsMember[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [tab] = useUrlTab(['members', 'info'] as const, 'members')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'active' | 'suspended' | 'all'>('active')
  const [page, setPage] = useState(1)
  const [inviteOpen, setInviteOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [listFailed, setListFailed] = useState(false)
  const [meFailed, setMeFailed] = useState(false)
  const [meLoading, setMeLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [me, setMe] = useState<string | null>(null)
  const [access, setAccess] = useState<'unknown' | 'readonly' | 'writer'>('unknown')
  const lock = access === 'readonly' ? OPS_READONLY_LOCK_REASON : undefined
  const unknown = access === 'unknown'
  const [pending, setPending] = useState<PendingAction | null>(null)
  const pendingRef = useRef<PendingAction | null>(null)
  const loadSeqRef = useRef(0)
  const loadInFlightRef = useRef<number | null>(null)
  const meSeqRef = useRef(0)
  const meInFlightRef = useRef<number | null>(null)
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      pendingRef.current = null
      loadSeqRef.current += 1
      loadInFlightRef.current = null
      meSeqRef.current += 1
      meInFlightRef.current = null
    }
  }, [])
  const [notice, setNotice] = useState('')
  const [resendingId, setResendingId] = useState<string | null>(null)

  const load = useCallback(async (options?: { force?: boolean }) => {
    if (!options?.force && loadInFlightRef.current !== null) return
    const seq = ++loadSeqRef.current
    const meSeq = ++meSeqRef.current
    loadInFlightRef.current = seq
    meInFlightRef.current = meSeq
    setLoading(true)
    setMeLoading(true)
    setError('')
    setListFailed(false)
    setMeFailed(false)
    try {
      const [res, meRes] = await Promise.all([opsCall(api.ops.members()), opsCall(api.ops.me())])
      if (!aliveRef.current || seq !== loadSeqRef.current) return
      setLoaded(true)
      if (meSeq === meSeqRef.current) {
        if (meRes.success && meRes.data) {
          setMe(meRes.data.id)
          setAccess(meRes.data.readOnly ? 'readonly' : 'writer')
          setMeFailed(false)
        } else {
          setMeFailed(true)
        }
      }
      if (!res.success || !Array.isArray(res.data)) {
        setError((!res.success && res.error) || '読み込めませんでした')
        setListFailed(true)
        return
      }
      setMembers(res.data)
    } finally {
      if (loadInFlightRef.current === seq) loadInFlightRef.current = null
      if (meInFlightRef.current === meSeq) meInFlightRef.current = null
      if (aliveRef.current && seq === loadSeqRef.current) setLoading(false)
      if (aliveRef.current && meSeq === meSeqRef.current) setMeLoading(false)
    }
  }, [])

  const reloadMe = useCallback(async () => {
    if (meInFlightRef.current !== null) return
    const meSeq = ++meSeqRef.current
    meInFlightRef.current = meSeq
    setMeLoading(true)
    setMeFailed(false)
    try {
      const meRes = await opsCall(api.ops.me())
      if (!aliveRef.current || meSeq !== meSeqRef.current) return
      if (meRes.success && meRes.data) {
        setMe(meRes.data.id)
        setAccess(meRes.data.readOnly ? 'readonly' : 'writer')
        setMeFailed(false)
      } else {
        setMeFailed(true)
      }
    } finally {
      if (meInFlightRef.current === meSeq) meInFlightRef.current = null
      if (aliveRef.current && meSeq === meSeqRef.current) setMeLoading(false)
    }
  }, [])

  useEffect(() => { void load({ force: true }) }, [load])

  const [inviteError, setInviteError] = useState<string | null>(null)
  const invite = async () => {
    if (access !== 'writer') return
    const problem = inviteEmailRequirement.check(email)
    setInviteError(problem)
    if (problem) return
    setBusy(true)
    setError('')
    const res = await opsCall(api.ops.addMember({ email: email.trim() }))
    setBusy(false)
    if (!res.success) { setError(res.error || '招待できませんでした。時間をおいて、もう一度お試しください。'); return }
    setNotice(res.data.activationState === 'active'
      ? '最初の運営メンバーとして登録しました'
      : `${email.trim()} に招待メールを送りました。相手が二段階認証の登録を終えると運営メンバーになります`)
    setEmail('')
    setInviteOpen(false)
    void load({ force: true })
  }

  const resend = async (member: OpsMember) => {
    if (access !== 'writer') return
    setResendingId(member.staffId)
    setError('')
    const res = await opsCall(api.ops.resendInvite(member.staffId))
    setResendingId(null)
    if (!res.success) { setError(res.error || '送り直せませんでした'); return }
    setNotice(`${member.email ?? member.name} に招待メールを送り直しました`)
    void load({ force: true })
  }

  const applyPending = async () => {
    if (!pending || pendingRef.current !== pending || access !== 'writer') return
    pendingRef.current = null
    setBusy(true)
    setError('')
    const res = await opsCall(api.ops.setMemberActive(pending.member.staffId, pending.kind === 'resume'))
    setBusy(false)
    if (!res.success) { pendingRef.current = pending; setError(res.error || '変更できませんでした。時間をおいて、もう一度お試しください。'); return }
    setPending(null)
    void load({ force: true })
  }

  const countsReady = loaded && !loading && !listFailed
  const active = members.filter(member => member.isActive).length
  const suspended = members.length - active
  const filtered = members.filter(member => `${member.name} ${member.email ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) && (filter === 'all' || (filter === 'active' ? member.isActive : !member.isActive)))
  const pageCount = Math.max(1, Math.ceil(filtered.length / 6))
  const visible = filtered.slice((Math.min(page, pageCount) - 1) * 6, Math.min(page, pageCount) * 6)

  return (
    <PageFrame kind="list" boardId="FvbHW" standalone skeleton>
      <h1 className={styles.srOnly}>メンバー管理</h1>
      <div className={styles.layout}>
        <div className={styles.main}>
          {tab === 'info' ? <div className={parts.stack}><NoticeLineAccountCard /></div> : <>
            <ListToolbarFrame singleRow><ListToolbarRow>
              <SearchField aria-label="名前・メールで探す" placeholder="名前・メールで探す" value={query} onChange={value => { setQuery(value); setPage(1) }} onClear={() => { setQuery(''); setPage(1) }} />
              <SegmentedControl aria-label="利用状態で絞り込む" fit="content" value={filter} onChange={value => { setFilter(value); setPage(1) }} options={[{ value: 'active', label: '有効', count: countsReady ? active : undefined }, { value: 'suspended', label: '止めた', count: countsReady ? suspended : undefined }, { value: 'all', label: 'すべて' }]} />
              <Button variant="primary" lockedReason={lock} disabled={unknown} onClick={() => setInviteOpen(true)}><UserPlus aria-hidden="true" />招待する</Button>
            </ListToolbarRow></ListToolbarFrame>
            {notice ? <p role="status" className={parts.status}>{notice}</p> : null}
            {loaded && !loading && !listFailed && meFailed && access === 'unknown' ? (
              <Notice
                tone="warn"
                className={parts.alertNoticePlacement}
                message="操作権限を確認できませんでした。一覧の確認は続けられますが、招待や停止の前に権限を読み直してください。"
                action={
                  <Button
                    variant="text"
                    size="inline"
                    onClick={() => void reloadMe()}
                    disabled={meLoading}
                    busy={meLoading}
                    busyLabel="確認しています"
                  >
                    権限を読み直す
                  </Button>
                }
              />
            ) : null}
            {error && !listFailed ? <Notice tone="danger" className={parts.alertNoticePlacement}>{error}</Notice> : null}
            {!loaded || (loading && members.length === 0) ? <ListState permissionScope="hq" kind="loading" title="運営メンバーを読み込んでいます" />
              : listFailed ? <ListState permissionScope="hq" kind="error" title="運営メンバーを読み込めませんでした" description={error} onRetry={() => void load()} />
              : <section className={styles.listCard}>
                <h2 className={styles.listTitle}>運営メンバー</h2><p className={styles.listCount}>{members.length}人</p>
                {members.length === 0 ? <ListState permissionScope="hq" kind="empty" title="運営メンバーがいません" /> :
                <GridTable label="運営メンバー" framed={false} design={{ columns: 'minmax(0, 1fr) minmax(0, 1fr) var(--tpl-rt-col-130) var(--tpl-op-mem-state-w) var(--tpl-op-mem-login-w) var(--tpl-op-mem-ops-w)', gap: 'var(--polish-space-card)', rowPadding: '0 var(--tpl-list-inset)', fontSize: 'var(--polish-text-body)' }}>
                  <GridHeadRow>
                    <GridCell role="columnheader">名前</GridCell>
                    <GridCell role="columnheader">メールアドレス</GridCell>
                    <GridCell role="columnheader">二段階認証</GridCell>
                    <GridCell role="columnheader">状態</GridCell>
                    <GridCell role="columnheader">最終ログイン</GridCell>
                    <GridCell role="columnheader">操作</GridCell>
                  </GridHeadRow>
                  {visible.map((m) => {
                    const self = m.staffId === me
                    const invited = m.isActive && m.activationState !== 'active'
                    return <GridRow key={m.staffId}>
                      <GridNameCell folder={false} name={<TruncatedText value={`${m.name}${self ? '（自分）' : ''}`} />} />
                      <GridCell><TruncatedText value={m.email ?? emptyValue('unknown')} /></GridCell>
                      <GridCell>{totpChip(m)}</GridCell>
                      <GridCell>{stateChip(m)}</GridCell>
                      <GridCell><span className={styles.shortText} title={m.lastLoginAt ? formatDateTime(m.lastLoginAt) : undefined}>{shortDateTime(m.lastLoginAt)}</span></GridCell>
                      <GridCell align="right">
                        {access === 'writer' && self ? (
                          <RowActions subjectName={m.name} menuButtonProps={{ disabled: true, title: '自分の運営アカウントは停止・取り消しできません' }} menuNote="自分の運営アカウントは停止・取り消しできません" />
                        ) : (
                          <RowActions subjectName={m.name} menuButtonProps={{ disabled: busy || resendingId !== null }} menuItems={memberRowItems(m, access, invited, () => { void resend(m) }, (kind) => { const action = { member: m, kind }; pendingRef.current = action; setPending(action) })} />
                        )}
                      </GridCell>
                    </GridRow>
                  })}
                </GridTable>}
              </section>}
            {loaded && !listFailed ? <div className={styles.listFoot}><span>運営メンバー {filtered.length}人中 {visible.length}人を表示</span><Pagination page={Math.min(page, pageCount)} pageCount={pageCount} onPageChange={setPage} /></div> : null}
          </>}
        </div>
        {tab === 'members' ? <aside className={styles.securityAside}><SelfSecurity loginPath="/ops/login" /></aside> : null}
      </div>
      <Dialog open={inviteOpen} title="運営メンバーを招待" confirmLabel="招待メールを送る" busy={busy} error={error} onConfirm={() => void invite()} onCancel={() => { if (!busy) setInviteOpen(false) }}>
        <Field label="招待する人のメールアドレス" requirement={inviteEmailRequirement} error={inviteError}>
          <SaveErrorField names={["email"]}><TextField type="email" value={email} onChange={event => { setEmail(event.target.value); setInviteError(null) }} placeholder="招待する人のメールアドレス" aria-label="招待する人のメールアドレス" autoComplete="off" disabled={busy || access !== 'writer'} /></SaveErrorField>
        </Field>
      </Dialog>
      <Dialog
        open={pending !== null}
        designWidth={480}
        designTop={300}
        tone={pending?.kind === 'resume' ? 'default' : 'destructive'}
        confirmation
        title={pending ? confirmTitle(pending) : ''}
        confirmLabel={pending?.kind === 'resume' ? '再開する' : pending?.kind === 'cancel' ? '取り消す' : '停止する'}
        busy={busy}
        error={error}
        designNode={pending?.kind === 'stop' ? 'VUyYu' : undefined}
        onConfirm={() => applyPending()}
        onCancel={() => { if (!busy) { pendingRef.current = null; setPending(null) } }}
      >
        <div className={parts.dialogBody}>
          <OperationTargetSummary accounts={[{ id: '', name: '不明' }]} externalTarget={{ label: '対象者', name: pending ? `${pending.member.name}（1人）` : '不明' }} />
          <Notice tone="info">
            {pending?.kind === 'resume'
              ? '再開すると、この人はまた運営コンソールに入れるようになります。'
              : pending?.kind === 'cancel'
                ? '取り消すと、届いた招待メールのリンクから入れなくなります。あとで再開できます。'
                : '停止すると、この人は運営コンソールに入れなくなります。あとで再開できます。'}
          </Notice>
        </div>
      </Dialog>
    </PageFrame>
  )
}

function confirmTitle(pending: PendingAction): string {
  const name = pending.member.name
  if (pending.kind === 'resume') return `${name} を再開しますか？`
  if (pending.kind === 'cancel') return `${name} への招待を取り消しますか？`
  return `${name} を停止しますか？`
}

/** 短い日時（10/2 07:10 の形）。 */
function shortDateTime(value: string | null): string {
  return polishFormatDate(value, { style: 'list', fallback: '—' })
}

function totpChip(m: OpsMember) {
  if (m.totpEnabled) return <StatusBadge tone="success">設定済み</StatusBadge>
  if (m.activationState === 'awaiting_totp' || m.activationState === 'invited') return <StatusBadge tone="info">二段階認証待ち</StatusBadge>
  return <StatusBadge tone="danger">未設定</StatusBadge>
}

/** 状態の札。停止 → 招待中 → 有効 の順に見る。 */
function stateChip(m: OpsMember) {
  if (!m.isActive) return <StatusBadge tone="neutral">停止</StatusBadge>
  if (m.activationState !== 'active') return <StatusBadge tone="info">招待中</StatusBadge>
  return <StatusBadge tone="success">有効</StatusBadge>
}
