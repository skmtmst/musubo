'use client'
import { type ImageUploaderValue } from '@/components/shared/image-uploader';
import { ApiError, api } from '@/lib/api';
import { checkAttachment, describeUploadFailure, type AttachSlot } from '@/v8/inbox-chat/attachments';
import { useEffect, useRef, useState } from 'react';
import type { PendingAttachment } from './inbox-model';
import { draftKeyOf } from './inbox-model';

type Options = {
  selectedAccountId: string | null
  selectedChatId: string | null
}

export function useInboxDraft({ selectedAccountId, selectedChatId }: Options) {

  const imageInputRef = useRef<HTMLInputElement>(null)

  const [imageError, setImageError] = useState('')

  /*
   * INBOX-23: 画像の準備(アップロード)結果は「選んだ会話」にだけ返す。
   * 完了を待つ間に別の会話・アカウントへ切り替わっても、今開いている
   * 入力欄へ書かない。進行中・失敗・添付済みも会話ごとに預かる。
   * 同一会話での選び直し・「外す」は世代を進めて古い結果を捨てる。
   */
  const imageJobGenRef = useRef(new Map<string, number>())

  const imageErrorDraftsRef = useRef(new Map<string, string>())

  const imageMetaDraftsRef = useRef(new Map<string, { name: string; size: number }>())

  const [imageBusyKeys, setImageBusyKeys] = useState<ReadonlySet<string>>(new Set())

  const [pendingImageMeta, setPendingImageMeta] = useState<{ name: string; size: number } | null>(null)

  const pendingImageMetaRef = useRef(pendingImageMeta)

  pendingImageMetaRef.current = pendingImageMeta

  const imageErrorRef = useRef(imageError)

  imageErrorRef.current = imageError

  const [imagePreviewOpen, setImagePreviewOpen] = useState(false)

  /**
   * 画像を1枚選ぶ。
   *
   * **1MB まで。** LINE はプレビュー用の画像が1MBまでで、ここは元画像と
   * プレビューに同じURLを渡している。10MB と書いてあった案内は、
   * 実際には1MBで弾かれるので直した。
   */
  const handlePickImage = async (file: File) => {
    // 選んだ時点のアカウント＋会話を固定する(INBOX-23)。完了時に
    // どこへ出すかはこの鍵で決め、今開いている会話へは直接書かない。
    const ownerKey = draftKeyOf(selectedAccountId, selectedChatId)
    const reportError = (message: string) => {
      imageErrorDraftsRef.current.set(ownerKey, message)
      if (draftOwnerKeyRef.current === ownerKey) setImageError(message)
    }
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      reportError('JPEG か PNG を選んでください')
      return
    }
    if (file.size > 1024 * 1024) {
      reportError('1MB 以下にしてください')
      return
    }
    const generation = (imageJobGenRef.current.get(ownerKey) ?? 0) + 1
    imageJobGenRef.current.set(ownerKey, generation)
    imageErrorDraftsRef.current.delete(ownerKey)
    if (draftOwnerKeyRef.current === ownerKey) setImageError('')
    setImageBusyKeys((prev) => new Set(prev).add(ownerKey))
    try {
      const res = await api.uploads.image(file)
      // 取消・別の画像への選び直しが済んでいれば、この結果は捨てる。
      if (imageJobGenRef.current.get(ownerKey) !== generation) return
      if (!res.success) {
        // 準備(アップロード)の失敗であり、相手への送信は始まっていない
        // (INBOX-31)。「送れなかった」とは言わない。
        reportError('画像を添付できませんでした。選び直してください')
        return
      }
      const value: ImageUploaderValue = {
        mode: 'line-image',
        originalContentUrl: res.data.url,
        previewImageUrl: res.data.url,
      }
      imageDraftsRef.current.set(ownerKey, value)
      imageMetaDraftsRef.current.set(ownerKey, { name: file.name, size: file.size })
      if (draftOwnerKeyRef.current === ownerKey) {
        setPendingImage(value)
        setPendingImageMeta({ name: file.name, size: file.size })
      }
    } catch {
      if (imageJobGenRef.current.get(ownerKey) !== generation) return
      reportError('画像を添付できませんでした。選び直してください')
    } finally {
      setImageBusyKeys((prev) => {
        if (imageJobGenRef.current.get(ownerKey) !== generation) return prev
        const next = new Set(prev)
        next.delete(ownerKey)
        return next
      })
    }
  }

  /*
   * ★V8 （「7. 添付」I7Skn）：クリップ・ドラッグで選んだもの。
   * 画像は今までの画像の準備へ渡す（1MB・送り方も同じ）。動画・ファイルは受信箱の添付の口
   * （API-15）へ先にアップロードし、書く欄の上の札で 準備中・済み・失敗（理由＋もう一度試す）を見せる。
   * 画像と同じく「アカウント＋会話」ごとに預かり、切り替えても前の会話の結果を今の欄へ書かない。
   */

  const attachDraftsRef = useRef(new Map<string, PendingAttachment>())

  const attachJobRef = useRef(0)

  const [pendingAttachment, setPendingAttachment] = useState<PendingAttachment | null>(null)

  const pendingAttachmentRef = useRef(pendingAttachment)

  pendingAttachmentRef.current = pendingAttachment

  const putAttachment = (ownerKey: string, value: PendingAttachment | null) => {
    if (value) attachDraftsRef.current.set(ownerKey, value)
    else attachDraftsRef.current.delete(ownerKey)
    if (draftOwnerKeyRef.current === ownerKey) setPendingAttachment(value)
  }

  const uploadAttachment = async (ownerKey: string, chatId: string, file: File, kind: 'video' | 'file') => {
    attachJobRef.current += 1
    const job = attachJobRef.current
    const base = { kind, name: file.name, size: file.size, file, job }
    putAttachment(ownerKey, { ...base, status: 'uploading' })
    try {
      const res = await api.chats.attachments.upload(chatId, file)
      if (attachDraftsRef.current.get(ownerKey)?.job !== job) return
      if (!res.success) throw new ApiError(400, res.error ?? '')
      putAttachment(ownerKey, { ...base, status: 'ready', attachment: res.data })
    } catch (uploadError) {
      if (attachDraftsRef.current.get(ownerKey)?.job !== job) return
      putAttachment(ownerKey, { ...base, status: 'failed', error: describeUploadFailure(uploadError) })
    }
  }

  const handlePickAttachment = async (file: File, slot?: AttachSlot) => {
    const ownerKey = draftKeyOf(selectedAccountId, selectedChatId)
    const check = checkAttachment(file, slot)
    if (!check.ok) {
      // 大きすぎる・送れない形式はその場で理由を出す（アップロードしない）。
      imageErrorDraftsRef.current.set(ownerKey, check.reason)
      if (draftOwnerKeyRef.current === ownerKey) setImageError(check.reason)
      return
    }
    if (check.kind === 'image') return handlePickImage(file)
    if (!selectedChatId) return
    imageErrorDraftsRef.current.delete(ownerKey)
    if (draftOwnerKeyRef.current === ownerKey) setImageError('')
    await uploadAttachment(ownerKey, selectedChatId, file, check.kind)
  }

  const retryAttachment = () => {
    const current = pendingAttachmentRef.current
    if (!current || !selectedChatId) return
    void uploadAttachment(draftKeyOf(selectedAccountId, selectedChatId), selectedChatId, current.file, current.kind)
  }

  const clearPendingAttachment = () => {
    putAttachment(draftKeyOf(selectedAccountId, selectedChatId), null)
  }

  const [dropOver, setDropOver] = useState(false)

  /** 添付を外す。読み込み中の結果が遅れて届いても復活しないよう世代を進める。 */
  const clearPendingImage = () => {
    const ownerKey = draftKeyOf(selectedAccountId, selectedChatId)
    imageJobGenRef.current.set(ownerKey, (imageJobGenRef.current.get(ownerKey) ?? 0) + 1)
    imageDraftsRef.current.delete(ownerKey)
    imageMetaDraftsRef.current.delete(ownerKey)
    imageErrorDraftsRef.current.delete(ownerKey)
    setPendingImage(null)
    setPendingImageMeta(null)
    setImageError('')
  }

  const [messageContent, setMessageContent] = useState('')

  const [pendingImage, setPendingImage] = useState<ImageUploaderValue | null>(null)

  /*
   * 入力中の下書き(本文・添付画像)は「アカウント＋会話」ごとに預かる
   * (#962 F06)。切替のたびに消すと、送信応答を待つ間に別の会話を
   * 開いただけで書きかけが消える。預かった下書きは送信した版だけを
   * 破棄し、追記・差し替えされた版は残す(dropSentDraft)。
   */
  const messageContentRef = useRef(messageContent)

  messageContentRef.current = messageContent

  const pendingImageRef = useRef(pendingImage)

  pendingImageRef.current = pendingImage

  const messageDraftsRef = useRef(new Map<string, string>())

  const imageDraftsRef = useRef(new Map<string, ImageUploaderValue>())

  const draftOwnerKeyRef = useRef(draftKeyOf(selectedAccountId, selectedChatId))

  /*
   * 会話・アカウントを切り替えたら、いまの下書きを前の会話の鍵で預け、
   * 次の会話に預けてあった下書きを戻す(#962 F06)。切り替えただけで
   * 書きかけの文面や添付が消えないようにする。
   */
  useEffect(() => {
    const nextKey = draftKeyOf(selectedAccountId, selectedChatId)
    const prevKey = draftOwnerKeyRef.current
    if (prevKey === nextKey) return
    draftOwnerKeyRef.current = nextKey
    const stashedText = messageContentRef.current
    if (stashedText) messageDraftsRef.current.set(prevKey, stashedText)
    else messageDraftsRef.current.delete(prevKey)
    setMessageContent(messageDraftsRef.current.get(nextKey) ?? '')
    const stashedImage = pendingImageRef.current
    if (stashedImage) imageDraftsRef.current.set(prevKey, stashedImage)
    else imageDraftsRef.current.delete(prevKey)
    setPendingImage(imageDraftsRef.current.get(nextKey) ?? null)
    // 添付のファイル名・準備の失敗も会話ごとに預かる(INBOX-23/32)。
    const stashedMeta = pendingImageMetaRef.current
    if (stashedMeta) imageMetaDraftsRef.current.set(prevKey, stashedMeta)
    else imageMetaDraftsRef.current.delete(prevKey)
    setPendingImageMeta(imageMetaDraftsRef.current.get(nextKey) ?? null)
    const stashedImageError = imageErrorRef.current
    if (stashedImageError) imageErrorDraftsRef.current.set(prevKey, stashedImageError)
    else imageErrorDraftsRef.current.delete(prevKey)
    setImageError(imageErrorDraftsRef.current.get(nextKey) ?? '')
    setImagePreviewOpen(false)
    // ：動画・ファイルの添付は預かりの表に常に書いているので、開いた会話の分を戻すだけ。
    setPendingAttachment(attachDraftsRef.current.get(nextKey) ?? null)
  }, [selectedAccountId, selectedChatId])

  /*
   * 送信・予約に使った版の下書きだけを預かりから外す(#962 F06)。
   * 応答を待つ間に文面へ追記したり画像を付け替えたりしていれば、
   * それは別の版なので残す。
   */
  const dropSentDraft = (
    chatId: string,
    accountId: string | null,
    sent: { content?: string; image?: ImageUploaderValue | null },
  ) => {
    const key = draftKeyOf(accountId, chatId)
    if (sent.content !== undefined && messageDraftsRef.current.get(key)?.trim() === sent.content) {
      messageDraftsRef.current.delete(key)
    }
    if (sent.image && imageDraftsRef.current.get(key) === sent.image) {
      imageDraftsRef.current.delete(key)
      imageMetaDraftsRef.current.delete(key)
    }
  }

  // この会話で画像の準備(アップロード)が進行中か(INBOX-23/31)。
  const imageUploading = imageBusyKeys.has(draftKeyOf(selectedAccountId, selectedChatId))
  return { imageInputRef, imageError, pendingImageMeta, setPendingImageMeta, imagePreviewOpen, setImagePreviewOpen, attachDraftsRef, pendingAttachment, putAttachment, handlePickAttachment, retryAttachment, clearPendingAttachment, dropOver, setDropOver, clearPendingImage, messageContent, setMessageContent, pendingImage, setPendingImage, pendingImageRef, dropSentDraft, imageUploading }
}
