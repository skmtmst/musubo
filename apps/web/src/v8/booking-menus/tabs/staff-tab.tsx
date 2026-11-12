'use client'

import SharedStatusPill from '@/components/shared/status-pill'
import { useListUrlValue } from '@/components/shared/list-url-state'
import { useEffect, useRef, useState } from 'react'
import { RowNameLink, DataTable, TableHeadRow, Tr, Th, Td } from '@/components/shared/table'
import HelpTip from '@/components/shared/help-tip'
import { ListChecks, Plus } from 'lucide-react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { type ActionMenuItem } from '@/components/shared/action-menu'
import Button from '@/components/shared/button'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Pagination from '@/components/shared/pagination'
import { RowMenu } from '@/components/shared/row-actions'
import ListRange from '@/components/ui/list-range'
import { ApiError, bookingApi, type BookingStaff, type StaffMenuMatrix } from '@/lib/api'
import type { StaffMember } from '@line-crm/shared'
import { EMPTY_STAFF, StaffEditModal } from '../staff-edit-dialog'
import { AssignmentConflict, AssignmentRowDialog, AssignmentSection, PRIORITY, useAssignment } from '@/v8/booking-payments/public/assignment/index'
import StatusBadge from '@/components/shared/status-badge'
import { usePreparingDialog } from '@/components/shared/preparing-dialog'
import { useDetailPanelUrl } from '@/components/shared/detail-panel'
import { StaffCalendarPanel } from '../staff-calendar'
import assignStyles from '../../booking-payments/assignment.module.css'
import {
  AccountIcon,
  StateCard,
  SkeletonRows,
  useV8TabEdit,
  type LoadStatus,
} from './shared'
import styles from '../settings.module.css'
import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import { emptyValue } from '@/components/shared/empty-value'
import { SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { formatNumber } from '@/lib/format'

/* ⑤ 担当スタッフ（settings-v8.tsx から分割。見た目・動きは変えない） */

const STAFF_PAGE_SIZE = 4

const MEMBER_ROLE_LABEL: Record<string, string> = {
  owner: 'オーナー',
  admin: '管理者',
  staff: 'スタッフ',
}

export function StaffTabV8({ accountId, staff, status, error, matrices, extras, members, canEdit, onReload }: {
  accountId: string
  staff: BookingStaff[]
  status: LoadStatus
  error: string | null
  matrices: Record<string, StaffMenuMatrix[]>
  extras: Record<string, { work: string | null; calendar: 'loading' | 'connected' | 'none' | 'error' }>
  members: StaffMember[]
  canEdit: boolean
  onReload: () => void
}) {
  const saveErrors = useSaveFormErrors()
  const router = useRouter()
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Partial<BookingStaff> | null>(null)
  const [removeTarget, setRemoveTarget] = useState<BookingStaff | null>(null)
  const [removeScope, setRemoveScope] = useState<{ accountId: string; generation: number } | null>(null)
  const [pauseScope, setPauseScope] = useState<{ accountId: string; generation: number } | null>(null)
  const scope = useRef({ accountId, generation: 0, awaitingLoad: false })
  if (scope.current.accountId !== accountId) scope.current = { accountId, generation: scope.current.generation + 1, awaitingLoad: true }
  if (scope.current.awaitingLoad && status === 'loading') scope.current.awaitingLoad = false
  const renderedScope = scope.current
  const statusRef = useRef(status); statusRef.current = status
  const canEditRef = useRef(canEdit); canEditRef.current = canEdit
  const alive = useRef(false)
  const operationLock = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const [removeError, setRemoveError] = useState('')
  const [removing, setRemoving] = useState(false)
  const [pauseTarget, setPauseTarget] = useState<BookingStaff | null>(null)
  const [pausing, setPausing] = useState(false)
  const [pauseError, setPauseError] = useState<string | null>(null)
  const [page, setPage] = useListUrlValue('page', 1)
  /* 指名なしの予約の割り当て方（・絵 QJMoY）。保存は下の帯。 */
  const assignment = useAssignment({ kind: 'staff', accountId })
  const preparing = usePreparingDialog()
  const [assignTarget, setAssignTarget] = useState<BookingStaff | null>(null)
  /* つなぐ先（カレンダーと会議の URL・B7 uRd8A）は右のパネル。URL の ?staff= で開く。 */
  const [calendarStaffId, setCalendarStaffId] = useDetailPanelUrl('staff')
  const calendarPerson = staff.find((person) => person.id === calendarStaffId) ?? null
  const staffOrder = staff.map((person) => person.id)
  useV8TabEdit({
    dirty: assignment.dirty,
    saving: assignment.saving,
    subject: '割り当て方への変更',
    saveDisabled: !canEdit,
    onSave: () => { if (assignment.status === 'not-ready') preparing.open('割り当て方の保存'); else void assignment.save(staffOrder) },
    onReset: assignment.reset,
  })

  const pageCount = Math.max(1, Math.ceil(staff.length / STAFF_PAGE_SIZE))
  const safePage = Math.min(page, pageCount)
  const visible = staff.slice((safePage - 1) * STAFF_PAGE_SIZE, safePage * STAFF_PAGE_SIZE)

  async function saveStaff(input: Partial<BookingStaff>) {
    if (input.id) {
      await bookingApi.updateStaff(accountId, input.id, input)
    } else {
      await bookingApi.createStaff(accountId, input)
    }
    setEditing(null)
    onReload()
  }

  async function setActive(person: BookingStaff, nextActive: boolean) {
    if (!pauseScope || !alive.current || !canEditRef.current || statusRef.current !== 'ready' || scope.current.awaitingLoad || pauseScope.generation !== scope.current.generation || operationLock.current) return
    operationLock.current = true
    setPausing(true)
    setPauseError(null)
    try {
      await bookingApi.updateStaff(pauseScope.accountId, person.id, { is_active: nextActive ? 1 : 0 })
      if (!alive.current || pauseScope.generation !== scope.current.generation) return
      setPauseTarget(null)
      onReload()
    } catch (cause) {
      if (!alive.current || pauseScope.generation !== scope.current.generation) return
      const fieldFailure = saveErrors.capture(cause)

      { if (!fieldFailure)
      setPauseError(cause instanceof ApiError && cause.status === 403
        ? permissionDeniedMessage('store')
        : '変更できませんでした。もう一度お試しください。') }
    } finally {
      operationLock.current = false
      if (alive.current) setPausing(false)
    }
  }

  async function remove() {
    const target = removeTarget
    if (!target || !removeScope || !alive.current || !canEditRef.current || statusRef.current !== 'ready' || scope.current.awaitingLoad || removeScope.generation !== scope.current.generation || operationLock.current) return
    operationLock.current = true
    setRemoving(true)
    setRemoveError('')
    try {
      await bookingApi.deleteStaff(removeScope.accountId, target.id)
      if (!alive.current || removeScope.generation !== scope.current.generation) return
      setRemoveTarget(null)
      onReload()
    } catch (cause) {
      if (!alive.current || removeScope.generation !== scope.current.generation) return
      const fieldFailure = saveErrors.capture(cause)

      { if (!fieldFailure)
      setRemoveError(cause instanceof ApiError && cause.status === 403
        ? permissionDeniedMessage('store')
        : '消せませんでした。もう一度お試しください。') }
    } finally {
      operationLock.current = false
      if (alive.current) setRemoving(false)
    }
  }

  function memberLabel(person: BookingStaff): string {
    if (!person.staff_member_id) return 'ひも付けなし'
    const member = members.find((entry) => entry.id === person.staff_member_id)
    if (!member) return 'ひも付けあり'
    const role = MEMBER_ROLE_LABEL[member.role] ?? member.role
    return `${member.name}（${role}）`
  }

  if (status === 'loading') return <SaveErrorScope errors={saveErrors}><SkeletonRows rows={4} /></SaveErrorScope>
  if (status === 'error') {
    return (
      <SaveErrorScope errors={saveErrors}><StateCard
        icon={<AccountIcon />}
        title="スタッフを読み込めませんでした"
        description={error ?? '通信状態を確認して、もう一度お試しください。'}
        action={<Button onClick={onReload}>もう一度読み込む</Button>}
      /></SaveErrorScope>
    )
  }

  return (
    <SaveErrorScope errors={saveErrors}><div className={styles.tabStack} data-design="Table">
      <AssignmentSection state={assignment} kind="staff" canEdit={canEdit} />
      <div className={styles.staffHeadRow}>
        <h2 className={styles.staffHeadTitle}>{`担当スタッフ ${formatNumber(staff.length)} 人`} <HelpTip label="担当スタッフの操作の説明">行の「…」から 勤務とシフト{canEdit ? '・編集・止める' : ''}。名前を押すと勤務とシフトが開きます。カレンダーにつないでいないスタッフは、ほかの予約サービスの予約で枠が埋まらないので、つなぐのをおすすめします。</HelpTip></h2>
        <div className={styles.staffHeadActions}>
          <Button href="/booking/menus/staff"><ListChecks size={16} aria-hidden="true" />担当メニューをまとめて決める</Button>
          {canEdit ? <Button variant="primary" onClick={() => setEditing(EMPTY_STAFF)}><Plus size={16} aria-hidden="true" />スタッフを登録</Button> : null}
        </div>
      </div>

      {staff.length === 0 ? (
        <StateCard
          icon={<AccountIcon />}
          title="スタッフはまだいません"
          description="お客さまが予約するときに指名できる担当者を登録します。"
          action={canEdit ? <Button variant="primary" onClick={() => setEditing(EMPTY_STAFF)}>スタッフを登録</Button> : undefined}
        />
      ) : (
      <section className={styles.staffTable}>
      <DataTable label="担当スタッフ" columnSizing="content" columnLayout={{
            headHeight: 'var(--tpl-bk2-staff-head-h)',
            rowHeight: 'auto', gap: 'var(--tpl-bm-12)', padding: 'var(--tpl-bm-8)',
            headPadding: 'var(--tpl-bm-8)', bodyTextSize: 'var(--text-label)', collapseScope: 'page',
          }}>
          <thead><TableHeadRow className={`${styles.staffRow} ${styles.staffTableHead}`} data-table-layout="columns">
        <Th className={styles.staffName} grow>スタッフ</Th>
        <Th className={styles.staffColMenus}>担当メニュー</Th>
        <Th className={assignStyles.priorityCell}>優先度</Th>
        <Th className={assignStyles.limitCell}>1日の上限</Th>
        <Th className={styles.staffColNoAssign} collapseAt="narrow">指名なし</Th>
        <Th className={styles.staffColWork} collapseAt="narrow">勤務（今週）</Th>
        <Th className={styles.staffColLink}>カレンダー・ログイン</Th>
        <Th className={styles.staffColStatus}>状態</Th>
        <Th className={styles.staffColMenu} />
      </TableHeadRow></thead>
          <tbody>

      {visible.map((person) => {
        const offered = (matrices[person.id] ?? []).filter((entry) => entry.is_offered).length
        const extra = extras[person.id]
        const menuItems: ActionMenuItem[] = [
          {
            id: 'shifts',
            label: '勤務とシフト',
            external: false,
            href: `/booking/staff/shifts?staff_id=${person.id}`, onSelect: () => router.push(`/booking/staff/shifts?staff_id=${person.id}`),
          },
          { id: 'calendar', label: 'カレンダーと会議の URL', onSelect: () => setCalendarStaffId(person.id) },
          ...(canEdit ? [
            { id: 'edit', label: '中身を編集', onSelect: () => setEditing(person) },
            { id: 'assign', label: '割り当ての設定', onSelect: () => setAssignTarget(person) },
            {
              id: 'pause',
              label: person.is_active ? '止める' : '再開する',
              onSelect: () => { if (!alive.current || !canEditRef.current || renderedScope !== scope.current || renderedScope.awaitingLoad || statusRef.current !== 'ready') return; setPauseScope(renderedScope); setPauseError(null); setPauseTarget(person) },
            },
            {
              id: 'delete',
              label: '削除する',
              tone: 'danger' as const,
              dividerBefore: true,
              onSelect: () => { if (!alive.current || !canEditRef.current || renderedScope !== scope.current || renderedScope.awaitingLoad || statusRef.current !== 'ready') return; setRemoveScope(renderedScope); setRemoveError(''); setRemoveTarget(person) },
            },
          ] satisfies ActionMenuItem[] : []),
        ]
        return (
          <Tr key={person.id} className={styles.staffRow} data-table-layout="columns">
            <Td className={styles.staffName} grow>
              <RowNameLink href={`/booking/staff/shifts?staff_id=${person.id}`} title={person.name}>
                {person.name}
              </RowNameLink>
              {person.role ? <span className={styles.staffRole} title={person.role}>{person.role}</span> : null}
            </Td>
            <Td className={styles.staffColMenus}>
              {offered > 0 ? (
                <span className={styles.staffCellMain}>{offered}つ</span>
              ) : (
                <span className={styles.cellWarn}>
                  0<span className={styles.staffCellSub} title="予約画面に出ません">予約画面に出ません</span>
                </span>
              )}
            </Td>
            <Td className={assignStyles.priorityCell}>
              {(() => { const level = PRIORITY[assignment.resources[person.id]?.priority ?? 'normal']; return <StatusBadge tone={level.tone} size="compact">{level.label}</StatusBadge> })()}
            </Td>
            <Td className={assignStyles.limitCell}>
              <span className={styles.staffCellMain}>{assignment.resources[person.id]?.dailyLimit ? `${assignment.resources[person.id]?.dailyLimit} 件` : '上限なし'}</span>
            </Td>
            <Td className={styles.staffColNoAssign} collapseAt="narrow">
              <span className={styles.staffCellMain}>{person.is_designation_optional ? '入る' : emptyValue('unknown')}</span>
            </Td>
            <Td className={styles.staffColWork} collapseAt="narrow">
              {extra?.work ? (() => {
                const [days, range] = extra.work.split('　')
                return (
                  <>
                    <span className={styles.staffCellMain}>{days}</span>
                    {range ? <span className={styles.staffCellSub}>{range}</span> : null}
                  </>
                )
              })() : <span className={styles.staffCellMain}>…</span>}
            </Td>
            <Td className={styles.staffColLink}>
              <StatusBadge tone={extra?.calendar === 'connected' ? 'success' : extra?.calendar === 'error' ? 'caution' : 'neutral'}>
                {extra?.calendar === 'connected' ? 'つながっている' : extra?.calendar === 'error' ? '確認できません' : 'つないでいない'}
              </StatusBadge>
              <span className={styles.staffCellSub}>ログイン：{memberLabel(person)}</span>
            </Td>
            <Td className={styles.staffColStatus}>
              <SharedStatusPill tone={person.is_active ? 'success' : 'neutral'}>{person.is_active ? '受付中' : '停止中'}</SharedStatusPill>
            </Td>
            <Td className={styles.staffColMenu}>
              <RowMenu
                appearance="box"
                size="row"
                label={`${person.display_name}のそのほかの操作`}
                menuLabel={`${person.display_name}の操作`}
                open={openMenuId === person.id}
                onOpenChange={(next) => setOpenMenuId(next ? person.id : null)}
                items={menuItems}
              />
            </Td>
          </Tr>
        )
      })}

      </tbody>
      </DataTable>
      {staff.length > STAFF_PAGE_SIZE ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <ListRange
            label="スタッフ"
            total={staff.length}
            first={visible.length === 0 ? 0 : (safePage - 1) * STAFF_PAGE_SIZE + 1}
            last={(safePage - 1) * STAFF_PAGE_SIZE + visible.length}
          />
          <Pagination page={safePage} pageCount={pageCount} onPageChange={setPage} ariaLabel="担当スタッフのページ送り" />
        </div>
      ) : null}
      </section>
      )}

      {preparing.dialog}
      <StaffCalendarPanel accountId={accountId} person={calendarPerson} menuCount={calendarPerson ? (matrices[calendarPerson.id] ?? []).filter((entry) => entry.is_offered).length : 0}
        canEdit={canEdit} onClose={() => setCalendarStaffId(null)} />
      <AssignmentRowDialog open={assignTarget !== null} name={assignTarget?.name ?? ''} unit="件"
        value={assignTarget ? assignment.resources[assignTarget.id] : undefined}
        onClose={() => setAssignTarget(null)}
        onApply={(patch) => { if (assignTarget) assignment.setResource(assignTarget.id, patch) }} />
      <AssignmentConflict state={assignment} unit="件" order={staffOrder} subject="指名なしの予約の割り当て方" names={Object.fromEntries(staff.map((person) => [person.id, person.name]))} />

      {editing ? (
        <StaffEditModal staff={editing} onSave={saveStaff} onClose={() => setEditing(null)} />
      ) : null}

      <ConfirmDialog
        open={pauseTarget !== null && pauseScope?.generation === scope.current.generation}
        title={`${pauseTarget?.display_name ?? ''}の受付を${pauseTarget?.is_active ? '止め' : '再開し'}ますか？`}
        description={pauseTarget?.is_active
          ? 'お客さまの画面から外れ、新しい予約を受けなくなります。すでに入っている予約はそのまま残ります。'
          : 'お客さまの画面へ出し、新しい予約を受け付けます。'}
        confirmLabel={pauseTarget?.is_active ? '止める' : '再開する'}
        destructive={Boolean(pauseTarget?.is_active)}
        busy={pausing}
        error={pauseError ?? undefined}
        onCancel={() => { if (!pausing) setPauseTarget(null) }}
        onConfirm={() => { if (pauseTarget) void setActive(pauseTarget, !pauseTarget.is_active) }}
      >{pauseScope ? <OperationTargetSummary accounts={[{ id: pauseScope.accountId }]} /> : null}</ConfirmDialog>

      <ConfirmDialog
        open={removeTarget !== null && removeScope?.generation === scope.current.generation}
        title={`「${removeTarget?.display_name ?? ''}」を削除しますか？`}
        description="削除すると元に戻せません。受付だけ止めたいときは「止める」を使ってください。"
        confirmLabel="削除する"
        destructive
        busy={removing}
        error={removeError || undefined}
        onCancel={() => { if (!removing) setRemoveTarget(null) }}
        onConfirm={() => remove()}
      >{removeScope ? <OperationTargetSummary accounts={[{ id: removeScope.accountId }]} /> : null}</ConfirmDialog>

    </div></SaveErrorScope>
  )
}
