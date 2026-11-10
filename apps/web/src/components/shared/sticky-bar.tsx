import type { CSSProperties, ReactNode } from 'react'
import styles from './sticky-bar.module.css'
import { normalizeStickyDestructiveActions, normalizeStickySaveActions, separateStickyInputReasons } from './sticky-save-actions'

export { default as StickyBarAction } from './sticky-bar-action'

/**
 * 下部追従バー。作成・編集画面の最下段。Pencil V5 の `Ai3fq`。
 *
 * **保存はここにしか置かない。** ヘッダーにも置くと、どちらを押せば
 * よいか分からなくなる。
 *
 * ## 並びは部品が決める
 *
 * **削除だけが左端。ほかは中央。右端は空ける。**
 *
 * 設計 `bV5Vs`（シナリオ編集）と `XBkiQ`（保存した検索を編集）は
 * どちらも同じ形——左端に赤い「このシナリオを削除」「この条件を削除」、
 * 中央に「キャンセル / 複製して保存 / 変更を保存」。
 *
 * **消す操作を、保存の隣に置かない。** 隣にあると、押し間違いが
 * 「保存したつもりが消えていた」になる。離すのは見た目の好みではない。
 *
 * ボタンの並びは「やめる → 下書き → 実行」で、実行がいちばん右。
 */
export default function StickyBar({
  destructive,
  status,
  info,
  actions,
  outlined,
  split,
  presentation,
  className,
}: {
  /**
   * 消す操作。**左端に、ほかから離して置く。**
   * 無ければ左端は空く（中央の位置は変わらない）。
   */
  destructive?: ReactNode
  /**
   * いまの状態。「下書き・最終保存 10:24」など。
   * 設計の2画面には無いので、**無い画面を作ってよい。**
   */
  status?: ReactNode
  /**
   * 操作の手前に添える**読むだけの一言**。押したときに何が起きるかを
   * 先に見せる用（例: ★BG-B `WDJak`「中 サイズ確認」の札
   * `components/hq/banners/export-size-chip.tsx`）。
   *
   * **帯は置き場所だけを持つ。** 色・形・アイコンは渡す側の部品が持つ。
   * 帯は40画面以上で共有しているので、ひとつの画面の見た目をここへ埋めない。
   *
   * ここにボタンや入力を置かない。置くと「操作は中央」が崩れる。
   * 渡さない画面は今までどおり左=状態／中央=操作のままで、見た目は変わらない。
   */
  info?: ReactNode
  /** 中央に並べる操作。実行がいちばん右。 */
  actions: ReactNode
  /**
   * **その画面の板が「枠線のある高さ72の帯」を描いているときに渡す。**
   * （承認済み ★BG-B `qIp42` の `X2oLn`：height 72・stroke `#DADDE2` 1px・影なし）
   *
   * V8 の既定は ★A/M10 の板の浮かせ（高さ60・枠なし・ふんわり影）。これは
   * **別の板**なので、全画面の決まりにはしない（`docs/v8-design-rules.md` §1
   * 「画面ごとに、その板の絵のとおり」）。板が違う画面はこれを渡して戻す。
   *
   * 管理画面 の土台は元から枠線のある高さ72なので、渡しても何も変わらない。
   */
  outlined?: boolean
  /** 左の一覧と右の作る欄を分ける板だけで使う。 */
  split?: { lead?: ReactNode; trailingWidth: string }
  /** 本文につながるアカウントの操作行。指定した画面だけ浮かせない。 */
  presentation?: 'account-registration' | 'account-handover' | 'distribution' | 'support-reply'
  className?: string
}) {
  const separated = separateStickyInputReasons(presentation ? actions : normalizeStickySaveActions(actions))
  const sharedActions = separated.actions
  const inputReasons = separated.reasons.length ? <div className={styles.inputReasons} role="status">{separated.reasons.join(' ')}</div> : null
  if (presentation) return (
    <div data-shared-part="sticky-bar" className={[styles.inlineBar, className].filter(Boolean).join(' ')} data-presentation={presentation}>
      {status}
      {sharedActions}
      {inputReasons}
    </div>
  )
  if (split) return (
    <div data-shared-part="sticky-bar" className={[styles.bar, styles.splitBar, outlined ? styles.outlined : null, className].filter(Boolean).join(' ')}
      style={{ '--sticky-trailing-width': split.trailingWidth } as CSSProperties}>
      <div className={styles.splitLead}>{split.lead}</div>
      <div className={styles.splitTrailing}>
        {info ? <div className={styles.info}>{info}</div> : null}
        <div className={styles.actions} data-sticky-actions>{sharedActions}</div>
        {inputReasons}
      </div>
    </div>
  )
  return (
    <div
      data-shared-part="sticky-bar"
      data-sticky-layout="center"
      className={[
        styles.bar,
        info ? styles.withInfo : null,
        outlined ? styles.outlined : null,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className={styles.lead} data-sticky-lead>
        {normalizeStickyDestructiveActions(destructive)}
        {status ? <p className={styles.status} title={typeof status === 'string' ? status : undefined}>{status}</p> : null}
        {info ? <div className={styles.info}>{info}</div> : null}
      </div>
      <div className={styles.actions} data-sticky-actions>{sharedActions}</div>
      {/* 左の補足の有無によらず、真ん中の操作のために右側も同じ幅を持つ。 */}
      <div aria-hidden="true" />
      {inputReasons}
    </div>
  )
}

/** 本文列の下端へ置く操作と、その直前の知らせ。 */
export function StickyBarRegion({ children, feedback, gap }: { children: ReactNode; feedback?: ReactNode; gap: string }) {
  return <div className={styles.region} style={{ '--sticky-region-gap': gap } as CSSProperties}>{feedback}{children}</div>
}
