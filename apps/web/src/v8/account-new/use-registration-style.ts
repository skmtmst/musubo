'use client'

import { useEffect, useRef, useState } from 'react'
import type { AccountStyle } from '@line-crm/shared'
import { styleApi } from '@/lib/api/helpers/styles'
import { accountStyleUpdated } from '@/hooks/use-account-style'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { readStaffIdentity } from '@/lib/staff-identity-state'
import { registrationStorageKey } from './registration-storage'

export const REGISTRATION_STYLE_KEY = 'musubo-registration-style'

/** アカウント作成の後半だけ再開する。接続・作成をもう一度呼ばない。 */
export function useRegistrationStyle(accountId: string, enabled: boolean) {
  const resumeKey = registrationStorageKey(REGISTRATION_STYLE_KEY, readStaffIdentity())
  const [choice, setChoice] = useState<AccountStyle | ''>('')
  const [baselineChoice, setBaselineChoice] = useState<AccountStyle | ''>('')
  const [profile, setProfile] = useState<{ version: number; hasMenuAnswer: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [tick, setTick] = useState(0)
  const busyLock = useRef(false)
  const dirty = choice !== baselineChoice
  const discard = () => { setChoice(baselineChoice) }
  useEffect(() => {
    if (!enabled || !accountId) return
    let active = true
    setProfile(null); setError('')
    void styleApi.get(accountId).then(res => {
      if (!res.success) throw new Error('使い方を読み込めませんでした')
      if (!active) return
      setProfile({ version: res.data.version, hasMenuAnswer: Boolean(res.data.answers?.image) })
      const loadedChoice = res.data.styleSelected ? res.data.style : ''
      setBaselineChoice(loadedChoice)
      setChoice(current => current || loadedChoice)
    }).catch(caught => { if (active) setError(describeApiFailure(caught, '読み込み')) })
    return () => { active = false }
  }, [accountId, enabled, tick])
  const save = async () => {
    if (busyLock.current || !choice || !profile) return false
    busyLock.current = true
    setBusy(true); setError('')
    try {
      // 登録時はメニューを作らず、はじめの設定に引き継ぐ。保存済みの回答がある場合は保持する。
      const res = await styleApi.save(accountId, {
        expectedVersion: profile.version,
        style: choice,
        ...(!profile.hasMenuAnswer ? { answers: { image: { mode: 'later' } } } : {}),
      })
      if (!res.success) throw new Error('使い方を保存できませんでした。時間をおいて、もう一度お試しください。')
      setProfile({ version: res.data.version, hasMenuAnswer: true })
      setBaselineChoice(choice)
      accountStyleUpdated(accountId)
      try { if (resumeKey) sessionStorage.removeItem(resumeKey) } catch { /* 保存済みの版を再読すれば再開できる。 */ }
      return true
    } catch (caught) {
      setError(describeApiFailure(caught, '保存'))
      return false
    } finally { busyLock.current = false; setBusy(false) }
  }
  const skip = async () => {
    if (busyLock.current || !profile) return false
    busyLock.current = true
    setBusy(true); setError('')
    try {
      const res = await styleApi.save(accountId, { expectedVersion: profile.version, styleMode: 'later' })
      if (!res.success) throw new Error('スキップを保存できませんでした。時間をおいて、もう一度お試しください。')
      setProfile({ version: res.data.version, hasMenuAnswer: profile.hasMenuAnswer })
      setChoice('')
      setBaselineChoice('')
      accountStyleUpdated(accountId)
      try { if (resumeKey) sessionStorage.removeItem(resumeKey) } catch { /* 設定画面であとから変更できる。 */ }
      return true
    } catch (caught) {
      setError(describeApiFailure(caught, 'スキップ'))
      return false
    } finally { busyLock.current = false; setBusy(false) }
  }
  return { choice, setChoice, version: profile?.version ?? null, busy, error, dirty, discard, reload: () => setTick(n => n + 1), save, skip }
}
