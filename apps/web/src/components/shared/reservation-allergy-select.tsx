'use client'

import { useEffect, useRef, useState } from 'react'
import type { RestaurantReservationAllergy } from '@line-crm/shared'
import { api } from '@/lib/api'
import { canManageRole } from '@/lib/staff-role'
import MultiSelect from './multi-select'
import { Field } from './form-controls'
import Button from './button'

export default function ReservationAllergySelect({ accountId, role, values, onChange, disabled = false }: {
  accountId: string | null | undefined
  role: string | null | undefined
  values: RestaurantReservationAllergy[]
  onChange: (values: RestaurantReservationAllergy[]) => void
  disabled?: boolean
}) {
  const [state, setState] = useState<{ accountId: string; options: string[]; version: number } | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const [saving, setSaving] = useState(false)
  const currentAccount = useRef(accountId)
  currentAccount.current = accountId
  useEffect(() => {
    let current = true
    setState(null); setError('')
    if (!accountId) return
    void Promise.resolve().then(() => api.accountSettings.getAllergyOptions(accountId)).then(result => {
      if (!result.success || !Array.isArray(result.data?.options)) throw new Error('read')
      if (current) setState({ accountId, options: result.data.options, version: result.data.version })
    }).catch(() => { if (current) setError('アレルギーの候補を読み込めませんでした。') })
    return () => { current = false }
  }, [accountId, retry])
  const current = state?.accountId === accountId ? state : null
  const create = async (query: string) => {
    const value = query.trim()
    if (!current || !role || !value || value.length > 100 || values.length >= 32) return
    if (!canManageRole(role)) { if (!values.some(item => item.kind === 'other' && item.value === value)) onChange([...values, { kind: 'other', value }]); return }
    setSaving(true); setError('')
    try {
      const options = [...current.options, value]
      const result = await api.accountSettings.saveAllergyOptions(current.accountId, options, current.version)
      if (!result.success || !result.data) throw new Error('save')
      if (currentAccount.current !== current.accountId) return
      setState({ ...current, options, version: result.data.version })
      onChange([...values, { kind: 'option', value }])
    } catch { if (currentAccount.current === current.accountId) setError('候補を追加できませんでした。読み直してもう一度お試しください。') }
    finally { setSaving(false) }
  }
  const key = (item: RestaurantReservationAllergy) => JSON.stringify(item)
  const choices: RestaurantReservationAllergy[] = [...(current?.options ?? []).map(value => ({ kind: 'option' as const, value })), ...values]
  const options = [...new Map(choices.map(item => [key(item), item])).values()].map(item => ({ value: key(item), label: item.kind === 'other' ? `その他：${item.value}` : item.value }))
  return <Field label="アレルギー">
    <MultiSelect aria-label="アレルギー" options={options} values={values.map(key)} onChange={keys => onChange(keys.map(item => JSON.parse(item) as RestaurantReservationAllergy))} disabled={disabled || !role || !current || saving} loading={Boolean(accountId && !current && !error)} placeholder="アレルギーを選ぶ" maxChips={32}
      createLabel={query => canManageRole(role) ? `「${query}」を候補に追加` : `「その他：${query}」として追加`}
      onCreate={query => { void create(query) }} />
    {error && <p role="status">{error} <Button variant="text" size="inline" onClick={() => setRetry(value => value + 1)}>読み直す</Button></p>}
  </Field>
}
