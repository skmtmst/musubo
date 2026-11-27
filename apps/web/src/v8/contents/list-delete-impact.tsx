'use client'

import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { api } from '@/lib/api'
import type { MediaDeleteImpact,MediaItem } from '@line-crm/shared'
import type { Dispatch,RefObject,SetStateAction } from 'react'


type LoadMediaDeleteImpactContext = {
  deleteRequestRef: RefObject<number>
  impactRequestRef: RefObject<{ accountId: string | null; mediaId: string | null; generation: number; }>
  saveErrors: ReturnType<typeof useSaveFormErrors>
  selectedAccountId: string | null
  setDeleteError: Dispatch<SetStateAction<string>>
  setDeleting: Dispatch<SetStateAction<MediaItem | null>>
  setImpact: Dispatch<SetStateAction<MediaDeleteImpact | null>>
  setImpactPhase: Dispatch<SetStateAction<"error" | "idle" | "loading" | "ready">>
}

export async function loadMediaDeleteImpact({ deleteRequestRef, impactRequestRef, saveErrors, selectedAccountId, setDeleteError, setDeleting, setImpact, setImpactPhase }: LoadMediaDeleteImpactContext, item: MediaItem) {
    deleteRequestRef.current += 1
    setDeleting(item)
    setDeleteError('')
    setImpact(null)
    setImpactPhase('loading')
    if (!selectedAccountId) {
      setImpactPhase('error')
      return
    }
    /*
      **遅れて返った別のメディアの結果を映さない。** Aを読み込み中に窓を
      閉じてBを開くと、あとから返るAの結果がBの窓に出る。読んでいるものと
      押せるものが食い違う。
    */
    const generation = impactRequestRef.current.generation + 1
    const at = { accountId: selectedAccountId, mediaId: item.id, generation }
    impactRequestRef.current = at
    const isCurrent = () =>
      impactRequestRef.current.accountId === at.accountId
      && impactRequestRef.current.mediaId === at.mediaId
      && impactRequestRef.current.generation === at.generation
    try {
      const res = await api.media.deleteImpact(item.id, at.accountId)
      if (!isCurrent()) return
      if (!res.success || !res.data || !Array.isArray(res.data.references)
        || !res.data.references.every(ref => ref !== null && typeof ref === 'object')
        || !Number.isInteger(res.data.usageCount) || res.data.usageCount < 0
        || typeof res.data.canDelete !== 'boolean') throw new Error('impact_failed')
      setImpact(res.data)
      setImpactPhase('ready')
    } catch (saveFailure) {
      if (!isCurrent()) return
      saveErrors.capture(saveFailure)
      /*
        使用先が読めないときは**消させない**。7種類のどれかに残ったまま
        消すと、その画面が壊れた画像を指す。
      */
      setImpactPhase('error')
    }
  }
