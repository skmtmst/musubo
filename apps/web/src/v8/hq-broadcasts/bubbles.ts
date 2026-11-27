import { knownValue } from '@/lib/known-value'
/*
 * 統括の一括配信の吹き出し（③ メッセージを作成・絵 lLyFR）。
 *
 * 種類のタブは絵の並び（テキスト・画像・動画・音声・スタンプ・カルーセル・リッチメッセージ・位置情報・質問・紹介・その他）。
 * 「その他」は統括だけの種類（クーポン）。口（hq-broadcasts の messageBubblesJson）へは店の一斉配信と同じ吹き出しの形で送り、
 * 入力の確かめも店と同じ関数（動画のプレビュー・位置情報/音声/スタンプ・カルーセル・素材の変換）を使う。
 * 質問・紹介は統括の口がまだ受けないので、タブは出して「まだ統括からは送れません」の1行だけにし、保存させない。
 */
import { composeHqMessageCard, type BroadcastBubble, type MessageTemplateDefinition, type TemplateImagemapUpload } from '@line-crm/shared'
import type { TemplateHostContent } from '@/v8/template-edit/public/host/index'
import { videoPreviewProblem } from '@/components/broadcasts/broadcast-form'
import { carouselColumnsProblem, flexContentProblem } from '@/components/broadcasts/bubble-content-check'
import { emptyMessageKindState, messageKindProblem, type MessageKind, type MessageKindState } from '@/components/scenarios/message-kind-fields'
import { assetBubbleError } from '@/lib/broadcast-template'
import { fromApiContent, toApiContent, type HqKind } from './model'
import { formatNumber } from '@/lib/format'

/** 吹き出し1つ。content は口へ送る中身（テキストは body）。カルーセルは素材（カードタイプ）のとき cardAsset。 */
export type HqBubble = {
  id: string; kind: HqKind; body: string; content: Record<string, unknown>; cardAsset?: boolean
  /** その場で作ったリッチメッセージの画像（統括の置き場）。［保存してテンプレート化する］で使う。口へは送らない。 */
  media?: TemplateImagemapUpload['media']
  /** 見え方だけに使うカードの中身（画像・題・本文・ボタン）。口へは送らない。 */
  previewCard?: Record<string, unknown>
}

/** 絵 lLyFR のタブの並び。最後の「その他」はクーポン。 */
export const HQ_KIND_TABS: ReadonlyArray<readonly [HqKind, string]> = [
  ['text', 'テキスト'], ['image', '画像'], ['video', '動画'], ['audio', '音声'], ['sticker', 'スタンプ'],
  ['carousel', 'カルーセル'], ['rich', 'リッチメッセージ'], ['location', '位置情報'], ['question', '質問'], ['intro', '紹介'],
  ['coupon', 'その他'],
]

export const HQ_KIND_LABEL: Record<HqKind, string> = {
  text: 'テキスト', image: '画像', video: '動画', audio: '音声', sticker: 'スタンプ', carousel: 'カルーセル',
  rich: 'リッチメッセージ', location: '位置情報', question: '質問', intro: '紹介', coupon: 'クーポン', research: 'リサーチ', flex: 'カード',
}

/** 統括の口がまだ受けない種類。 */
export const HQ_NOT_YET: ReadonlySet<HqKind> = new Set<HqKind>(['question', 'intro'])
export const notYetText = (kind: HqKind) => `${knownValue(HQ_KIND_LABEL, kind, '種類を確認できません')}は、まだ統括からは送れません。送るときは店の一斉配信で作ってください`

const KIND_FIELDS: ReadonlySet<HqKind> = new Set<HqKind>(['audio', 'sticker', 'location'])

export function emptyContent(kind: HqKind): Record<string, unknown> {
  if (kind === 'image' || kind === 'video') return { originalContentUrl: '', previewImageUrl: '' }
  if (KIND_FIELDS.has(kind)) return { state: emptyMessageKindState() }
  return {}
}

export function newHqBubble(kind: HqKind = 'text'): HqBubble {
  return { id: `hq-b-${Math.random().toString(36).slice(2, 10)}`, kind, body: '', content: emptyContent(kind) }
}

/** 口へ送る吹き出し（店の一斉配信と同じ形）。まだ送れない種類は null。 */
export function toApiBubble(item: HqBubble, id: string): BroadcastBubble | null {
  switch (item.kind) {
    case 'text': return { id, type: 'text', content: { text: toApiContent(item.body) } }
    case 'image': case 'video': case 'audio': case 'sticker': case 'location': return { id, type: item.kind, content: item.content }
    case 'carousel': return { id, type: item.cardAsset ? 'card_message' : 'carousel', content: item.content }
    case 'rich': return { id, type: 'rich_message', content: item.content }
    case 'research': return { id, type: 'research', content: item.content }
    case 'coupon': return { id, type: 'coupon', content: item.content }
    case 'flex': return { id, type: 'flex', content: item.content }
    default: return null
  }
}

/** 保存した吹き出し（口の messageBubblesJson の1つ）を画面の吹き出しに戻す。読めない種類は null。 */
export function fromApiBubble(raw: { type?: string; content?: Record<string, unknown> }): HqBubble | null {
  const content = raw.content && typeof raw.content === 'object' ? raw.content : {}
  const base = newHqBubble('text')
  switch (raw.type) {
    case 'text': return typeof content.text === 'string' ? { ...base, body: fromApiContent(content.text) } : null
    case 'image': case 'video': case 'audio': case 'sticker': case 'location': return { ...base, kind: raw.type, content }
    case 'carousel': return { ...base, kind: 'carousel', content }
    case 'card_message': return { ...base, kind: 'carousel', content, cardAsset: true }
    case 'rich_message': return { ...base, kind: 'rich', content }
    case 'research': return { ...base, kind: 'research', content }
    case 'coupon': return { ...base, kind: 'coupon', content }
    case 'flex': return { ...base, kind: 'flex', content }
    default: return null
  }
}

/** カルーセルのカード（口の columns）。読めなければ空。 */
export function carouselColumns(item: Pick<HqBubble, 'content' | 'cardAsset'>): Array<Record<string, unknown>> {
  if (item.cardAsset) {
    const cards = item.content.cards ?? item.content.columns
    return Array.isArray(cards) ? cards as Array<Record<string, unknown>> : []
  }
  try {
    const parsed = JSON.parse(String(item.content.columnsJson ?? '')) as unknown
    return Array.isArray(parsed) ? parsed as Array<Record<string, unknown>> : []
  } catch {
    return []
  }
}

/**
 * カルーセルのボタンで「動きを実行する」（postback）は、押されたときに店のテンプレートの動きを探す。
 * 統括のひな形をそのまま送ると、店にそのテンプレートが無いので押しても何も起きない。口が付け替えるまで止める。
 */
export function carouselPostbackProblem(item: Pick<HqBubble, 'content' | 'cardAsset'>): string | null {
  if (item.cardAsset) return null
  const postback = carouselColumns(item).some((column) => Array.isArray(column.actions)
    && (column.actions as Array<Record<string, unknown>>).some((action) => action?.type === 'postback'))
  return postback ? 'ボタンで動きを実行するカルーセルは、まだ統括からは送れません。URLを開くボタンだけのカルーセルを選んでください' : null
}

/** カード（統括のメッセージのひな形の画像・ボタンつき）のボタンで回答フォーム・シナリオを開くもの（postback）は、店の ID に直せないので止める。 */
export function flexPostbackProblem(item: Pick<HqBubble, 'content'>): string | null {
  return /"type"\s*:\s*"postback"/.test(String(item.content.flexJson ?? ''))
    ? '回答フォーム・シナリオを開くボタンのあるカードは、まだ統括からは送れません。URLを開くボタンだけにしてください'
    : null
}

/** 吹き出しの入れ忘れ・送れない形。店の一斉配信と同じ確かめ。問題なければ null。 */
export function hqBubbleProblem(item: HqBubble): string | null {
  if (item.kind === 'research' && item.content.hqTemplateId && !item.content.hqTemplateVersionId) return '公開した版のリサーチを選び直してください'
  if (HQ_NOT_YET.has(item.kind)) return notYetText(item.kind)
  if (item.kind === 'text') return item.body.trim() ? null : '本文を入れてください'
  if (item.kind === 'image' || item.kind === 'video') {
    if (!item.content.originalContentUrl) return `${knownValue(HQ_KIND_LABEL, item.kind, '種類を確認できません')}のファイルをアップロードしてください`
    return item.kind === 'video' ? videoPreviewProblem(item.content.previewImageUrl) : null
  }
  if (KIND_FIELDS.has(item.kind)) {
    const state = item.content.state as MessageKindState | undefined
    return state ? messageKindProblem(item.kind as MessageKind, state) : `${knownValue(HQ_KIND_LABEL, item.kind, '種類を確認できません')}を入力してください`
  }
  if (item.kind === 'carousel') {
    if (!item.content.templateName && !item.content.assetName) return 'カルーセルを選んでください'
    if (item.cardAsset) return assetBubbleError({ id: 'check', type: 'card_message', content: item.content }) || null
    return carouselColumnsProblem(item.content.columnsJson) ?? carouselPostbackProblem(item)
  }
  if (item.kind === 'flex') return flexContentProblem(item.content.flexJson) ?? flexPostbackProblem(item)
  if (item.kind === 'rich' || item.kind === 'coupon' || item.kind === 'research') {
    if (!item.content.assetId) return `${knownValue(HQ_KIND_LABEL, item.kind, '種類を確認できません')}を選んでください`
    return assetBubbleError({ id: 'check', type: item.kind === 'rich' ? 'rich_message' : item.kind === 'research' ? 'research' : 'coupon', content: item.content }) || null
  }
  return 'この吹き出しの種類は送れません。消して作り直してください'
}

/** 1行の要約（開いていない吹き出しの見出し。絵：「カルーセル ・ 秋の新商品 3種（カード1枚）」）。 */
export function hqBubbleSummary(item: HqBubble): string {
  const label = knownValue(HQ_KIND_LABEL, item.kind, '種類を確認できません')
  if (item.kind === 'text') return item.body.trim() ? `テキスト・${item.body.trim().slice(0, 40)}` : 'テキスト・本文がまだありません'
  if (HQ_NOT_YET.has(item.kind)) return `${label}・統括からは送れません`
  if (item.kind === 'carousel') {
    const name = String(item.content.templateName ?? item.content.assetName ?? '')
    return name ? `${label}・${name}（カード${formatNumber(carouselColumns(item).length)} 枚）` : `${label}・まだ選んでいません`
  }
  if (item.kind === 'rich' || item.kind === 'coupon' || item.kind === 'research' || item.kind === 'flex') return `${label}・${String(item.content.assetName ?? item.content.templateName ?? '') || 'まだ選んでいません'}`
  return hqBubbleProblem(item) ? `${label}・まだ入れていません` : `${label}・入力済み`
}

/** LINE の見え方の例に出す1行（テキストは呼ぶ側が差し込みを置き換える）。 */
export function hqBubblePreview(item: HqBubble): string {
  if (item.kind === 'carousel' || item.kind === 'rich' || item.kind === 'coupon' || item.kind === 'research') {
    const name = String(item.content.templateName ?? item.content.assetName ?? '')
    if (!name) return ''
    return item.kind === 'carousel' ? `［カルーセル］${name}（カード${formatNumber(carouselColumns(item).length)} 枚）` : `［${knownValue(HQ_KIND_LABEL, item.kind, '種類を確認できません')}］${name}`
  }
  if (item.kind === 'location') {
    const state = item.content.state as MessageKindState | undefined
    return state?.location.title ? `［位置情報］${state.location.title}` : '［位置情報］'
  }
  if (HQ_NOT_YET.has(item.kind)) return ''
  return `［${knownValue(HQ_KIND_LABEL, item.kind, '種類を確認できません')}］`
}

/** 統括のひな形を吹き出しへ読む。読めない種類は理由。 */
export function bubbleFromTemplate(templateId: string, definition: MessageTemplateDefinition, versionId?: string | null): { bubble: HqBubble } | { error: string } {
  const base = newHqBubble('text')
  const name = definition.template.name
  if (definition.asset) {
    const content = { assetId: templateId, assetName: name, ...(definition.asset.payload as Record<string, unknown>) }
    if (definition.asset.kind === 'research') return { bubble: { ...base, kind: 'research', content: { ...content, hqTemplateId: templateId, hqTemplateVersionId: versionId } } }
    if (definition.asset.kind === 'coupon') return { bubble: { ...base, kind: 'coupon', content } }
    if (definition.asset.kind === 'rich_message') return { bubble: { ...base, kind: 'rich', content } }
    if (definition.asset.kind === 'card_message') return { bubble: { ...base, kind: 'carousel', content, cardAsset: true } }
    return { error: `${definition.asset.kind === 'research' ? 'リサーチ' : 'この種類'}のひな形は、まだ統括からは送れません` }
  }
  if (definition.template.questionJson) return { error: '質問のひな形は、まだ統括からは送れません' }
  /* 画像・ボタンつきのカード（card）は、店へ配るときと同じ組み立てで LINE の形にする（保存してある本文が古い形でも直る）。 */
  const card = definition.card
    ? composeHqMessageCard(definition.card, definition.template.id, definition.media.find((m) => m.id === definition.card?.imageMediaId)?.publicUrl ?? undefined)
    : null
  const messageType = card ? card.messageType : definition.template.messageType
  const messageContent = card ? card.messageContent : definition.template.messageContent
  if (messageType === 'text') return { bubble: { ...base, body: fromApiContent(messageContent) } }
  if (messageType === 'carousel') return { bubble: { ...base, kind: 'carousel', content: { templateId: '', hqTemplateId: templateId, templateName: name, columnsJson: messageContent } } }
  if (messageType === 'image') {
    let parsed: Record<string, unknown> = {}
    try { parsed = JSON.parse(messageContent) as Record<string, unknown> } catch { parsed = {} }
    const url = String(parsed.originalContentUrl ?? definition.media[0]?.publicUrl ?? '')
    if (url.startsWith('https://')) return { bubble: { ...base, kind: 'image', content: { originalContentUrl: url, previewImageUrl: String(parsed.previewImageUrl ?? url) } } }
    return { error: 'この画像のひな形は、まだ統括からは読み込めません。画像のタブでアップロードしてください' }
  }
  if (messageType === 'flex') {
    const c = definition.card
    const imageUrl = definition.media.find((m) => m.id === c?.imageMediaId)?.publicUrl ?? undefined
    return { bubble: { ...base, kind: 'flex', content: { flexJson: messageContent, templateName: name },
      ...(c ? { previewCard: { imageUrl, title: c.title, description: c.body, actionLabel: c.buttons[0]?.label } } : {}) } }
  }
  return { error: 'このひな形は、まだ統括からは送れません' }
}

/** 店の作る部品（カルーセル・リッチメッセージ。template-edit/host の口）がその場で組み立てた中身を、吹き出しにする。 */
export function bubbleFromHostContent(content: TemplateHostContent): HqBubble | null {
  const base = newHqBubble('text')
  if (content.kind === 'carousel') return { ...base, kind: 'carousel', content: { templateId: '', templateName: content.name, columnsJson: content.messageContent }, media: content.media }
  if (content.kind === 'rich_message') {
    return { ...base, kind: 'rich', content: { assetId: `hq-inline-${base.id}`, assetName: content.name, ...content.payload }, media: [...content.media] }
  }
  if (content.kind === 'coupon') return { ...base, kind: 'coupon', content: { assetId: `hq-inline-${base.id}`, assetName: content.name, ...content.payload } }
  if (content.kind === 'message' && content.messageType === 'text') return { ...base, body: fromApiContent(content.messageContent) }
  return null
}

/** 吹き出しを、店の作る部品へ渡す中身（編集で開き直す）に戻す。戻せなければ undefined（空から作る）。 */
export function hostContentOfBubble(item: HqBubble): TemplateHostContent | undefined {
  const name = String(item.content.templateName ?? item.content.assetName ?? '')
  if (item.kind === 'carousel' && !item.cardAsset && item.content.columnsJson) {
    return { kind: 'carousel', name, messageContent: String(item.content.columnsJson), tapLimitMode: 'none', tapLimitText: null, media: item.media }
  }
  if (item.kind === 'rich' && item.media?.length) {
    const { assetId: _id, assetName: _name, ...payload } = item.content
    void _id; void _name
    return { kind: 'rich_message', name, payload, media: [...item.media] }
  }
  return undefined
}

/**
 * ［保存してテンプレート化する］：吹き出しを統括のひな形の中身にする。
 * テキスト・画像・カルーセル・クーポン・その場で作ったリッチメッセージ（画像つき）だけ。ほかは保存できない理由。
 */
export function templateContentOfBubble(item: HqBubble, name: string): { content: TemplateHostContent } | { error: string } {
  if (item.kind === 'text') return item.body.trim() ? { content: { kind: 'message', name, messageType: 'text', messageContent: toApiContent(item.body) } } : { error: '本文を入れてから保存してください' }
  if (item.kind === 'image') {
    return item.content.originalContentUrl ? { content: { kind: 'message', name, messageType: 'image', messageContent: JSON.stringify(item.content) } } : { error: '画像をアップロードしてから保存してください' }
  }
  if (item.kind === 'flex' && item.content.flexJson) return { content: { kind: 'message', name, messageType: 'flex', messageContent: String(item.content.flexJson) } }
  if (item.kind === 'carousel' && !item.cardAsset && item.content.columnsJson) return { content: { kind: 'carousel', name, messageContent: String(item.content.columnsJson), tapLimitMode: 'none', tapLimitText: null, media: item.media } }
  if (item.kind === 'coupon' && item.content.assetId) {
    const { assetId: _id, assetName: _name, ...payload } = item.content
    void _id; void _name
    return { content: { kind: 'coupon', name, payload } }
  }
  if (item.kind === 'rich' && item.media?.length) {
    const host = hostContentOfBubble(item)
    if (host && host.kind === 'rich_message') return { content: { ...host, name } }
  }
  return { error: `${knownValue(HQ_KIND_LABEL, item.kind, 'この吹き出し')}は、まだ統括のテンプレートとして保存できません` }
}

/** LINE の見え方に出す吹き出し（店の一斉配信の BubblePreview に渡す形）。カルーセルはカードの中身を見せる。 */
export function previewBubbleOf(item: HqBubble, text: string): BroadcastBubble | null {
  if (item.kind === 'text') return { id: item.id, type: 'text', content: { text } }
  if (HQ_NOT_YET.has(item.kind)) return null
  if (item.kind === 'carousel' && !item.cardAsset) {
    const cards = carouselColumns(item).map((column) => {
      const actions = Array.isArray(column.actions) ? column.actions as Array<Record<string, unknown>> : []
      return { imageUrl: column.thumbnailImageUrl, title: column.title ?? column.text, actionLabel: actions[0]?.label }
    })
    return cards.length ? { id: item.id, type: 'card_message', content: { cards } } : null
  }
  if (item.kind === 'flex' && item.previewCard) return { id: item.id, type: 'card_message', content: { cards: [item.previewCard] } }
  if ((item.kind === 'rich' || item.kind === 'coupon' || item.kind === 'research' || item.kind === 'carousel') && !item.content.assetName) return null
  return toApiBubble(item, item.id)
}
