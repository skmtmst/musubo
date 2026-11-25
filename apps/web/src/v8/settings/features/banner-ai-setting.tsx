'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AccountAiSetting } from '@line-crm/shared'
import { accountAiFeaturesApi } from '@/lib/api/helpers/gap3'
import { readSessionSnapshot } from '@/lib/session-snapshot'
import { useStepUpGate } from '@/components/step-up-prompt'
import Button from '@/components/shared/button'
import Card from '@/components/shared/card'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import Notice from '@/components/shared/notice'
import Toggle from '@/components/shared/toggle'

/** メニューの表示設定とは別に、この店のAI利用を保存する。 */
export default function BannerAiSetting({ accountId, canManage }: { accountId: string; canManage: boolean }) {
  const [setting, setSetting] = useState<AccountAiSetting | null>(null)
  const [disclosure, setDisclosure] = useState('')
  const [version, setVersion] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const scope = useRef({ accountId, canManage })
  if (scope.current.accountId !== accountId || scope.current.canManage !== canManage) scope.current = { accountId, canManage }
  const gate = useStepUpGate()
  const load = useCallback(async () => {
    const target = scope.current
    setLoading(true); setError(''); setSetting(null)
    try {
      const res = await accountAiFeaturesApi.get(target.accountId)
      if (!res.success) throw new Error('load failed')
      const found = res.data.items.find(item => item.feature === 'banner')
      if (!found || !res.data.disclosure || !res.data.disclosureVersion) throw new Error('invalid response')
      if (target !== scope.current) return
      setSetting(found); setDisclosure(res.data.disclosure); setVersion(res.data.disclosureVersion)
    } catch { if (target === scope.current) setError('AI の機能を読み込めませんでした。もう一度お試しください。') }
    finally { if (target === scope.current) setLoading(false) }
  }, [])
  useEffect(() => {
    scope.current = { accountId, canManage }
    setConfirmOpen(false); gate.cancel(); setBusy(false)
    if (canManage) void load()
    return () => { scope.current = { accountId: '', canManage: false } }
  }, [accountId, canManage, load, gate.cancel])
  const save = async (enabled: boolean) => {
    const target = scope.current
    const current = setting
    if (!current || busy || !target.canManage || readSessionSnapshot()?.impersonation) return
    setBusy(true); setError(''); setConfirmOpen(false)
    try {
      const token = enabled ? await gate.gate('ai.settings', 'バナー生成をオンにする') : undefined
      if (enabled && !token) return
      if (target !== scope.current || readSessionSnapshot()?.impersonation) return
      const res = await accountAiFeaturesApi.save(target.accountId, 'banner', { enabled, expectedVersion: current.version, ...(enabled ? { consent: true, disclosureVersion: version } : {}) }, token ?? undefined)
      if (!res.success) throw new Error('save failed')
      if (target === scope.current) setSetting(res.data)
    } catch { if (target === scope.current) setError('AI の機能を変更できませんでした。読み直してからもう一度お試しください。') }
    finally { if (target === scope.current) setBusy(false) }
  }
  if (!canManage) return null
  return <Card layout="vertical" gap="normal">
    <h2>AI の機能</h2>
    <p>バナー生成で文章や画像を AI に送って画像を作ります。切り替えるとこのアカウントにすぐ保存されます。</p>
    {loading ? <p role="status">AI の機能を読み込んでいます</p> : error ? <Notice tone="danger" action={<Button onClick={() => void load()}>もう一度読み込む</Button>}>{error}</Notice> : setting ? <div>
      <span>バナー生成：{setting.enabled ? 'オン' : 'オフ'}</span>{' '}
      <Toggle label="バナー生成" checked={setting.enabled} disabled={busy || Boolean(readSessionSnapshot()?.impersonation)} onChange={next => next ? setConfirmOpen(true) : void save(false)} />
    </div> : null}
    <ConfirmDialog open={confirmOpen} title="バナー生成をオンにする" description={`${disclosure}。同意して本人確認へ進みます。`} confirmLabel="同意して本人確認へ" onConfirm={() => void save(true)} onCancel={() => setConfirmOpen(false)} />
    {gate.prompt}
  </Card>
}
