import type { ReactNode } from 'react'
import { CloudOff, FileSearch, List, Lock, RotateCw, SearchX } from 'lucide-react'
import Button from './button'
import { loadFailureCopy, type PermissionScope } from './api-error-message'
import LoadFailureContact from './load-failure-contact'
import styles from './target-missing.module.css'

/**
 * 開く対象がないときの共通表示。見た目は現在のトークンを使う。
 *
 * 詳細・編集・結果の画面で、開く対象が無いときの1枚。3つの状態を
 * 言い分ける（いまは37画面が赤い字だけ・ピンクの箱・灰色の文だけ・
 * 枠つきの箱とばらばらだった）。
 *
 * - `unspecified` … URL に id が無い（FileSearch の印）
 * - `not-found` … 取得して見つからない（404・空。SearchX の印）
 * - `error` … 取得に失敗（CloudOff の印。`onRetry` で再取得）
 *
 * 見出しは「何が」＋「どうなっているか」の1文
 * （「編集するテンプレートが指定されていません」など）。英語・id は
 * 出さない。ボタンは副（枠）1つだけ。`unspecified` と `not-found` は
 * `backHref`＋`backLabel` で一覧へ戻し、`error` は `onRetry` で
 * もう一度読み込む。赤・ピンク・主ボタン（緑の塗り）は使わない。
 *
 * 対象が無いときは、この部品だけを出す。その画面の KPI・タブ・
 * 右の案内カード・下の固定バーなど、対象が無いと意味のない部品は
 * 呼び出し側で出さない（設計の決まり）。
 */
/** forbiddenは権限が確認済みの入口拒否。通信の読込失敗とは区別して戻る道を出す。 */
export type TargetMissingKind = 'unspecified' | 'not-found' | 'error' | 'forbidden'

const ICONS = {
  unspecified: FileSearch,
  'not-found': SearchX,
  error: CloudOff,
  forbidden: Lock,
} as const

export type TargetMissingProps = {
  permissionScope?: PermissionScope
  kind: TargetMissingKind
  /** 「何が」＋「どうなっているか」の1文。 */
  title: string
  /** 画面全体の入口で使う場合はページ見出しにする。 */
  pageHeading?: boolean
  /** 1〜2文。次にすることを書く。 */
  description: string
  /** 戻り先の一覧（`unspecified`・`not-found`）。今のリンク先を使う。 */
  backHref?: string
  /** 「◯◯の一覧へ戻る」。 */
  backLabel?: string
  /** もう一度読み込む（`error`）。 */
  onRetry?: () => void
  /**
   * 捕まえた取得失敗（m23m）。`error` のときだけ見る。
   * 403 は権限の案内にし、押しても直らない再試行の口は出さない。
   * 429 は待ち秒数（`Retry-After` があれば使う）を添える。
   */
  error?: unknown
  /** 読み直している間。二度押しを止める。 */
  retrying?: boolean
  /** 既存の再試行や権限確認の操作。渡したときは既定の再試行と重ねない。 */
  action?: ReactNode
  /**
   * いまの LINE アカウント名（`not-found` のみ・任意）。
   * 渡すと説明のあとに「いまの LINE アカウントは「◯◯」です。」を足す
   * （別アカウントのものを開いた人が気づけるように）。
   */
  accountName?: string
}

/** ダイアログの本文に再取得の操作を置くときに使う。 */
export function InlineLoadFailure({ title, description, onRetry, retrying, 'data-design-node': designNode }: {
  title: string
  description: string
  onRetry: () => void
  retrying?: boolean
  'data-design-node'?: string
}) {
  return <div className={styles.inlineError} role="alert" data-design-node={designNode}>
    <strong>{title}</strong>
    <p>{description}</p>
    <Button busy={retrying} busyLabel="読み込んでいます" onClick={onRetry}>もう一度読み込む</Button>
  </div>
}

export default function TargetMissing({
  kind,
  permissionScope = 'store',
  title,
  pageHeading = false,
  description,
  backHref,
  backLabel,
  onRetry,
  error,
  retrying = false,
  action: suppliedAction,
  accountName,
}: TargetMissingProps) {
  const Icon = ICONS[kind]
  /*
   * ：v8 の絵の失敗の題は「読み込めませんでした」。共通の文（ListState・失敗の言い分け）と、
   * 画面が渡す「〇〇を表示できませんでした」を、v8 では「〇〇を読み込めませんでした」で出す。
   */
  const shownTitle = kind === 'error' ? title.replace(/表示できませんでした$/, '読み込めませんでした') : title
  const showBack = (kind === 'unspecified' || kind === 'not-found' || kind === 'forbidden') && backHref && backLabel
  // 権限の案内を残し、権限変更後にも同じ口から読み直せる。
  // 文言は画面の指定どおり（出し分け文言が要るときは ListState の `error` を使う）。
  const failure = kind === 'error' && error !== undefined ? loadFailureCopy(error, 'この画面', permissionScope) : null
  const retry = onRetry ?? (() => window.location.reload())
  const showRetry = kind === 'error'
  const accountLine =
    kind === 'not-found' && accountName ? `いまの LINE アカウントは「${accountName}」です。` : null

  // ボタンは1つだけ（設計の決まり）。両方渡されたら戻るを優先する。
  let action: ReactNode = null
  if (showBack) {
    action = (
      <Button href={backHref} variant="secondary">
        <List aria-hidden="true" size={16} />
        {backLabel}
      </Button>
    )
  } else if (showRetry) {
    /* ：v8 の絵は「もう一度試す」。 */
    /* 読み上げ名は見えている文字と同じにする（別の名前を付けると、声で操作する人が呼べない）。 */
    action = (
      <Button type="button" variant="secondary" onClick={retry} disabled={retrying} busy={retrying} busyLabel="読み込んでいます">
        <RotateCw aria-hidden="true" size={16} />もう一度読み込む
      </Button>
    )
  }

  const finalAction = suppliedAction !== undefined ? suppliedAction : action

  return (
    <div
      className={styles.root}
      data-target-missing={kind}
      // 読み込めなかったことだけ、その場で読ませる。
      role={kind === 'error' ? 'alert' : undefined}
    >
      <div className={styles.mark}>
        <Icon aria-hidden="true" size={20} />
      </div>
      {pageHeading ? <h1 className={styles.title}>{shownTitle}</h1> : <p className={styles.title}>{shownTitle}</p>}
      <p className={styles.description}>
        {failure && !failure.retryable ? failure.description : kind === 'error' ? <LoadFailureContact description={description} /> : description}
        {accountLine ? <span> {accountLine}</span> : null}
      </p>
      {finalAction ? <div className={styles.action}>{finalAction}</div> : null}
    </div>
  )
}
