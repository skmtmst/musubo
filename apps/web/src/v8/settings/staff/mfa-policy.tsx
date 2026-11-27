'use client'
import { useEffect, useState } from 'react'
import { describeSaveFailure, fetchApi } from '@/lib/api'
import type { ApiResponse, StaffMember } from '@line-crm/shared'
import Card from '@/components/shared/card'
import { AuthDetailRow, AuthHelp } from '@/components/templates/auth-page'
import SectionHeader from '@/components/shared/section-header'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import Toggle from '@/components/shared/toggle'
import FormSection from '@/components/shared/form-section'
import Notice from '@/components/shared/notice'
import { notifySaved } from '@/components/shared/toast'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import ListState from '@/components/shared/list-state'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { useStepUpGate } from '@/components/step-up-prompt'

type Policy = { required: boolean; canEdit: boolean; impersonating?: boolean; configured?: boolean; notice?: string | null; registered?: number; total?: number }
type AccountMember = Pick<StaffMember, 'name' | 'twoFactorEnabled' | 'isActive' | 'inviteStatus'>
export default function MfaPolicy({ loginPath = '/login', accountMembers, compact = false }: { loginPath?: '/login' | '/ops/login'; accountMembers?: readonly AccountMember[] | null; compact?: boolean }) {
  const saveErrors = useSaveFormErrors()
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [turnOn, setTurnOn] = useState(false)
  const [unregistered, setUnregistered] = useState<string[] | null>(null)
  const [peopleLoading, setPeopleLoading] = useState(false)
  const [peopleError, setPeopleError] = useState('')
  const accountPeople = accountMembers?.filter(person => person.isActive && person.inviteStatus === 'active')
  const registered = accountMembers === undefined ? policy?.registered : accountPeople?.filter(person => person.twoFactorEnabled).length
  const total = accountMembers === undefined ? policy?.total : accountPeople?.length
  const showUnregistered = async () => {
    if (accountMembers !== undefined) {
      if (!accountPeople) return
      setPeopleError(''); setUnregistered(accountPeople.filter(person => !person.twoFactorEnabled).map(person => person.name))
      return
    }
    setUnregistered([]); setPeopleError(''); setPeopleLoading(true)
    try { const result = await fetchApi<ApiResponse<{ name: string; twoFactorEnabled: boolean; isActive: boolean }[]>>('/api/staff'); if (!result.success) throw new Error(result.error); setUnregistered(result.data.filter(person => person.isActive && !person.twoFactorEnabled).map(person => person.name)) }
    catch { setPeopleError('未登録の人を読み込めませんでした') } finally { setPeopleLoading(false) }
  }
  const stepUp = useStepUpGate()
  const load = async () => {
    setError('')
    try { const result = await fetchApi<ApiResponse<Policy>>('/api/auth/two-factor/policy'); if (!result.success) throw new Error(result.error); setPolicy(result.data) }
    catch { setError('二段階認証の設定を読み込めませんでした') }
  }
  useEffect(() => { void load() }, [])
  const save = async (required: boolean) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const token = required ? null : await stepUp.gate('auth.mfa.policy', '二段階認証の必須をオフにする')
      if (!required && !token) return
      const result = await fetchApi<ApiResponse<{ required: boolean; relogin: boolean }>>('/api/auth/two-factor/policy', {
        method: 'PUT', headers: token ? { 'X-Step-Up-Token': token } : undefined, body: JSON.stringify({ required }),
      })
      if (!result.success) throw new Error(result.error)
      const data = result.data
      setPolicy(current => current ? { ...current, required: data.required } : null)
      setTurnOn(false)
      if (data.relogin) window.location.assign(loginPath)
      else notifySaved(data.required ? '二段階認証を必須にしました。' : '二段階認証の必須を解除しました。')
    } catch (caught) { if (!saveErrors.capture(caught)) setError(describeSaveFailure(caught)) }
    finally { setBusy(false) }
  }
  if (policy?.impersonating) return null
  const toggle = policy?.canEdit ? <SaveErrorField names={["required"]}><Toggle checked={policy.required} label="ログインで二段階認証を必須にする" disabled={busy || policy.configured === false} onChange={value => value ? setTurnOn(true) : void save(false)} /></SaveErrorField> : undefined
  return <SaveErrorScope errors={saveErrors}>
    <FormSection id="mfa-policy-title" title={compact ? 'ログイン時の二段階認証' : 'ログインの安全'} description={compact ? '統括全体で必須にする' : '管理画面へ入る時の確かめ方を決めます'} action={compact ? toggle : undefined}>
      {!compact ? <SectionHeader title="ログインで二段階認証を必須にする" description={policy?.required ? '全員が、ログインのたびに認証アプリの6桁を入れます。まだ登録していない人は、次のログインで登録します。' : 'パスワードやLINEだけで入れます。自分で登録した人には、確かめが出ます。'} actions={toggle} /> : null}
      {error ? <Notice tone="danger" message={error} /> : null}
      {policy?.notice ? <Notice tone="warn" message={policy.notice} /> : null}
      {policy ? compact ? <AuthDetailRow label="登録済み" value={`${registered ?? '—'} / ${total ?? '—'} 人`} /> : <Card surface="muted" padding="compact"><AuthDetailRow label={accountMembers === undefined ? '登録済み' : '登録済み（このアカウント）'} value={`${registered ?? '—'} / ${total ?? '—'} 人`} actions={policy.canEdit ? <Button variant="text" size="inline" disabled={accountMembers === null} onClick={() => showUnregistered()}>未登録の人を見る →</Button> : undefined} /></Card> : <ListState kind={error ? 'error' : 'loading'} onRetry={() => void load()} />}
      {!compact ? <AuthHelp>{accountMembers !== undefined ? '必須設定は統括全体に適用されます。' : ''}切り替えられるのはオーナー（運営）だけです。切り替えは記録に残ります。</AuthHelp> : null}
      <ConfirmDialog open={turnOn} title="二段階認証をオンにする" description="全員が一度ログアウトします。まだ登録していない人は、次のログインで登録できます。" confirmLabel="オンにする" onConfirm={() => save(true)} onCancel={() => setTurnOn(false)} busy={busy} error={error} />
      <Dialog open={unregistered !== null} title="二段階認証が未登録の人" onCancel={() => setUnregistered(null)} cancelLabel="閉じる" error={peopleError}>
        {peopleLoading ? <ListState kind="loading" /> : unregistered?.length ? <ul>{unregistered.map((name, index) => <li key={index}>{name}</li>)}</ul> : peopleError ? null : <p>未登録の人はいません</p>}
      </Dialog>
      {stepUp.prompt}
    </FormSection>
  </SaveErrorScope>
}
