'use client'
import { useOverlayFocus } from '@/components/shared/overlay-utils';
import { ApiError, api, fetchApi, type ChatDetail as ApiChatDetail, type ChatListItem } from '@/lib/api';
import { UNANSWERED_REFRESH_EVENT } from '@/lib/events';
import { runOptimistic } from '@/lib/undoable';
import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Chat } from './inbox-model';
import { useStaffRole } from '@/lib/staff-role';
import { canEditFeature } from '@/lib/staff-capability';

type Options = {
  chatDetail: ApiChatDetail | null
  selectedChatId: string | null
  loadChatDetail: (chatId: string) => Promise<void>
  loadChats: () => Promise<void>
  setError: Dispatch<SetStateAction<string>>
  setChatDetail: Dispatch<SetStateAction<ApiChatDetail | null>>
  setChats: Dispatch<SetStateAction<ChatListItem[]>>
}

export function useInboxActions({ chatDetail, selectedChatId, loadChatDetail, loadChats, setError, setChatDetail, setChats }: Options) {
  const staffRole = useStaffRole()

  const [showMemoEditor, setShowMemoEditor] = useState(false)

  const [memoDraft, setMemoDraft] = useState('')

  const [memoSaving, setMemoSaving] = useState(false)

  const [memoError, setMemoError] = useState('')

  const [attentionSaving, setAttentionSaving] = useState(false)

  useEffect(() => {
    setMemoDraft(chatDetail?.notes ?? '')
    setMemoError('')
    setShowMemoEditor(false)
  }, [chatDetail?.id, chatDetail?.notes])

  /*
   * 対応状況の切替は取り消せる軽い操作。押した瞬間に画面へ反映して
   * 裏で保存する（★管理画面 sTJsh §1）。失敗したら元の状況へ戻す。
   */
  const handleStatusUpdate = (newStatus: Chat['status']) => {
    if (!selectedChatId || !chatDetail) return
    const chatId = selectedChatId
    const previous = chatDetail.status
    const revision = chatDetail.revision
    const apply = (status: Chat['status']) => {
      setChatDetail((current) => (current?.id === chatId ? { ...current, status } : current))
      setChats((prev) => prev.map((chat) => (chat.id === chatId ? { ...chat, status } : chat)))
    }
    apply(newStatus)
    runOptimistic({
      request: () => api.chats.update(chatId, { status: newStatus, revision }),
      revert: () => apply(previous),
      failureMessage: '対応状況を変えられませんでした。',
      retry: () => handleStatusUpdate(newStatus),
      onSuccess: () => {
        loadChatDetail(chatId)
        loadChats()
        // 対応済み/未読の切替は未対応バッジに影響するので即時更新させる
        window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT))
      },
    })
  }

  /** 友だち一覧と同じ「注目」を受信箱の★から切り替える。 */
  const handleAttentionUpdate = async () => {
    if (!chatDetail || attentionSaving || !canEditFeature('/friends', staffRole)) return
    const updatingChatId = chatDetail.id
    const updatingFriendId = chatDetail.friendId
    const next = !chatDetail.isAttention
    const apply = (isAttention: boolean) => {
      setChatDetail((current) => current?.id === updatingChatId ? { ...current, isAttention } : current)
      setChats((current) => current.map((chat) => chat.friendId === updatingFriendId ? { ...chat, isAttention } : chat))
    }
    setAttentionSaving(true)
    apply(next)
    try {
      // N-040(#808): 友だちの現行改訂値を読んでから送り、競合は上書きしない。
      const detail = await fetchApi<{ success: boolean; data: { updatedAt: string } }>(
        `/api/friends/${chatDetail.friendId}`,
      )
      if (!detail?.success || typeof detail.data?.updatedAt !== 'string' || !detail.data.updatedAt.trim()) throw new Error('friend_version_unavailable')
      const saved = await fetchApi<{ success: boolean; data: unknown }>(
        `/api/friends/${chatDetail.friendId}/metadata?expectedUpdatedAt=${encodeURIComponent(detail.data.updatedAt)}`,
        { method: 'PUT', body: JSON.stringify({ __attention: next ? '1' : null }) },
      )
      if (!saved?.success) throw new Error('attention_update_failed')
      apply(next)
    } catch (error) {
      apply(!next)
      if (error instanceof ApiError && error.status === 409) {
        setError('ほかの変更が先に保存されました。最新の状態で確認してもう一度お試しください。')
      } else {
        setError('注目の変更に失敗しました。時間をおいて、もう一度お試しください。')
      }
    } finally {
      setAttentionSaving(false)
    }
  }

  /*
   * 内部メモの紙を閉じる。Escape・キャンセル・フォーカス戻しで
   * 共通なので1か所にする(N-031)。
   */
  const closeMemoEditor = useCallback(() => {
    setMemoDraft(chatDetail?.notes ?? '')
    setMemoError('')
    setShowMemoEditor(false)
  }, [chatDetail?.notes])

  /*
   * role="dialog" の紙なのに Tab が裏の送信欄へ抜け、閉じても
   * フォーカスがボタンへ戻らなかった(N-031)。共通部品と同じ
   * useOverlayFocus で、Tabを紙の中に留め・Escapeで閉じ・
   * 閉じたら開いたボタンへフォーカスを戻す。
   */
  const memoPopoverRef = useOverlayFocus(showMemoEditor, closeMemoEditor, memoSaving)

  return { showMemoEditor, setShowMemoEditor, memoDraft, setMemoDraft, memoSaving, setMemoSaving, memoError, setMemoError, attentionSaving, setAttentionSaving, handleStatusUpdate, handleAttentionUpdate, closeMemoEditor, memoPopoverRef }
}
