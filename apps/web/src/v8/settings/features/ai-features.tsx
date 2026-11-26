'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import IconButton from '@/components/shared/icon-button'
import type { AccountAiFeature, AccountAiSetting } from '@line-crm/shared'
import { ApiError } from '@/lib/api'
import { readPermissionSessionSnapshot, SESSION_SNAPSHOT_CHANGED } from '@/lib/session-snapshot'
import { accountAiFeaturesApi } from '@/lib/api/helpers/gap3'
import Card from '@/components/shared/card'
import Toggle from '@/components/shared/toggle'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import Button from '@/components/shared/button'
import Checkbox from '@/components/shared/checkbox'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import StepUpPrompt, { isStepUpRequired, type StepUpRequest } from '@/components/step-up-prompt'
import styles from './screen.module.css'

const IMPERSONATION_REASON = '代理ログイン中は変更できません。代理ログインを終了してから操作してください。'
const FEATURES: Array<{ id: AccountAiFeature; label: string; note: string }> = [
  { id: 'banner', label: 'バナー生成', note: '統括のバナー生成でこの店の AI を使います' },
  { id: 'google_review', label: 'Google口コミの返信案', note: '口コミへの返信の下書きを AI が作ります' },
]
type Settings = { items: AccountAiSetting[]; disclosure: string; disclosureVersion: string }
const subscribeSession = (listener: () => void) => {
  window.addEventListener(SESSION_SNAPSHOT_CHANGED, listener)
  return () => window.removeEventListener(SESSION_SNAPSHOT_CHANGED, listener)
}

export default function AiFeatures({ accountId, canManage, lockedReason }: { accountId: string; canManage: boolean; lockedReason?: string }) {
  const session = useSyncExternalStore(subscribeSession, readPermissionSessionSnapshot, () => null)
  const impersonating = Boolean(session?.impersonation)
  const reason = impersonating ? IMPERSONATION_REASON : lockedReason
  const canEdit = canManage && !impersonating
  const saveErrors = useSaveFormErrors()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loading, setLoading] = useState(canManage)
  const [open, setOpen] = useState(true)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [pending, setPending] = useState<AccountAiSetting | null>(null)
  const [agreed, setAgreed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savingFeature, setSavingFeature] = useState<AccountAiFeature | null>(null)
  const savingRef = useRef(false)
  const [stepUp, setStepUp] = useState<StepUpRequest | null>(null)
  const load = useCallback(async () => {
    setLoading(true); setError(''); setInfo(''); setPending(null); setAgreed(false); setStepUp(null)
    try {
      const result = await accountAiFeaturesApi.get(accountId)
      if (!result.success) throw new Error('load failed')
      setSettings(result.data)
    } catch { setSettings(null); setError('AI の機能を読み込めませんでした。もう一度お試しください。') }
    finally { setLoading(false) }
  }, [accountId])
  useEffect(() => { if (canManage) void load() }, [canManage, load])
  useEffect(() => { if (!canEdit) { setPending(null); setAgreed(false); setStepUp(null) } }, [canEdit])
  useEffect(() => {
    if (window.location.hash !== '#ai-features') return
    const frame = requestAnimationFrame(() => document.getElementById('ai-features')?.scrollIntoView({ block: 'start' }))
    return () => cancelAnimationFrame(frame)
  }, [])
  const save = async (item: AccountAiSetting, enabled: boolean, token?: string) => {
    if (!canEdit || readPermissionSessionSnapshot()?.impersonation || !settings || savingRef.current) return
    savingRef.current = true
    saveErrors.reset()
    setSavingFeature(item.feature)
    setSaving(true); setError(''); setInfo('')
    try {
      const result = await accountAiFeaturesApi.save(accountId, item.feature, { enabled, expectedVersion: item.version, ...(enabled ? { consent: true, disclosureVersion: settings.disclosureVersion } : {}) }, token)
      if (!result.success) throw new Error('save failed')
      setSettings(current => current ? { ...current, items: current.items.map(row => row.feature === item.feature ? result.data : row) } : current)
      setPending(null); setAgreed(false)
    } catch (cause) {
      if (enabled && !token && isStepUpRequired(cause)) {
        setStepUp({ purpose: 'ai.settings', action: `${FEATURES.find(row => row.id === item.feature)?.label ?? 'AI の機能'}をオンにする`, retry: async grant => { await save(item, true, grant) } })
      } else if (cause instanceof ApiError && (cause.status === 409 || cause.code === 'ai_consent_required')) {
        try {
          const refreshed = await accountAiFeaturesApi.get(accountId)
          if (!refreshed.success) throw new Error('reload failed')
          setSettings(refreshed.data); setAgreed(false)
          if (cause.code === 'ai_consent_required') {
            setPending(refreshed.data.items.find(row => row.feature === item.feature) ?? null)
            setError('同意文が更新されました。内容を確認してもう一度同意してください。')
          } else {
            setPending(null)
            setInfo('ほかの人が先に変更しました。最新の状態を表示しています。')
          }
        } catch (failure) { if (!saveErrors.capture(failure)) { setPending(null); setError('最新の設定を読み込めませんでした。もう一度お試しください。') } }
      } else if (saveErrors.capture(cause)) {
        // 同意の窓からは、窓の外のスイッチにある理由が見えない。
        if (enabled) setError('入力内容を確認してください。')
      } else if (cause instanceof ApiError && cause.status === 403) {
        setPending(null); setAgreed(false)
        setError(cause.code === 'IMPERSONATION_WRITE_BLOCKED' ? IMPERSONATION_REASON : 'AI の機能を変更する権限がありません。オーナーまたは管理者に依頼してください。')
      } else setError('AI の機能を保存できませんでした。設定を読み直してからお試しください。')
    } finally { savingRef.current = false; setSaving(false) }
  }
  const enabledCount = settings?.items.filter(item => FEATURES.some(feature => feature.id === item.feature) && item.enabled).length
  const Chevron = open ? ChevronDown : ChevronRight
  return <SaveErrorScope errors={saveErrors}><Card as="section" id="ai-features" overflow="hidden" aria-label="AI の機能">
    <div className={styles.groupHead}>
      <IconButton size="small" variant="plain" aria-expanded={open} aria-label={`AI の機能を${open ? '畳む' : '開く'}`} onClick={() => setOpen(!open)}><Chevron className={styles.chevron} aria-hidden="true" /></IconButton>
      <h2 className={styles.groupTitle}>AI の機能</h2><span className={styles.spacer} />
      <span className={styles.groupMeta}>{enabledCount === undefined ? '状態を確認できません' : `${FEATURES.length}件中${enabledCount}件オン`}</span>
    </div>
    {open ? <>
      <div className={styles.row}><p className={styles.rowNote}>切り替えるとすぐ保存されます。オンには同意と本人確認が必要です。</p></div>
      {reason ? <Notice tone="info">{reason}</Notice> : null}
      {loading && canManage ? <ListState kind="loading" /> : null}
      {info ? <Notice tone="info" role="status">{info}</Notice> : null}
      {error && !pending ? <Notice tone="danger" action={!error.includes('権限がありません') && error !== IMPERSONATION_REASON ? <Button size="compact" onClick={() => void load()} disabled={saving}>読み直す</Button> : undefined}>{error}</Notice> : null}
      <ul className={styles.rows}>{FEATURES.map(feature => {
        const item = settings?.items.find(row => row.feature === feature.id)
        return <li className={styles.row} key={feature.id}>
          <div className={styles.rowText}><p className={styles.rowName}><span className={styles.rowLabel}>{feature.label}</span></p><p className={styles.rowNote}>{feature.note}</p></div>
          <SaveErrorField names={[feature.id, ...(savingFeature === feature.id ? ['enabled'] : [])]}><Toggle label={feature.label} checked={item?.enabled ?? false} disabled={loading || saving || (canManage && !item) || (!canEdit && !reason)} lockedReason={!canEdit ? reason : undefined} onChange={next => { if (!item || !canEdit) return; if (next) { setPending(item); setAgreed(false) } else void save(item, false) }} /></SaveErrorField>
        </li>
      })}</ul>
    </> : null}
    {pending && settings && !stepUp ? <Dialog open title={`${FEATURES.find(row => row.id === pending.feature)?.label}をオンにする`} onCancel={() => { if (!saving) { setPending(null); setAgreed(false) } }} footer={<DialogActions><Button onClick={() => { setPending(null); setAgreed(false) }} disabled={saving}>キャンセル</Button><Button variant="primary" disabled={!agreed || saving} onClick={() => void save(pending, true)}>同意してオンにする</Button></DialogActions>}>
      {error ? <Notice tone="danger" action={<Button size="compact" onClick={() => void load()} disabled={saving}>読み直す</Button>}>{error}</Notice> : null}
      <p>{settings.disclosure}</p><SaveErrorField names={['consent', 'disclosureVersion']}><Checkbox checked={agreed} onCheckedChange={setAgreed}>内容に同意します</Checkbox></SaveErrorField>
    </Dialog> : null}
    {stepUp ? <StepUpPrompt request={stepUp} onDone={() => setStepUp(null)} onClose={() => setStepUp(null)} /> : null}
  </Card></SaveErrorScope>
}
