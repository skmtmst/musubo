import { ChevronDown, ChevronUp } from 'lucide-react'
import { useId, type FocusEventHandler, type ReactNode, type Ref } from 'react'
import styles from './disclosure.module.css'

/** カード全体を開閉する共通の操作。 */
export function DisclosureToggle({ open, controls, onToggle }: { open: boolean; controls: string; onToggle: () => void }) {
  return <button type="button" className={styles.foldToggle} onClick={onToggle} aria-expanded={open} aria-controls={controls}>
    {open ? '畳む' : '開く'}{open ? <ChevronUp className={styles.foldToggleIcon} aria-hidden="true" /> : <ChevronDown className={styles.foldToggleIcon} aria-hidden="true" />}
  </button>
}

/**
 * 開閉する欄。Pencil ★V8（V8.pen）「開け閉めする段」。
 *
 * 中身はネイティブの `<details>`/`<summary>`。キーボード（Enter・Space）と読み上げ
 * （開いている／閉じている）は最初から効く。見た目と動きだけをそろえる。
 *
 * - 閉じている時は、中に何があるかを `hint`（「3項目」など）で見せる。空の欄は作らない
 * - 高さは動かさない（周りが揺れる）。印を回し、中身を薄く出すだけ
 */
export default function Disclosure({
  title,
  hint,
  defaultOpen = false,
  size = 'standard',
  appearance = 'card',
  selected = false,
  className,
  id,
  onToggle,
  detailsRef,
  onBlur,
  children,
}: {
  title: ReactNode
  /** 閉じている時に右へ出す要約。開くと消える。 */
  hint?: ReactNode
  defaultOpen?: boolean
  size?: 'standard' | 'compact' | 'body'
  appearance?: 'card' | 'inset' | 'section'
  /** 選択中の欄を見出し左の緑印で示す。 */
  selected?: boolean
  className?: string
  id?: string
  /** 開いたときにだけ必要な詳細を読み込むための口。 */
  onToggle?: (open: boolean) => void
  /** 保存の誤りで欄を開いて移るとき（呼ぶ側が open を立てる）。 */
  detailsRef?: Ref<HTMLDetailsElement>
  onBlur?: FocusEventHandler<HTMLDetailsElement>
  children: ReactNode
}) {
  return (
    <details
      ref={detailsRef}
      onBlur={onBlur}
      id={id}
      data-appearance={appearance}
      data-size={size}
      onToggle={onToggle ? (event) => onToggle(event.currentTarget.open) : undefined}
      open={defaultOpen || undefined}
      className={[styles.root, size === 'compact' ? styles.compact : '', className].filter(Boolean).join(' ')}
    >
      <summary className={styles.summary} data-selected={selected || undefined}>
        <span className={styles.title}>{title}</span>
        {hint ? <span className={styles.hint}>{hint}</span> : null}
        <ChevronDown aria-hidden="true" className={styles.chevron} />
      </summary>
      <div className={styles.body}>{children}</div>
    </details>
  )
}

/** 開いた欄に添える補足文。 */
export function DisclosureNote({ children }: { children: ReactNode }) {
  return <p className={styles.note}>{children}</p>
}

/**
 * 1枚のカードの中に並べる開閉の項目。閉じた時は見出しの下に要約を置き、開くと中身を出す。
 *
 * - 開閉は呼ぶ側が持つ（開き方を覚える画面のため）。押す所は「開閉」「行き先」「中身」に分ける
 * - 開閉は見出しの行のどこを押してもよい（中のボタンの押せる範囲を見出しの行いっぱいに広げる）。「？」と行き先はその上に重ね、押しても開閉しない
 * - 行き先は、閉じている時は見出しの行の右、開くと中身の下に置く（明細を読んでから動けるように。同じ物を2か所に出さない）
 * - キーボードは Enter・Space で開閉、Tab で「？」と行き先へ。読み上げは開閉の状態と要約を伝える
 * - 注意の点は要約の文字と一緒に出す（色だけで伝えない）。中身が無い要約（なし・—）は灰色にして、中身のある項目と見分ける
 * - 閉じている間は中身を描かない
 */
export function DisclosureItem({
  title,
  summary,
  tone,
  empty = false,
  help,
  action,
  open,
  onOpenChange,
  headingLevel = 4,
  id,
  children,
}: {
  title: string
  /** 閉じている時に見出しの下へ出す要約。開くと消える。 */
  summary?: string | null
  /** 要約の前の色の点。注意が要る中身があるときだけ渡す。 */
  tone?: 'danger' | 'warning'
  /** 要約が中身の無いこと（なし・—）を示す時。灰色で出す。 */
  empty?: boolean
  /** 見出しの右の「？」。 */
  help?: ReactNode
  /** 開閉とは別に押す行き先。閉じている時は見出しの行の右、開くと中身の下。 */
  action?: ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  headingLevel?: 3 | 4
  id?: string
  children: ReactNode
}) {
  const bodyId = useId()
  const summaryId = useId()
  const Heading = headingLevel === 3 ? 'h3' : 'h4'
  const shownSummary = !open && summary ? summary : null
  return (
    <section className={styles.item} id={id} data-open={open || undefined}>
      <div className={styles.itemHead}>
        <div className={styles.itemRow} data-center-row>
          <Heading className={styles.itemTitle} data-center-row-part="title">
            <button type="button" className={styles.itemToggle} data-disclosure-toggle aria-expanded={open} aria-controls={bodyId}
              aria-describedby={shownSummary ? summaryId : undefined} title={title} onClick={() => onOpenChange(!open)}>
              {title}
            </button>
          </Heading>
          {help ? <span className={styles.itemHelp} data-center-row-part="help">{help}</span> : null}
          {action && !open ? <span className={styles.itemAction} data-disclosure-action="head" data-center-row-part="action">{action}</span> : null}
          <ChevronDown aria-hidden="true" className={styles.itemChevron} data-center-row-part="icon" />
        </div>
        {shownSummary ? (
          <p id={summaryId} className={styles.itemSummary} data-empty={empty || undefined} title={shownSummary}>
            {tone ? <span className={styles.itemDot} data-tone={tone} aria-hidden="true" /> : null}
            <span className={styles.itemSummaryText}>{shownSummary}</span>
          </p>
        ) : null}
      </div>
      <div id={bodyId} className={styles.itemBody}>
        {open ? <>{children}{action ? <div className={styles.itemFoot} data-disclosure-action="foot">{action}</div> : null}</> : null}
      </div>
    </section>
  )
}
