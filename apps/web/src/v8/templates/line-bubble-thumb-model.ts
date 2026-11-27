import type { TemplateQuestion } from '@/lib/api'
import { readTemplateText } from '@/lib/template-message-text'

/*
 * 一覧の行に出す小さな吹き出しの中身。
 * カード型（Flex）は大きな JSON なので一覧では描かず、印と題だけにする。
 * 読めない中身は「見え方を出せません」にして、行は壊さない。
 */
export type BubbleThumb =
  | { kind: 'text'; text: string }
  | { kind: 'image'; src: string }
  | { kind: 'card'; title: string }
  | { kind: 'carousel'; title: string; count: number }
  | { kind: 'question'; text: string; choices: number }
  | { kind: 'rich_message'; title: string }
  | { kind: 'rich_video'; title: string }
  | { kind: 'empty' }
  | { kind: 'unavailable' }

/** 一覧で1行に収める分だけ持つ。途中で切れた差し込み（{{…）は札にならないので落とす。 */
const TEXT_KEEP = 120

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname ? url.href : null
  } catch {
    return null
  }
}

export function bubbleThumbOf(input: { messageType: string; content: string; question: TemplateQuestion | null }): BubbleThumb {
  if (input.question) {
    const question = text(input.question.text) || text(input.question.intro)
    if (!question || !Array.isArray(input.question.choices)) return { kind: 'unavailable' }
    return { kind: 'question', text: question, choices: input.question.choices.length }
  }
  const content = typeof input.content === 'string' ? input.content.trim() : ''
  if (input.messageType === 'text') {
    if (!content) return { kind: 'empty' }
    const message = readTemplateText(content)
    const oneLine = message.replace(/\s+/g, ' ').trim()
    if (!oneLine) return { kind: 'empty' }
    return { kind: 'text', text: oneLine.length > TEXT_KEEP ? oneLine.slice(0, TEXT_KEEP).replace(/\{\{[^}]*\}?$/, '') : oneLine }
  }
  if (!['image', 'flex', 'carousel', 'imagemap'].includes(input.messageType)) return { kind: 'unavailable' }
  if (!content) return { kind: 'empty' }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { kind: 'unavailable' }
  }
  const obj = record(parsed)
  if (input.messageType === 'image') {
    const src = httpsUrl(obj?.previewImageUrl) ?? httpsUrl(obj?.originalContentUrl)
    return src ? { kind: 'image', src } : { kind: 'unavailable' }
  }
  if (input.messageType === 'carousel') {
    const columns = Array.isArray(parsed) ? parsed : obj?.columns
    if (!Array.isArray(columns) || columns.length === 0 || columns.some(column => !record(column))) return { kind: 'unavailable' }
    const first = record(columns[0])
    return { kind: 'carousel', title: text(obj?.altText) || text(first?.title) || text(first?.text), count: columns.length }
  }
  if (!obj) return { kind: 'unavailable' }
  if (input.messageType === 'flex') return { kind: 'card', title: text(obj.altText) }
  return { kind: obj.video ? 'rich_video' : 'rich_message', title: text(obj.altText) }
}
