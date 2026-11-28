'use client'

import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { api,type CommonVarReplacementCandidate,type CommonVarReplacementImpact } from '@/lib/api'
import type { CommonVar,CommonVarDeleteImpact } from '@line-crm/shared'
import type { Dispatch,RefObject,SetStateAction } from 'react'
import { MAX_BATCH_DELETE_COUNT } from './list-model'
import { reasonRequirement } from './model'
import { formatNumber } from '@/lib/format'

type OpenCommonVarDeleteContext = {
  deleteRequestRef: RefObject<{ accountId: string | null; itemId: string | null; generation: number; }>
  saveErrors: ReturnType<typeof useSaveFormErrors>
  selectedAccountId: string | null
  setDeleteChoice: Dispatch<SetStateAction<"stop" | "replace">>
  setDeleteError: Dispatch<SetStateAction<string>>
  setDeleteImpact: Dispatch<SetStateAction<CommonVarDeleteImpact | null>>
  setDeletePhase: Dispatch<SetStateAction<"loading" | "idle" | "ready" | "error">>
  setDeleteReason: Dispatch<SetStateAction<string>>
  setDeleteTarget: Dispatch<SetStateAction<CommonVar | null>>
  setReplacementCandidates: Dispatch<SetStateAction<CommonVarReplacementCandidate[]>>
  setReplacementId: Dispatch<SetStateAction<string>>
  setReplacementImpact: Dispatch<SetStateAction<CommonVarReplacementImpact | null>>
  setReplacementPhase: Dispatch<SetStateAction<"loading" | "idle" | "ready" | "error">>
  setTypedKey: Dispatch<SetStateAction<string>>
  setUsageExpanded: Dispatch<SetStateAction<boolean>>
}

export async function openCommonVarDelete({ deleteRequestRef, saveErrors, selectedAccountId, setDeleteChoice, setDeleteError, setDeleteImpact, setDeletePhase, setDeleteReason, setDeleteTarget, setReplacementCandidates, setReplacementId, setReplacementImpact, setReplacementPhase, setTypedKey, setUsageExpanded }: OpenCommonVarDeleteContext, item: CommonVar) {
    setDeleteTarget(item)
    setTypedKey('')
    setDeleteReason('')
    setDeleteError('')
    setDeleteImpact(null)
    setDeletePhase('loading')
    setDeleteChoice('replace')
    setUsageExpanded(false)
    setReplacementCandidates([])
    setReplacementId('')
    setReplacementImpact(null)
    setReplacementPhase('loading')
    if (!selectedAccountId) {
      setDeletePhase('error')
      setReplacementPhase('error')
      return
    }
    /*
     * 遅れて返った別の共通情報の結果を映さない。Aを読み込み中に窓を
     * 閉じてBを開くと、あとから返るAの結果がBの窓に出る。
     */
    const request = {
      accountId: selectedAccountId,
      itemId: item.id,
      generation: deleteRequestRef.current.generation + 1,
    }
    deleteRequestRef.current = request
    const isCurrentRequest = () =>
      deleteRequestRef.current.accountId === request.accountId &&
      deleteRequestRef.current.itemId === request.itemId &&
      deleteRequestRef.current.generation === request.generation
    const [impactResult, candidatesResult] = await Promise.allSettled([
      api.commonVars.deleteImpact(request.itemId, request.accountId),
      api.commonVars.replacementCandidates(request.itemId, request.accountId),
    ])
    if (!isCurrentRequest()) return
    const impact = impactResult.status === 'fulfilled' && impactResult.value?.success ? impactResult.value.data : null
    if (!impact || !impact.variable || typeof impact.variable.varKey !== 'string' || !Array.isArray(impact.items) || impact.items.some((item) => !item || typeof item !== 'object') || !Array.isArray(impact.unavailableReferences) || typeof impact.canDelete !== 'boolean' || !Number.isInteger(impact.total) || impact.total < 0 || !Number.isInteger(impact.blockingTotal) || impact.blockingTotal < 0) {
      setDeletePhase('error')
      setReplacementPhase('error')
      return
    }
    setDeleteImpact(impact)
    setDeletePhase('ready')
    const candidates = candidatesResult.status === 'fulfilled' && candidatesResult.value?.success ? candidatesResult.value.data?.candidates : null
    if (!Array.isArray(candidates) || candidates.some((candidate) => !candidate || typeof candidate.id !== 'string' || typeof candidate.name !== 'string' || typeof candidate.varKey !== 'string')) {
      setReplacementPhase('error')
      return
    }
    setReplacementCandidates(candidates)
    const first = candidates[0]
    if (!first) {
      setReplacementPhase('ready')
      return
    }
    setReplacementId(first.id)
    try {
      const preview = await api.commonVars.replacementImpact(request.itemId, request.accountId, first.id)
      if (!isCurrentRequest()) return
      if (!preview.success) throw new Error('replacement_impact_failed')
      setReplacementImpact(preview.data)
      setReplacementPhase('ready')
    } catch (saveFailure) {
      if (!isCurrentRequest()) return
      saveErrors.capture(saveFailure)
      setReplacementPhase('error')
    }
  }

type PrepareCommonVarRemovalContext = {
  batchRequestRef: RefObject<{ accountId: string | null; generation: number; }>
  items: CommonVar[]
  saveErrors: ReturnType<typeof useSaveFormErrors>
  selected: Set<string>
  selectedAccountId: string | null
  setBatchReason: Dispatch<SetStateAction<string>>
  setDeleteBatchError: Dispatch<SetStateAction<string>>
  setDeleteTargets: Dispatch<SetStateAction<CommonVar[]>>
  setError: Dispatch<SetStateAction<string>>
}

export async function prepareCommonVarRemoval({ batchRequestRef, items, saveErrors, selected, selectedAccountId, setBatchReason, setDeleteBatchError, setDeleteTargets, setError }: PrepareCommonVarRemovalContext) {
    if (selected.size === 0 || !selectedAccountId) return
    if (selected.size > MAX_BATCH_DELETE_COUNT) {
      setError(`一度に削除できるのは${MAX_BATCH_DELETE_COUNT} 件までです。フォルダや検索で絞り込んで分けて削除してください。`)
      return
    }
    const request = {
      accountId: selectedAccountId,
      generation: batchRequestRef.current.generation + 1,
    }
    batchRequestRef.current = request
    const isCurrentRequest = () =>
      batchRequestRef.current.accountId === request.accountId &&
      batchRequestRef.current.generation === request.generation
    setError('')
    setDeleteBatchError('')
    try {
      const impacts = await Promise.all(
        [...selected].map(async (id) => {
          const response = await api.commonVars.deleteImpact(id, request.accountId)
          if (!response.success) throw new Error(response.error)
          return { id, impact: response.data }
        }),
      )
      if (!isCurrentRequest()) return
      const blocked = impacts.filter(({ impact }) => !impact.canDelete)
      if (blocked.length > 0) {
        const references = blocked.reduce((sum, { impact }) => sum + impact.total, 0)
        setError(`${formatNumber(blocked.length)} 件は、合計${references}か所で使用中のため削除できません。`)
        return
      }
    } catch (saveFailure) {
      if (!isCurrentRequest()) return
      const fieldFailure = saveErrors.capture(saveFailure)
      { if (!fieldFailure)

      setError('使用先を確認できないため削除できません。もう一度お試しください。') }
      return
    }

    if (!isCurrentRequest())


 return
    const targets = items.filter((item) => selected.has(item.id))
    if (targets.length !== selected.size) {
      if (!saveErrors.fail("selected", '選択した共通情報を確認できませんでした。状態を読み直してから、もう一度お試しください。'))
      setError('選択した共通情報を確認できませんでした。状態を読み直してから、もう一度お試しください。')
      return
    }
    setBatchReason('')
    setDeleteTargets(targets)
  }

type RemoveCommonVarsContext = {
  batchReason: string
  batchRequestRef: RefObject<{ accountId: string | null; generation: number; }>
  deleteTargets: CommonVar[]
  deleting: boolean
  load: () => Promise<void>
  saveErrors: ReturnType<typeof useSaveFormErrors>
  selectedAccountId: string | null
  setBatchReason: Dispatch<SetStateAction<string>>
  setDeleteBatchError: Dispatch<SetStateAction<string>>
  setDeleteTargets: Dispatch<SetStateAction<CommonVar[]>>
  setDeleting: Dispatch<SetStateAction<boolean>>
  setSelected: Dispatch<SetStateAction<Set<string>>>
}

export async function removeCommonVars({ batchReason, batchRequestRef, deleteTargets, deleting, load, saveErrors, selectedAccountId, setBatchReason, setDeleteBatchError, setDeleteTargets, setDeleting, setSelected }: RemoveCommonVarsContext) {
    if (deleteTargets.length === 0 || !selectedAccountId || deleting) return
    if (reasonRequirement.check(batchReason)) {
      setDeleteBatchError('消した理由を入力してください。')
      return
    }
    const request = {
      accountId: selectedAccountId,
      generation: batchRequestRef.current.generation + 1,
    }
    batchRequestRef.current = request
    const isCurrentRequest = () =>
      batchRequestRef.current.accountId === request.accountId &&
      batchRequestRef.current.generation === request.generation
    const targets = [...deleteTargets]
    setDeleting(true)
    setDeleteBatchError('')
    const failed: CommonVar[] = []
    for (const target of targets) {
      try {
        const result = await api.commonVars.delete(target.id, request.accountId, batchReason.trim())
        if (!result.success) throw new Error(result.error)
      } catch (saveFailure) {
        saveErrors.capture(saveFailure)
        failed.push(target)
      }
      if (!isCurrentRequest())


 return
    }

    try {
      if (!isCurrentRequest())


 return
      if (failed.length > 0) {
        setDeleteTargets(failed)
        setSelected(new Set(failed.map((item) => item.id)))
        setDeleteBatchError(
          failed.length === targets.length
            ? '選択した共通情報を削除できませんでした。状態を読み直してから、もう一度お試しください。'
            : `${formatNumber(failed.length)} 件の共通情報を削除できませんでした。削除できなかったものだけを残しています。`,
        )
        await load()
        return
      }

      setDeleteTargets([])
      setBatchReason('')
      setSelected(new Set())
      await load()
    } finally {
      if (isCurrentRequest()) setDeleting(false)
    }
  }
