'use client'
import { type EntityPickerFolder } from '@/components/shared/entity-picker'
import { notifyToast } from '@/components/shared/toast'
import { api } from '@/lib/api'
import { runOptimisticWithUndo } from '@/lib/undoable'
import type { Tag } from '@line-crm/shared'
import type { Dispatch, SetStateAction } from 'react'
import { useCallback, useEffect, useState } from 'react'

type Options = {
  setMemoSaving: Dispatch<SetStateAction<boolean>>
  targetKey: string
  friendId: string | null
  accountId: string | null | undefined
  effectiveTags: { id: string; name: string; color: string; }[] | undefined
  setLocalTags: Dispatch<SetStateAction<{ id: string; name: string; color: string; }[] | undefined>>
  beginChange: (scope: string) => () => boolean
}

export function useFriendInfoTags({ setMemoSaving, targetKey, friendId, accountId, effectiveTags, setLocalTags, beginChange }: Options) {

  // タグの候補と新規作成。↑↓Enter で選び、×で外す。1つずつ付ける・外す（足し引き）ので、
  // ほかの人が同じ時に付けた別のタグを消さない。
  const [tagQuery, setTagQuery] = useState('')

  const [tagOptions, setTagOptions] = useState<Tag[]>([])

  const [tagActive, setTagActive] = useState(0)

  const [tagSaving, setTagSaving] = useState(false)

  useEffect(() => { setTagSaving(false); setMemoSaving(false); setTagQuery('') }, [setMemoSaving, targetKey])

  useEffect(() => {
    if (!friendId) return
    let cancelled = false
    api.tags.list().then((res) => {
      if (cancelled) return
      if (res.success && Array.isArray(res.data)) setTagOptions(res.data as Tag[])
    }).catch(() => { })
    return () => { cancelled = true }
  }, [friendId, accountId])

  const addTagById = useCallback((tagId: string, known?: { name: string; color: string }) => {
    if (!friendId || !tagId) return
    const target = known ?? tagOptions.find((t) => t.id === tagId)
    // 候補に無い ID は付けない（色は店が付けた値だけを使い、直書きしない）。
    if (!target) return
    const tag = { id: tagId, name: target.name, color: target.color }
    if ((effectiveTags ?? []).some((t) => t.id === tagId)) return
    setTagSaving(true)
    setLocalTags((now) => [...(now ?? effectiveTags ?? []), tag])
    const drop = () => setLocalTags((now) => (now ?? effectiveTags ?? []).filter((t) => t.id !== tagId))
    runOptimisticWithUndo({
      isCurrent: beginChange(`tag:${tagId}`),
      request: () => api.friends.addTag(friendId, tagId),
      revert: drop,
      reapply: () => setLocalTags((now) => [...(now ?? effectiveTags ?? []).filter((t) => t.id !== tagId), tag]),
      successMessage: `タグ「${tag.name}」を付けました`,
      failureMessage: `タグ「${tag.name}」を付けられませんでした。`,
      retry: () => addTagById(tagId, target),
      undoRequest: () => api.friends.removeTag(friendId, tagId),
      onSuccess: () => {
        setTagSaving(false)
        setTagQuery('')
      },
      onFailure: () => setTagSaving(false),
    })
  }, [friendId, tagOptions, effectiveTags, setLocalTags, beginChange])

  const removeTagById = useCallback((tagId: string) => {
    if (!friendId) return
    const tag = (effectiveTags ?? []).find((t) => t.id === tagId)
    if (!tag) return Promise.resolve(true)
    const putBack = () => setLocalTags((now) => [...(now ?? effectiveTags ?? []).filter((t) => t.id !== tagId), tag])
    setLocalTags((now) => (now ?? effectiveTags ?? []).filter((t) => t.id !== tagId))
    const isCurrent = beginChange(`tag:${tagId}`)
    return new Promise<boolean | void>((resolve, reject) => {
    runOptimisticWithUndo({
      isCurrent,
      request: async () => {
        try { return await api.friends.removeTag(friendId, tagId) }
        finally { if (!isCurrent()) resolve(undefined) }
      },
      onSuccess: () => resolve(true),
      onFailure: reject,
      revert: putBack,
      reapply: () => setLocalTags((now) => (now ?? effectiveTags ?? []).filter((t) => t.id !== tagId)),
      successMessage: `タグ「${tag.name}」を外しました`,
      failureMessage: `タグ「${tag.name}」を外せませんでした。`,
      retry: () => removeTagById(tagId),
      undoRequest: () => api.friends.addTag(friendId, tagId),
    })
    })
  }, [friendId, effectiveTags, setLocalTags, beginChange])

  const [tagFolders, setTagFolders] = useState<EntityPickerFolder[]>([])

  const loadTagFolders = useCallback(() => {
    api.tagGroups.list(accountId ?? undefined).then((res) => {
      if (res.success && Array.isArray(res.data)) setTagFolders(res.data.map((group) => ({ id: group.id, name: group.name, color: group.color ?? null })))
    }).catch(() => { })
  }, [accountId])

  /** 選ぶ窓の「＋タグを作る」。作るだけで、付けるのは窓の［選ぶ］のとき。 */
  const createTagForPicker = async (name: string) => {
    const res = await api.tags.create({ name })
    if (!res.success) return null
    const created = res.data
    setTagOptions((prev) => [...prev.filter((tag) => tag.id !== created.id), created])
    return { id: created.id, name: created.name, color: created.color, folderId: created.groupId ?? null, frequent: false }
  }

  /** 選ぶ窓で決めたタグの組へ、足りない物を付け、外した物を外す。窓で作ったタグは候補を読み直してから付ける。 */
  const applyTagSelection = async (ids: string[]) => {
    const current = new Set((effectiveTags ?? []).map((tag) => tag.id))
    const added = ids.filter((id) => !current.has(id))
    const removed = [...current].filter((id) => !ids.includes(id))
    let known = tagOptions
    if (added.some((id) => !known.some((tag) => tag.id === id))) {
      const res = await api.tags.list().catch(() => null)
      if (res?.success && Array.isArray(res.data)) { known = res.data as Tag[]; setTagOptions(known) }
    }
    for (const id of added) {
      const target = known.find((tag) => tag.id === id)
      if (target) addTagById(id, { name: target.name, color: target.color })
      else notifyToast('タグを保存できませんでした。候補を読み直してお試しください。', { tone: 'error' })
    }
    for (const id of removed) void removeTagById(id)?.catch(() => undefined)
  }

  // 購入（EC の直近3件と合計）。今ある口だけを使い、結びつきが無い人は「—」で出す。
  const createAndAddTag = async (query: string) => {
    const name = query.trim()
    if (!name || !friendId) return
    const isCurrent = beginChange('create-tag')
    setTagSaving(true)
    try {
      const res = await api.tags.create({ name })
      if (!isCurrent()) return
      if (!res.success) throw new Error('failed')
      const created = res.data
      setTagOptions((prev) => [...prev, created])
      addTagById(created.id, { name: created.name, color: created.color })
    } catch {
      if (isCurrent()) notifyToast(`タグ「${name}」を作れませんでした。もう一度お試しください。`, { tone: 'error' })
    } finally {
      if (isCurrent()) setTagSaving(false)
    }
  }
  return { tagQuery, setTagQuery, tagOptions, tagActive, setTagActive, tagSaving, addTagById, removeTagById, tagFolders, loadTagFolders, createTagForPicker, applyTagSelection, createAndAddTag }
}
