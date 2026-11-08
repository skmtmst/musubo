'use client'

import { loadStaffIdentity, useTenantAdministratorAccess } from '@/lib/staff-role'
import { PageFrame } from '@/components/templates/page-frame'
import { UserPlus } from 'lucide-react'
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import type { LineAccount, StaffMember } from '@line-crm/shared'
import StepUpPrompt from '@/components/step-up-prompt'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { describeApiFailure, japaneseDetailOf } from '@/components/shared/api-error-message'
import { api, ApiError } from '@/lib/api'
import StatusBadge from '@/components/shared/status-badge'
import { canResendInvite, lastLoginShort, memberStatus, sortMembersByRole } from '@/lib/hq-members'
import HqSettingsNavV8 from './settings-nav'
import MemberDialogV8, { MemberChangeConfirmV8, type MemberDialogValue } from './member-dialog'
import styles from './members.module.css'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import Notice from '@/components/shared/notice'
import { GridTable, GridHeadRow, GridRow, GridCell, GridNameCell } from '@/components/shared/grid-table'
import TruncatedText from '@/components/shared/truncated-text'
import { RowActions } from '@/components/shared/row-actions'
import { SelfSecurity } from '@/v8/settings/staff'
import SegmentedControl from '@/components/shared/segmented'
import Pagination from '@/components/shared/pagination'
import SearchField from '@/components/shared/search-field'
import { ListToolbarFrame, ListToolbarRow } from '@/components/shared/list-toolbar'

/*
 * ★V8 統括のメンバー（Pencil 。招待の窓 ・権限を変える窓 ・
 * 変える前の確認 ）。
 *
 * 管理画面 の画面（app/hq/members/page.tsx）と読み書きの口・権限・失敗時の扱いは同じ。
 * 見た目だけを絵どおりに一から組んだ：頭（型 ListPage）・左の「統括の設定」の列
 * （型のフォルダの列）・数のカード4枚・権限者の表・役割の説明。
 */

type LoadStatus = 'loading' | 'ready' | 'error' | 'forbidden'

/** 絵の言葉（役割）。担当範囲のアカウントだけを触る人は「担当者」。 */
const ROLE_WORDS: Record<StaffMember['role'], string> = {
  owner: 'オーナー',
  admin: '管理者',
  staff: '担当者',
  viewer: '閲覧のみ',
}

const VIEWER_NOTE = '閲覧のみで見ています。権限者の招待・変更は統括の管理者に頼んでください。'

export default function HqMembersV8() {
  return (
    <Suspense fallback={null}>
      <MembersInner />
    </Suspense>
  )
}

function MembersInner() {
  const saveErrors = useSaveFormErrors()
  // ★V8 上の帯のパンくずは「ホーム › 統括の設定 › 画面名」。
  usePageTitle('メンバー')
  usePageCrumbs([{ label: '統括の設定', href: '/hq/settings' }])

  const [status, setStatus] = useState<LoadStatus>('loading')
  const [members, setMembers] = useState<StaffMember[]>([])
  const [accounts, setAccounts] = useState<LineAccount[]>([])
  const [me, setMe] = useState<StaffMember | null>(null)
  const [lastLogins, setLastLogins] = useState<Record<string, string>>({})
  const [dialog, setDialog] = useState<{ open: boolean; member: StaffMember | null }>({ open: false, member: null })
  const [dialogSession, setDialogSession] = useState(0)
  const [dialogBusy, setDialogBusy] = useState(false)
  const [dialogError, setDialogError] = useState('')
  const [actionError, setActionError] = useState('')
  const [notice, setNotice] = useState('')
  const [resendingId, setResendingId] = useState<string | null>(null)
  /* 権限変更が STEP_UP_REQUIRED で止まったときの本人確認。通ったら grant を付けて同じ保存をやり直す。 */
  const [stepUp, setStepUp] = useState<null | { retry: (token: string) => Promise<void> }>(null)
  /* 板 「権限を変える確認」。変える前に変更前→変更後を見せる。 */
  const [confirmChange, setConfirmChange] = useState<{ member: StaffMember; value: MemberDialogValue } | null>(null)

  const load = useCallback(async () => {
    setStatus('loading')
    setActionError('')
    try {
      // M025: 範囲限定の担当者に一覧は出さない（口も403で断る）。
      // 先に自分を読んで理由の分かる面を出し、通らない一覧は呼ばない。
      const meRes = await loadStaffIdentity()
      if (!meRes.success) throw new Error(meRes.error)
      setMe(meRes.data)
      if (meRes.data.accountScope === 'accounts') {
        setStatus('ready')
        return
      }
      const [staffRes, accountRes, loginRes] = await Promise.all([
        api.staff.list(),
        api.lineAccounts.list(),
        api.staff.lastLogins().catch(() => null),
      ])
      if (!staffRes.success) throw new Error(staffRes.error)
      setMembers(staffRes.data)
      if (accountRes.success) setAccounts(accountRes.data)
      if (loginRes?.success) setLastLogins(loginRes.data)
      setStatus('ready')
    } catch (caught) {
      saveErrors.capture(caught);

      setStatus(caught instanceof ApiError && caught.status === 403 ? 'forbidden' : 'error')
    }
  }, [saveErrors])

  useEffect(() => {
    void load()
  }, [load]);


  const accountNames = useMemo(() => new Map(accounts.map((a) => [a.id, a.name])), [accounts])
  /* 絵  の並び：状態→役割（オーナー→管理者→担当者→閲覧のみ）→名前。 */
  const rows = sortMembersByRole(members)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'active' | 'suspended' | 'all'>('active')
  const [page, setPage] = useState(1)
  const activeCount = members.filter(member => memberStatus(member) !== 'inactive').length
  const suspendedCount = members.length - activeCount
  const filteredRows = rows.filter(member => {
    const matchesQuery = `${member.name} ${member.email ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    return matchesQuery && (filter === 'all' || (filter === 'active' ? memberStatus(member) !== 'inactive' : memberStatus(member) === 'inactive'))
  })
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / 6))
  const visibleRows = filteredRows.slice((Math.min(page, pageCount) - 1) * 6, Math.min(page, pageCount) * 6)
  const missingMfa = members.filter(member => memberStatus(member) === 'active' && !member.twoFactorEnabled).length
  const canManage = useTenantAdministratorAccess()
  const restricted = me?.accountScope === 'accounts'

  const submitDialog = async (value: MemberDialogValue, stepUpToken?: string) => {
    setDialogBusy(true)
    setDialogError('')
    try {
      if (dialog.member) {
        const res = await api.staff.update(dialog.member.id, {
          /*
           * 役割は変えたときだけ送る（担当者のまま保存しても管理者へ上がらない）。
           * WEB216：統括（owner）は窓の中では「管理者」として出る。役割を触らずに範囲だけ
           * 保存したとき、owner→admin の変更（と本人確認）を混ぜない。
           */
          ...(value.role !== (dialog.member.role === 'owner' ? 'admin' : dialog.member.role) ? { role: value.role } : {}),
          isActive: value.isActive,
          assignedLineAccountId: value.accountScope === 'all' ? null : dialog.member.assignedLineAccountId,
          accountScope: value.accountScope,
          scopedLineAccountIds: value.scopedLineAccountIds,
          managementContext: 'hq',
        }, stepUpToken)
        if (!res.success) throw new Error(res.error)
        setNotice(`${dialog.member.name}さんの権限を変更しました。`)
      } else {
        const res = await api.staff.create({
          name: value.name,
          email: value.email,
          role: value.role,
          assignedLineAccountId: null,
          accountScope: value.accountScope,
          scopedLineAccountIds: value.scopedLineAccountIds,
          managementContext: 'hq',
        })
        if (!res.success) throw new Error(res.error)
        setNotice(`${value.email} へ招待メールを送りました。`)
      }
      setDialog({ open: false, member: null })
      await load()
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught);

      if (!stepUpToken && caught instanceof ApiError && caught.code === 'STEP_UP_REQUIRED') {
        setStepUp({ retry: (token) => submitDialog(value, token) });

        return
      }
      // M026：原文のまま出さず、共通の状態別案内へ渡す（本人確認の分岐は先に残す）。
      { if (!fieldFailure)
      setDialogError(japaneseDetailOf(caught) || describeApiFailure(caught, '保存', {
        scope: 'hq',
      })) }
    } finally {
      setDialogBusy(false)
    }
  }

  const resend = async (member: StaffMember) => {
    setResendingId(member.id)
    setActionError('')
    setNotice('')
    try {
      const res = await api.staff.resendInvite(member.id)
      if (!res.success) throw new Error(res.error)
      setNotice(`${member.email} へ招待メールを送り直しました。`)
    } catch (caught) {
      const fieldFailure = saveErrors.capture(caught)
      // M026：再試行の言葉がない代替文にしない。共通の状態別案内へ渡す。
      { if (!fieldFailure)
      setActionError(japaneseDetailOf(caught) || describeApiFailure(caught, '招待メールの再送', {
        scope: 'hq',
      })) }
    } finally {
      setResendingId(null)
    }
  }

  const openInvite = () => { setDialogError(''); setDialogSession((n) => n + 1); setDialog({ open: true, member: null }) }
  const openChange = (member: StaffMember) => { setDialogError(''); setDialogSession((n) => n + 1); setDialog({ open: true, member }) }
  const ready = status === 'ready' && !restricted

  return (
    <SaveErrorScope errors={saveErrors}><PageFrame kind="settings" boardId="r4ARpV">
      <div className={styles.layout}>
        <aside className={styles.settingsNav}><HqSettingsNavV8 active="members" /></aside>
        <div className={styles.main}>
        {ready && !canManage ? <div className={styles.viewerBand}><ReadOnlyNotice role="status">{VIEWER_NOTE}</ReadOnlyNotice></div> : null}
        {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
        {actionError ? <Notice tone="danger" >{actionError}</Notice> : null}

        {status === 'loading' ? (
          <ListState permissionScope="hq" kind="loading" title="権限者を読み込んでいます" />
        ) : status === 'forbidden' ? (
          <ListState permissionScope="hq" kind="forbidden" />
        ) : status === 'error' ? (
          <ListState permissionScope="hq" kind="error" title="権限者を読み込めませんでした" description="通信の状態を確認して、もう一度お試しください。" onRetry={() => void load()} />
        ) : restricted ? (
          <ListState permissionScope="hq" kind="forbidden" title="全アカウントの担当者だけが権限者を管理できます" permissionReason="担当アカウントが限定されているため、権限者の一覧と変更はできません。" />
        ) : (
          <>
            <ListToolbarFrame singleRow><ListToolbarRow>
              <SearchField aria-label="名前・メールで探す" placeholder="名前・メールで探す" value={query} onChange={value => { setQuery(value); setPage(1) }} onClear={() => { setQuery(''); setPage(1) }} />
              <SegmentedControl aria-label="利用状態で絞り込む" fit="content" value={filter} onChange={value => { setFilter(value); setPage(1) }} options={[{ value: 'active', label: '有効', count: activeCount }, { value: 'suspended', label: '止めた', count: suspendedCount }, { value: 'all', label: 'すべて' }]} />
              <Button variant="primary" disabled={!canManage} onClick={openInvite}><UserPlus aria-hidden="true" className={styles.buttonIcon} />招待する</Button>
            </ListToolbarRow></ListToolbarFrame>
            <section className={styles.listCard}>
              <h2 className={styles.listTitle}>メンバー</h2><p className={styles.listCount}>{members.length}人</p>
            <GridTable label="権限者の一覧" columnSizing="content" framed={false} design={{ columns: 'minmax(0, 1fr) var(--tpl-hq-col-role) var(--tpl-hq-col-login) var(--tpl-hq-col-action)', gap: 'var(--polish-space-card)', rowPadding: '0 var(--tpl-list-inset)', fontSize: 'var(--polish-text-body)' }}>
              <GridHeadRow>
                <GridCell role="columnheader">ユーザー情報</GridCell>
                <GridCell role="columnheader">権限</GridCell>
                <GridCell role="columnheader">最終ログイン</GridCell>
                <GridCell role="columnheader">操作</GridCell>
              </GridHeadRow>
              {visibleRows.map((member) => {
                const isSelf = member.id === me?.id
                return (
                  <GridRow key={member.id}>
                    <GridNameCell folder={false} name={<span className={styles.identity}><strong><TruncatedText value={`${member.name}${isSelf ? '（あなた）' : ''}`} /></strong><small><TruncatedText value={member.email ?? emptyValue('unknown')} /></small></span>} />
                    <GridCell><StatusBadge tone={member.role === 'viewer' ? 'neutral' : member.role === 'staff' ? 'info' : 'success'}>{ROLE_WORDS[member.role] ?? member.role}</StatusBadge></GridCell>
                    <GridCell><span className={styles.shortText}>{lastLoginShort(lastLogins[member.id])}</span></GridCell>
                    <GridCell align="right">
                      {canManage ? <RowActions subjectName={member.name} edit={{ label: '権限を変更する', onClick: () => openChange(member) }} menuItems={canResendInvite(member) ? [{ id: 'resend', label: '招待を再送する', disabled: resendingId === member.id, disabledReason: resendingId === member.id ? '招待を送信しています' : undefined, onSelect: () => { void resend(member) } }] : []} /> : null}
                    </GridCell>
                  </GridRow>
                )
              })}
            </GridTable></section>
            {missingMfa > 0 ? <p className={styles.warning}>二段階認証が未設定の人が {missingMfa}人 います。高い権限の人から設定してください。</p> : null}
            <div className={styles.listFoot}><span>メンバー {filteredRows.length}人中 {visibleRows.length}人を表示</span><Pagination page={Math.min(page, pageCount)} pageCount={pageCount} onPageChange={setPage} /></div>

          </>
        )}
        </div>
        <aside className={styles.securityAside}><SelfSecurity /></aside>
      </div>

      <MemberDialogV8
        /* 確認を出す間は閉じる。確認をやめたら入れた中身のまま戻る。 */
        open={dialog.open && !confirmChange}
        active={dialog.open}
        session={dialogSession}
        member={dialog.member}
        isSelf={dialog.member?.id === me?.id}
        busy={dialogBusy}
        error={dialogError}
        onSubmit={(value) => {
          if (dialog.member) setConfirmChange({ member: dialog.member, value })
          else void submitDialog(value)
        }}
        onCancel={() => {
          if (dialogBusy) return
          setConfirmChange(null)
          setDialog({ open: false, member: null })
        }}
      />
      {confirmChange ? (
        <MemberChangeConfirmV8
          member={confirmChange.member}
          value={confirmChange.value}
          accountNames={accountNames}
          busy={dialogBusy}
          error={dialogError}
          onCancel={() => { if (!dialogBusy) setConfirmChange(null) }}
          onConfirm={() => {
            const pending = confirmChange
            setConfirmChange(null)
            return submitDialog(pending.value)
          }}
        />
      ) : null}
      {stepUp ? (
        <StepUpPrompt
          request={{ purpose: 'staff.permissions.change', action: 'メンバーの権限を変更する', retry: stepUp.retry }}
          onDone={() => setStepUp(null)}
          onClose={() => setStepUp(null)}
        />
      ) : null}
    </PageFrame></SaveErrorScope>
  )
}
