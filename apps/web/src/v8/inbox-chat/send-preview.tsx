'use client'

import { useState } from 'react'
import Button from '@/components/shared/button'
import { DetailContent, DetailField } from '@/components/shared/detail-content'
import Dialog from '@/components/shared/dialog'
import { InsertText } from '@/components/shared/insert-text-field'
import type { InsertTokenNames } from '@/components/shared/insert-tokens'
import Notice from '@/components/shared/notice'
import { CHAT_INSERT_TOKENS, PREVIEW_FAILED_TEXT, unresolvedNoticeText } from './chat-inserts'
import type { InboxPreview } from './use-reservation-warning'
import styles from './inbox-chat.module.css'

/** 返信欄の上の注意：口が解決できなかった差し込みの全部を、札の名前で（赤にしない）。 */
export function InboxUnresolvedNotice({ preview, tokenNames }: { preview: InboxPreview; tokenNames: InsertTokenNames }) {
  if (preview.status !== 'ready') return null
  const message = unresolvedNoticeText(preview.unresolved, tokenNames, 'compose')
  return message ? <Notice tone="warn" message={message} /> : null
}

/*
 * 返信欄の下の「送るとこうなります」（PC の受信箱と電話のトークで同じ形）。
 * 相手に合わせて入った値は札、入らない差し込みは「（入りません：名前）」。改行はそのまま見せ、
 * 会話を読む場所を残すため2行で切り、［全文を見る］（見出しの行）で改行ごと全部を読む。
 * 生の {{…}} は本文にも title にも出さない。
 */
export function InboxResolvedText({ preview, content, tokenNames, scope }: { preview: InboxPreview; content: string; tokenNames: InsertTokenNames; scope: string | null }) {
  /*
   * 全文の窓は開いた時の相手・本文・結果に結び付ける。どれかが変わったら開いていた印を捨てる
   * （新しい結果で古い窓を出さず、前の相手・本文へ戻っても勝手に開き直さない）。
   */
  const shownKey = preview.status === 'ready' ? JSON.stringify([scope, content, preview.preview]) : null
  const [fullOpenFor, setFullOpenFor] = useState<string | null>(null)
  const [seenKey, setSeenKey] = useState(shownKey)
  if (seenKey !== shownKey) {
    setSeenKey(shownKey)
    setFullOpenFor(null)
  }
  if (preview.status === 'failed') return <Notice tone="info" message={PREVIEW_FAILED_TEXT.compose} />
  if (preview.status !== 'ready' || shownKey === null) return null
  const fullOpen = fullOpenFor !== null && fullOpenFor === shownKey
  const text = <InsertText value={content} resolvedValue={preview.preview} tokenNames={tokenNames} extraTokens={CHAT_INSERT_TOKENS} markUnknown />
  return (
    <>
      <Notice
        tone="info"
        heading={<>送るとこうなります：<Button variant="text" size="inline" type="button" data-notice-inline-action onClick={() => setFullOpenFor(shownKey)}>全文を見る</Button></>}
      >
        <span className={styles.sendPreviewText} data-send-preview="">{text}</span>
      </Notice>
      <Dialog open={fullOpen} title="送るとこうなります" onCancel={() => setFullOpenFor(null)} cancelLabel="閉じる">
        <DetailContent>
          <DetailField label="送る文（改行もこのまま届きます）" multiline>{text}</DetailField>
        </DetailContent>
      </Dialog>
    </>
  )
}
