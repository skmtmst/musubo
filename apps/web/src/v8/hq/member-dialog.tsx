'use client'

import { canAdministerRole } from '@/lib/staff-role'
import { formatDate as polishFormatDate } from '@/lib/format'
import { Field } from '@/components/shared/form-controls'
import { useContext, useEffect, useId, useState, type ReactNode } from 'react'
import { Send, ShieldCheck } from 'lucide-react'
import type { StaffMember } from '@line-crm/shared'
import Button from '@/components/shared/button'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { Field as FormField, FieldError } from '@/components/shared/form-controls'
import { focusFieldById } from '@/lib/use-form-errors'
import Radio from '@/components/shared/radio'
import Select from '@/components/shared/select'
import StatusBadge from '@/components/shared/status-badge'
import { TextField } from '@/components/shared/text-field'
import { EmailChipField } from '@/components/shared/email-chip-field'
import head from './dialog-head.module.css'
import styles from './member-dialog.module.css'
import { inviteRequirements } from './member-requirements'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'


/*
 * ★V8 統括のメンバーの窓（Pencil  権限者を招待・ 権限を変更する・ 変える前の確認）。
 *
 * 読み書きの中身は 管理画面（components/hq/members/member-dialog.tsx）と同じ：
 *   招待＝名前・メール・役割・担当範囲
 *   変更＝役割・担当範囲・状態（名前とメールは本人が持つ）
 * 見た目だけを絵どおりに組んだ：幅 620・上から 110 の窓、欄は全幅で縦に並べ、担当範囲と状態は
 * 行内のラジオ、担当するアカウントは専用の窓で選び、下の帯は線の下で真ん中寄せ。
 * 窓の枠・×・題は共通の Dialog、頭の寸法は dialog-head.module.css。
 */

/** 絵の の窓の幅と上からの位置（px）。 */
const MEMBER_WIDTH = 620
const MEMBER_TOP = 110
/** 絵  の確認の窓。 */
const CONFIRM_TOP = 220

export type MemberRole = 'admin' | 'staff' | 'viewer'

export type MemberDialogValue = {
  name: string
  email: string
  role: MemberRole
  accountScope: 'all' | 'accounts'
  scopedLineAccountIds: string[]
  isActive: boolean
}

/**
 * 招待メールは送った日から7日（実装 `staff-invite.ts` が7日で送る）。
 * 絵  の「10/9（金）18:40」の形で出す。
 */
export function inviteExpiryLabel(now: Date = new Date()): string {
  return polishFormatDate(new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000), { style: 'detail', now })
}

function initial(member: StaffMember | null): MemberDialogValue {
  return {
    name: member?.name ?? '',
    email: member?.email ?? '',
    /*
     * 統括の招待は承認済みの画面どおり「担当者」から始める。
     * 変更は今の役割のまま（互換経路は担当者を管理者に置き換えていた）。
     */
    role: member ? (member.role === 'viewer' ? 'viewer' : member.role === 'staff' ? 'staff' : 'admin') : 'staff',
    /* 統括からの新規招待は全体権限。既存メンバーの編集では保存済みの範囲を保つ。 */
    accountScope: member?.accountScope ?? 'all',
    scopedLineAccountIds: member?.scopedLineAccountIds ?? [],
    isActive: member?.isActive ?? true,
  }
}

/**
 * 権限者を招待する／変更する窓。
 */
export default function MemberDialogV8({
  open,
  active = open,
  session,
  member,
  isSelf,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  open: boolean
  /** 確認窓で一時的に閉じても、入力が残る間は離脱を守る。 */
  active?: boolean
  /**
   * 開き直しの番号。変わったときだけ中身を初めに戻す。確認の窓を出す間はこの窓を閉じ、
   * 確認で「キャンセル」したら入れた中身のまま戻す（open だけでは戻さない）。
   */
  session: number
  /** 変えるとき。招待は null。 */
  member: StaffMember | null
  /** 自分自身を変えるとき。役割と状態は触らせない（自分の管理者権限を外す事故を防ぐ）。 */
  isSelf?: boolean
  busy?: boolean
  error?: string
  onSubmit: (value: MemberDialogValue) => void
  onCancel: () => void
}) {
  const uid = useId()
  const [value, setValue] = useState<MemberDialogValue>(initial(member))
  const [localError, setLocalError] = useState('')
  /* 板 ：名前・メールの間違いは欄の下に赤で出し、直すまで送るボタンを押せなくする。 */
  const [fieldErrors, setFieldErrors] = useState<{ name?: string; email?: string; scope?: string }>({})
  const depth = useContext(OverlayDepthContext)
  const dirty = JSON.stringify(value) !== JSON.stringify(initial(member))
  const guard = useUnsavedGuard({ dirty: active && (dirty || Boolean(busy)), busy: active && busy, onDiscard: onCancel })
  const close = () => guard.guarded(() => { if (!dirty) onCancel() })
  useEffect(() => { if (!active) guard.cancelLeave() }, [active, guard.cancelLeave])

  useEffect(() => {
    setValue(initial(member))
    setLocalError('')
    setFieldErrors({})
  }, [session, member])

  const set = <K extends keyof MemberDialogValue>(key: K, next: MemberDialogValue[K]) => {
    setValue((v) => ({ ...v, [key]: next }))
    const field: 'name' | 'email' | 'scope' | null = key === 'name' || key === 'email' ? key
      : key === 'scopedLineAccountIds' || key === 'accountScope' ? 'scope' : null
    if (field) setFieldErrors((errors) => (errors[field] ? { ...errors, [field]: undefined } : errors))
  }

  const submit = () => {
    /* 欄の誤りは全部その欄の下に出し、上から1つ目へ移る（板 ・）。 */
    const errors = {
      name: member ? undefined : inviteRequirements.name.check(value.name) ?? undefined,
      email: member ? undefined : inviteRequirements.email.check(value.email) ?? undefined,
      scope: value.accountScope === 'accounts' && value.scopedLineAccountIds.length === 0 ? '担当するアカウントを1つ以上選んでください' : undefined,
    }
    setFieldErrors(errors)
    const first = (['name', 'email', 'scope'] as const).find((key) => errors[key])
    if (first) {
      setLocalError('')
      focusFieldById(`${uid}-${first}`)
      return
    }
    setLocalError('')
    onSubmit({ ...value, name: value.name.trim(), email: value.email.trim() })
  }

  /* 絵 ：変更の窓には決まりの注をいつも出す（自分・招待中の人のどちらでも同じ文）。 */
  const note = member ? '自分の役割と状態は変えられません。招待中の人には「招待メールを再送」が出ます。' : ''
  const roleOptions = [
    { value: 'admin', label: '管理者（メンバーと決済も管理できる）' },
    { value: 'staff', label: '担当者（業務を操作できる）' },
    { value: 'viewer', label: '閲覧のみ（見るだけ）' },
  ]

  return (<>
    <Dialog
      open={open}
      title={member ? 'メンバーの権限を変更する' : '権限者を招待'}
      description={
        member
          ? member.email ? `${member.name}（${member.email}）` : member.name
          : `招待メールは送った日から 7 日（${inviteExpiryLabel()} まで）有効です。メールの確認と LINE の連携が済むとログインできます。`
      }
      /* 板 ：招待の入力の間違いは同じ窓の状態として印を付ける。 */
      designNode={member ? 'BHEl9' : fieldErrors.name || fieldErrors.email ? 'ukPgd' : 'yLKwV'}
      designWidth={MEMBER_WIDTH}
      designTop={MEMBER_TOP}
      busy={busy}
      error={localError || error || undefined}
      dirty={false}
      onCancel={close}
      footer={
        <DialogActions>
          <Button type="button" onClick={close} disabled={busy}>キャンセル</Button>
          <Button type="button" variant="primary" onClick={submit} disabled={busy || Boolean(fieldErrors.name || fieldErrors.email)} busy={busy} busyLabel="処理中…">
            {member ? null : <Send aria-hidden="true" className={styles.icon} />}
            {member ? '変更を保存する' : '招待メールを送る'}
          </Button>
        </DialogActions>
      }
    >
      <form noValidate
        className={`${head.head} ${styles.form}`}
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        {!member ? (
          <div className={styles.pair}>
            <FormField label="名前" requirement={inviteRequirements.name} htmlFor={`${uid}-name`} error={fieldErrors.name}>
              <SaveErrorField names={["name","value.name"]}><TextField id={`${uid}-name`} value={value.name} maxLength={100} disabled={busy} autoFocus invalid={Boolean(fieldErrors.name)} onChange={(e) => set('name', e.target.value)} className={styles.full} placeholder="例：見本 141" /></SaveErrorField>

            </FormField>
            <FormField label="メールアドレス" requirement={inviteRequirements.email} htmlFor={`${uid}-email`} error={fieldErrors.email}>

              <SaveErrorField names={["email","value.email"]}><EmailChipField id={`${uid}-email`} value={value.email} disabled={busy} invalid={Boolean(fieldErrors.email)} onValueChange={(email) => set('email', email)} className={styles.full} placeholder="例：staff@example.com" /></SaveErrorField>

            </FormField>
          </div>
        ) : null}

        <Field label="役割" required htmlFor={`${uid}-role`} note={isSelf ? '自分の役割は変えられません' : undefined}>

          <SaveErrorField names={["role","value.role"]}><Select
            aria-label="役割"
            size="full"
            id={`${uid}-role`}
            value={value.role}
            disabled={busy || isSelf}
            onChange={(next) => set('role', next as MemberRole)}
            options={roleOptions}
          /></SaveErrorField>

        </Field>

        <div className={styles.group} role="group" aria-labelledby={`${uid}-scope-label`}>
          <span id={`${uid}-scope-label`} className={styles.label}>担当範囲</span>
          <p className={styles.note}>{value.role === 'staff' ? '予約・配信などの業務を操作できます。メンバーの追加や決済の変更はできません。' : value.role === 'viewer' ? '統括のすべてのアカウントを閲覧できます。変更はできません。' : '統括のすべてのアカウントで、メンバーや決済を含む管理ができます。'}</p>
          <FieldError id={`${uid}-scope-error`}>{fieldErrors.scope}</FieldError>
        </div>

        {member ? (
          <div className={styles.group} role="radiogroup" aria-labelledby={`${uid}-active-label`}>
            <span id={`${uid}-active-label`} className={styles.label}>状態{isSelf ? <span className={styles.note}>自分の状態は変えられません</span> : null}</span>
            <div className={styles.radios}>
              <SaveErrorField names={["isActive","value.isActive"]}><Radio name={`${uid}-active`} value="active" checked={value.isActive} disabled={busy || isSelf} onChange={() => set('isActive', true)}>有効（ログインできる）</Radio></SaveErrorField>
              <Radio name={`${uid}-active`} value="inactive" checked={!value.isActive} disabled={busy || isSelf} onChange={() => set('isActive', false)}>無効（ログインできない）</Radio>
            </div>
          </div>
        ) : null}

        {note ? <p className={styles.callout}>{note}</p> : null}
      </form>
    </Dialog>
    <OverlayDepthContext.Provider value={depth + 1}><UnsavedLeaveDialog open={active && guard.leaveTarget !== null} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} busy={busy} /></OverlayDepthContext.Provider>
  </>)
}

const ROLE_WORD: Record<string, string> = { owner: 'オーナー', admin: '管理者', staff: '担当者', viewer: '閲覧のみ' }
/** 請求の画面を見られるのはオーナーと管理者だけ。 */
const seesBilling = (role: string) => canAdministerRole(role)

/** 板 「権限を変える確認」。変える前に変更前→変更後を並べる。 */
export function MemberChangeConfirmV8({ member, value, accountNames, busy, error, onCancel, onConfirm }: {
  member: StaffMember
  value: MemberDialogValue
  accountNames: Map<string, string>
  busy: boolean
  error: string
  onCancel: () => void
  onConfirm: () => void
}) {
  const roleOf = (role: string) => ROLE_WORD[role] ?? role
  const scopeOf = (scope: 'all' | 'accounts', ids: string[]) => (
    scope === 'all' ? 'すべてのアカウント' : ids.map((id) => accountNames.get(id) ?? id).join('・') || '（選択なし）'
  )
  const beforeScope = member.accountScope ?? 'all'
  const beforeIds = member.scopedLineAccountIds ?? []
  const rows = [
    { label: '役割', before: roleOf(member.role), after: roleOf(value.role), changed: member.role !== value.role },
    {
      label: '担当範囲',
      before: scopeOf(beforeScope, beforeIds),
      after: scopeOf(value.accountScope, value.scopedLineAccountIds),
      changed: beforeScope !== value.accountScope || beforeIds.join(',') !== value.scopedLineAccountIds.join(','),
    },
    {
      label: '請求の画面',
      before: seesBilling(member.role) ? '見られる' : '見られない',
      after: seesBilling(value.role) ? '見られる' : '見られない',
      changed: seesBilling(member.role) !== seesBilling(value.role),
    },
    {
      label: '状態',
      before: member.isActive ? '有効' : '停止中',
      after: value.isActive ? '有効' : '停止中',
      changed: member.isActive !== value.isActive,
    },
  ].filter((row) => row.label !== '状態' || row.changed)
  /* 管理者を外す・止めるときはサーバーが確認コードを求める（STEP_UP_REQUIRED）。押す前に分かるように書く。 */
  const needsCode = seesBilling(member.role) && (!seesBilling(value.role) || !value.isActive)
  return (
    <Dialog
      open
      title={`${member.name} さんの権限を変えますか？`}
      designNode="M4jS9"
      designWidth={720}
      designTop={CONFIRM_TOP}
      busy={busy}
      error={error || undefined}
      onCancel={onCancel}
      footer={
        <DialogActions>
          <Button type="button" onClick={onCancel} disabled={busy}>キャンセル</Button>
          <Button type="button" variant="primary" onClick={onConfirm} disabled={busy} busy={busy} busyLabel="処理中…">
            {needsCode ? <ShieldCheck aria-hidden="true" className={styles.icon} /> : null}
            {needsCode ? '確認コードを入れて変える' : '変える'}
          </Button>
        </DialogActions>
      }
    >
      <div className={`${head.head} ${styles.form}`}>
        <dl className={styles.confirmList}>
          {rows.map((row) => (
            <div key={row.label} className={styles.confirmRow}>
              <dt className={styles.confirmLabel}>{row.label}</dt>
              <dd className={styles.confirmValue}>{row.before} → {row.after}</dd>
              {/* 絵 `M4jS9`：点なしの薄い琥珀の札（状態の札の形）。 */}
              {row.changed ? <StatusBadge tone="warning" dot={false}>変わる</StatusBadge> : null}
            </div>
          ))}
        </dl>
        <p className={styles.confirmNote}>管理者が 1 人だけのときは、その人を管理者から外せません。管理者を外すときは、6 桁の確認コードを入れます。</p>
      </div>
    </Dialog>
  )
}
