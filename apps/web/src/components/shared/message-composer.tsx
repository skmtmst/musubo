'use client'

import { useInsertTokenNames } from '@/lib/use-insert-token-names'
import { useRef, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Plus, Save, Trash2, MessageSquare, Image, Video, Music, Smile, GalleryHorizontal, MapPin, FileText, Pencil, Bookmark } from 'lucide-react'
import type { BroadcastBubble, BroadcastBubbleType } from '@line-crm/shared'
import Button from './button'
import Card from './card'
import HelpTip from './help-tip'
import IconButton from './icon-button'
import InsertTextField, { InsertText, type InsertTextFieldHandle, type InsertTextFieldProps } from './insert-text-field'
import { MessageBody } from './message-insert-row'
import InsertToolbar from '@/components/scenarios/insert-toolbar'
import { MAX_BUBBLES, MAX_TEXT_LENGTH, messageLengthLabel } from '@/components/broadcasts/message-limits'
import MessageKindFields, { emptyMessageKindState, type MessageKind, type MessageKindState } from '@/components/scenarios/message-kind-fields'
import ComposerMedia from './message-composer-media'
import { ErrorCountBadge } from './error-count-badge'
import { FieldError } from './form-controls'
import styles from './message-composer.module.css'
import TruncatedText from './truncated-text'
import { PageFrame } from '@/components/templates/page-frame'
import { formatNumber } from '@/lib/format'

export function MessageComposerPage({ active, children }: { active: boolean; children: ReactNode }) { return active ? <PageFrame kind="create">{children}</PageFrame> : <>{children}</> }

export const COMPOSER_TYPES = [
  ['text', 'テキスト'], ['image', '画像'], ['video', '動画'], ['audio', '音声'], ['sticker', 'スタンプ'],
  ['carousel', 'カルーセル'], ['rich_message', 'リッチメッセージ'], ['rich_video', 'リッチビデオ'],
  ['location', '位置情報'], ['research', 'リサーチ'], ['intro', '紹介'], ['coupon', 'クーポン'],
] as const
export type ComposerKind = typeof COMPOSER_TYPES[number][0] | 'question'
const KIND_ICONS: Record<string, typeof MessageSquare> = { text: MessageSquare, image: Image, video: Video, audio: Music, sticker: Smile, carousel: GalleryHorizontal, rich_message: Image, rich_video: Video, location: MapPin }
export const composerLabel = (type: string) => COMPOSER_TYPES.find(([value]) => value === type)?.[1] ?? ({ flex: 'フレックスメッセージ', card_message: 'カードタイプメッセージ', question: '質問' } as Record<string, string>)[type] ?? '未対応の種類'
export function composerSummary(bubble: BroadcastBubble): string {
  const c = bubble.content
  if (bubble.type === 'text') return String(c.text ?? '').trim().slice(0, 40) || 'まだ書いていません'
  if (bubble.type === 'sticker') {
    const state = c.state as MessageKindState | undefined
    return state?.sticker?.packageId ? `パッケージ ${state.sticker.packageId} / スタンプ ${state.sticker.stickerId}` : 'まだ選んでいません'
  }
  return String(c.templateName ?? c.assetName ?? c.fileName ?? '') || (c.originalContentUrl ? 'ファイルを選びました' : 'まだ作っていません')
}

export interface MessageComposerProps {
  bubbles: BroadcastBubble[]
  accountId: string | null
  onChange: (index: number, bubble: BroadcastBubble) => void
  onMove: (index: number, direction: -1 | 1) => void
  onDelete: (index: number) => void
  onAdd: () => void
  onPickTemplate: (index: number, kind?: ComposerKind) => void
  onSaveTemplate: (index: number) => void
  onCompose: (index: number, kind: 'carousel' | 'rich_message' | 'rich_video') => void
  /** 統括でだけ使う差し込み。省略時は店の差し込み候補。 */
  inserts?: (ref: React.RefObject<InsertTextFieldHandle | HTMLTextAreaElement | null>, value: string, onChange: (next: string) => void) => ReactNode
  extraTokens?: InsertTextFieldProps['extraTokens']
  unavailable?: Partial<Record<ComposerKind, string>>
  extraFields?: (index: number, bubble: BroadcastBubble) => ReactNode
  busy?: boolean
  onBusyChange?: (busy: boolean) => void
  /**
   * 保存で落ちた吹き出しの理由。吹き出しごと。あると中身の下に理由、頭の右に赤い丸を出す。
   * `bubbleFieldProps` で欄の誤り（useFormErrors.bind）を中身の枠に結び、1つ目の吹き出しへ移れるようにする。
   */
  bubbleErrors?: ReadonlyArray<string | null | undefined>
  bubbleFieldProps?: (index: number) => { ref?: (el: HTMLElement | null) => void; onBlur?: () => void }
  /**
   * 吹き出しの枠だけを出す（頭の「メッセージ（n / 5）」・テンプレートの操作・［メッセージを追加する］を出さない）。
   * 保存先が1通しか持てない画面（飲食の LINE来店フォロー）で、押しても保存できない操作を置かないための口。
   * 渡さない画面は今までどおり。
   */
  bubblesOnly?: boolean
  /** この入口ではテンプレート操作を使えない理由。 */
  templateDisabledReason?: string
}

function ComposerText({ bubble, index, onChange, inserts, extraTokens, tokenNames }: Pick<MessageComposerProps, 'inserts' | 'extraTokens'> & { tokenNames: InsertTextFieldProps['tokenNames'] } & { bubble: BroadcastBubble; index: number; onChange: (next: BroadcastBubble) => void }) {
  const ref = useRef<InsertTextFieldHandle | HTMLTextAreaElement>(null)
  const value = String(bubble.content.text ?? '')
  const change = (text: string) => onChange({ ...bubble, content: { ...bubble.content, text } })
  return <MessageBody>
    <InsertTextField tokenNames={tokenNames} ref={ref} aria-label={index ? `${index + 1}通目の本文` : '本文'} placeholder="テキストを入力" maxLength={MAX_TEXT_LENGTH} value={value} onValueChange={change} extraTokens={extraTokens} className={styles.text} />
    {inserts ? inserts(ref, value, change) : <InsertToolbar compact targetRef={ref} value={value} onChange={change} count={messageLengthLabel(value.length)} />}
  </MessageBody>

}

/** G-9。吹き出しの枠・タブ・本文・素材・作成の入口は統括と店で同じ部品。 */
export default function MessageComposer(props: MessageComposerProps) {
  const { bubbles, accountId, onChange, onMove, onDelete, onAdd, onPickTemplate, onSaveTemplate, onCompose, unavailable = {}, busy = false } = props
  const tokenNames = useInsertTokenNames(accountId)
  const busyReason = busy ? '処理中です。完了してから操作してください。' : undefined
  return <section className={styles.root} data-message-composer data-bubbles-only={props.bubblesOnly || undefined}>
    {props.bubblesOnly ? null : <div className={styles.heading}>
      <div className={styles.title}><h3>{`メッセージ（${bubbles.length} / ${MAX_BUBBLES}）`}</h3><HelpTip label="メッセージの説明">1回の配信に5つまで入れられます。上から順に届きます。</HelpTip></div>
      <div className={styles.actions}><Button size="composer" disabled={busy || Boolean(props.templateDisabledReason)} title={props.templateDisabledReason} onClick={() => onPickTemplate(0)}><FileText size={16} aria-hidden />テンプレートから選ぶ</Button><Button size="composer" disabled={busy || Boolean(props.templateDisabledReason)} title={props.templateDisabledReason} onClick={() => onSaveTemplate(0)}><Save size={16} aria-hidden />保存してテンプレートにする</Button></div>
    </div>}
    {props.templateDisabledReason ? <p role="note">{props.templateDisabledReason}</p> : null}
    {bubbles.map((bubble, index) => {
      const tabs: ReadonlyArray<readonly [ComposerKind, string]> = unavailable.question ? [...COMPOSER_TYPES.slice(0, 10), ['question', '質問'], ...COMPOSER_TYPES.slice(10)] : COMPOSER_TYPES
      const activeType = tabs.some(([type]) => type === bubble.type) ? bubble.type : null
      const composed = ['carousel', 'rich_message', 'rich_video'].includes(bubble.type)
      const name = String(bubble.content.templateName ?? bubble.content.assetName ?? '')
      const reason = unavailable[bubble.type as ComposerKind]
      const KindIcon = KIND_ICONS[bubble.type] ?? MessageSquare
      return <Card key={bubble.id} className={styles.bubble} padding="rows" overflow="hidden" aria-label={`${index + 1}通目の吹き出し`}>
        <div className={styles.header}>
          <span className={styles.number}>{index + 1}</span><span className={styles.kind}><KindIcon size={16} aria-hidden />{composerLabel(bubble.type)}</span><span className={styles.summary} title={composerSummary(bubble)}>{/* 本文は途中で切らずに渡し、欄の幅で「…」にする。差し込みは札で見せる（k0TPPS）。 */}{bubble.type === 'text' && String(bubble.content.text ?? '').trim() ? <InsertText tokenNames={tokenNames} value={String(bubble.content.text ?? '').trim().replace(/\s+/g, ' ')} extraTokens={props.extraTokens} /> : composerSummary(bubble)}</span><ErrorCountBadge count={props.bubbleErrors?.[index] ? 1 : 0} label={`${index + 1}通目`} />
          <div className={styles.controls}><IconButton size="row" aria-label={`${index + 1}通目を上へ移動`} disabled={busy || index === 0} title={busyReason ?? (index === 0 ? '最初のメッセージです。' : undefined)} onClick={() => onMove(index, -1)}><ArrowUp size={16} aria-hidden /></IconButton><IconButton size="row" aria-label={`${index + 1}通目を下へ移動`} disabled={busy || index === bubbles.length - 1} title={busyReason ?? (index === bubbles.length - 1 ? '最後のメッセージです。' : undefined)} onClick={() => onMove(index, 1)}><ArrowDown size={16} aria-hidden /></IconButton><IconButton size="row" aria-label={`${index + 1}通目を削除する`} disabled={busy || bubbles.length === 1} title={busyReason ?? (bubbles.length === 1 ? 'メッセージは1通以上必要です。' : undefined)} onClick={() => onDelete(index)}><Trash2 size={16} aria-hidden /></IconButton></div>
        </div>
        <div className={styles.tabs} role="tablist" aria-label={`${index + 1}通目のメッセージ形式`} onKeyDown={(event) => {
          const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']
          if (!keys.includes(event.key)) return
          const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
          const current = tabs.indexOf(document.activeElement as HTMLButtonElement)
          if (current < 0) return
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + tabs.length) % tabs.length
          event.preventDefault(); tabs[next]?.focus()
        }}>
          {tabs.map(([type, label], tabIndex) => <button key={type} type="button" role="tab" tabIndex={activeType === type || (activeType === null && tabIndex === 0) ? 0 : -1} aria-selected={activeType === type} aria-disabled={Boolean(unavailable[type]) || busy} aria-description={unavailable[type]} title={unavailable[type]}  onClick={() => { if (type !== bubble.type && !busy && !unavailable[type] && type !== 'intro' && type !== 'question') onChange(index, { id: bubble.id, type: type as BroadcastBubbleType, content: ['audio', 'sticker', 'location'].includes(type) ? { state: emptyMessageKindState() } : {} }) }}>{label}</button>)}
        </div>
        <div className={styles.content} {...props.bubbleFieldProps?.(index)} data-invalid={props.bubbleErrors?.[index] ? '' : undefined} aria-describedby={props.bubbleErrors?.[index] ? `composer-bubble-${bubble.id}-error` : undefined}>
          {activeType === null ? <p role="note">この種類は形式のタブから選べません。内容を確認してください。</p> : null}
          {reason ? <p role="note">{reason}</p> : bubble.type === 'text' ? <ComposerText tokenNames={tokenNames} bubble={bubble} index={index} onChange={(next) => onChange(index, next)} inserts={props.inserts} extraTokens={props.extraTokens} />
            : ['image', 'video', 'audio'].includes(bubble.type) ? <ComposerMedia key={`${bubble.id}-${bubble.type}-${accountId}`} bubble={bubble} accountId={accountId} disabled={busy} onBusyChange={props.onBusyChange} onChange={(content) => onChange(index, { ...bubble, content })} />
            : bubble.type === 'sticker' || bubble.type === 'location' ? <MessageKindFields kind={bubble.type as MessageKind} value={(bubble.content.state as MessageKindState) ?? emptyMessageKindState()} onChange={(state) => onChange(index, { ...bubble, content: { ...bubble.content, state } })} composer />
            : composed ? name ? <div className={styles.made}>
                <div className={styles.thumbnail}>{bubble.type === 'carousel' ? (() => { try { return (JSON.parse(String(bubble.content.columnsJson ?? '[]')) as Array<{ title?: string; thumbnailImageUrl?: string }>).slice(0, 3).map((column, i) => <div key={i}>{column.thumbnailImageUrl ? <img width={160} height={44} src={column.thumbnailImageUrl} alt="" /> : null}<TruncatedText value={column.title ?? ''} /></div>) } catch { return null } })() : <img width={160} height={44} src={String(bubble.content.imageUrl ?? bubble.content.previewImageUrl ?? '')} alt="" />}</div>
                <div className={styles.madeText}><strong>{name}</strong><small>{bubble.content.inline ? 'ここで作った' : 'テンプレートから選んだ'}</small><p>{bubble.type === 'carousel' ? (() => { try { return `カード ${formatNumber(JSON.parse(String(bubble.content.columnsJson ?? '[]')).length)} 枚・横にめくって見られます` } catch { return 'カードを横にめくって見られます' } })() : composerLabel(bubble.type)}</p><div className={styles.actions}><Button size="composer" disabled={busy} onClick={() => onCompose(index, bubble.type as 'carousel' | 'rich_message' | 'rich_video')}><Pencil size={16} aria-hidden />開いて直す</Button><Button size="composer" disabled={busy} onClick={() => onSaveTemplate(index)}><Bookmark size={16} aria-hidden />テンプレートにする</Button></div></div>
              </div> : <>
                <p>{`${composerLabel(bubble.type)}の作り方を選んでください`}</p>
                <div className={styles.choices}><Card className={styles.choice}><div className={styles.choiceHeading}><FileText size={16} aria-hidden /><strong>テンプレートから選ぶ</strong></div><p>{`作ってある${composerLabel(bubble.type)}を選んで入れます。入れたあとで、この配信の分だけ直せます。`}</p><Button size="composer" disabled={busy} onClick={() => onPickTemplate(index, bubble.type as ComposerKind)}><FileText size={16} aria-hidden />テンプレートから選ぶ</Button></Card><Card className={styles.choice}><div className={styles.choiceHeading}><Plus size={16} aria-hidden /><strong>ここで作る</strong></div><p>{`テンプレートの${composerLabel(bubble.type)}と同じ編集画面が開きます。作ったものがこの吹き出しに入ります。`}</p><Button size="composer" variant="primary" disabled={busy} onClick={() => onCompose(index, bubble.type as 'carousel' | 'rich_message' | 'rich_video')}><Plus size={16} aria-hidden />ここで作る</Button></Card></div>
              </> : props.extraFields?.(index, bubble)}
          {bubble.type === 'text' ? props.extraFields?.(index, bubble) : null}
          <FieldError id={`composer-bubble-${bubble.id}-error`}>{props.bubbleErrors?.[index]}</FieldError>
        </div>
      </Card>
    })}
    {props.bubblesOnly ? null : <div className={styles.add}><Button size="composer" disabled={busy || bubbles.length >= MAX_BUBBLES} title={bubbles.length >= MAX_BUBBLES ? '1回の配信は5つまでです' : undefined} onClick={onAdd}><Plus size={16} aria-hidden />メッセージを追加する</Button>{bubbles.length >= MAX_BUBBLES ? <span>1回の配信は5つまでです</span> : null}</div>}
  </section>
}


/** LINE の小さなカルーセル見本も、実際に入れたカードと操作から描く。 */
export function ComposerCarouselPreview({ bubble }: { bubble: BroadcastBubble }) {
  let columns: Array<{ title?: string; thumbnailImageUrl?: string; actions?: Array<{ label?: string }> }> = []
  try { const parsed: unknown = JSON.parse(String(bubble.content.columnsJson ?? '[]')); if (Array.isArray(parsed)) columns = parsed.filter(column => column && typeof column === 'object') } catch { /* 編集途中のJSONは空の見本にする。 */ }
  return <div className={styles.carouselPreview} aria-label="カルーセルのプレビュー">
    {columns.length ? columns.map((column, index) => <div className={styles.previewCard} key={index}>
      {column.thumbnailImageUrl ? <img width={160} height={62} src={column.thumbnailImageUrl} alt="" /> : null}
      {column.title ? <strong title={column.title}>{column.title}</strong> : null}
      {(Array.isArray(column.actions) ? column.actions : []).map((action, i) => <span className={styles.previewAction} key={i}>{action?.label || 'ボタン'}</span>)}
    </div>) : <span>カードを作ると表示されます</span>}
  </div>
}
