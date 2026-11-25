'use client'

import { useEffect, useRef, useState } from 'react'
import type { AccountStyle } from '@line-crm/shared'
import { styleApi } from '@/lib/api/helpers/styles'
import { accountStyleUpdated } from '@/hooks/use-account-style'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { readRegistrationPresentation } from './registration-storage'

export { REGISTRATION_STYLE_KEY } from './registration-storage'

/** アカウント作成の後半だけ再開する。接続・作成をもう一度呼ばない。 */
export function useRegistrationStyle(accountId: string, enabled: boolean, presentationKey: string | null) {
  const [choice, setChoice] = useState<AccountStyle | ''>('')
  const [baselineChoice, setBaselineChoice] = useState<AccountStyle | ''>('')
  const [profile, setProfile] = useState<{ version: number; hasMenuAnswer: boolean; selected: boolean } | null>(null)
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
    void styleApi.get(accountId, true).then(res => {
      if (!res.success) throw new Error('使い方を読み込めませんでした')
      if (!active) return
      setProfile({ version: res.data.version, hasMenuAnswer: Boolean(res.data.answers?.image), selected: res.data.styleSelected })
      const loadedChoice = res.data.styleSelected ? res.data.style : ''
      setBaselineChoice(loadedChoice)
      const draft = readRegistrationPresentation(presentationKey).choice
      setChoice(res.data.styleSelected ? loadedChoice : draft || '')
    }).catch(caught => { if (active) setError(describeApiFailure(caught, '読み込み')) })
    return () => { active = false }
  }, [accountId, enabled, presentationKey, tick])
  const save = async (selectedStyle: AccountStyle = choice as AccountStyle) => {
    if (busyLock.current || !selectedStyle || !profile) return false
    setChoice(selectedStyle)
    busyLock.current = true
    setBusy(true); setError('')
    try {
      // 登録時はメニューを作らず、はじめの設定に引き継ぐ。保存済みの回答がある場合は保持する。
      const res = await styleApi.save(accountId, {
        expectedVersion: profile.version,
        style: selectedStyle,
        ...(!profile.hasMenuAnswer ? { answers: { image: { mode: 'later' } } } : {}),
      }, true)
      if (!res.success) throw new Error('使い方を保存できませんでした。時間をおいて、もう一度お試しください。')
      setProfile({ version: res.data.version, hasMenuAnswer: true, selected: true })
      setBaselineChoice(selectedStyle)
      accountStyleUpdated(accountId)
      return true
    } catch (caught) {
      setError(describeApiFailure(caught, '保存'))
      return false
    } finally { busyLock.current = false; setBusy(false) }
  }
  return { choice, setChoice, selected: profile?.selected === true, version: profile?.version ?? null, busy, error, dirty, discard, reload: () => setTick(n => n + 1), save }
}
