'use client'

import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { api,ApiError } from '@/lib/api'
import type { MediaDeleteImpact,MediaItem } from '@line-crm/shared'
import type { Dispatch,RefObject,SetStateAction } from 'react'

type DeleteMediaItemContext = {
  deleteBusy: boolean
  deleteRequestRef: RefObject<number>
  deleting: MediaItem | null
  impactRequestRef: RefObject<{ accountId: string | null; mediaId: string | null; generation: number; }>
  latestAccountRef: RefObject<string | null>
  load: () => Promise<void>
  loadKpis: () => Promise<void>
  saveErrors: ReturnType<typeof useSaveFormErrors>
  selectedAccountId: string | null
  setDeleteBusy: Dispatch<SetStateAction<boolean>>
  setDeleteError: Dispatch<SetStateAction<string>>
  setDeleting: Dispatch<SetStateAction<MediaItem | null>>
  setImpact: Dispatch<SetStateAction<MediaDeleteImpact | null>>
  setImpactPhase: Dispatch<SetStateAction<"error" | "idle" | "loading" | "ready">>
}

export async function deleteMediaItem({ deleteBusy, deleteRequestRef, deleting, impactRequestRef, latestAccountRef, load, loadKpis, saveErrors, selectedAccountId, setDeleteBusy, setDeleteError, setDeleting, setImpact, setImpactPhase }: DeleteMediaItemContext) {
    if (!deleting || !selectedAccountId || deleteBusy) return
    const accountAtRequest = selectedAccountId
    const mediaIdAtRequest = deleting.id
    const deleteGeneration = deleteRequestRef.current + 1
    deleteRequestRef.current = deleteGeneration
    const isCurrentDelete = () =>
      deleteRequestRef.current === deleteGeneration
      && latestAccountRef.current === accountAtRequest
      && impactRequestRef.current.accountId === accountAtRequest
      && impactRequestRef.current.mediaId === mediaIdAtRequest
    setDeleteBusy(true)
    setDeleteError('')
    try {
      const res = await api.media.delete(mediaIdAtRequest, accountAtRequest)
      if (!isCurrentDelete()) return
      if (!res.success) throw new Error('delete_failed')
      setDeleting(null)
      setImpact(null)
      setImpactPhase('idle')
      setDeleteBusy(false)
      deleteRequestRef.current += 1
      void load()
      void loadKpis()
      return true
    } catch (e) {
      if (!isCurrentDelete()) return
      const fieldFailure = saveErrors.capture(e);

      if (e instanceof ApiError && e.status === 409) {
        /*
          **409 は「読んだあとに使われ始めた」。** 消せない理由が変わって
          いるので、影響を読み直してから見せる。
        */
        { if (!fieldFailure)
        setDeleteError('いま使われ始めたため、削除できませんでした。使用先を確認しています。') }
        /* 読み直しの返事も、同じ3つで照合してから映す。 */
        const at = { ...impactRequestRef.current }
        try {
          const again = await api.media.deleteImpact(mediaIdAtRequest, accountAtRequest)
          const same =
            isCurrentDelete()
            && latestAccountRef.current === accountAtRequest
            && impactRequestRef.current.accountId === at.accountId
            && impactRequestRef.current.mediaId === at.mediaId
            && impactRequestRef.current.generation === at.generation
          if (same && again.success) {
            setImpact(again.data)
            if (!fieldFailure) setDeleteError('いま使われ始めたため、削除できませんでした。使用先を読み直しました。')
          }
          else if (same) {
            setImpact(null)
            setImpactPhase('error')
            if (!fieldFailure) setDeleteError('いま使われ始めたため、削除できませんでした。')
          }
        } catch (saveFailure) {
          saveErrors.capture(saveFailure);

          if (isCurrentDelete()) {
            setImpact(null)
            setImpactPhase('error')
            if (!fieldFailure) setDeleteError('いま使われ始めたため、削除できませんでした。')
          }
        }
        return
      }
      { if (!fieldFailure)
      setDeleteError('削除できませんでした。状態を読み直してから、もう一度お試しください。') }
    } finally {
      if (isCurrentDelete()) setDeleteBusy(false)
    }
  }
