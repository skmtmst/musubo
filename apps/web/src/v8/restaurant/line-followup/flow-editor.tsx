'use client'

import type { BroadcastBubble } from '@line-crm/shared'
import Card from '@/components/shared/card'
import { Field } from '@/components/shared/form-controls'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import { TextArea } from '@/components/shared/text-field'
import LinePreview, { LinePreviewMessage } from '@/components/shared/line-preview'
import MessageComposer, { composerLabel } from '@/components/shared/message-composer'
import styles from './line-followup.module.css'

/*
 * 行の本文の編集。テキストの吹き出しは何通あっても直せる。
 * 複数吹き出しは本体では保存を断られるため、この画面で直す。
 * テキスト以外の吹き出しは理由を出して触らない。
 * 吹き出しの枠はシナリオ・一斉配信と同じ共通の MessageComposer を、1通だけの形で使う。
 */
const TEXT_ONLY = 'LINE来店フォローは、いまはテキストだけ直せます。'
const UNAVAILABLE = {
  image: TEXT_ONLY, video: TEXT_ONLY, audio: TEXT_ONLY, sticker: TEXT_ONLY, carousel: TEXT_ONLY,
  rich_message: TEXT_ONLY, rich_video: TEXT_ONLY, location: TEXT_ONLY, research: TEXT_ONLY, intro: TEXT_ONLY, coupon: TEXT_ONLY,
} as const

export function bubbleText(bubble: BroadcastBubble | null | undefined): string {
  const text = bubble?.content?.text
  return typeof text === 'string' ? text : ''
}

/** 読むだけの欄に出す全文。2通以上あっても先頭だけにしない。 */
export function allBubbleText(bubbles: BroadcastBubble[]): string {
  return bubbles.map(bubbleText).filter(text => text !== '').join('\n\n')
}

export function StepEditor({ name, bubbles, readOnly, busy, onChange }: {
  name: string; bubbles: BroadcastBubble[]; readOnly: boolean; busy: boolean
  onChange: (bubbles: BroadcastBubble[]) => void
}) {
  const noop = () => {}
  const current = bubbles.length ? bubbles : [{ id: 'draft', type: 'text', content: { text: '' } } as BroadcastBubble]
  const move = (index: number, direction: -1 | 1) => {
    if (readOnly || busy) return
    const next = [...current]
    const at = index + direction
    if (index < 0 || index >= next.length || at < 0 || at >= next.length) return
    const moved = next.splice(index, 1)[0]!
    next.splice(at, 0, moved)
    onChange(next)
  }
  const remove = (index: number) => {
    if (readOnly || busy || current.length <= 1) return
    if (index < 0 || index >= current.length) return
    onChange(current.filter((_item, at) => at !== index))
  }
  const update = (index: number, next: BroadcastBubble) => {
    if (readOnly || busy) return
    onChange(current.map((item, at) => at === index ? { ...next, id: item.id } : item))
  }
  return <Card variant="form" padding="default" gap="normal" aria-label={`${name} の中身`}>
    <div className={styles.contentHead}>
      <h3 className={styles.contentTitle}>{`${name} の中身`}</h3>
      <span className={styles.contentNote}>右の LINE での見え方がそのまま変わります</span>
    </div>
    <SaveErrorField names={['messageBubbles', 'body']}>
      {readOnly
        ? <Field label="本文" fill><TextArea value={allBubbleText(bubbles)} readOnly /></Field>
        : <MessageComposer bubblesOnly bubbles={current} accountId={null} busy={busy} unavailable={UNAVAILABLE}
            onChange={update}
            onMove={move} onDelete={remove} onAdd={noop} onPickTemplate={noop} onSaveTemplate={noop} onCompose={noop} />}
    </SaveErrorField>
  </Card>
}

/* 描けない通も消さず、その位置に未対応の説明を出す。 */
export function previewBubbleText(bubble: BroadcastBubble): string {
  if (bubble.type === 'text') return bubbleText(bubble)
  return `（${composerLabel(bubble.type)}はこの画面では見られません）`
}

/* 送る中身そのままの見え方。送らない画像やボタンは付けない。吹き出しは共通の部品。 */
export function StepPreview({ bubbles, accountName }: { bubbles: BroadcastBubble[]; accountName: string }) {
  const shown = bubbles.length ? bubbles.map(previewBubbleText) : ['本文']
  const senderName = accountName.trim() || '公式アカウント'
  const avatar = Array.from(senderName)[0] ?? '公'
  return <LinePreview title={null} accountName={senderName} fit>
    {shown.map((text, index) => <LinePreviewMessage key={index} accountName={senderName} avatar={avatar} time="今">{text}</LinePreviewMessage>)}
  </LinePreview>
}
