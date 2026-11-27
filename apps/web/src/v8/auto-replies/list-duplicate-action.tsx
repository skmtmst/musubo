'use client'

import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { notifyToast } from '@/components/shared/toast'
import { api,ApiError } from '@/lib/api'
import type { Dispatch,RefObject,SetStateAction } from 'react'
import { AutoReply,displayName } from './list-model'
import { NO_WRITE_PERMISSION } from './words'
import { canEditAutoReplyListNow } from './list-access'

type DuplicateAutoReplyContext = {
  duplicateFeedback: { highlightedId: string | null; clear(): void; mark(sourceId: string, copyId: string): void; order<T extends { id: string; }>(rows: readonly T[], allRows?: readonly T[]): readonly T[]; }
  duplicateKeysRef: RefObject<Map<string, string>>
  duplicateLock: RefObject<boolean>
  duplicating: boolean
  load: () => Promise<void>
  nextPriority: number
  saveErrors: ReturnType<typeof useSaveFormErrors>
  selectedAccountId: string | null
  setDuplicateError: (message: string | null) => void
  setDuplicating: Dispatch<SetStateAction<boolean>>
}

export async function duplicateAutoReply({ duplicateFeedback, duplicateKeysRef, duplicateLock, duplicating, load, nextPriority, saveErrors, selectedAccountId, setDuplicateError, setDuplicating }: DuplicateAutoReplyContext, duplicateTarget: AutoReply) {
    if (!canEditAutoReplyListNow()) return
    if (duplicateLock.current) return
    if (!duplicateTarget || duplicating) return
    duplicateLock.current = true
    setDuplicating(true)
    setDuplicateError('')
    const operationId = `${selectedAccountId}:${duplicateTarget.id}`
    if (!duplicateKeysRef.current.has(operationId)) duplicateKeysRef.current.set(operationId, crypto.randomUUID())
    const source = duplicateTarget
    try {
      const result = await api.autoReplies.create({
        keyword: source.keyword,
        matchType: source.matchType,
        responseType: source.responseType,
        responseContent: source.responseContent,
        templateId: source.templateId,
        lineAccountId: source.lineAccountId,
        isActive: false,
        activeFrom: source.activeFrom,
        activeUntil: source.activeUntil,
        cooldownMinutes: source.cooldownMinutes,
        skipWhenOperatorActive: source.skipWhenOperatorActive,
        priority: nextPriority,
        messageKinds: source.messageKinds,
        receiveSources: source.receiveSources,
        actions: source.actions,
        responseWeekdays: source.responseWeekdays,
        responseHolidayRule: source.responseHolidayRule,
        oncePerFriend: source.oncePerFriend,
        keywords: source.keywords,
        friendConditions: source.friendConditions,
        respondToAll: source.respondToAll,
        name: `${displayName(source)}（コピー）`,
        keywordMatchMode: source.keywordMatchMode === 'all' ? 'all' : 'any',
        folderId: source.folderId,
        internalMemo: source.internalMemo,
      }, duplicateKeysRef.current.get(operationId)!)
      if (!result.success) {
        setDuplicateError('複製できませんでした。状態を読み直してからお試しください。')
        return
      }
      if (typeof result.data?.id !== 'string' || !result.data.id.trim()) {
        setDuplicateError('複製できたか確認できません。一覧を読み直してください。')
        return
      }

      duplicateKeysRef.current.delete(operationId)
      duplicateFeedback.mark(source.id, result.data.id)
      notifyToast('複製しました', { tone: 'success' })
      await load()
    } catch (reason) {
      const fieldFailure = saveErrors.capture(reason)

      { if (!fieldFailure)
      setDuplicateError(
        reason instanceof ApiError && reason.status === 403
          ? `${NO_WRITE_PERMISSION.label}。${NO_WRITE_PERMISSION.note}`
          : '複製できませんでした。状態を読み直してからお試しください。',
      ) }
    } finally {
      duplicateLock.current = false
      setDuplicating(false)
    }
  }
