import { Children, isValidElement, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, TriangleAlert } from 'lucide-react'
import styles from './delta-chip.module.css'

function textOf(node: ReactNode): string {
  return Children.toArray(node).map((child) => {
    if (typeof child === 'string' || typeof child === 'number') return String(child)
    return isValidElement<{ children?: ReactNode }>(child) ? textOf(child.props.children) : ''
  }).join('')
}

/** 差の札の文字が 0（「+0」「−0」「0.0%」など）なら、札を出さない。 */
export function isZeroDelta(children: ReactNode): boolean {
  const normalized = textOf(children)
    .replace(/[−ー–—]/gu, '-')
    .replace(/[+±]/gu, '')
    .replace(/[,\s]/gu, '')
    .replace(/(%|pt|ポイント|件|人|分|円)$/iu, '')
  return normalized !== '' && Number(normalized) === 0
}

/**
 * 増減の札（Pencil ★V8 `C6DGX`・`OEQxt`・`r9qfM2`）。
 *
 * 前より増えた・減った・要確認、を小さな色付きの札で出す。
 * 数のマス（KPI）の横などに置く。良い＝緑、悪い＝赤、要確認＝黄。
 * 矢印と符号は数の向き、色は良し悪しを示す。
 */
export default function DeltaChip({
  tone,
  direction,
  children,
}: {
  /** up＝良い（緑）・down＝悪い（赤）・attention＝要確認（黄） */
  tone: 'up' | 'down' | 'attention'
  /** 数の増減の向き。色（良い・悪い）とは別。渡さなければ色と同じ向き。ブロック率が下がって良いときは tone=up・direction=down。 */
  direction?: 'up' | 'down'
  children: React.ReactNode
}) {
  if (tone !== 'attention' && isZeroDelta(children)) return null
  const text = textOf(children).trimStart()
  const hasMagnitude = /^[+＋−\-±]?(?:[¥￥$€£]\s*)?\d/u.test(text)
  const arrowDirection = /^[−-]/u.test(text) ? 'down' : /^[+＋]/u.test(text) ? 'up' : direction ?? (tone === 'down' ? 'down' : 'up')
  // 既に符号がある文字・未知の値・説明文は変えず、符号なしの数だけ補う。
  const sign = tone !== 'attention' && /^(?:[¥￥$€£]\s*)?\d/u.test(text)
    ? (direction ?? tone) === 'up' ? '+' : '−'
    : ''
  return (
    <span className={[styles.root, styles[tone]].join(' ')}>
      {tone === 'attention' ? <TriangleAlert size={16} aria-hidden="true" className={styles.attentionIcon} /> : null}
      {tone !== 'attention' && hasMagnitude ? (arrowDirection === 'up' ? <ArrowUp size={12} aria-hidden="true" data-delta-direction="up" /> : <ArrowDown size={12} aria-hidden="true" data-delta-direction="down" />) : null}
      <span>{sign}{children}</span>
      {tone !== 'attention' && hasMagnitude ? <span data-delta-word className={styles.word}>{tone === 'up' ? '改善' : '悪化'}</span> : null}
    </span>
  )
}
