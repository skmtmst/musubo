'use client'

import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { notifySaved } from '@/components/shared/toast'
import { api,ApiError,type CommonVarDetail } from '@/lib/api'
import { commonVarValueError,isSecretLikeVarValue } from '@/lib/common-vars'
import { focusFieldById } from '@/lib/use-form-errors'
import type { Dispatch,RefObject,SetStateAction } from 'react'
import { b244Requirements } from './edit-model'
import { saveErrorText } from './impact'

type SaveCommonVarContext = {
  changeReason: string
  expiryBehavior: "stop" | "fallback"
  fallbackValue: string
  folderId: string
  item: CommonVarDetail | null
  latestAccountRef: RefObject<string | null>
  load: () => Promise<void>
  memo: string
  name: string
  refreshBaseline: (varId: string, accountId: string, err?: ApiError) => Promise<CommonVarDetail | null>
  saveErrors: ReturnType<typeof useSaveFormErrors>
  saving: boolean
  selectedAccountId: string | null
  setChangeReason: Dispatch<SetStateAction<string>>
  setCompareOpen: Dispatch<SetStateAction<boolean>>
  setConflict: Dispatch<SetStateAction<{ actorName: string | null; savedAt: string | null; } | null>>
  setError: Dispatch<SetStateAction<string>>
  setFallbackFieldError: Dispatch<SetStateAction<string>>
  setNameFieldError: Dispatch<SetStateAction<string>>
  setPeriodFieldError: Dispatch<SetStateAction<string>>
  setReasonFieldError: Dispatch<SetStateAction<string>>
  setSaved: Dispatch<SetStateAction<boolean>>
  setSaving: Dispatch<SetStateAction<boolean>>
  setValueFieldError: Dispatch<SetStateAction<string>>
  validFrom: string
  validUntil: string
  value: string
}

export async function saveCommonVar({ changeReason, expiryBehavior, fallbackValue, folderId, item, latestAccountRef, load, memo, name, refreshBaseline, saveErrors, saving, selectedAccountId, setChangeReason, setCompareOpen, setConflict, setError, setFallbackFieldError, setNameFieldError, setPeriodFieldError, setReasonFieldError, setSaved, setSaving, setValueFieldError, validFrom, validUntil, value }: SaveCommonVarContext) {
    if (!item || saving || !selectedAccountId)
 return
    const accountAtRequest = selectedAccountId
    const nameProblem = name.trim() ? '' : '共通情報名を入力してください'
    const valueProblem = commonVarValueError(item.type, value) ?? ''
    const periodProblem = validFrom && validUntil && validFrom >= validUntil ? '有効終了は有効開始より後にしてください' : ''
    const fallbackProblem = expiryBehavior !== 'fallback' ? ''
      : !fallbackValue ? '期限切れ時に使う代替値を入力してください'
        : commonVarValueError(item.type, fallbackValue, '代替値') ?? ''
    setNameFieldError(nameProblem)
    setValueFieldError(valueProblem)
    setPeriodFieldError(periodProblem)
    setFallbackFieldError(fallbackProblem)
    const firstProblem = nameProblem ? 'cv-name' : valueProblem ? 'cv-value' : periodProblem ? 'cv-valid-from' : fallbackProblem ? 'cv-fallback-value' : null
    if (firstProblem) {
      setError('')
      focusFieldById(firstProblem)
      return
    }
    if (isSecretLikeVarValue(value)) {
      const message = '鍵やトークンのような秘密の値は共通情報に保存できません'
      if (!saveErrors.fail("value", message))
      setError(message)
      setValueFieldError(message)
      document.getElementById('cv-value')?.focus()
      return
    }
    if (expiryBehavior === 'fallback' && isSecretLikeVarValue(fallbackValue)) {
      const message = '鍵やトークンのような秘密の値は代替値にも保存できません'
      if (!saveErrors.fail("expiryBehavior", message))
      setError(message)
      setFallbackFieldError(message)
      document.getElementById('cv-fallback-value')?.focus()
      return
    }
    if ((b244Requirements.changeReason.check(changeReason) !== null)) {
      const message = '変える理由を入力してください'
      if (!saveErrors.fail("changeReason", message))
      setError(message)
      setReasonFieldError(message)
      document.getElementById('cv-change-reason')?.focus()
      return
    }
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      let preview: Awaited<ReturnType<typeof api.commonVars.impactPreview>> | null = null
      try {
        preview = await api.commonVars.impactPreview(item.id, accountAtRequest, value, item.version)
      } catch (saveFailure) {
        saveErrors.capture(saveFailure)
        preview = null
      }
      if (accountAtRequest !== latestAccountRef.current)
 return
      if (!preview?.success || typeof preview.data?.impactProof !== 'string' || !preview.data.impactProof.trim()) {
        setError('影響を確認できませんでした。しばらく待って保存し直してください')
        return
      }
      const res = await api.commonVars.update(item.id, accountAtRequest, {
        name: name.trim(),
        value,
        memo,
        folderId: folderId || null,
        expectedVersion: item.version,
        changeReason: changeReason.trim(),
        impactProof: preview.data.impactProof,
        validFrom: validFrom || null,
        validUntil: validUntil || null,
        expiryBehavior,
        fallbackValue: expiryBehavior === 'fallback' ? fallbackValue : null,
      })
      if (accountAtRequest !== latestAccountRef.current) return
      if (!res.success) {
        setError(res.error)
        if (res.error.includes('代替値')) setFallbackFieldError(res.error)
        else if (res.error.includes('値')) setValueFieldError(res.error)
        return
      }
      setSaved(true); notifySaved()
      setChangeReason('')
      setConflict(null)
      setCompareOpen(false)
      void load()
    } catch (e) {
      const fieldFailure = saveErrors.capture(e);

      if (e instanceof ApiError && (e.status === 428 || e.status === 409)) {
        if (accountAtRequest !== latestAccountRef.current)
 return
        // 409 は頭の下の帯が知らせるので、本文の上に同じ知らせを重ねない。
        if (e.status === 428) { if (!fieldFailure) setError(saveErrorText(e)) }
        const fresh = await refreshBaseline(item.id, accountAtRequest, e)
        /*
         * 409は誰かが先に保存した。入力は残したまま、帯で誰の保存かを見せる
         * （板 ）。428（確認切れ）は文だけで、帯は出さない。
         */
        if (e.status === 409) {
          const latest = fresh?.history[0]
          setConflict({
            actorName: latest?.actorName ?? null,
            savedAt: latest?.createdAt ?? null,
          })
        }
        return
      }
      { if (!fieldFailure)
      setError(saveErrorText(e)) }
    } finally {
      setSaving(false)
    }
  }
