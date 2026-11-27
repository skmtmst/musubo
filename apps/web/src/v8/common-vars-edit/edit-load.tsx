'use client'

import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { api,ApiError,type CommonVarDetail } from '@/lib/api'
import type { CommonVarSchedule,Folder } from '@line-crm/shared'
import type { Dispatch,RefObject,SetStateAction } from 'react'

type LoadCommonVarContext = {
  accountLoading: boolean
  applyDetail: (found: CommonVarDetail) => void
  id: string
  latestAccountRef: RefObject<string | null>
  saveErrors: ReturnType<typeof useSaveFormErrors>
  selectedAccountId: string | null
  setConflict: Dispatch<SetStateAction<{ actorName: string | null; savedAt: string | null; } | null>>
  setError: Dispatch<SetStateAction<string>>
  setFolders: Dispatch<SetStateAction<Folder[]>>
  setFoldersError: Dispatch<SetStateAction<boolean>>
  setItem: Dispatch<SetStateAction<CommonVarDetail | null>>
  setLoadFailure: Dispatch<SetStateAction<"error" | "missing" | null>>
  setLoading: Dispatch<SetStateAction<boolean>>
  setSchedules: Dispatch<SetStateAction<CommonVarSchedule[]>>
  setSchedulesError: Dispatch<SetStateAction<boolean>>
}

export async function loadCommonVar({ accountLoading, applyDetail, id, latestAccountRef, saveErrors, selectedAccountId, setConflict, setError, setFolders, setFoldersError, setItem, setLoadFailure, setLoading, setSchedules, setSchedulesError }: LoadCommonVarContext) {
    if (!id) {
      setLoading(false)
      setError('')
      setLoadFailure(null)
      return
    }
    const accountAtRequest = selectedAccountId
    if (!accountAtRequest) {
      setItem(null)
      setLoading(false)
      setError(accountLoading ? '' : 'LINEアカウントを選択してください')
      setLoadFailure(null)
      return
    }
    setLoading(true)
    setError('')
    setLoadFailure(null)
    setFoldersError(false)
    setSchedulesError(false)
    try {
      const [detailResult, folderResult, scheduleResult] = await Promise.all([
        api.commonVars.detail(id, accountAtRequest).then(
          (data) => ({ ok: true as const, data }),
          (caught: unknown) => ({ ok: false as const, caught }),
        ),
        api.folders.list('common_var').then(
          (data) => ({ ok: true as const, data }),
          (caught: unknown) => ({ ok: false as const, caught }),
        ),
        api.commonVars.schedules(id, accountAtRequest).then(
          (data) => ({ ok: true as const, data }),
          (caught: unknown) => ({ ok: false as const, caught }),
        ),
      ])
      if (accountAtRequest !== latestAccountRef.current) return
      if (folderResult.ok && folderResult.data.success) {
        setFolders(folderResult.data.data)
        setFoldersError(false)
      } else {
        setFoldersError(true)
      }
      if (scheduleResult.ok && scheduleResult.data.success) {
        setSchedules(scheduleResult.data.data)
        setSchedulesError(false)
      } else {
        setSchedulesError(true)
      }
      if (!detailResult.ok) {
        if (detailResult.caught instanceof ApiError && detailResult.caught.status === 404) {
          setError('この共通情報は見つかりませんでした')
          setLoadFailure('missing')
        } else {
          setError('読み込みに失敗しました。もう一度読み込んでください。')
          setLoadFailure('error')
        }
        return
      }
      if (!detailResult.data.success) {
        setError('読み込みに失敗しました。もう一度読み込んでください。')
        setLoadFailure('error')
        return
      }
      const found = detailResult.data.data
      if (!found) {
        setError('この共通情報は見つかりませんでした')
        setLoadFailure('missing')
        return
      }
      applyDetail(found)
      setConflict(null)
    } catch (saveFailure) {
      if (accountAtRequest !== latestAccountRef.current) return
      const fieldFailure = saveErrors.capture(saveFailure)
      { if (!fieldFailure)

      setError('読み込みに失敗しました。もう一度読み込んでください。') }
      { if (!fieldFailure)
      setLoadFailure('error') }
    } finally {
      if (accountAtRequest === latestAccountRef.current) setLoading(false)
    }
  }
