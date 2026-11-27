'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { readSessionSnapshot } from '@/lib/session-snapshot'
import { useStaffRole } from '@/lib/staff-role'
import { aiReplyApi, type AiSettings } from './api'
import { aiPermissions } from './words'

export type AiSettingsStatus = 'loading' | 'ready' | 'error'

/**
 * 店の AI の段（要件 G2 §2-2）と、いまの人の権限。
 * 読めないときは「使っていない」と同じ扱いにする（空の枠・押せないボタンを出さない）。
 */
export function useAiSettings(accountId: string | null) {
  const role = useStaffRole()
  const impersonating = Boolean(readSessionSnapshot()?.impersonation)
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [status, setStatus] = useState<AiSettingsStatus>('loading')
  const generation = useRef(0)
  const accountScope = useRef({ accountId })
  if (accountScope.current.accountId !== accountId) accountScope.current = { accountId }
  const [loadedScope, setLoadedScope] = useState<object | null>(null)

  const load = useCallback(async () => {
    const mine = ++generation.current
    const scope = accountScope.current
    if (!accountId) { setSettings(null); setStatus('ready'); setLoadedScope(scope); return }
    setStatus('loading')
    try {
      const res = await aiReplyApi.settings(accountId)
      if (mine !== generation.current || accountScope.current !== scope) return
      if (!res?.success || !res.data || !['off', 'draft_only', 'auto_qa', 'suspended'].includes(res.data.mode)) throw new Error('invalid_ai_mode')
      setSettings(res.data)
      setStatus('ready')
      setLoadedScope(scope)
    } catch {
      if (mine !== generation.current || accountScope.current !== scope) return
      setSettings(null)
      setStatus('error')
      setLoadedScope(scope)
    }
  }, [accountId])

  useEffect(() => { void load() }, [load])

  const currentSettings = loadedScope === accountScope.current ? settings : null
  const currentStatus = loadedScope === accountScope.current ? status : 'loading'
  const mode = currentSettings?.mode ?? 'off'
  return { settings: currentSettings, setSettings, status: currentStatus, reload: load, mode, role, impersonating, permissions: aiPermissions(role, impersonating, mode) }
}
