'use client'
import { FormLeaveGuard } from '@/components/shared/form-leave-guard'

import { orderPools } from './pool-order'
export { orderPools } from './pool-order'

import { useSaveConflict, SaveConflictBand, SaveConflictCompareDialog, saveConflictTitle } from '@/components/shared/save-conflict'

/*
 * ★V8 プール管理（Pencil ）。
 *
 * 白い板の頭（題・説明・右に「新規プール」）→ 左に「設定の中のメニュー」→
 * 右にプールのカードを2列、その下に「外す」の案内の帯。
 * データの口は今の画面（app/pools/page.tsx）と同じ：
 * プール一覧・LINEアカウント一覧・プールごとの所属アカウント・追加・外す・削除。
 * 「新規プール」は V8 の作る画面（/pools/new・）へ移る。
 */
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import CopyTextButton from '@/components/shared/copy-text-button'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Plus } from 'lucide-react'
import Card, { CardHeader } from '@/components/shared/card'
import type { LineAccount, PoolAccount, TrafficPool } from '@line-crm/shared'
import { api, ApiError } from '@/lib/api'
import { isPoolsFeatureAvailable } from '@/lib/pools-availability'
import { useStaffRole } from '@/lib/staff-role'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { SettingsPage } from '@/components/templates'
import SettingsInnerNav from '@/components/layout/settings-inner-nav'
import { FeatureDisabledScreen } from '@/components/feature-disabled-gate'
import ActionMenu from '@/components/shared/action-menu'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import { Field } from '@/components/shared/form-controls'
import { TextField } from '@/components/shared/text-field'
import { notifyToast } from '@/components/shared/toast'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { RowMenu } from '@/components/shared/row-actions'
import ListState from '@/components/shared/list-state'
import frame from '../sa-frame.module.css'
import styles from './pools.module.css'
import { formatNumber as polishFormatNumber } from '@/lib/format'
import TruncatedText from '@/components/shared/truncated-text'

import Notice from '@/components/shared/notice'

type AccountWithStats = LineAccount & { stats?: { friendCount: number } }

const TITLE = 'プール管理'
const DESCRIPTION = '来たお客さまを振り分ける LINE アカウントをまとめる入れ物です。公開 URL から来た人を、有効の所属アカウントからランダムに振り分けます。'


export default function PoolsV8() {
  usePageTitle(TITLE)
  usePageCrumbs([{ label: '設定', href: '/settings' }])
  const role = useStaffRole()
  // APIと同じくオーナーだけ。役割の確認中も変更操作を隠す。
  const canManage = role === 'owner'
  const [pools, setPools] = useState<TrafficPool[]>([])
  const [accounts, setAccounts] = useState<AccountWithStats[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // どこも無効と確定したときは口を呼ばず、案内だけ出す（403 自体が console error になるため・#703）。
  const [featureOff, setFeatureOff] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    setFeatureOff(false)
    if (!(await isPoolsFeatureAvailable())) {
      setPools([])
      setFeatureOff(true)
      setLoading(false)
      return
    }
    try {
      const [poolsRes, accRes] = await Promise.all([api.pools.list(), api.lineAccounts.list()])
      if (poolsRes.success) setPools(poolsRes.data)
      else setError('プール一覧の取得に失敗しました。もう一度読み込んでください。')
      if (accRes.success) setAccounts(accRes.data as AccountWithStats[])
    } catch (err) {
      // FEATURE_DISABLED は共通ゲートが案内へ切り替える。それ以外だけここで伝える。
      if (err instanceof ApiError && err.code === 'FEATURE_DISABLED') {
        setFeatureOff(true)
      } else {
        setError('プール一覧の取得に失敗しました。もう一度読み込んでください。')
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (featureOff) {
    return (
      <div className={frame.screen}>
        <SettingsPage layout="accounts" heightMode="content" boardId="u3iab3" title={TITLE} help={DESCRIPTION} navigation={<SettingsInnerNav inline />}>
          <FeatureDisabledScreen featureId="multi_store_hierarchy" />
        </SettingsPage>
      </div>
    )
  }

  const ordered = orderPools(pools)
  // 読み込み済み・失敗なし・0件のときは空状態だけ出す（右上の作る口と重ねない）。
  const isEmpty = !loading && !error && ordered.length === 0
  const createButton = (
    <Button variant="primary" href="/pools/new">
      <Plus size={16} aria-hidden="true" />新規プール
    </Button>
  )

  return (
    <div className={frame.screen}>
      <SettingsPage layout="accounts" heightMode="content"
        boardId="u3iab3"
        title={TITLE}
        help={DESCRIPTION}
        explanation="「外す」と、これから来たお客さまはそのアカウントへ振り分けられなくなります。アカウント自体と、これまでの流入の記録は残ります。"
        actions={canManage && !isEmpty ? createButton : undefined}
        navigation={<SettingsInnerNav inline />}
      >
        {loading ? <ListState kind="loading" /> : error ? (
          <ListState kind="error" title="プール一覧を表示できませんでした" description={error} onRetry={() => { void load() }} />
        ) : isEmpty ? (
          <ListState
            kind="empty"
            title="まだプールがありません"
            description="プールは、来たお客さまを振り分ける LINE アカウントをまとめる入れ物です。"
            action={canManage ? createButton : undefined}
          />
        ) : (
          <>
            <div className={styles.cards}>
              {ordered.map((pool) => (
                <PoolCard key={pool.id} pool={pool} accounts={accounts} canManage={canManage} onChange={() => void load()} />
              ))}
            </div>
            {/* 決まり2: 外した時の説明は帯にせず、題の横の「？」（explanation）へ入れる。 */}
          </>
        )}
      </SettingsPage>
    </div>
  )
}

function PoolCard({ pool, accounts, canManage, onChange }: {
  pool: TrafficPool
  accounts: AccountWithStats[]
  canManage: boolean
  onChange: () => void
}) {
  const saveErrors = useSaveFormErrors()
  const isMain = pool.slug === 'main'
  const apiBase = process.env.NEXT_PUBLIC_API_URL ?? ''
  const publicUrl = `${apiBase}/pool/${pool.slug}`
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState(pool.name)
  const [savedName, setSavedName] = useState(pool.name)
  const [editVersion, setEditVersion] = useState(pool.updatedAt)
  const [editBusy, setEditBusy] = useState(false)
  const [editError, setEditError] = useState('')
  const [nameError, setNameError] = useState('')
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleteContext, setDeleteContext] = useState<{ ticket: object; poolId: string; updatedAt: string; revision: number | undefined; accounts: string[] | null } | null>(null)
  const [accountsLoading, setAccountsLoading] = useState(false)
  const deleteTicket = useRef<object | null>(null)
  const deleteLock = useRef(false)
  const alive = useRef(false)
  const canManageRef = useRef(canManage); canManageRef.current = canManage
  const poolRef = useRef(pool); poolRef.current = pool
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')

  const fetchLatest = async () => {
    const response = await api.pools.get(pool.id)
    if (!response.success) throw new Error('latest_failed')
    return response.data
  }
  const conflict = useSaveConflict<TrafficPool>({ contextKey: pool.id, fetchLatest, reload: async () => {
    try {
      const latest = await fetchLatest()
      setEditName(latest.name); setSavedName(latest.name); setEditVersion(latest.updatedAt); setEditError(''); conflict.clear()
    } catch { setEditError('最新のプールを読み込めませんでした。入力は残っています。もう一度お試しください。') }
  } })

  const closeEdit = () => {
    if (editBusy) return
    setEditing(false)
  }
  const saveEdit = async () => {
    if (!canManage || editBusy || conflict.conflict || editName.trim() === savedName.trim()) return
    if (!editName.trim()) { setNameError('名前を入力してください'); return }
    setEditBusy(true); setEditError('')
    try {
      const response = await api.pools.update(pool.id, { name: editName.trim(), expectedUpdatedAt: editVersion })
      if (!response.success) throw new Error(response.error)
      setEditing(false); notifyToast('プールを保存しました'); onChange()
    } catch (cause) {
      if ((cause as { status?: number })?.status === 409) {
        conflict.mark((cause as ApiError).data && typeof (cause as ApiError).data === 'object' ? ((cause as ApiError).data as { updatedAt?: string }).updatedAt : undefined)
      } else if (!saveErrors.capture(cause)) setEditError('保存できませんでした。入力は残っています。もう一度お試しください。')
    }
    finally { setEditBusy(false) }
  }


  const openDelete = async () => {
    if (isMain || !alive.current || !canManageRef.current || poolRef.current.id !== pool.id) return
    const ticket = {}; deleteTicket.current = ticket
    const current = () => alive.current && canManageRef.current && poolRef.current.id === pool.id && poolRef.current.updatedAt === pool.updatedAt && deleteTicket.current === ticket
    setDeleteError(''); setConfirmOpen(true); setAccountsLoading(true)
    setDeleteContext({ ticket, poolId: pool.id, updatedAt: pool.updatedAt, revision: pool.confirmationRevision, accounts: null })
    try {
      const result = await api.pools.accounts.list(pool.id)
      if (!current()) return
      if (!result.success || result.data.some(member => typeof member.lineAccountId !== 'string' || !member.lineAccountId.trim())) throw new Error('accounts_unavailable')
      setDeleteContext({ ticket, poolId: pool.id, updatedAt: pool.updatedAt, revision: pool.confirmationRevision, accounts: [...new Set(result.data.map(member => member.lineAccountId))].sort() })
    } catch {
      if (current()) setDeleteError('所属アカウントを確認できませんでした。閉じてから、もう一度お試しください。')
    } finally {
      if (alive.current && deleteTicket.current === ticket) setAccountsLoading(false)
    }
  }

  const deleteStale = !!deleteContext && (deleteContext.poolId !== pool.id || deleteContext.updatedAt !== pool.updatedAt)

  const onDelete = async () => {
    // 押している間は受け付けない（二度押しの2回目は404になり、消えているのに失敗と出る）。
    if (isMain || deleting || deleteLock.current || !deleteContext || !deleteContext.accounts || !alive.current || !canManageRef.current || deleteContext.ticket !== deleteTicket.current || deleteContext.poolId !== poolRef.current.id || deleteContext.updatedAt !== poolRef.current.updatedAt) return
    const current = () => alive.current && canManageRef.current && deleteContext.ticket === deleteTicket.current && deleteContext.poolId === poolRef.current.id && deleteContext.updatedAt === poolRef.current.updatedAt
    deleteLock.current = true; setDeleting(true)
    setDeleteError('')
    try {
      const members = await api.pools.accounts.list(deleteContext.poolId).catch(() => null)
      if (!current()) return
      if (!members?.success || members.data.some(member => typeof member.lineAccountId !== 'string' || !member.lineAccountId.trim())) {
        setDeleteError('所属アカウントを確認できませんでした。閉じてから、もう一度お試しください。')
        setDeleteContext({ ...deleteContext, accounts: null })
        return
      }
      const currentAccounts = [...new Set(members.data.map(member => member.lineAccountId))].sort()
      if (JSON.stringify(currentAccounts) !== JSON.stringify(deleteContext.accounts)) {
        setDeleteError('所属アカウントが変わりました。閉じて確認し直してください。')
        setDeleteContext({ ...deleteContext, accounts: null })
        return
      }
      if (!deleteContext.revision) throw new Error('missing_confirmation_revision')
      const res = await api.pools.delete(pool.id, { revision: deleteContext.revision, accountIds: deleteContext.accounts })
      if (!current()) return
      if (!res.success) throw new Error(res.error)
      deleteTicket.current = null
      setConfirmOpen(false)
      onChange()
    } catch {
      if (current()) setDeleteError('このプールを削除できませんでした。状態を読み直してから、もう一度お試しください。')
    } finally {
      deleteLock.current = false
      if (alive.current && deleteContext.poolId === poolRef.current.id) setDeleting(false)
    }
  }

  return (
    <Card layout="vertical" padding="compact" gap="var(--polish-space-field)" aria-label={pool.name}>
      <CardHeader size="stacked" title={pool.name} meta={`URLの名前：${pool.slug}${isMain ? '・既定' : ''}`} action={
        canManage ? (
          <div className={styles.menuBox}>
            <RowMenu
              label={`${pool.name}の操作`}
              menuLabel="操作"
              open={menuOpen}
              onOpenChange={setMenuOpen}
              items={[{ id: 'edit', label: '編集する', onSelect: () => { setMenuOpen(false); setEditName(pool.name); setSavedName(pool.name); setEditVersion(pool.updatedAt); conflict.clear(); setEditError(''); setNameError(''); setEditing(true) } }, ...(!isMain ? [{ id: 'delete', label: '削除する', tone: 'danger', onSelect: () => { setMenuOpen(false); void openDelete() } } as const] : [])]}
            />
          </div>
        ) : null} />
      <Card layout="horizontal" surface="muted" padding="compact" gap="var(--polish-space-row)">
        <span className={styles.url} ><TruncatedText value={String(publicUrl ?? '')} url /></span>
        <CopyTextButton value={publicUrl} aria-label="公開URLをコピー" variant="secondary" label="公開 URL コピー" icon={<Copy size={16} aria-hidden="true" />} />
      </Card>
      {copyError ? <Notice tone="danger" >{copyError}</Notice> : null}
      <PoolMembers poolId={pool.id} poolName={pool.name} accounts={accounts} canManage={canManage} onChange={onChange} />

      <SaveErrorScope errors={saveErrors}><FormLeaveGuard dirty={editing && editName.trim() !== savedName.trim()} busy={editBusy} /><Dialog open={editing} title="プールを編集" designWidth={560} dirty={editName.trim() !== savedName.trim()} busy={editBusy} error={editError} onCancel={closeEdit} onConfirm={conflict.conflict || editName.trim() === savedName.trim() ? undefined : () => void saveEdit()} confirmLabel="保存する">
        {conflict.conflict && <SaveConflictBand title={saveConflictTitle(conflict.conflict.updatedAt, 'プール', pool.name)} description="ほかの人が先に保存しました。入力は残っています。" compareBusy={conflict.compareBusy} onCompare={() => void conflict.compare()} onReload={() => void conflict.reloadLatest()} />}
        <Field label="プール名" htmlFor={`pool-name-${pool.id}`} required error={nameError}>
          <SaveErrorField names={["name"]}><TextField id={`pool-name-${pool.id}`} value={editName} maxLength={100} onChange={(event) => { setEditName(event.target.value); setNameError('') }} /></SaveErrorField>
        </Field>
      </Dialog></SaveErrorScope>
      <SaveConflictCompareDialog open={conflict.compareOpen} busy={conflict.compareBusy} error={conflict.compareError} lines={conflict.latest ? (conflict.latest.name === editName ? [] : [{ text: `プール名：あなたの下書き「${editName}」／最新「${conflict.latest.name}」`, kind: 'change' }]) : null} onReload={() => void conflict.reloadLatest()} onCancel={conflict.closeCompare} />
      <ConfirmDialog
        open={confirmOpen}
        title={`プール「${pool.name}」を削除しますか？`}
        description={`公開URL ${publicUrl} は使えなくなり、これから来たお客様はどのアカウントにも振り分けられません。所属していたLINEアカウントと、これまでの流入の記録は残ります。この操作は取り消せません。`}
        confirmLabel="削除する"
        destructive
        busy={deleting}
        confirmDisabled={accountsLoading || !deleteContext?.accounts || deleteStale}
        confirmDisabledReason={deleteStale ? 'プールが更新されました。閉じて確認し直してください。' : '所属アカウントを確認してから操作してください。'}
        confirmLockedReason={canManage ? undefined : 'プールを変更する権限がありません。'}
        error={deleteError}
        onConfirm={() => onDelete()}
        onCancel={() => {
          if (deleting || !deleteContext || deleteContext.ticket !== deleteTicket.current) return
          deleteTicket.current = null
          setConfirmOpen(false)
          setDeleteError('')
        }}
      >
        {deleteContext?.accounts ? <OperationTargetSummary accounts={deleteContext.accounts.map(id => ({ id, name: accounts.find(account => account.id === id)?.name }))} showAccountCount /> : <p>{accountsLoading ? '所属アカウントを確認しています。' : '所属アカウントを確認できません。'}</p>}
      </ConfirmDialog>
    </Card>
  )
}

function PoolMembers({ poolId, poolName, accounts, canManage, onChange }: {
  poolId: string
  poolName: string
  accounts: AccountWithStats[]
  canManage: boolean
  onChange: () => void
}) {
  const [members, setMembers] = useState<PoolAccount[]>([])
  const poolScope = useRef({ id: poolId, generation: 0 })
  if (poolScope.current.id !== poolId) poolScope.current = { id: poolId, generation: poolScope.current.generation + 1 }
  const renderedScope = poolScope.current
  const [removeTarget, setRemoveTarget] = useState<{ id: string; lineAccountId: string; name: string; accountName: string | null; poolName: string; scope: typeof renderedScope; ticket: object } | null>(null)
  const ticketRef = useRef<object | null>(null)
  const lock = useRef(false)
  const alive = useRef(false)
  const manageRef = useRef(canManage); manageRef.current = canManage
  const membersRef = useRef(members); membersRef.current = members
  const loadedScope = useRef<typeof renderedScope | null>(null)
  const request = useRef(0)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState('')
  const [listError, setListError] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const addRef = useRef<HTMLButtonElement>(null)

  // 読み直しの失敗は握りつぶさない（空のままだと「所属なし」と読み違える）。
  const reload = useCallback(async () => {
    if (!alive.current || renderedScope !== poolScope.current) return
    loadedScope.current = null
    const sequence = ++request.current
    const current = () => alive.current && renderedScope === poolScope.current && request.current === sequence
    try {
      const res = await api.pools.accounts.list(poolId)
      if (!current()) return
      if (res.success) {
        loadedScope.current = renderedScope
        setMembers(res.data)
        setListError('')
      } else {
        setListError('所属アカウントを読み込めませんでした。もう一度お試しください。')
      }
    } catch {
      if (current()) setListError('所属アカウントを読み込めませんでした。もう一度お試しください。')
    }
  }, [poolId, renderedScope])

  useEffect(() => {
    void reload()
  }, [reload])

  const memberIds = new Set(members.map((m) => m.lineAccountId))
  const candidates = accounts.filter((a) => !memberIds.has(a.id))

  const onAdd = async (lineAccountId: string) => {
    try {
      const res = await api.pools.accounts.add(poolId, lineAccountId)
      if (!res.success) throw new Error(res.error)
      await reload()
      onChange()
    } catch {
      setListError('このアカウントをプールに追加できませんでした。もう一度お試しください。')
    }
  }

  // 外す確認。あとから入れ直せるので destructive は付けない。
  const onRemove = async () => {
    if (!removeTarget || removing || lock.current || !alive.current || !manageRef.current || removeTarget.scope !== poolScope.current || loadedScope.current !== removeTarget.scope || removeTarget.ticket !== ticketRef.current || !membersRef.current.some(member => member.id === removeTarget.id && member.lineAccountId === removeTarget.lineAccountId)) return
    const current = () => alive.current && manageRef.current && removeTarget.scope === poolScope.current && removeTarget.ticket === ticketRef.current
    lock.current = true; setRemoving(true)
    setRemoveError('')
    try {
      const res = await api.pools.accounts.remove(poolId, removeTarget.id)
      if (!current()) return
      if (!res.success) throw new Error(res.error)
      ticketRef.current = null
      setRemoveTarget(null)
      await reload()
      if (alive.current && manageRef.current && removeTarget.scope === poolScope.current) onChange()
    } catch {
      if (current()) setRemoveError('このアカウントをプールから外せませんでした。状態を読み直してから、もう一度お試しください。')
    } finally {
      lock.current = false
      if (alive.current && removeTarget.scope === poolScope.current) setRemoving(false)
    }
  }

  return (
    <>
      <p className={styles.membersLabel}>所属アカウント（来たお客さまをランダムに振り分けます）</p>
      <ul className={styles.members}>
        {members.map((m) => {
          const acc = accounts.find((a) => a.id === m.lineAccountId)
          const name = acc?.name ?? m.lineAccountId
          const friends = acc?.stats?.friendCount == null ? '—' : polishFormatNumber(acc.stats.friendCount)
          return (
            <li key={m.id}><Card frame="inset" layout="horizontal" surface="inset" corner="control" padding="compact" gap="var(--polish-space-row)">
              <span className={styles.memberName} ><TruncatedText value={String(name ?? '')} /></span>
              <span className={styles.memberFriends}>{`友だち ${friends}`}</span>
              {canManage ? (
                <Button variant="secondary" onClick={() => { if (!alive.current || !manageRef.current || renderedScope !== poolScope.current || loadedScope.current !== renderedScope) return; const ticket = {}; ticketRef.current = ticket; setRemoveError(''); setRemoveTarget({ id: m.id, lineAccountId: m.lineAccountId, name, accountName: acc?.name ?? null, poolName, scope: renderedScope, ticket }) }}>外す</Button>
              ) : null}
            </Card></li>
          )
        })}
        {members.length === 0 && !listError ? <li className={styles.empty}>所属アカウントなし</li> : null}
      </ul>
      {listError ? (
        <Notice tone="danger" >{listError}{' '}<Button type="button" variant="text" onClick={() => void reload()}>もう一度読み込む</Button></Notice>
      ) : null}
      {canManage && candidates.length > 0 ? (
        <div className={styles.menuBox}>
          <Button
            ref={addRef}
            type="button"
            variant="text"
            size="inline"
            textTone="accent"
            aria-haspopup="menu"
            aria-expanded={addOpen}
            onClick={() => setAddOpen(!addOpen)}
          >
            <Plus size={16} aria-hidden="true" />アカウントを追加
          </Button>
          <ActionMenu
            open={addOpen}
            anchorRef={addRef}
            ariaLabel="追加するアカウント"
            onClose={() => setAddOpen(false)}
            items={candidates.map((a) => ({ id: a.id, label: a.name, onSelect: () => { setAddOpen(false); void onAdd(a.id) } }))}
          />
        </div>
      ) : null}

      <ConfirmDialog
        open={removeTarget !== null && removeTarget.scope === poolScope.current}
        title={`「${removeTarget?.name ?? ''}」をこのプールから外しますか？`}
        description="これから来たお客様は、このアカウントへ振り分けられなくなります。アカウント自体と、これまでの流入の記録は残ります。外したあとで、同じアカウントを入れ直せます。"
        confirmLabel="外す"
        busy={removing}
        confirmLockedReason={canManage ? undefined : 'プールを変更する権限がありません。'}
        error={removeError}
        onConfirm={() => onRemove()}
        onCancel={() => {
          if (removing || !removeTarget || removeTarget.ticket !== ticketRef.current) return
          ticketRef.current = null
          setRemoveTarget(null)
          setRemoveError('')
        }}
      >
        {removeTarget ? <OperationTargetSummary accounts={[{ id: removeTarget.lineAccountId, name: removeTarget.accountName }]} externalTarget={{ label: 'プール', name: removeTarget.poolName }} /> : null}
      </ConfirmDialog>
    </>
  )
}
