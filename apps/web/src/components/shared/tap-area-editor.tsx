'use client'

import type { ReactNode } from 'react'
import { ErrorCountBadge } from './error-count-badge'
import styles from './tap-area-editor.module.css'

/*
 * 画像の上で面を選ぶ（Pencil ★V8 採用案 `Wmch0`：リッチメニュー作る② 店 ・統括 egdGx／リッチメッセージ ）。
 *
 * 画像（幅 320・縦横比そのまま）を左、面の一覧（記号 A〜F・名前・動きの要約・未設定）を右に並べ、
 * その下に選んだ面の動きの欄（detail）を置く。画像の上の面を押しても、一覧の行を押しても同じ面を選べる。
 * 選んだ面は緑の枠、一覧の行は薄い緑。
 *
 * - 面を足す・線を動かして区切り直す画像（リッチメニューの CanvasEditor）は `canvas` で差し替える。
 *   渡さないときは、部品が `areas` の位置（％）で画像の上に押せる面を描く（リッチメッセージ）。
 * - 画面の上にタブの切り替えなどを置くときは `head`。
 */

export interface TapAreaItem {
  id: string
  /** 一覧の名前（例：「予約する」「右下」）。 */
  name: string
  /** 動きの要約。空・null は「未設定」。 */
  summary?: string | null
  /** 保存で落ちた、この面の直す欄の数。1 以上で行の右に赤い丸。 */
  errorCount?: number
  /** 画像の上の位置（％・左上が 0）。`canvas` を渡すときは使わない。 */
  x?: number
  y?: number
  width?: number
  height?: number
}

export interface TapAreaEditorProps {
  /** 段の題。既定「画像の上で面を選ぶ」。 */
  title?: string
  description?: ReactNode
  items: TapAreaItem[]
  selectedId: string | null
  onSelect: (id: string) => void
  /** 面を描く画像を差し替える（ドラッグで面を足す・区切り直すとき）。 */
  canvas?: ReactNode
  /** 部品が描く画像の URL（`canvas` なしのとき）。無ければ面の線だけ。 */
  imageUrl?: string | null
  /** 画像の縦横比（幅 / 高さ）。既定 1（正方形）。 */
  aspectRatio?: number
  /** 一覧が空のときの文。 */
  emptyNote?: ReactNode
  /** 題の上の段（直すタブの切り替えなど）。 */
  head?: ReactNode
  /** 下の選んだ面の動きの欄。 */
  detail?: ReactNode
  /** 外の枠を描く（リッチメニュー作る②）。カードの中に置くときは false。 */
  framed?: boolean
  /** 一覧の読み上げ名。 */
  listLabel?: string
}

/** 0 番目→A。 */
export const tapAreaLetter = (index: number) => String.fromCharCode(65 + index)

export default function TapAreaEditor({
  title = '画像の上で面を選ぶ',
  description,
  items,
  selectedId,
  onSelect,
  canvas,
  imageUrl = null,
  aspectRatio = 1,
  emptyNote,
  head,
  detail,
  framed = true,
  listLabel = '面の一覧',
}: TapAreaEditorProps) {
  return (
    <div className={styles.root}>
      <section className={framed ? styles.frame : styles.plain} aria-label={title}>
        {head}
        <div className={styles.head}>
          <h2 className={styles.title}>{title}</h2>
          {description ? <p className={styles.note}>{description}</p> : null}
        </div>
        <div className={styles.body}>
          <div className={styles.canvas} data-tap-area-canvas="">
            {canvas ?? (
              <div className={styles.image} style={{ aspectRatio: String(aspectRatio) }} data-image={imageUrl ? '' : undefined}>
                {imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- 管理用の画像（認証つき・外部の URL）
                  <img width={2500} height={1686} src={imageUrl} alt="" />
                ) : null}
                {items.map((item, index) => {
                  const selected = item.id === selectedId
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={styles.area}
                      data-selected={selected ? '' : undefined}
                      aria-pressed={selected}
                      aria-label={`面 ${tapAreaLetter(index)}「${item.name}」を選択する`}
                      onClick={() => onSelect(item.id)}
                      style={{ left: `${item.x ?? 0}%`, top: `${item.y ?? 0}%`, width: `${item.width ?? 100}%`, height: `${item.height ?? 100}%` }}
                    >
                      <span className={styles.areaLetter} aria-hidden="true">{tapAreaLetter(index)}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          {items.length > 0 ? (
            <ul className={styles.list} aria-label={listLabel}>
              {items.map((item, index) => {
                const selected = item.id === selectedId
                const summary = item.summary?.trim()
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={styles.row}
                      data-selected={selected ? '' : undefined}
                      aria-pressed={selected}
                      onClick={() => onSelect(item.id)}
                    >
                      <span className={styles.letter} aria-hidden="true">{tapAreaLetter(index)}</span>
                      <span className={styles.name}>{item.name}</span>
                      {summary ? <span className={styles.summary}>{summary}</span> : <span className={styles.unset}>未設定</span>}
                      <ErrorCountBadge count={item.errorCount ?? 0} label={`面 ${item.name}`} />
                    </button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className={`${styles.note} ${styles.empty}`}>{emptyNote ?? '面がありません。'}</p>
          )}
        </div>
      </section>
      {detail}
    </div>
  )
}
