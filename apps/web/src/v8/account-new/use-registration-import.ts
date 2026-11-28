import { useEffect, useRef, useState } from 'react'
import { api, type FollowerImportState } from '@/lib/api'
import { ApiError } from '@/lib/api/transport/errors'
import { handoverProgress, isValidFollowerImportState, latestFollowerImportState } from './check-rows'

export function useRegistrationImport(createdId: string, enabled: boolean, initialPhase: FollowerImportState['phase'] | undefined, preference: boolean | undefined, resumed: boolean) {
  const [importState, setImportState] = useState<FollowerImportState | null>(null)
  const [importReadError, setImportReadError] = useState(false)
  const [importStepError, setImportStepError] = useState(false)
  const importRequestError = importReadError || importStepError
  const [importRefreshing, setImportRefreshing] = useState(false)
  const [idleSeconds, setIdleSeconds] = useState(0)
  const importProgressRef = useRef('')
  const importFriends = preference ?? Boolean(importState && importState.phase !== 'not_started')
  const importPhase = importState?.phase ?? initialPhase
  const importRunning = importPhase === 'importing_ids' || importPhase === 'hydrating_profiles'
  const importAttention = (importRunning || importState?.phase === 'completed') && (Boolean(importState?.lastError) || importRequestError || (importRunning && idleSeconds >= 60))

  /* ⑤：画面を開いている間は1回ぶんが終わるたびに次を呼ぶ。
   * 本番では cron も拾うが、検証環境は cron を無効にしている。 */
  useEffect(() => {
    if (!createdId || !enabled || !importRunning || !importFriends) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const advance = async () => {
      try {
        const response = await api.lineAccounts.stepFollowerImport(createdId)
        if (!active) return
        if (!response.success || !isValidFollowerImportState(response.data?.state)) {
          setImportStepError(true)
          timer = setTimeout(() => void advance(), 5000)
          return
        }
        setImportStepError(false)
        setImportState((current) => latestFollowerImportState(current, response.data.state))
        if (['importing_ids', 'hydrating_profiles'].includes(response.data.state.phase)) {
          /* 進めた直後は待たない（0.5秒は、何も進まない応答が続いたときの空回り止め）。 */
          timer = setTimeout(() => void advance(), response.data.busy ? 3000 : 500)
        }
      } catch (saveFailure) {
        if (saveFailure instanceof ApiError && [403, 404, 409].includes(saveFailure.status)) { if (active) setImportStepError(true); return }
        if (active) {
          setImportStepError(true)
          timer = setTimeout(() => void advance(), 5000)
        }
      }
    }
    void advance()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [createdId, enabled, importRunning, importFriends])

  // ⑤：バックグラウンドで進む状態も読む。POST が一時的に失敗しても表示を止めない。
  useEffect(() => {
    if (!enabled || !createdId || (!importFriends && !resumed)) return
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const response = await api.lineAccounts.followerImportState(createdId)
        if (active && response.success && isValidFollowerImportState(response.data)) {
          setImportState((current) => latestFollowerImportState(current, response.data))
          setImportReadError(false)
          if (response.data.phase === 'completed') setImportStepError(false)
        } else if (active) setImportReadError(true)
      } catch {
        if (active) setImportReadError(true)
      }
      if (active) timer = setTimeout(() => void poll(), 5000)
    }
    void poll()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [enabled, createdId, importFriends, resumed])

  // ⑤：件数・段階が動いたら待ち時間を戻す。時間は目安をでっち上げず更新確認に使う。
  const importProgressKey = importState
    ? `${importState.phase}:${importState.received}:${importState.imported}:${importState.alreadyPresent}:${importState.profilesProcessed}:${importState.profilesUpdated}`
    : ''
  useEffect(() => {
    if (!importProgressKey || importProgressRef.current === importProgressKey) return
    importProgressRef.current = importProgressKey
    setIdleSeconds(0)
  }, [importProgressKey])
  useEffect(() => {
    if (!enabled || !importRunning) return
    const timer = setInterval(() => setIdleSeconds((current) => current + 1), 1000)
    return () => clearInterval(timer)
  }, [enabled, importRunning])

  const handover = handoverProgress({
    phase: importState?.phase ?? initialPhase ?? 'not_started',
    received: importState?.received ?? 0,
    imported: importState?.imported ?? 0,
    alreadyPresent: importState?.alreadyPresent ?? 0,
    reactivated: importState?.reactivated ?? 0,
    claimedUnassigned: importState?.claimedUnassigned ?? 0,
    conflicts: importState?.conflicts ?? 0,
    invalid: importState?.invalid ?? 0,
    profilesUpdated: importState?.profilesUpdated ?? 0,
  })
  const refreshImport = async () => {
    if (!createdId || importRefreshing) return
    setImportRefreshing(true)
    try {
      const response = await api.lineAccounts.followerImportState(createdId)
      if (response.success && isValidFollowerImportState(response.data)) {
        setImportState((current) => latestFollowerImportState(current, response.data))
        setImportReadError(false)
        if (response.data.phase === 'completed') setImportStepError(false)
      } else setImportReadError(true)
    } catch {
      setImportReadError(true)
    } finally {
      setImportRefreshing(false)
    }
  }
  return { importState, importRunning, importFriends, importAttention, importRequestError, importRefreshing, idleSeconds, handover, refreshImport }
}
