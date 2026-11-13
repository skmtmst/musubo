'use client'

import { isConflictResponse } from '@/components/shared/save-conflict'

import { permissionDeniedMessage } from '@/components/shared/api-error-message'
import { useSaveFormErrors } from '@/components/shared/save-form-errors'
import { notifyToast } from '@/components/shared/toast'
import { api,ApiError } from '@/lib/api'
import type { Dispatch,RefObject,SetStateAction } from 'react'
import { AutoReply,PendingToggle } from './list-model'
import { formatNumber } from '@/lib/format'
import { canEditAutoReplyListNow } from './list-access'

type ToggleAutoReplyContext = {
  listContextKey: string
  isCurrent?: () => boolean
  load: () => Promise<void>
  pendingToggle: PendingToggle | null
  rules: AutoReply[]
  saveErrors: ReturnType<typeof useSaveFormErrors>
  selectedAccountId: string | null
  selectedAccountIdRef: RefObject<string | null>
  setOptimisticRows: Dispatch<SetStateAction<{ key: string; rows: AutoReply[]; } | null>>
  setPendingToggle: Dispatch<SetStateAction<PendingToggle | null>>
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>
  setToggleError: Dispatch<SetStateAction<string>>
  setToggleReason: Dispatch<SetStateAction<string>>
  toggleReason: string
}

export function toggleAutoReply({ listContextKey, isCurrent = () => true, load, pendingToggle, rules, saveErrors, selectedAccountId, selectedAccountIdRef, setOptimisticRows, setPendingToggle, setSelectedIds, setToggleError, setToggleReason, toggleReason }: ToggleAutoReplyContext, target = pendingToggle) {
    if (!isCurrent() || !canEditAutoReplyListNow() || !target) return
    if (target.accountId !== selectedAccountId) {
      setToggleError('アカウントが切り替わりました。操作する自動応答を選び直してください。')
      return
    }
    if (target.kind === 'stop' && target.ids.some(id => !Number.isSafeInteger(target.versions?.[id]) || (target.versions?.[id] ?? 0) < 1)) {
      setToggleError('確認する内容を読み直してください。'); void load(); return
    }
    const requestAccountId = target.accountId
    const ids = target.ids
    const kind = target.kind
    const reason = toggleReason.trim() === '' ? null : toggleReason.trim()
    const key = listContextKey
    const applyOptimistic = (active: boolean, stopReasonOf: (id: string) => string | null) => {
      setOptimisticRows({
        key,
        rows: rules.map((r) =>
          ids.includes(r.id)
            ? { ...r, isActive: active, stopReason: active ? r.stopReason : stopReasonOf(r.id) }
            : r,
        ),
      })
    }
    const doneMessage = (targetKind: 'stop' | 'resume') =>
      ids.length === 1
        ? targetKind === 'resume'
          ? '自動応答を再開しました'
          : '自動応答を停止しました'
        : targetKind === 'resume'
          ? `${formatNumber(ids.length)} 件の自動応答を再開しました`
          : `${formatNumber(ids.length)} 件の自動応答を停止しました`
    const failedMessage = (targetKind: 'stop' | 'resume', forbidden: boolean) =>
      forbidden
        ? permissionDeniedMessage('store')
        : targetKind === 'stop'
          ? '自動応答を停止できませんでした。状態を読み直してからお試しください。'
          : '自動応答を再開できませんでした。状態を読み直してからお試しください。'
    const reloadIfSameAccount = () => {
      if (isCurrent() && selectedAccountIdRef.current === requestAccountId) void load()
    }
    const sendToggle = (targetKind: 'stop' | 'resume', targetReasonOf: (id: string) => string | null, requestKeys = new Map<string, string>()) => {
      if (!isCurrent() || !canEditAutoReplyListNow() || selectedAccountIdRef.current !== requestAccountId) return
      applyOptimistic(targetKind === 'resume', targetReasonOf)
      void (async () => {
        let failed = 0
        let forbidden = false
        let changed = false
        for (const id of ids) {
          if (!isCurrent()) return
          if (!canEditAutoReplyListNow() || selectedAccountIdRef.current !== requestAccountId) {
            setOptimisticRows(null)
            reloadIfSameAccount()
            return
          }
          try {
            if (!requestKeys.has(id)) requestKeys.set(id, crypto.randomUUID())
            const result = targetKind === 'stop'
              ? await api.autoReplies.stop(id, { reason: targetReasonOf(id), expectedVersion: target.versions![id] }, requestKeys.get(id)!)
              : await api.autoReplies.update(id, { isActive: true })
            if (!isCurrent()) return
            if (!result.success) failed += 1
          } catch (error) {
            if (!isCurrent()) return
            saveErrors.capture(error);

            if (error instanceof ApiError && error.status === 403) forbidden = true
            if (isConflictResponse(error) && error.code === 'auto_reply_confirmation_conflict') changed = true
            failed += 1
          }
        }
        if (failed > 0) {
          setOptimisticRows(null)
          reloadIfSameAccount()
          if (changed) { notifyToast(target.ids.length === 1 ? '内容が変わった自動応答は停止していません。一覧を読み直して確認してください。' : '内容が変わった自動応答は停止していません。ほかの対象は停止した可能性があります。一覧を読み直して確認してください。', {tone:'error'}); return }
          notifyToast(failedMessage(targetKind, forbidden), {
            tone: 'error',
            actionLabel: 'もう一度',
            onAction: () => sendToggle(targetKind, targetReasonOf, requestKeys),
          })
          return
        }
        setOptimisticRows(null)
        setSelectedIds(new Set())
        reloadIfSameAccount()
        notifyToast(doneMessage(targetKind))
      })()
    }
    setPendingToggle(null)
    setToggleReason('')
    setToggleError('')
    sendToggle(kind, () => reason)
  }
