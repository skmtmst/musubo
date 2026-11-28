'use client'

import { carouselColumnsProblem,flexContentProblem } from '@/components/broadcasts/bubble-content-check'
import { emptyMessageKindState,messageKindProblem,type MessageKind,type MessageKindState } from '@/components/scenarios/message-kind-fields'
import Button from '@/components/shared/button'
import { SaveErrorField } from '@/components/shared/save-form-errors'
import TapActionField from '@/components/shared/tap-action-field'
import { TextField } from '@/components/shared/text-field'
import { useTapActionSources } from '@/components/shared/use-tap-action-sources'
import { type BroadcastBubble,type BroadcastBubbleType,type BroadcastMessageButton } from '@/lib/api'
import { assetBubbleError,isContentTemplateType } from '@/lib/broadcast-template'
import { formatTime } from '@/lib/format'
import { tapActionFromSavedUri,tapActionLiffUrl,tapActionNeedsLiff,type TapActionKind,type TapActionValue } from '@/lib/tap-actions'
import { FileText,Trash2 } from 'lucide-react'
import { TextField as SharedTextField } from '@/components/shared/text-field'


/** 知らない種類でも内部の語を出さない。 */
export function typeLabel(type: string): string {
  return TYPE_LABELS[type as BroadcastBubbleType] ?? 'その他'
}

/*
 * 直接は選べない種別と、その理由。
 *
 * ここに無い種別は、シナリオと同じ組み立て（`line-message.ts`）を通って
 * そのまま LINE へ渡る。ここに載っているものは手書きの中身が無いので、
 * 種別の選択肢からは選ばせない。送って初めて分かる壊れ方にしない。
 *
 * リッチメッセージ・カードタイプ・クーポン・リサーチは、コンテンツの素材
 * からのみ引用する。引用時は画面の保存と Worker の解析が同じ変換
 *（`@line-crm/shared` の素材変換）で LINE の種別に直すので、中身の JSON が
 * そのまま相手のトークに届かない（監査 R144）。
 */
export const UNSENDABLE_TYPES: Partial<Record<BroadcastBubbleType, string>> = {
  rich_message: 'リッチメッセージには未対応です。いまは写真かFlexで作れます',
  card_message: 'カードタイプには未対応です。いまはカルーセルで作れます',
  coupon: 'クーポンには未対応です',
}

/*
 * メッセージ形式タブの矢印キー操作（N-063）。
 *
 * タブの作法（WAI-ARIA tabs, 手動起動）に揃える。
 * ←→↑↓ はフォーカスだけを動かし、Home/End は端へ飛ぶ。
 * **選ぶのは Enter・スペース・クリック。** 矢印を押しただけで切り替えると、
 * 書きかけの中身が移るたびに空へ戻ってしまう（切替は bubble の中身を
 * 作り直す）ので、フォーカスと選択は分ける。
 */
/**
 * R580: 保存の検査で止まった不備を直す欄がある段。
 *
 * 段の名前は `broadcast-steps.ts` の5段と同じにする。確認の段は入力を
 * 持たないので、ここには出ない（不備は必ず基本・対象者・メッセージの
 * どれかにある）。
 */
export const VALIDATION_STEP_LABEL: Record<'basic' | 'audience' | 'message', string> = {
  basic: '基本設定',
  audience: '対象者',
  message: 'メッセージ',
}

export function moveMessageTypeTabFocus(
  event: { key: string; currentTarget: HTMLElement; preventDefault: () => void },
  activeElement: Element | null,
): void {
  const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End']
  if (!keys.includes(event.key)) return
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'))
  const current = tabs.findIndex((tab) => tab === activeElement)
  if (current < 0) return
  event.preventDefault()
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? tabs.length - 1
      : (current + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) + tabs.length) % tabs.length
  tabs[next]?.focus()
}

export function formatScheduleTime(iso: string): string {
  return formatTime(iso)
}

/**
 * 配信名の上限。設計 `zZ9fA` の「14 / 60文字」。
 *
 * 保存の口には上限が無いので、ここで止めなければいくらでも入る。
 * 一覧（`q76C35`）の1列目に出る名前なので、長いと表がその1件で崩れる。
 */
export const TITLE_MAX = 60

export const STANDARD_CONDITION_AXES = [
  '名前', 'メモ', 'ステータスメッセージ', '友だち登録日', 'タグ',
  '友だち情報', 'シナリオ', 'イベント予約', 'カレンダー予約', '共通情報',
  'リマインダ', '回答フォーム', '最終反応日', 'その他', '対応マーク',
] as const

export const BROADCAST_ONLY_CONDITION_AXES = [
  '担当者', '流入経路', '配信状況', '予約状況', '購入履歴', 'ブロック状態',
] as const

/** 位置情報・音声・スタンプは、シナリオと同じ入力欄をそのまま使う。 */
export const KIND_FIELD_TYPES = new Set<BroadcastBubbleType>(['location', 'audio', 'sticker'])

export function emptyBubble(type: BroadcastBubbleType = 'text'): BroadcastBubble {
  const content: Record<string, unknown> = type === 'text' ? { text: '' }
    : type === 'image' ? { originalContentUrl: '', previewImageUrl: '' }
    : type === 'flex' ? { flexJson: '' }
    : type === 'video' ? { originalContentUrl: '', previewImageUrl: '' }
    : type === 'carousel' ? { templateId: '', templateName: '', columnsJson: '' }
    : KIND_FIELD_TYPES.has(type) ? { state: emptyMessageKindState() }
    : type === 'rich_video' ? {}
    : { assetId: '', assetName: '' }
  return { id: crypto.randomUUID(), type, content }
}

/**
 * 動画のプレビュー画像。LINE は動画と一緒に必ず受け取り（https・JPEG/PNG・1MBまで）、
 * 無いと保存の時点でサーバーが断る。以前は「任意」と書いていて、保存で英語の文が出ていた。
 */
export function videoPreviewProblem(value: unknown): string | null {
  const url = typeof value === 'string' ? value.trim() : ''
  if (!url) return '動画のプレビュー画像のURLを入れてください（JPEG・PNG、1MBまで）'
  if (!url.toLowerCase().startsWith('https://')) return '動画のプレビュー画像のURLは https:// から始めてください'
  return null
}

/*
 * ボタンの押したら（共通の欄 TapActionField・YPzmo・）。送る形（label・type: url/pdf・value）は今のまま。
 * 予約・回答フォーム・予約履歴・来店スタンプは type 'url' のまま、value にアカウントの LIFF の URL を入れる
 * （LIFF ID がまだ分からないときは一斉配信で置き換わる {{liff_id}}）。テキストを送るは、このボタンの形
 * （URL・PDF）が持てないので出さない。
 */
export const BROADCAST_TAP_KINDS: readonly TapActionKind[] = ['uri', 'booking', 'form', 'booking_history', 'visit_stamp']

export const PDF_KIND = [{ value: 'pdf', label: 'PDFを開く', description: 'https:// で始まる PDF のアドレスを開く', icon: FileText }] as const

export function buttonTapValue(button: BroadcastMessageButton): TapActionValue {
  if (button.type === 'pdf') return { kind: 'pdf', uri: button.value, text: '', refId: '' }
  return tapActionFromSavedUri(button.value)
}

export function MessageButtonsSection({ buttons, error, onChange, liffId, accountId }: {
  buttons: BroadcastMessageButton[]
  error: string
  onChange: (buttons: BroadcastMessageButton[]) => void
  liffId: string | null
  accountId: string | null
}) {
  const sources = useTapActionSources(accountId)
  const patchButton = (index: number, patch: Partial<TapActionValue>) => onChange(buttons.map((item, i) => {
    if (i !== index) return item
    const current = buttonTapValue(item)
    const kind = patch.kind ?? current.kind
    if (kind === 'pdf') return { ...item, type: 'pdf' as const, value: patch.uri ?? item.value }
    if (kind === 'uri') return { ...item, type: 'url' as const, value: patch.uri ?? (patch.kind !== undefined && current.kind !== 'pdf' ? '' : item.value) }
    if (tapActionNeedsLiff(kind)) return { ...item, type: 'url' as const, value: tapActionLiffUrl(liffId || '{{liff_id}}', kind, patch.refId ?? (patch.kind !== undefined ? '' : current.refId)) }
    return item
  }))
  return (
    <section className="border-hairline mt-4 rounded-card border bg-canvas p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-ink">ボタン</h3>
          <p className="mt-1 text-xs text-ink-faint">配信全体で1組です。すべてのメッセージの後に付きます。最大4つまで。</p>
        </div>
        <Button type="button" onClick={() => onChange([...buttons, { label: '', type: 'url' as const, value: '' }])} disabled={buttons.length >= 4}>＋ ボタンを追加する</Button>
      </div>
      <p className="mt-2 text-xs text-ink-faint">URL・PDFは https:// から始まるアドレスを入れてください。</p>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
      <div className="mt-3 space-y-2">
        {buttons.map((button, buttonIndex) => (
          <div key={buttonIndex} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2.4fr)_2rem] items-center gap-2 rounded-control bg-canvas-sunken p-2">
            <SaveErrorField names={[`buttons.${buttonIndex}.label`,"label","button.label"]}><SharedTextField aria-label={`ボタン${buttonIndex + 1}の名前`} value={button.label} onChange={(event) => onChange(buttons.map((item, i) => i === buttonIndex ? { ...item, label: event.target.value } : item))} placeholder="ボタン名" className="min-w-0 rounded-control border border-hairline bg-canvas px-2 py-1.5 text-xs" /></SaveErrorField>
            <SaveErrorField names={["button"]}><TapActionField
              name={`ボタン${buttonIndex + 1}`}
              kindLabel={`ボタン${buttonIndex + 1}の種類`}
              value={buttonTapValue(button)}
              onChange={(patch) => patchButton(buttonIndex, patch)}
              kinds={BROADCAST_TAP_KINDS}
              extraKinds={PDF_KIND}
              hasLiff={Boolean(liffId)}
              liffSettingsHref={accountId ? `/accounts/detail?id=${encodeURIComponent(accountId)}` : '/accounts'}
              sources={sources}
              renderBody={(kind) => kind !== 'pdf' ? undefined : (
                <SaveErrorField names={[`buttons.${buttonIndex}.value`,"value","button.value"]}><TextField type="url" aria-label={`ボタン${buttonIndex + 1}のURL`} value={button.value} placeholder="https://example.com/guide.pdf" onChange={(event) => patchButton(buttonIndex, { uri: event.target.value })} /></SaveErrorField>
              )}
            /></SaveErrorField>
            <button type="button" aria-label={`ボタン${buttonIndex + 1}を削除`} onClick={() => onChange(buttons.filter((_, i) => i !== buttonIndex))} className="flex justify-center text-danger"><Trash2 size={16} aria-hidden /></button>
          </div>
        ))}
        {buttons.length === 0 && <p className="rounded-control bg-canvas-sunken p-3 text-xs text-ink-faint">ボタンはまだありません。</p>}
      </div>
    </section>
  )
}

/**
 * 送る内容がそのまま送れる形になっているか。空文字なら問題なし。
 *
 * **保存の検査と、上の5段の帯が同じ関数を見る。** 別々に書いていると、
 * 帯は「メッセージ 済み」なのに保存で断られる、という一番困る形になる。
 */
export function bubblesError(bubbles: BroadcastBubble[]): string {
  for (const [index, bubble] of bubbles.entries()) {
    if (bubble.type === 'text' && !String(bubble.content.text ?? '').trim()) return `吹き出し${index + 1}のテキストを入力してください`
    if (['image','video'].includes(bubble.type) && !bubble.content.originalContentUrl) return `吹き出し${index + 1}のファイルをアップロードしてください`
    if (bubble.type === 'video') {
      const problem = videoPreviewProblem(bubble.content.previewImageUrl)
      if (problem) return `吹き出し${index + 1}：${problem}`
    }
    /*
      位置情報・音声・スタンプは、足りない項目があると送る形にできない。
      空のまま保存すると、本文が空文字の配信になって、相手には**何も
      書かれていないメッセージ**が届く。
    */
    if (KIND_FIELD_TYPES.has(bubble.type)) {
      const state = bubble.content.state as MessageKindState | undefined
      /*
       * R234: 空だけでなく「入っているが送れない」（http の音声URL・
       * 文字のスタンプ番号）も未完成にする。理由は入力欄の検査と同じ文にし、
       * 5段の帯と保存の検査で食い違わせない。
       * R210: 範囲外の緯度・経度も messageKindProblem が直し方まで言う
       * （「未入力」とは言わない）。分岐を分けると文言がずれるので1本化する。
       */
      const problem = !state
        ? `${TYPE_LABELS[bubble.type]}を入力してください`
        : messageKindProblem(bubble.type as MessageKind, state)
      if (problem) {
        return `吹き出し${index + 1}の${problem}`
      }
    }
    if (bubble.type === 'carousel') {
      const columnsProblem = carouselColumnsProblem(bubble.content.columnsJson)
      if (columnsProblem) {
        return `吹き出し${index + 1}の${columnsProblem}`
      }
    }
    if (bubble.type === 'flex') {
      const flexProblem = flexContentProblem(bubble.content.flexJson)
      if (flexProblem) {
        return `吹き出し${index + 1}の${flexProblem}`
      }
    }
    /*
     * 素材の引用は、選んでいないときも選んだ中身が送れる形に直せないときも
     * ここで止める。保存の検査と Worker の解析が同じ変換を見るので、
     * 画面では通るのに送信で断られる形にならない（監査 R144）。
     */
    if (bubble.type === 'rich_video' || isContentTemplateType(bubble.type)) {
      const problem = assetBubbleError(bubble)
      if (problem) return `吹き出し${index + 1}の${problem}`
    }
  }
  return ''
}

/*
 * 右側のプレビューの枠は、LINEのトーク画面に近い共通部品
 * `LinePreview`（`components/shared/line-preview`）を使う。
 * 画面ごとに枠の色を作らない。
 */

/**
 * 種類の名前。**内部の語をそのまま画面へ出さない。**
 *
 * ここに無い種類が来たときに元の値へ落とすと、テンプレートの札に
 * `text` や `carousel` が出る（設計 `p97Tf` で見つかった）。
 * 知らない種類は「その他」にして、内部の語は出さない。
 */
export const TYPE_LABELS: Record<BroadcastBubbleType, string> = {
  text: 'テキスト', sticker: 'スタンプ', image: '写真', flex: 'Flex', location: '位置情報',
  audio: '音声', carousel: 'カルーセル', video: '動画', rich_message: 'リッチメッセージ',
  rich_video: 'リッチビデオ', card_message: 'カードタイプ', coupon: 'クーポン', research: 'リサーチ',
}
