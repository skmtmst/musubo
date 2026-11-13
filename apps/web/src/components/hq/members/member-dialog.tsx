'use client'

import { useEffect, useId, useState, type ReactNode } from 'react'
import type { LineAccount, StaffMember } from '@line-crm/shared'
import Checkbox from '@/components/shared/checkbox'
import Dialog from '@/components/shared/dialog'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import Select from '@/components/shared/select'
import { TextField } from '@/components/shared/text-field'
import { memberStatus } from '@/lib/hq-members'

export type MemberDialogValue = {
  name: string
  email: string
  role: 'admin' | 'viewer'
  assignedLineAccountId: string
  accountScope: 'all' | 'accounts'
  scopedLineAccountIds: string[]
  isActive: boolean
}

/**
 * 板 ：招待メールは送った日から7日（実装 `staff-invite.ts` が7日で送る）。
 * 「10/9（金）18:40」の形で出す。
 */
export function inviteExpiryLabel(now: Date = new Date()): string {
  const at = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at)
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${pick('month')}/${pick('day')}（${pick('weekday')}） ${pick('hour')}:${pick('minute')}`
}

/**
 * 権限者を招待する／変更する。★管理画面 36-5 の「＋ 権限者を招待」と「変更」。
 *
 * 招待では名前・メール・役割・最初に表示するアカウント・担当範囲を聞く。
 * 変更では役割・担当範囲・状態（有効／無効）だけ。名前とメールは本人が持つ。
 */
export default function MemberDialog({
  open,
  member,
  accounts,
  isSelf,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  open: boolean
  /** 変えるとき。招待は null。 */
  member: StaffMember | null
  accounts: LineAccount[]
  /** 自分自身を変えるとき。役割と状態は触らせない（自分の管理者権限を外す事故を防ぐ）。 */
  isSelf?: boolean
  busy?: boolean
  error?: string
  onSubmit: (value: MemberDialogValue) => void
  onCancel: () => void
}) {
  const uid = useId()
  const [value, setValue] = useState<MemberDialogValue>(initial(member, accounts))
  const [localError, setLocalError] = useState('')

  useEffect(() => {
    if (!open) return
    setValue(initial(member, accounts))
    setLocalError('')
  }, [open, member, accounts])

  const set = <K extends keyof MemberDialogValue>(key: K, next: MemberDialogValue[K]) => setValue((v) => ({ ...v, [key]: next }))
  const toggleAccount = (id: string) =>
    set('scopedLineAccountIds', value.scopedLineAccountIds.includes(id) ? value.scopedLineAccountIds.filter((x) => x !== id) : [...value.scopedLineAccountIds, id])

  const submit = () => {
    if (!member) {
      if (!value.name.trim()) return setLocalError('名前を入力してください')
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email.trim())) return setLocalError('正しいメールアドレスを入力してください')
      if (!value.assignedLineAccountId) return setLocalError('最初に表示するアカウントを選んでください')
    }
    if (value.accountScope === 'accounts' && value.scopedLineAccountIds.length === 0) {
      return setLocalError('担当するアカウントを1つ以上選んでください')
    }
    setLocalError('')
    onSubmit({ ...value, name: value.name.trim(), email: value.email.trim() })
  }

  const invited = member ? memberStatus(member) === 'invited' : false
  const notes = [
    isSelf ? '自分の役割と状態は変えられません。' : '',
    invited ? '招待中の人には「招待メールを再送」が出ます。' : '',
  ].filter(Boolean)

  return (
    <Dialog
      open={open}
      title={member ? 'メンバーの権限を変更する' : '権限者を招待'}
      description={
        member
          ? member.email ? `${member.name}（${member.email}）` : member.name
          : `招待メールは送った日から7日（${inviteExpiryLabel()}まで）有効です。メールの確認とLINEの連携が済むとログインできます。`
      }
      /* 板 ：招待の入力の間違いは同じ窓の状態として印を付ける。 */
      designNode={member ? 'BHEl9' : localError ? 'ukPgd' : 'yLKwV'}
      confirmLabel={member ? '変更を保存' : '招待メールを送る'}
      busy={busy}
      error={localError || error}
      onConfirm={submit}
      onCancel={onCancel}
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        {!member ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="名前" htmlFor={`${uid}-name`}>
              <TextField id={`${uid}-name`} value={value.name} maxLength={100} disabled={busy} autoFocus onChange={(e) => set('name', e.target.value)} className="w-full" placeholder="例: 見本 141" />
            </Field>
            <Field label="メールアドレス" htmlFor={`${uid}-email`}>
              <TextField id={`${uid}-email`} type="email" value={value.email} disabled={busy} onChange={(e) => set('email', e.target.value)} className="w-full" placeholder="例: staff@example.com" />
            </Field>
          </div>
        ) : null}

        <Field label="役割" htmlFor={`${uid}-role`} note={isSelf ? '自分の役割は変えられません' : undefined}>
          <Select
            aria-label="役割"
            size="full"
            id={`${uid}-role`}
            className="w-full"
            value={value.role}
            disabled={busy || isSelf}
            onChange={(value) => set('role', value as 'admin' | 'viewer')}
            options={[
              { value: 'admin', label: '管理者（すべて操作できる）' },
              { value: 'viewer', label: '閲覧のみ（見るだけ）' },
            ]}
          />
        </Field>

        <fieldset className="flex flex-col gap-2" disabled={busy}>
          <legend className="text-label font-medium text-ink">担当範囲</legend>
          <RadioCardGroup legend="担当範囲" className="flex flex-wrap gap-4">
            <RadioCard name={`${uid}-scope`} value="all" checked={value.accountScope === 'all'} disabled={busy} onChange={() => { set('accountScope', 'all'); set('scopedLineAccountIds', []) }} title="全アカウント" />
            <RadioCard name={`${uid}-scope`} value="accounts" checked={value.accountScope === 'accounts'} disabled={busy} onChange={() => set('accountScope', 'accounts')} title="指定したアカウントだけ" />
          </RadioCardGroup>
          {value.accountScope === 'accounts' ? (
            <div className="grid gap-1.5 rounded-control border border-hairline p-3 sm:grid-cols-2">
              {accounts.map((account) => (
                <Checkbox key={account.id} checked={value.scopedLineAccountIds.includes(account.id)} disabled={busy} onCheckedChange={() => toggleAccount(account.id)}>{account.name}</Checkbox>
              ))}
              {accounts.length === 0 ? <p className="text-caption text-ink-faint">アカウントがまだありません。</p> : null}
            </div>
          ) : (
            <p className="text-micro text-ink-faint">統括のすべてのアカウントを見て操作できます。</p>
          )}
        </fieldset>

        <Field label="最初に表示するアカウント" htmlFor={`${uid}-assigned`}>
          <Select
            aria-label="最初に表示するアカウント"
            size="full"
            id={`${uid}-assigned`}
            className="w-full"
            value={value.assignedLineAccountId}
            disabled={busy}
            onChange={(value) => set('assignedLineAccountId', value)}
            options={accounts.map((a) => ({ value: a.id, label: a.name }))}
          />
        </Field>
        {member ? (
          <Field label="状態" htmlFor={`${uid}-active`} note={isSelf ? '自分の状態は変えられません' : undefined}>
            <Select
              aria-label="状態"
              size="full"
              id={`${uid}-active`}
              className="w-full"
              value={value.isActive ? 'active' : 'inactive'}
              disabled={busy || isSelf}
              onChange={(value) => set('isActive', value === 'active')}
              options={[
                { value: 'active', label: '有効（ログインできる）' },
                { value: 'inactive', label: '無効（ログインできない）' },
              ]}
            />
          </Field>
        ) : null}
        {notes.length > 0 ? (
          <p className="rounded-control bg-surface-pearl px-3 py-2 text-caption text-ink-secondary">{notes.join('')}</p>
        ) : null}
      </form>
    </Dialog>
  )
}

function Field({ label, note, htmlFor, children }: { label: string; note?: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-label font-medium text-ink">{label}</label>
        {note ? <span className="text-micro text-ink-faint">{note}</span> : null}
      </div>
      {children}
    </div>
  )
}

function initial(member: StaffMember | null, accounts: LineAccount[]): MemberDialogValue {
  return {
    name: member?.name ?? '',
    email: member?.email ?? '',
    role: member?.role === 'viewer' ? 'viewer' : 'admin',
    assignedLineAccountId: member?.assignedLineAccountId ?? accounts[0]?.id ?? '',
    accountScope: member?.accountScope ?? 'all',
    scopedLineAccountIds: member?.scopedLineAccountIds ?? [],
    isActive: member?.isActive ?? true,
  }
}
