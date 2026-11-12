'use client'
import Notice from '@/components/shared/notice'
import styles from './message-type-tabs.module.css'
import Button from '@/components/shared/button'

/*
 * 送るものの種別を選ぶタブ。
 *
 * 並びと呼び名は Lステップの「配信内容の設定」に合わせてある。作れないものも
 * **並べたうえで押せなくする**。並びごと消すと「この管理画面ではスタンプを
 * 送れない」ことが分からず、できるはずだと思って探し回ることになる。
 *
 * 押せないものには理由を出す。「まだ」なのか「別の場所でできる」のかで、
 * 次にどうすればいいかが変わる。
 */

/** 送るものの種別。'question' は質問メッセージ（分岐）。 */
export type StepMessageKind =
  | 'text'
  | 'sticker'
  | 'image'
  | 'question'
  | 'carousel'
  | 'location'
  | 'intro'
  | 'audio'
  | 'video'

interface KindDef {
  value: StepMessageKind
  label: string
  /** 押せないときの理由。作れるものは undefined。 */
  disabledReason?: string
}

/**
 * 132 / 137 で列を広げ、位置情報・動画・音声・スタンプ・カルーセルを
 * 送れるようにした。
 *
 * 残るのは紹介だけ。LINE に該当するメッセージの種別が無い。
 *
 * カルーセルは組み立てが重いので、この画面では作らずテンプレートから選ぶ。
 * 同じ編集画面を2つ持つと、片方だけ直して食い違う。
 */
export const STEP_MESSAGE_KINDS: KindDef[] = [
  { value: 'text', label: 'テキスト' },
  { value: 'image', label: '画像' },
  { value: 'video', label: '動画' },
  { value: 'audio', label: '音声' },
  { value: 'sticker', label: 'スタンプ' },
  { value: 'carousel', label: 'カルーセル' },
  { value: 'location', label: '位置情報' },
  { value: 'question', label: '質問' },
  {
    value: 'intro',
    label: '紹介',
    disabledReason:
      '他のLINEアカウントの紹介は、LINE側に該当するメッセージの種別がありません。テキストに友だち追加のURLを書くか、カードタイプのテンプレートにボタンを置いてください。',
  },
]

export function isStepMessageKindAvailable(kind: StepMessageKind): boolean {
  return !STEP_MESSAGE_KINDS.find((k) => k.value === kind)?.disabledReason
}

export interface MessageTypeTabsProps {
  value: StepMessageKind
  onChange: (next: StepMessageKind) => void
  /** タブの下に出すもの（本文の入力欄など）。 */
  children?: React.ReactNode
}

export default function MessageTypeTabs({ value, onChange, children }: MessageTypeTabsProps) {
  const selected = STEP_MESSAGE_KINDS.find((k) => k.value === value)

  return (
    <div>
      {/*
        設計は外枠h38・r8の帯に、h30・r6のタブを入れた形。
        横に9つ並ぶ。狭い画面では折り返す（横スクロールにすると隠れたタブに気づけない）ので、
        高さは `min-h` で持つ。1行に収まるときは設計どおり38pxになる。
      */}
      <div
        role="tablist"
        className={`${styles.rail} bg-canvas-sunken flex flex-wrap items-center gap-1 p-1`}
      >
        {STEP_MESSAGE_KINDS.map((kind) => {
          const disabled = Boolean(kind.disabledReason)
          const active = kind.value === value
          return (
            <Button variant="secondary" className={(`${styles.tab} px-3 text-micro font-medium transition-colors ${
                active
                  ? 'border-hairline bg-canvas text-ink border'
                  : disabled
                    ? 'text-ink-faint cursor-not-allowed opacity-50'
                    : 'text-ink-secondary hover:bg-canvas'
              }`) + ' h-auto whitespace-normal'} key={kind.value} type="button" role="tab" aria-selected={active} lockedReason={kind.disabledReason} onClick={() => !disabled && onChange(kind.value)}>
              {kind.label}
            </Button>
          )
        })}
      </div>

      {/*
        押せないタブを押したときに何も起きないと、壊れているのか未対応なのかが
        分からない。選ばれている種別の説明を、タブのすぐ下に出しておく。
      */}
      {selected?.disabledReason && (
        <Notice tone="warn" className="mt-3">
          {selected.disabledReason}
        </Notice>
      )}

      <div className="mt-4">{children}</div>
    </div>
  )
}
