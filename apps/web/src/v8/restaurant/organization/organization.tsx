'use client'


import Button from '@/components/shared/button'
import PermissionGatedButton from '@/components/shared/permission-gated-button'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import Disclosure from '@/components/shared/disclosure'
import { emptyValue } from '@/components/shared/empty-value'
import { GridCell,GridHeadRow,GridRow,GridTable } from '@/components/shared/grid-table'
import KpiCard from '@/components/shared/kpi-card'
import ListState from '@/components/shared/list-state'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { RowActions } from '@/components/shared/row-actions'
import { SaveErrorScope,useSaveFormErrors } from '@/components/shared/save-form-errors'
import TruncatedText from '@/components/shared/truncated-text'
import { isStepUpRequired,useStepUpGate } from '@/components/step-up-prompt'
import { useAccount } from '@/contexts/account-context'
import { restaurantTestApi,type RestaurantStore } from '@/lib/restaurant-test-api'
import { canManageRole,useStaffRole } from '@/lib/staff-role'
import type { RestaurantLoginMember } from '@line-crm/shared'
import { Check,Plus } from 'lucide-react'
import { useCallback,useContext,useEffect,useState } from 'react'
import { RestaurantFrame, type RestaurantContext } from '@/v8/restaurant/common-a/public/frame/index'
import { Panel, StatRow, Status } from '@/v8/restaurant/common-a/public/parts/index'
import styles from './organization.module.css'
import StoreGroups from './store-groups'

import { IntakeAddressPanel,LoginConnection,loginSummary,MATRIX,MemberForm,roleLabel,StoreForm,tableDesign } from './organization-forms'
import { formatNumber } from '@/lib/format'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'

function OrganizationBoard({ ctx }: { ctx: RestaurantContext }) {
  const saveErrors = useSaveFormErrors()
  const depth = useContext(OverlayDepthContext)

  const { data, store, selectedStoreId, busy, mutate } = ctx
  const { accounts, selectedAccountId } = useAccount()
  const role = useStaffRole()
  const readOnly = !canManageRole(role)
  const members = selectedStoreId ? data.memberships.filter((m) => !m.store_id || m.store_id === selectedStoreId) : data.memberships
  const [showStoreForm, setShowStoreForm] = useState(false)
  const [editingStoreId, setEditingStoreId] = useState('')
  const [showMemberForm, setShowMemberForm] = useState(false)
  const [editingMemberId, setEditingMemberId] = useState('')
  const [storeDirty, setStoreDirty] = useState(false)
  const [memberDirty, setMemberDirty] = useState(false)
  const [loginDirty, setLoginDirty] = useState(false)
  const [stopId, setStopId] = useState('')
  const editingMember = members.find((m) => m.id === editingMemberId)
  const editingStore = data.stores.find((s) => s.id === editingStoreId)
  const stopping = members.find((m) => m.id === stopId)
  const closeStoreDialog = useCallback(() => { setShowStoreForm(false); setEditingStoreId(''); setStoreDirty(false) }, [])
  const closeMemberDialog = useCallback(() => { setShowMemberForm(false); setEditingMemberId(''); setMemberDirty(false); setLoginDirty(false) }, [])
  const editorOpen = showStoreForm || Boolean(editingStore) || showMemberForm || Boolean(editingMember)
  const dirty = editorOpen && (storeDirty || memberDirty || loginDirty)
  const guard = useUnsavedGuard({ dirty: dirty || (editorOpen && busy), busy: editorOpen && busy, onDiscard: () => {
    setStoreDirty(false); setMemberDirty(false); setLoginDirty(false)
    closeStoreDialog(); closeMemberDialog()
  } })
  const closeEditor = (close: () => void) => guard.guarded(() => { if (!dirty) close() })
  const accountId = selectedAccountId || ''
  const { gate, prompt, cancel } = useStepUpGate()
  const [loginsError,setLoginsError]=useState(false)
  const [loginsRetry,setLoginsRetry]=useState(0)
  const [logins, setLogins] = useState<RestaurantLoginMember[]>([])
  useEffect(() => {
    let current = true
    setLogins([])
    if (accountId) void restaurantTestApi.loginMembers(accountId).then((res) => { if (current) {setLogins(res.data);setLoginsError(false)} }).catch(() => { if (current) setLoginsError(true) })
    return () => { current = false; cancel() }
  }, [accountId, cancel,loginsRetry])

  /* 役割・停止の変更は本人確認（step-up）を挟むことがある（今の画面と同じ）。 */
  const updateMember = async (id: string, body: Record<string, unknown>) => {
    const member = members.find((m) => m.id === id)
    const request = { ...body, expectedPolicyVersion: member?.loginPolicyVersion, idempotencyKey: crypto.randomUUID() }
    try { return await restaurantTestApi.updateMembership(accountId, id, request) }
    catch (error) {
      saveErrors.capture(error);

      if (!isStepUpRequired(error)) throw error
      const token = await gate('staff.permissions.change', '店の役割とログイン権限を変更する');

      if (!token) throw new Error('本人確認を中止しました。変更は保存されていません。')
      return restaurantTestApi.updateMembership(accountId, id, request, token)
    }
  }

  const submitStore = (id: string | null) => (form: FormData) => {
    const body = {
      name: String(form.get('name') || ''),
      code: String(form.get('code') || ''),
      area: String(form.get('area') || ''),
      capacity: Number(form.get('capacity')),
      lineAccountId: String(form.get('lineAccountId') || ''),
    }
    if (id) {
      void mutate(
        () => restaurantTestApi.updateStore(accountId, id, { ...body, status: String(form.get('status')) as RestaurantStore['status'] }),
        '店舗情報を更新しました。',
      ).then((ok) => { if (ok) closeStoreDialog() })
    } else {
      void mutate(
        () => restaurantTestApi.createStore(accountId, { ...body, timezone: String(form.get('timezone') || 'Asia/Tokyo') }),
        '店舗を追加しました。',
      ).then((ok) => { if (ok) closeStoreDialog() })
    }
  }

  const submitMember = (id: string | null) => (form: FormData) => {
    const body = {
      storeId: form.get('storeId') || null,
      staffName: form.get('staffName'),
      email: form.get('email'),
      role: form.get('role'),
      lineUid: form.get('lineUid'),
      googleEmail: form.get('googleEmail'),
    }
    if (id) {
      void mutate(() => updateMember(id, body), members.find((m) => m.id === id)?.staff_id ? '所属ユーザーとログイン権限を更新しました。' : '所属ユーザーを更新しました。')
        .then((ok) => { if (ok) closeMemberDialog() })
    } else {
      void mutate(() => restaurantTestApi.createMembership(accountId, body), '飲食店向けの名簿へ追加しました。この登録だけではログイン権限は変わりません。')
        .then((ok) => { if (ok) closeMemberDialog() })
    }
  }

  const organizationTree = (
    <div className={styles.treeBody}>
      <p className={styles.treeTenant}>{`統括：${data.organization?.tenant_name || emptyValue('unconfigured')}`}</p>
      <p className={styles.treeRoot}>{data.organization?.name}</p>
      <div className={styles.treeChildren}>
        {data.stores.map((s) => (
          <div key={s.id} className={styles.treeStore}>
            <span className={styles.treeStoreName}>{s.name}</span>
            <span className={styles.spacer} aria-hidden="true" />
            <Status value={s.status} />
          </div>
        ))}
      </div>
    </div>
  )

  return (
    <SaveErrorScope errors={saveErrors}><>
      {loginsError?<ListState kind="error" title="ログインメンバーを読み込めませんでした" onRetry={()=>setLoginsRetry(n=>n+1)}/>:null}
      {readOnly ? (
        <ReadOnlyNotice role="note" />
      ) : null}
      <div className={styles.layout}>
        {prompt}
        <div className={styles.tree}>
          <div className={styles.treeExpanded}>
            <Panel title="組織階層" flush>{organizationTree}</Panel>
          </div>
          <Disclosure className={styles.treeCollapsed} title="組織階層" hint={`${formatNumber(data.stores.length)} 店舗`}>
            {organizationTree}
          </Disclosure>
        </div>
        <div className={styles.main}>
          <Panel
            title="店舗管理"
            description="1店舗につき1つのLINE公式アカウントを割り当てます。"
            aside={<PermissionGatedButton allowed={!readOnly} onClick={() => { setShowStoreForm(true); setEditingStoreId('') }}><Plus aria-hidden className={styles.buttonIcon} />店舗を作る</PermissionGatedButton>}
            flush
          >
            {/* 3行の中身に合わせて伸びる行にし（区切り線は同じ1px）、次の店に重ねない。上下に4pxの空きを付ける。 */}
            <GridTable label="店舗管理" framed={false} presentation="dashboard" design={{ ...tableDesign, rowPadding: 'var(--space-4) var(--tpl-list-inset)', columns: 'minmax(0, 1fr) max-content max-content' }}>
              {data.stores.map((s) => (
                <GridRow key={s.id}>
                  <GridCell className={styles.storeText}>
                    <TruncatedText value={s.name} className={styles.memberName} />
                    <TruncatedText value={`${s.code} · ${s.area || 'エリア未設定'} · ${s.capacity}席`} className={styles.sub} />
                    <TruncatedText value={`LINE: ${s.line_account_name ? `${s.line_account_name} 公式` : emptyValue('unconfigured')}`} className={styles.sub} />
                  </GridCell>
                  <GridCell><Status value={s.status} /></GridCell>
                  <GridCell align="right">
                    {readOnly ? null : <RowActions subjectName={s.name} edit={{ onClick: () => { setEditingStoreId(s.id); setShowStoreForm(false) } }} />}
                  </GridCell>
                </GridRow>
              ))}
            </GridTable>
          </Panel>
          <Dialog
            open={showStoreForm || editingStore !== undefined}
            dirty={false}
            busy={busy}
            designNode="vCEKM"
            designWidth={560}
            designTop={160}
            designHeaderPadding="24px 24px 0"
            designHeaderHeight={50}
            title={editingStore ? `${editingStore.name}を編集` : '店舗を作る'}
            onCancel={() => closeEditor(closeStoreDialog)}
          >
            <StoreForm
              store={editingStore}
              accounts={accounts}
              stores={data.stores}
              busy={busy}
              onDirtyChange={setStoreDirty}
              onSubmit={submitStore(editingStore ? editingStore.id : null)}
              onCancel={() => closeEditor(closeStoreDialog)}
            />
          </Dialog>
          <StoreGroups key={accountId} accountId={accountId} stores={data.stores} readOnly={readOnly} />
          <IntakeAddressPanel accountId={accountId} store={store} readOnly={readOnly} />
          <StatRow>
            <KpiCard title="所属ユーザー" valueText={`${formatNumber(members.length)}名`} detail="名簿に載っている人数" icon={null} presentation="band" value={null} unit="" />
            <KpiCard title="店舗管理者" valueText={`${formatNumber(members.filter((m) => m.role === 'store_manager').length)}名`} detail="名簿上の役割（操作権限は別）" icon={null} presentation="band" value={null} unit="" />
            <KpiCard title="連携アカウント" valueText={`${formatNumber(members.filter((m) => m.line_uid || m.google_email).length)}件`} detail="LINE UID / Google" icon={null} presentation="band" value={null} unit="" />
          </StatRow>
          <Panel
            title="アカウント一覧"
            description="この一覧は名簿です。ここでの役割・担当店舗の登録だけではログイン権限は変わりません。"
            aside={<PermissionGatedButton allowed={!readOnly} variant="primary" onClick={() => { setShowMemberForm(true); setEditingMemberId('') }}><Plus aria-hidden className={styles.buttonIcon} />ユーザーを追加する</PermissionGatedButton>}
            flush
          >
            <GridTable label="アカウント一覧" framed={false} design={{ ...tableDesign, columns: 'minmax(0, 2fr) var(--tpl-rt-col-100) minmax(0, 1fr) minmax(0, 1.5fr) var(--tpl-rt-col-80) var(--tpl-rt-col-130)' }}>
              <GridHeadRow>
                <GridCell role="columnheader">氏名</GridCell>
                <GridCell role="columnheader">役割</GridCell>
                <GridCell role="columnheader">担当店舗</GridCell>
                <GridCell role="columnheader">連携（LINE・Google）</GridCell>
                <GridCell role="columnheader">状態</GridCell>
                <GridCell role="columnheader"><span className="sr-only">操作</span></GridCell>
              </GridHeadRow>
              {members.map((m) => (
                <GridRow key={m.id}>
                  <GridCell className={styles.memberText} title={loginSummary(m)}>
                    <TruncatedText className={styles.memberName} value={m.staff_name} />
                    <TruncatedText className={styles.sub} value={m.email || emptyValue('unconfigured')} />
                  </GridCell>
                  <GridCell className={styles.shortText}>{roleLabel[m.role]}</GridCell>
                  <GridCell><TruncatedText value={data.stores.find((s) => s.id === m.store_id)?.name || '全店舗'} /></GridCell>
                  <GridCell className={styles.memberText}>
                    <span className={styles.shortText}>{`LINE ${m.line_uid ? '設定済' : emptyValue('unconfigured')}`}</span>
                    <TruncatedText className={styles.sub} value={m.google_email || 'Google 未設定'} />
                  </GridCell>
                  <GridCell><Status value={m.status} /></GridCell>
                  <GridCell align="right" data-list-action-cell="">
                    {readOnly ? null : (
                      <RowActions
                        subjectName={m.staff_name}
                        detail={{ label: '変更', disabled: busy, onClick: () => { setEditingMemberId(m.id); setShowMemberForm(false) } }}
                        menuButtonProps={{ disabled: busy }}
                        menuItems={[m.status === 'suspended' ? {
                          id: 'resume', label: '再開', disabled: busy,
                          disabledReason: busy ? 'ほかの操作を反映しています' : undefined,
                          onSelect: () => void mutate(() => updateMember(m.id, { status: 'active' }), '再開しました。'),
                        } : {
                          id: 'stop', label: '停止', tone: 'danger', disabled: busy,
                          disabledReason: busy ? 'ほかの操作を反映しています' : undefined,
                          onSelect: () => setStopId(m.id),
                        }]}
                      />
                    )}
                  </GridCell>
                </GridRow>
              ))}
            </GridTable>
          </Panel>
          <Dialog
            open={showMemberForm || editingMember !== undefined}
            dirty={false}
            busy={busy}
            designNode="ou60i"
            designWidth={560}
            designTop={140}
            designHeaderPadding="24px 24px 0"
            designHeaderHeight={50}
            title={editingMember ? `${editingMember.staff_name}を変更` : '飲食店向けユーザーを追加'}
            onCancel={() => closeEditor(closeMemberDialog)}
          >
            <MemberForm
              member={editingMember}
              stores={data.stores}
              busy={busy}
              onDirtyChange={setMemberDirty}
              onSubmit={submitMember(editingMember ? editingMember.id : null)}
              onCancel={() => closeEditor(closeMemberDialog)}
              login={editingMember ? (
                <LoginConnection
                  member={editingMember}
                  logins={logins}
                  busy={busy}
                  onDirtyChange={setLoginDirty}
                  save={(staffId) => void mutate(() => restaurantTestApi.linkMembershipLogin(accountId, editingMember.id, staffId), 'ログインメンバーとの連携を保存しました。')}
                />
              ) : null}
            />
          </Dialog>
          <OverlayDepthContext.Provider value={depth + 2}><UnsavedLeaveDialog open={guard.leaveTarget !== null} busy={busy} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} /></OverlayDepthContext.Provider>
          <Dialog
            open={Boolean(stopping)}
            designNode="bMpC5"
            designWidth={480}
            designTop={300}
            title="この所属ユーザーを停止しますか？"
            designHeaderPadding="24px 24px 0"
            designHeaderHeight={50}
            busy={busy}
            onCancel={() => setStopId('')}
            footer={<DialogActions>
              <Button onClick={() => setStopId('')} disabled={busy}>キャンセル</Button>
              <Button widthReserve="idle" variant="danger" busy={busy} busyLabel="処理中…" disabled={busy} onClick={() => { if (stopping) void mutate(() => updateMember(stopping.id, { status: 'suspended' }), '停止しました。').then(() => setStopId('')) }}>停止する</Button>
            </DialogActions>}
          >
            {/* 絵（bMpC5）：だれを止めるか（役割・担当店舗）と、名簿の停止はログインを変えないこと（受け口も名簿だけを変える）。 */}
            {stopping ? (
              <div className={styles.stopBody}>
                <p className={styles.stopWho}>{`${stopping.staff_name}（${roleLabel[stopping.role]}・${data.stores.find((s) => s.id === stopping.store_id)?.name || '全店舗'}）`}</p>
                <p className={styles.stopNote}>名簿には残り、再開できます。ログインの権限は変わりません。</p>
              </div>
            ) : null}
          </Dialog>
          <Panel title="権限マトリクス" description="想定の役割分担です。実際の操作可否は、ログイン中のスタッフの役割（オーナー・管理者・スタッフ）で決まります。" flush>
            <GridTable label="権限マトリクス" framed={false} design={{ ...tableDesign, columns: 'minmax(0, 1fr) repeat(3, var(--tpl-rt-col-110))' }}>
              <GridHeadRow>
                <GridCell role="columnheader">操作</GridCell>
                {[roleLabel.super_admin, roleLabel.store_manager, roleLabel.staff].map((label) => <GridCell key={label} role="columnheader">{label}</GridCell>)}
              </GridHeadRow>
              {MATRIX.map(([label, ...values]) => (
                <GridRow key={label}>
                  <GridCell className={styles.shortText}>{label}</GridCell>
                  {values.map((v, i) => (
                    <GridCell key={i}>
                      {v ? <Check aria-label="できる" className={styles.buttonIcon} /> : <span aria-label="できない">{emptyValue('unknown')}</span>}
                    </GridCell>
                  ))}
                </GridRow>
              ))}
            </GridTable>
          </Panel>
        </div>
      </div>
    </></SaveErrorScope>
  )
}

export default function OrganizationV8() {
  return (
    <RestaurantFrame
      boardId="bSp4h"
      title="組織・権限"
      description="本部・店舗・スタッフの閲覧範囲と承認権限を管理します。"
    >
      {(ctx) => <OrganizationBoard ctx={ctx} />}
    </RestaurantFrame>
  )
}
