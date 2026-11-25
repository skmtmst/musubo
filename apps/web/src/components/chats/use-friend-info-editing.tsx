'use client'
import { ApiError, api } from '@/lib/api'
import { runOptimisticWithUndo } from '@/lib/undoable'
import type { Dispatch, RefObject, SetStateAction } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { STATUS_WORD } from './friend-info-status'
import { asArray } from './friend-detail-shape'
import { type ChatStatusInfo, type FriendDetail } from './friend-info-types'

type Options = {
  setLocalStatus: Dispatch<SetStateAction<"in_progress" | "resolved" | "unread" | "on_hold" | null | undefined>>
  chatStatus: ChatStatusInfo | undefined
  setLocalOperatorId: Dispatch<SetStateAction<string | null | undefined>>
  operatorId: string | null | undefined
  setLocalNotes: Dispatch<SetStateAction<string | null | undefined>>
  setLocalTags: Dispatch<SetStateAction<{ id: string; name: string; color: string; }[] | undefined>>
  friend: FriendDetail | null
  revision: number | undefined
  chatId: string | null | undefined
  targetRef: RefObject<{ key: string; generation: number; }>
  onChatChanged: (() => void) | undefined
  effectiveStatus: "in_progress" | "resolved" | "unread" | "on_hold" | null | undefined
  beginChange: (scope: string) => () => boolean
  effectiveOperatorId: string | null | undefined
  operators: { id: string; name: string; }[] | undefined
  friendId: string | null
  effectiveNotes: string | null | undefined
  setFriend: Dispatch<SetStateAction<FriendDetail | null>>
  memoAreaRef: RefObject<HTMLTextAreaElement | null>
}

export function useFriendInfoEditing({ setLocalStatus, chatStatus, setLocalOperatorId, operatorId, setLocalNotes, setLocalTags, friend, revision, chatId, targetRef, onChatChanged, effectiveStatus, beginChange, effectiveOperatorId, operators, friendId, effectiveNotes, setFriend, memoAreaRef }: Options) {

  /*
   * （A-2 採用）：押した瞬間に変えて裏で保存し、白い知らせに［元に戻す］（5秒・乗せている間は止まる）。
   * 失敗したら画面を戻し、理由と［もう一度試す］。
   * 同時に直したとき：対応状況・担当は版（revision）を送らず、その項目だけを変える（ほかの人が直した
   * メモや担当を巻き戻さない）。タグは1つずつ付ける・外す（足し引き）。メモは最後に直した方を残す（下の queueMemoSave）。
   * 親（会話の頭）で変わったら、ここの持ち直しを捨てて親の値に合わせる。
   */
  useEffect(() => { setLocalStatus(undefined) }, [chatStatus?.status, setLocalStatus])

  useEffect(() => { setLocalOperatorId(undefined) }, [operatorId, setLocalOperatorId])

  useEffect(() => { setLocalNotes(undefined) }, [chatStatus?.notes, setLocalNotes])

  // 再取得のたびに同じタグが新しい配列で返るため、参照ではなく内容の変更だけを見る。
  const tagSignature = JSON.stringify(asArray(friend?.tags).map(tag => [tag.id, tag.name, tag.color]).sort((a,b) => String(a[0]).localeCompare(String(b[0]))))
  useEffect(() => { setLocalTags(undefined) }, [tagSignature, setLocalTags])

  const revisionRef = useRef<number | undefined>(revision)

  useEffect(() => { revisionRef.current = revision }, [chatId, revision])

  const noteRevision = (res: unknown) => {
    const next = (res as { data?: { revision?: unknown } } | undefined)?.data?.revision
    if (typeof next === 'number') revisionRef.current = next
  }

  const targetGeneration = targetRef.current.generation

  const changed = useCallback((res: unknown) => {
    if (targetRef.current.generation !== targetGeneration) return
    noteRevision(res)
    onChatChanged?.()
  }, [onChatChanged, targetGeneration, targetRef])

  const saveChatStatus = useCallback((next: NonNullable<ChatStatusInfo['status']>) => {
    if (!chatId) return
    const previous = effectiveStatus ?? null
    if (previous === next) return
    setLocalStatus(next)
    const isCurrent = beginChange('status')
    runOptimisticWithUndo({
      isCurrent,
      request: () => api.chats.update(chatId, { status: next }),
      revert: () => setLocalStatus(previous),
      reapply: () => setLocalStatus(next),
      successMessage: `対応状況を「${STATUS_WORD[next]}」にしました`,
      failureMessage: '対応状況を変えられませんでした。',
      retry: () => saveChatStatus(next),
      undoRequest: previous ? async () => {
        const res = await api.chats.update(chatId, { status: previous })
        if (isCurrent()) changed(res)
        return res
      } : undefined,
      onSuccess: changed,
    })
  }, [chatId, effectiveStatus, setLocalStatus, beginChange, changed])

  const saveAssignee = useCallback((nextOperatorId: string | null) => {
    if (!chatId) return
    const previous = effectiveOperatorId ?? null
    if (previous === nextOperatorId) return
    setLocalOperatorId(nextOperatorId)
    const nameOf = (id: string | null) => (id ? operators?.find((op) => op.id === id)?.name ?? '担当' : '未割り当て')
    const isCurrent = beginChange('assignee')
    runOptimisticWithUndo({
      isCurrent,
      request: () => api.chats.update(chatId, { operatorId: nextOperatorId }),
      revert: () => setLocalOperatorId(previous),
      reapply: () => setLocalOperatorId(nextOperatorId),
      successMessage: nextOperatorId ? `担当を${nameOf(nextOperatorId)}にしました` : '担当を外しました',
      failureMessage: '担当を変えられませんでした。',
      retry: () => saveAssignee(nextOperatorId),
      undoRequest: async () => {
        const res = await api.chats.update(chatId, { operatorId: previous })
        if (isCurrent()) changed(res)
        return res
      },
      onSuccess: changed,
    })
  }, [chatId, effectiveOperatorId, setLocalOperatorId, beginChange, changed, operators])

  /*
   * メモは書くのをやめて1秒で自動保存。最後に直した日時（版）で比べる：
   * 書き始めたあとにほかの人がメモを直していたら（版がずれて 409）、最新を読み直し、
   * - ほかの人が変えたのがメモ以外（対応状況など）なら、そのまま今の版で保存し直す
   * - メモも直されていたら、あとから直したこちらを残し、知らせの［元に戻す］で相手のメモに戻せる
   */
  const memoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const memoToastRef = useRef<{ dismiss: () => void } | null>(null)

  const [memoSaving, setMemoSaving] = useState(false)

  useEffect(() => {
    if (memoTimerRef.current) clearTimeout(memoTimerRef.current)
  }, [friendId, chatId, chatStatus?.notes])

  const queueMemoSave = useCallback((text: string) => {
    if (!chatId) return
    if (memoTimerRef.current) clearTimeout(memoTimerRef.current)
    const isCurrent = beginChange('memo')
    memoTimerRef.current = setTimeout(() => {
      if (!isCurrent()) return
      const previous = effectiveNotes ?? null
      const next = text.trim() || null
      if (next === previous) return
      setMemoSaving(true)
      setLocalNotes(next)
      memoToastRef.current?.dismiss()
      let overwritten: string | null | undefined
      const save = async () => {
        try {
          return await api.chats.update(chatId, { notes: next ?? '', ...(revisionRef.current !== undefined ? { revision: revisionRef.current } : {}) })
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'REVISION_CONFLICT') throw error
          const latest = await api.chats.get(chatId, { limit: 1 })
          if (!isCurrent()) return latest
          if (!latest.success) throw error
          revisionRef.current = latest.data.revision
          const theirs = latest.data.notes ?? null
          if (theirs !== previous) overwritten = theirs
          return api.chats.update(chatId, { notes: next ?? '', revision: latest.data.revision })
        }
      }
      memoToastRef.current = runOptimisticWithUndo({
        request: save,
        isCurrent,
        revert: () => setLocalNotes(previous),
        reapply: () => setLocalNotes(next),
        successMessage: '',
        failureMessage: 'メモを保存できませんでした。',
        retry: () => queueMemoSave(text),
        undoRequest: async () => {
          const back = overwritten !== undefined ? overwritten : previous
          setLocalNotes(back)
          // 書く欄（手で書く欄なので値を持たない）にも戻した文を入れる。
          if (memoAreaRef.current) memoAreaRef.current.value = back ?? ''
          const res = await api.chats.update(chatId, { notes: back ?? '' })
          if (isCurrent()) changed(res)
          return res
        },
        onSuccess: (res) => {
          setMemoSaving(false)
          changed(res)
        },
        onFailure: () => setMemoSaving(false),
        successMessageOf: () => overwritten !== undefined
          ? 'ほかの人が先にメモを直していました。あとから直したこの内容で保存しました'
          : 'メモを保存しました',
      })
    }, 1000)
  }, [chatId, beginChange, effectiveNotes, setLocalNotes, memoAreaRef, changed])

  useEffect(() => () => {
    if (memoTimerRef.current) clearTimeout(memoTimerRef.current)
  }, [])
  const saveMetadata = async (entry: { key: string }, next: string) => {
    if (!friendId) return
    const isCurrent = beginChange(`metadata:${entry.key}`)
    const res = await api.friends.updateMetadata(friendId, { [entry.key]: next || null })
    if (!isCurrent()) return
    if (!res.success) throw new Error('failed')
    setFriend((prev) => prev ? { ...prev, metadata: { ...prev.metadata, [entry.key]: next } } : prev)
  }

  return { saveMetadata, saveChatStatus, saveAssignee, memoSaving, setMemoSaving, queueMemoSave }
}
