'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountAiFeature, AccountAiSetting } from '@line-crm/shared'
import { accountAiFeaturesApi } from '@/lib/api/helpers/gap3'
import Card, { CardHeader } from '@/components/shared/card'
import { ToggleField } from '@/components/shared/toggle'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import StepUpPrompt, { isStepUpRequired, type StepUpRequest } from '@/components/step-up-prompt'

const FEATURES: Array<{ id: AccountAiFeature; label: string }> = [
  { id: 'banner', label: 'バナー生成' },
  { id: 'google_review', label: 'Google口コミの返信案' },
]
type Settings = { items: AccountAiSetting[]; disclosure: string; disclosureVersion: string }

export default function AiFeatures({ accountId, canManage, lockedReason }: { accountId: string; canManage: boolean; lockedReason?: string }) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(canManage)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<AccountAiSetting | null>(null)
  const [agreed, setAgreed] = useState(false)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null)
  const load = useCallback(async () => {
    setLoading(true); setError(''); setPending(null); setAgreed(false); setStepUp(null)
    try {
      const result = await accountAiFeaturesApi.get(accountId)
      if (!result.success) throw new Error('load failed')
      setSettings(result.data)
    } catch { setSettings(null); setError('AI の機能を読み込めませんでした。もう一度お試しください。') }
    finally { setLoading(false) }
  }, [accountId])
  useEffect(() => { if (canManage) void load() }, [canManage, load])
  useEffect(() => {
    if (window.location.hash !== '#ai-features') return
    const frame = requestAnimationFrame(() => document.getElementById('ai-features')?.scrollIntoView({ block: 'start' }))
    return () => cancelAnimationFrame(frame)
  }, [])
  const save = async (item: AccountAiSetting, enabled: boolean, token?: string) => {
    if (!canManage || !settings || savingRef.current) return
    savingRef.current = true
    setSaving(true); setError('')
    try {
      const result = await accountAiFeaturesApi.save(accountId, item.feature, { enabled, expectedVersion: item.version, ...(enabled ? { consent: true, disclosureVersion: settings.disclosureVersion } : {}) }, token)
      if (!result.success) throw new Error('save failed')
      setSettings(current => current ? { ...current, items: current.items.map(row => row.feature === item.feature ? result.data : row) } : current)
      setPending(null); setAgreed(false)
    } catch (cause) {
      if (enabled && !token && isStepUpRequired(cause)) {
        setStepUp({ purpose: 'ai.settings', action: `${FEATURES.find(row => row.id === item.feature)?.label ?? 'AI の機能'}をオンにする`, retry: async grant => { await save(item, true, grant) } })
      } else setError('AI の機能を保存できませんでした。設定を読み直してからお試しください。')
    } finally { savingRef.current = false; setSaving(false) }
  }
  return <Card as="section" id="ai-features" layout="vertical" spacing="settings" aria-label="AI の機能">
    <CardHeader title="AI の機能" />
    {!canManage && lockedReason ? <Notice tone="info">AI の機能の確認・変更はオーナーまたは管理者に依頼してください。</Notice> : null}
    {loading && canManage ? <ListState kind="loading" /> : null}
    {error && !pending ? <Notice tone="danger" action={<Button size="compact" onClick={() => void load()} disabled={saving}>読み直す</Button>}>{error}</Notice> : null}
    <div className="flex flex-col gap-3">{FEATURES.map(feature => {
      const item = settings?.items.find(row => row.feature === feature.id)
      return <ToggleField className="w-full" key={feature.id} checked={item?.enabled ?? false} disabled={loading || saving || (canManage && !item) || (!canManage && !lockedReason)} lockedReason={!canManage ? lockedReason : undefined} onChange={next => { if (!item || !canManage) return; if (next) { setPending(item); setAgreed(false) } else void save(item, false) }}>{feature.label}</ToggleField>
    })}</div>
    {pending && settings ? <Dialog open title={`${FEATURES.find(row => row.id === pending.feature)?.label}をオンにする`} onCancel={() => { if (!saving) { setPending(null); setAgreed(false) } }} footer={<DialogActions><Button onClick={() => { setPending(null); setAgreed(false) }} disabled={saving}>キャンセル</Button><Button variant="primary" disabled={!agreed || saving} onClick={() => void save(pending, true)}>同意してオンにする</Button></DialogActions>}>
      {error ? <Notice tone="danger" action={<Button size="compact" onClick={() => void load()} disabled={saving}>読み直す</Button>}>{error}</Notice> : null}
      <p>{settings.disclosure}</p><Checkbox checked={agreed} onCheckedChange={setAgreed}>内容に同意します</Checkbox>
    </Dialog> : null}
    {stepUp ? <StepUpPrompt request={stepUp} onDone={() => setStepUp(null)} onClose={() => setStepUp(null)} /> : null}
  </Card>
}
