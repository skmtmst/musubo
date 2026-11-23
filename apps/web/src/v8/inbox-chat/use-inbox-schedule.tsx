'use client'
import { notifyToast } from '@/components/shared/toast'
import { type ImageUploaderValue } from '@/components/shared/image-uploader';
import { api, type ChatDetailMessage, type ScheduledChatSend } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { IdempotencyKeyStore } from '@/lib/idempotency-key-store';
import { attachmentSendInput } from '@/v8/inbox-chat/attachments';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PendingAttachment } from './inbox-model';
import { MESSAGE_MAX_LENGTH, draftKeyOf, jstDatetimeLocalToIso } from './inbox-model';
import { describeSendFailure } from './send-failure';
import type { InsertTokenNames } from '@/components/shared/insert-tokens';

const NO_TOKEN_NAMES: InsertTokenNames = {}

type Options = {
  detailAccountRef: RefObject<string | null>
  selectedChatIdRef: RefObject<string | null>
  getFriendName?: () => string | undefined
  selectedChatId: string | null
  messageContent: string
  pendingImage: ImageUploaderValue | null
  pendingAttachment: PendingAttachment | null
  setError: Dispatch<SetStateAction<string>>
  selectedAccountId: string | null
  dropSentDraft: (chatId: string, accountId: string | null, sent: { content?: string; image?: ImageUploaderValue | null; }) => void
  pendingImageRef: RefObject<ImageUploaderValue | null>
  setPendingImage: Dispatch<SetStateAction<ImageUploaderValue | null>>
  setPendingImageMeta: Dispatch<SetStateAction<{ name: string; size: number; } | null>>
  attachDraftsRef: RefObject<Map<string, PendingAttachment>>
  putAttachment: (ownerKey: string, value: PendingAttachment | null) => void
  setMessageContent: Dispatch<SetStateAction<string>>
  quotedMessage: ChatDetailMessage | null
  sendKeysRef: RefObject<IdempotencyKeyStore>
  setQuotedMessage: Dispatch<SetStateAction<ChatDetailMessage | null>>
  /** 失敗文の差し込みの名前（返信欄と同じ名前で言う）。 */
  tokenNames?: InsertTokenNames
}

export function useInboxSchedule({ getFriendName, detailAccountRef, selectedChatIdRef, selectedChatId, messageContent, pendingImage, pendingAttachment, setError, selectedAccountId, dropSentDraft, pendingImageRef, setPendingImage, setPendingImageMeta, attachDraftsRef, putAttachment, setMessageContent, quotedMessage, sendKeysRef, setQuotedMessage, tokenNames = NO_TOKEN_NAMES }: Options) {

  // N-025: 送信予約。JSTの datetime-local 値をそのまま口へ渡し、
  // 保存はサーバー側でUTCへ正規化される。
  const [scheduledSends, setScheduledSends] = useState<ScheduledChatSend[]>([])

  // 予約一覧の取得失敗は「予約なし」と分けて持つ。0件のまま黙ると、
  // 消えたわけではない予約を送り忘れる(#962 F07)。
  const [scheduledSendsFailed, setScheduledSendsFailed] = useState(false)

  const [scheduleInput, setScheduleInput] = useState('')

  const [showSchedulePanel, setShowSchedulePanel] = useState(false)

  const [scheduling, setScheduling] = useState(false)

  // 予約送信の多重実行ロック。state の scheduling は描画を待つため、
  // 同じ tick の二度押しを止めるには ref が要る(sendLockRef と同じ型・#965)。
  const scheduleLockRef = useRef(false)

  // N-025: 会話を開いた/変えたとき、その会話の送信予約を読む。
  // 予約はfriend単位なので会話IDはそのまま使える。失敗しても画面は止めない。
  const loadScheduledSends = useCallback(async (chatId: string) => {
    // 取得の起点となったアカウントを固定する。切替後に届いた応答は捨てる。
    const requestedAccountId = detailAccountRef.current
    try {
      const res = await api.chats.scheduled(chatId)
      if (selectedChatIdRef.current !== chatId || detailAccountRef.current !== requestedAccountId) return
      // 口の形が変わったり古い環境の応答でも、一覧は必ず配列を保つ。
      if (res.success) {
        setScheduledSendsFailed(false)
        setScheduledSends(Array.isArray(res.data?.scheduled) ? res.data.scheduled : [])
      } else {
        setScheduledSendsFailed(true)
      }
    } catch {
      if (selectedChatIdRef.current !== chatId || detailAccountRef.current !== requestedAccountId) return
      // 失敗を「予約なし」にしない。一覧は空に戻さず、失敗だけを知らせる(#962)。
      setScheduledSendsFailed(true)
    }
  }, [detailAccountRef, selectedChatIdRef])

  useEffect(() => {
    // 会話を切り替えたら前の会話の予約を残さない。応答が遅れても
    // その間に前の会話の行が見える事故を防ぐ(#962 F07)。
    setScheduledSends([])
    setScheduledSendsFailed(false)
    if (selectedChatId) {
      void loadScheduledSends(selectedChatId)
    }
  }, [selectedChatId, loadScheduledSends])

  /**
   * N-025: 本文を予約送信する。画像つきは予約口がまだ持たないため止める。
   * 成功したら入力と引用をクリアし、予約一覧を読み直す。
   */
  const handleScheduleSend = async () => {
    if (!selectedChatId || scheduling || scheduleLockRef.current) return
    const content = messageContent.trim()
    /*
     * （API-15）：予約でも画像・動画・ファイルを使える。添付は1通ずつ、本文は最後に予約する
     * （同じ日時なので届く順は 添付 → 本文）。準備中・失敗の添付は予約しない。
     */
    const schedulingImage = pendingImage && pendingImage.mode === 'line-image' ? pendingImage : null
    const schedulingAttachment = pendingAttachment
    if (schedulingAttachment && schedulingAttachment.status !== 'ready') {
      setError(schedulingAttachment.status === 'uploading'
        ? `「${schedulingAttachment.name}」の準備が終わってから予約できます。`
        : `「${schedulingAttachment.name}」を準備できていません。もう一度試すか、外してから予約してください。`)
      return
    }
    if (!content && (!schedulingImage && !schedulingAttachment)) return
    // INBOX-29: 上限を超えた本文は予約もさせない。
    if (messageContent.length > MESSAGE_MAX_LENGTH) {
      setError(`メッセージは${formatNumber(MESSAGE_MAX_LENGTH)}文字までです。`)
      return
    }
    if (!scheduleInput) {
      setError('予約する日時を選んでください')
      return
    }

    const friendName = getFriendName?.()
    const schedulingChatId = selectedChatId
    const schedulingAccountId = selectedAccountId
    setScheduling(true)
    scheduleLockRef.current = true
    try {
      const scheduledAt = jstDatetimeLocalToIso(scheduleInput)
      const items: Array<{ messageType?: 'image' | 'video' | 'file'; content: string; done: () => void }> = []
      if (schedulingImage) {
        items.push({
          messageType: 'image',
          content: JSON.stringify({ originalContentUrl: schedulingImage.originalContentUrl, previewImageUrl: schedulingImage.previewImageUrl }),
          done: () => {
            dropSentDraft(schedulingChatId, schedulingAccountId, { image: schedulingImage })
            if (selectedChatIdRef.current === schedulingChatId && detailAccountRef.current === schedulingAccountId && pendingImageRef.current === schedulingImage) {
              setPendingImage(null)
              setPendingImageMeta(null)
            }
          },
        })
      }
      if (schedulingAttachment?.attachment) {
        const input = attachmentSendInput(schedulingAttachment.attachment)
        items.push({
          messageType: input.messageType as 'video' | 'file',
          content: input.content,
          done: () => {
            const key = draftKeyOf(schedulingAccountId, schedulingChatId)
            if (attachDraftsRef.current.get(key)?.job === schedulingAttachment.job) putAttachment(key, null)
          },
        })
      }
      if (content) {
        items.push({
          content,
          done: () => {
            dropSentDraft(schedulingChatId, schedulingAccountId, { content })
            if (selectedChatIdRef.current === schedulingChatId && detailAccountRef.current === schedulingAccountId) {
              setMessageContent((prev) => (prev.trim() === content ? '' : prev))
            }
          },
        })
      }
      let allScheduled = true
      let completed = 0
      for (const item of items) {
        /*
         * 同じ送信版には同じ操作キーを使い回す(#965)。通信中の二度押しや
         * 失敗後の再試行で毎回新しいキーを生やすと、処理待ちの予約行が
         * 二重に登録される。成功した版は消して、次の予約を別操作にする。
         */
        const signature = JSON.stringify({
          kind: 'schedule',
          chatId: schedulingChatId,
          messageType: item.messageType ?? 'text',
          content: item.content,
          scheduledAt: scheduleInput,
          quotedMessageId: quotedMessage?.id ?? null,
        })
        const res = await api.chats.schedule(schedulingChatId, {
          content: item.content,
          ...(item.messageType ? { messageType: item.messageType } : {}),
          // 入力欄は日本時間の約束(INBOX-21)。オフセットを付けて送り、
          // サーバー側の時間帯に左右されない同じ瞬間を保存する。
          scheduledAt,
          quotedMessageId: quotedMessage?.id,
        }, sendKeysRef.current.get(signature))
        if (!res.success) {
          if (detailAccountRef.current === schedulingAccountId && selectedChatIdRef.current === schedulingChatId) {
            setError(completed > 0 ? '一部のメッセージを予約できませんでした。未予約の入力を残しています。内容を確認してもう一度お試しください。' : '予約できませんでした。入力を確認してもう一度お試しください。')
          }
          allScheduled = false
          break
        }
        sendKeysRef.current.clear(signature)
        // 予約した版だけを消す。切替先の下書きや開いたパネルは触らない(#962 F06)。
        item.done()
        completed += 1
      }
      if (allScheduled && selectedChatIdRef.current === schedulingChatId && detailAccountRef.current === schedulingAccountId) {
        setQuotedMessage((prev) => (prev === quotedMessage ? null : prev))
        setScheduleInput((prev) => (prev === scheduleInput ? '' : prev))
        setShowSchedulePanel(false)
        notifyToast(friendName ? `「${friendName}」へのメッセージを予約しました` : 'メッセージを予約しました')
      }
      await loadScheduledSends(schedulingChatId)
    } catch (scheduleError) {
      // 別の会話・アカウントへ切り替えたあとの古い失敗は、
      // 新しい画面へ出さない(A02-04)。
      if (detailAccountRef.current === schedulingAccountId && selectedChatIdRef.current === schedulingChatId) {
        setError(describeSendFailure(scheduleError, new Date(), tokenNames))
      }
    } finally {
      setScheduling(false)
      scheduleLockRef.current = false
    }
  }

  /** 予約の取消。送信中・送信済みは口が409で拒否し、一覧を読み直す。 */
  const handleCancelScheduled = async (scheduleId: string) => {
    if (!selectedChatId) return
    try {
      const res = await api.chats.cancelScheduled(selectedChatId, scheduleId)
      if (res.success) {
        setScheduledSends((prev) => prev.filter((row) => row.id !== scheduleId))
      }
    } catch (caught) {
      setError((caught as { code?: string })?.code === 'SCHEDULE_TOO_LATE'
        ? 'まもなく送ります。取り消せません。'
        : '予約の取消に失敗しました。一覧を読み込み直してください。')
      void loadScheduledSends(selectedChatId)
    }
  }

  return { scheduledSends, scheduledSendsFailed, scheduleInput, setScheduleInput, showSchedulePanel, setShowSchedulePanel, scheduling, loadScheduledSends, handleScheduleSend, handleCancelScheduled, }
}
