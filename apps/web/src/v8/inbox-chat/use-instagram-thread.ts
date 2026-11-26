'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { japaneseDetailOf } from '@/components/shared/api-error-message'
import { permissionLockReason } from '@/components/shared/permission-lock'
import { api, type ChatListItem } from '@/lib/api'
import { UNANSWERED_REFRESH_EVENT } from '@/lib/events'
import { canEditFeature } from '@/lib/staff-capability'
import { readStaffIdentity } from '@/lib/staff-identity-state'
import { canAdministerRole } from '@/lib/staff-role'

export type InstagramMessage = { id: string; content: string; createdAt: string; direction: 'incoming' | 'outgoing' }
export type InstagramReplyState = 'ready' | 'disconnected' | 'permission_required'
export type InstagramPendingReply = { key: string; content: string; canResolve: boolean; canResolveNotSent?: boolean; resolveAt?: string; serverNow?: string; warning?: string | null }
type Detail = { reconciliationWarning?: string | null; lateEchoNotice?: string | null; messages: InstagramMessage[]; replyState: InstagramReplyState; pendingReply?: InstagramPendingReply | null }
export type InstagramResolveOutcome = 'sent' | 'not_sent'

/** Instagram の決まり：お客さまの最後のメッセージから24時間だけ返信できる。Worker も同じ物差しで断る。 */
export const INSTAGRAM_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000
/** 期限の残りを数え直す間隔。開いたまま期限を過ぎても送れる形のまま残さない。 */
const CLOCK_TICK_MS = 30 * 1000

/** 返信の宛先にする、お客さまの最後のメッセージ。お客さまから届いていなければ null。 */
export function latestIncoming(messages: readonly InstagramMessage[]): InstagramMessage | null {
  let latest: InstagramMessage | null = null
  let latestAt = -Infinity
  for (const message of messages) {
    if (message.direction !== 'incoming') continue
    const at = Date.parse(message.createdAt)
    if (Number.isFinite(at) && at >= latestAt) { latest = message; latestAt = at }
  }
  return latest
}

/** 返信できる最後の時刻（ミリ秒）。お客さまから届いていなければ null。 */
export function instagramReplyDeadline(messages: readonly InstagramMessage[]): number | null {
  const last = latestIncoming(messages)
  return last ? Date.parse(last.createdAt) + INSTAGRAM_REPLY_WINDOW_MS : null
}

/** 返信できない理由（送れる時は空）。結果の分からない返信は別の知らせで扱うので、ここには入れない。 */
export function instagramBlockedReason(detail: Detail, deadline: number | null, now: number): string {
  if (detail.replyState === 'disconnected') return '接続が切れているため返信できません。Instagram の接続を確認してください。'
  if (detail.replyState === 'permission_required') return 'DM の権限がありません。Instagram をつなぎ直してください。'
  if (deadline === null) return 'お客さまからのメッセージが無いため、まだ返信できません。'
  if (now >= deadline) return '最後のお客さまのメッセージから24時間を過ぎたため返信できません。'
  return ''
}

/**
 * 受信箱で開いた Instagram の会話1つの読み書き。中央の会話と右の欄が同じ値を見る。
 * - 開いたら読み込み、書ける人だけ既読にする（閲覧のみは読むだけ）。
 * - 送るのは1回ずつ。結果が分かるまで同じ送信キーを使い、失敗の後も同じ文なら同じキーで送る（二重送信を作らない）。
 * - 結果の分からない返信がある間は送らない。確かめた人が「送信済み／未送信」を記録して解く。
 */
export function useInstagramThread(chat: ChatListItem | null, role: string | null, onChanged: () => void) {
  const account = chat?.lineAccountId ?? ''
  const senderId = chat?.friendId ?? ''
  const instagramId = chat?.instagramId
  const threadKey = chat ? `${account}\u001f${instagramId ?? ''}\u001f${senderId}` : ''
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const [text, setTextState] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState('')
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState('')
  const [resolveNotice, setResolveNotice] = useState('')
  const serverClock = useRef<{ server: number; monotonic: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const lock = useRef(false)
  const key = useRef<string | null>(null)
  const generation = useRef(0)
  const onChangedRef = useRef(onChanged)
  onChangedRef.current = onChanged
  const canEdit = role !== null && canEditFeature('/chats', role) && !readStaffIdentity()?.readOnly
  const canConfirmNotSent = canEdit && canAdministerRole(role)

  const load = useCallback(async () => {
    if (!threadKey) return
    const current = generation.current
    try {
      const result = await api.instagram.conversation(account, senderId, instagramId)
      if (current !== generation.current) return
      if (!result.success || !result.data || !Array.isArray(result.data.messages)) throw new Error('invalid')
      const server = Date.parse(result.data.pendingReply?.serverNow ?? '')
      serverClock.current = Number.isFinite(server) ? { server, monotonic: performance.now() } : null
      setDetail(result.data)
      setLoadFailed(false)
      setNow(Date.now())
    } catch {
      if (current === generation.current) setLoadFailed(true)
    }
  }, [threadKey]) // eslint-disable-line react-hooks/exhaustive-deps -- 相手の3つの値は threadKey に入っている

  const announce = () => {
    onChangedRef.current()
    window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT))
  }

  // 相手が替わったら前の相手の文・送信キー・結果を持ち越さない。遅れて届いた前の応答も捨てる。
  useEffect(() => {
    generation.current += 1
    lock.current = false
    key.current = null
    setDetail(null)
    setLoadFailed(false)
    setTextState('')
    setSending(false)
    setSendError('')
    setResolving(false)
    setResolveError('')
    setResolveNotice('')
    void load()
  }, [load])

  /*
   * 開いたままの会話に新着が届いたら（一覧の最終受信の時刻が進んだら）本文を読み直す。
   * 期限を過ぎた会話でも、お客さまの新しいメッセージで期限が延びて返信できるようになる。
   * 入力中の文・送信キーはそのまま残す（相手は替わっていない）。
   */
  const lastMessageAt = chat?.lastMessageAt ?? null
  const seenMessageAt = useRef<{ key: string; at: string | null }>({ key: '', at: null })
  useEffect(() => {
    const seen = seenMessageAt.current
    seenMessageAt.current = { key: threadKey, at: lastMessageAt }
    // 相手が替わった時の読み込みは上の効果が持つ。ここは同じ相手で時刻が進んだ時だけ。
    if (!threadKey || seen.key !== threadKey || seen.at === lastMessageAt) return
    void load()
  }, [threadKey, lastMessageAt, load])

  useEffect(() => {
    if (!threadKey || !canEdit) return
    const current = generation.current
    void api.instagram.markConversationRead(account, senderId, instagramId)
      .then(() => { if (current === generation.current) announce() })
      .catch(() => undefined)
  }, [threadKey, canEdit]) // eslint-disable-line react-hooks/exhaustive-deps -- 相手と権限が替わった時だけ既読にする

  useEffect(() => {
    if (!threadKey) return
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => window.clearInterval(timer)
  }, [threadKey])

  const target = detail ? latestIncoming(detail.messages) : null
  const deadline = detail ? instagramReplyDeadline(detail.messages) : null
  const pendingNow = serverClock.current ? serverClock.current.server + (performance.now() - serverClock.current.monotonic) : now
  const pendingRaw = detail?.pendingReply ?? null
  const pending = pendingRaw ? { ...pendingRaw, canResolveNotSent: pendingRaw.canResolveNotSent ?? pendingRaw.canResolve, ...(pendingRaw.resolveAt && pendingNow >= Date.parse(pendingRaw.resolveAt) ? { canResolve: true, canResolveNotSent: true } : {}) } : null
  const blockedReason = detail ? instagramBlockedReason(detail, deadline, now) : ''
  const canSend = canEdit && detail !== null && !pending && !blockedReason && target !== null
  const lockedReason = role === null ? undefined : permissionLockReason(role, canEdit)

  const setText = (value: string) => {
    setTextState(value)
    // 文を変えたら別の返信。送信キーも新しくする。
    key.current = null
  }

  const send = async () => {
    if (lock.current || !canSend || !target || !text.trim()) return
    lock.current = true
    const current = generation.current
    setSending(true)
    setSendError('')
    key.current ??= crypto.randomUUID()
    try {
      await api.instagram.sendReply(account, target.id, text, key.current)
      if (current !== generation.current) return
      setTextState('')
      key.current = null
    } catch (error) {
      if (current !== generation.current) return
      setSendError(japaneseDetailOf(error) || '返信できませんでした。')
    }
    // 結果の分からない返信はサーバーが控える。読み直してから次を押せるようにし、同じ相手へ重ねて送らない。
    await load()
    if (current !== generation.current) return
    lock.current = false
    setSending(false)
    announce()
  }

  const resolve = async (outcome: InstagramResolveOutcome, reason?: string): Promise<boolean> => {
    if (!pending || !pending.canResolve || (outcome === 'not_sent' && !pending.canResolveNotSent) || !canEdit || !canConfirmNotSent || resolving) return false
    const current = generation.current
    setResolving(true)
    setResolveError('')
    try {
      const trimmedReason = reason?.trim()
      const result = trimmedReason ? await api.instagram.resolveReply(account, senderId, instagramId, pending.key, outcome, trimmedReason) : await api.instagram.resolveReply(account, senderId, instagramId, pending.key, outcome)
      if (result?.success === false) throw new Error(result.error)
      const foundSent = result?.success && result.data?.outcome === 'sent'
      if (current !== generation.current) return false
      if (foundSent) setResolveNotice(result.data?.message ?? 'Instagram で届いていたので送信済みにしました。')
      // 届いていなかった返信は、入力欄が空なら同じ文を戻し、再送時は必ず新しい送信キーにする。
      if (outcome === 'not_sent' && !foundSent) {
        if (!text.trim()) setTextState(pending.content)
        key.current = null
      } else if (key.current === pending.key) {
        key.current = null
      }
      setSendError('')
      await load()
      announce()
      return true
    } catch (error) {
      if (current === generation.current) setResolveError(japaneseDetailOf(error) || '確かめた結果を記録できませんでした。')
      return false
    } finally {
      if (current === generation.current) setResolving(false)
    }
  }

  return {
    detail, loadFailed, reload: load, text, setText, sending, sendError, send,
    canEdit, canConfirmNotSent, canSend, lockedReason, blockedReason, deadline, now, pending,
    resolve, resolving, resolveError, resolveNotice, pendingNow, clearResolveError: () => setResolveError(''),
  }
}

export type InstagramThread = ReturnType<typeof useInstagramThread>
