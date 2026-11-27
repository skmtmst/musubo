'use client'

import { useState } from 'react'
import { api } from '@/lib/api'
import CreatePage, { AsideCard, FormSection, Field } from '@/components/shared/create-page'
import Checkbox from '@/components/shared/checkbox'
import Card from '@/components/shared/card'
import RadioCard, { RadioCardGroup } from '@/components/shared/radio-card'
import Notice from '@/components/shared/notice'
import { TextInput } from '@/components/shared/form-controls'
import { EmailChipField } from '@/components/shared/email-chip-field'
import { DetailContent, DetailField } from '@/components/shared/detail-content'
import TruncatedText from '@/components/shared/truncated-text'

import NotificationSwitch from '@/components/ui/notification-switch'
import { useAccount } from '@/contexts/account-context'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { useFormErrors } from '@/lib/use-form-errors'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { CONVERSION_APPROVAL_EDIT_KEY, normalizeStaffPermissionKeys, toggleStaffPermissionKey } from '@/v8/settings/staff/permission-labels'
import { formatNumber } from '@/lib/format'

type Role = 'admin' | 'staff' | 'viewer'
type Channel = { email: boolean; line: boolean }

const ROLES: Array<{ value: Role; label: string; note: string }> = [
  { value: 'admin', label: '管理者', note: 'このアカウントのすべての機能を設定・操作できます' },
  { value: 'staff', label: 'スタッフ', note: 'このアカウントで選択した機能だけを操作できます' },
  { value: 'viewer', label: '閲覧のみ', note: 'このアカウントだけを閲覧でき、操作はできません' },
]

const PERMISSION_GROUPS = [
  { label: '基本', items: [['/', 'ダッシュボード'], ['/chats', '受信箱'], ['/friends', '友だち'], ['/tags', 'タグ']] },
  { label: '配信', items: [['/scenarios', 'シナリオ配信'], ['/broadcasts', '一斉配信'], ['/reminders', 'リマインダ'], ['/auto-replies', '自動応答'], ['/friend-add-settings', '友だち追加時の配信'], ['/webinars', 'ウェビナー']] },
  { label: 'コンテンツ', items: [['/templates', 'テンプレート'], ['/rich-menus', 'リッチメニュー'], ['/form-submissions', '回答フォーム'], ['/contents/vars', '共通情報'], ['/contents', '登録メディア一覧']] },
  { label: '成果と分析', items: [['/conversions', '成果とアフィリエイト'], [CONVERSION_APPROVAL_EDIT_KEY, '成果を承認・却下する'], ['/mileage', 'マイル'], ['/inflow-links', '流入と計測'], ['/analytics', '分析']] },
  { label: '自動化・予約', items: [['/automations', 'オートメーション'], ['/webhooks', '外部連携'], ['/booking/bookings', '予約管理'], ['/booking/menus', '予約設定'], ['/events', 'イベント予約']] },
] as const

const NOTIFICATIONS = [
  ['operations', '運用状態のエラー', '異常を検知したとき'],
  ['emergency', '緊急停止・復旧', '停止または復旧したとき'],
  ['security', 'ログイン・権限変更', 'ログインや権限が変わったとき'],
  ['updates', 'システム更新', '更新が完了したとき'],
] as const

const INITIAL_NOTIFICATIONS: Record<string, Channel> = {
  operations: { email: true, line: true }, emergency: { email: true, line: true },
  security: { email: true, line: false }, updates: { email: false, line: true },
}

export default function NewStaffPage() {
  const { selectedAccountId, selectedAccount } = useAccount()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('admin')
  const [permissionKeys, setPermissionKeys] = useState<string[]>([])
  const [notifications, setNotifications] = useState<Record<string, Channel>>({ ...INITIAL_NOTIFICATIONS })
  /*
   * 欄の検査。欄から離れた時点で1回だけ理由を出し、
   * 直すとその場で消える。送信時は全欄を見て上にまとめを出す。
   */
  const fields = useFormErrors()
  fields.define('name', '名前', () => (name.trim() ? null : '名前を入力してください'))
  fields.define('email', 'メールアドレス', () => {
    if (!email.trim()) return 'メールアドレスを入力してください'
    // #581: サーバー・編集窓と同じ1行正規表現で先に形式を見る。
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return '正しいメールアドレスを入力してください'
    if (email.trim().length > 254) return 'メールアドレスは254文字以内で入力してください'
    return null
  })
  fields.define('permissions', 'スタッフに表示する機能', () =>
    role === 'staff' && permissionKeys.length === 0
      ? 'スタッフに表示する機能を1つ以上選択してください'
      : null)

  const togglePermission = (key: string) => {
    fields.touch('permissions')
    setPermissionKeys((current) => toggleStaffPermissionKey(current, key))
  }
  const toggleChannel = (key: string, channel: keyof Channel) => setNotifications((current) => ({ ...current, [key]: { ...current[key], [channel]: !current[key][channel] } }))

  /*
   * 追加途中の離脱確認。名前・アドレス・役割・権限・通知先のどれかに
   * 手を付けていたら、キャンセルや左メニューで確認窓を出す。
   * 招待メールを送ると一覧へ router.push するので、成功後に警告は出ない。
   */
  const dirty = Boolean(
    name || email || permissionKeys.length > 0 || role !== 'admin' ||
    JSON.stringify(notifications) !== JSON.stringify(INITIAL_NOTIFICATIONS)
  )
  const { leaveTarget, confirmLeave, cancelLeave } = useUnsavedGuard({ dirty })

  return <>
      <CreatePage
    title="ユーザーを追加する"
    help="管理画面にログインできる人を追加し、できることの範囲を決めます。"
    parent={['ユーザー管理', '/staff?tab=members']}
    saveLabel="招待メールを送る"
    fields={fields}
    onSave={async () => { if (!selectedAccountId) throw new Error('店舗を選択してください'); const res = await api.staff.create({ name: name.trim(), email: email.trim(), role, permissionKeys: normalizeStaffPermissionKeys(permissionKeys), notificationPreferences: notifications, assignedLineAccountId: selectedAccountId, canAccessDescendantAccounts: false, accountScope: 'accounts', scopedLineAccountIds: [selectedAccountId] }); if (!res.success) throw new Error(res.error); return res.data.id }}
    aside={<>
      <AsideCard title="追加後の流れ"><ol className="space-y-3 text-sm text-ink-secondary"><li><b className="text-ink">1.</b> 招待メールでアドレスを確認</li><li><b className="text-ink">2.</b> 続けて届くメールからLINE認証</li><li><b className="text-ink">3.</b> 連携完了後はLINE認証でログイン</li></ol></AsideCard>
      <AsideCard title="設定内容"><dl className="space-y-2 text-sm"><div className="flex justify-between"><dt className="text-ink-faint">役割</dt><dd className="text-ink">{ROLES.find((item) => item.value === role)?.label}</dd></div><div className="flex justify-between"><dt className="text-ink-faint">表示機能</dt><dd className="text-ink">{role === 'staff' ? `${formatNumber(permissionKeys.length)}件` : 'すべて'}</dd></div></dl></AsideCard>
    </>}
  >
    <Notice tone="info">{selectedAccount?.name ? `担当範囲は${selectedAccount.name}のみです。` : '担当範囲はこの店舗のみです。'}</Notice>
    <FormSection step={1} label="どなたを追加するか">
      <div className="grid gap-4 md:grid-cols-2">
        <Field label="名前" htmlFor="staff-name" required error={fields.error('name')}><TextInput {...fields.bind('name')} id="staff-name" value={name} onChange={(e) => setName(e.target.value)} invalid={fields.invalid('name')} /></Field>
        <Field label="メールアドレス" htmlFor="staff-email" required note="このアドレスに招待メールが届きます。" error={fields.error('email')}><EmailChipField {...fields.bind('email')} id="staff-email" value={email} onValueChange={setEmail} maxLength={254} invalid={fields.invalid('email')} /></Field>
      </div>
    </FormSection>

    <FormSection step={2} label="役割" note="役割を選ぶと、できることの範囲が決まります。">
      <RadioCardGroup legend="役割" className="grid gap-3 lg:grid-cols-3">{ROLES.map((item) => <RadioCard key={item.value} name="staff-role" value={item.value} checked={role === item.value} onChange={(value) => setRole(value as Role)} title={item.label} note={item.note} />)}</RadioCardGroup>
    </FormSection>

    {role === 'staff' && <FormSection step={3} label="スタッフに表示する機能" note="選択した機能だけが左のメニューに表示され、操作できます。">
      {fields.error('permissions') ? <p className="text-danger text-xs" role="alert">{fields.error('permissions')}</p> : null}
      <div className="space-y-4">{PERMISSION_GROUPS.map((group) => <div key={group.label}><p className="mb-2 text-xs font-semibold text-ink-faint">{group.label}</p><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{group.items.map(([key, label]) => <Checkbox key={key} checked={permissionKeys.includes(key)} onCheckedChange={() => togglePermission(key)}>{label}</Checkbox>)}</div></div>)}</div>
    </FormSection>}

    <FormSection step={role === 'staff' ? 4 : 3} label="通知先" note="通知の種類ごとに、メールとLINEへの送信を切り替えます。">
      <Card frame="inset" className="divide-hairline overflow-hidden divide-y">{NOTIFICATIONS.map(([key, label, note]) => <div key={key} className="grid grid-cols-[1fr_auto_auto] items-center gap-5 px-4 py-3"><div><p className="text-sm font-medium text-ink">{label}</p><p className="text-xs text-ink-faint">{note}</p></div><div className="flex items-center gap-2 text-xs text-ink-secondary"><span>メール</span><NotificationSwitch checked={notifications[key].email} onChange={() => toggleChannel(key, 'email')} label={`${label}をメールで通知`} /></div><div className="flex items-center gap-2 text-xs text-ink-secondary"><span>LINE</span><NotificationSwitch checked={notifications[key].line} onChange={() => toggleChannel(key, 'line')} label={`${label}をLINEで通知`} /></div></div>)}</Card>
    </FormSection>
    <FormSection step={role === 'staff' ? 5 : 4} label="送信前の確認" note="招待メールの宛先と担当範囲を確認してください。">
      <DetailContent>
        <DetailField label="名前"><TruncatedText value={name.trim() || '未入力'} /></DetailField>
        <DetailField label="招待先メールアドレス"><TruncatedText value={email.trim() || '未入力'} /></DetailField>
        <DetailField label="担当する店舗"><TruncatedText value={selectedAccount?.name || '店舗を選択してください'} /></DetailField>
        <DetailField label="役割">{ROLES.find(item => item.value === role)?.label}</DetailField>
        {role === 'staff' ? <DetailField label="操作できる機能"><TruncatedText value={PERMISSION_GROUPS.flatMap(group => group.items.filter(([key]) => permissionKeys.includes(key)).map(([, label]) => label)).join('・') || '未選択'} /></DetailField> : null}
      </DetailContent>
    </FormSection>
  </CreatePage>
    <UnsavedLeaveDialog open={leaveTarget !== null} subject="入力したユーザー" onConfirm={confirmLeave} onCancel={cancelLeave} />
  </>
}
