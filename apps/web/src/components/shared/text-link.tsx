
import Link from '@/components/shared/list-navigation'
import type { AnchorHTMLAttributes } from 'react'
import { ArrowRight, ArrowUpRight } from 'lucide-react'
import styles from './text-link.module.css'

/**
 * リンク（→つき。Pencil ★V8 `g5Db8`）。
 *
 * 文字 12px/500 の緑のリンクの右に小さな矢印が付く。乗せると矢印が
 * 2px 右に滑る（120ms）。「受信箱で開く」「配信設定へ」など、
 * 行き先を示す小さな導線に使う。
 *
 * `inline` は本文の中のリンク（「パスワードを忘れた方」「無料で始める」など）。
 * 矢印を付けず、周りの文字の大きさのまま緑の文字にし、乗せると下線。
 */
export default function TextLink({
  href,
  children,
  className,
  external = false,
  tone,
  iconTone,
  emphasis,
  inline = false,
  truncate = false,
  title,
  ...rest
}: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
  tone?: 'action' | 'menu'
  iconTone?: 'link'
  /** 一覧の段の行で使う強めの文字（大きさ・太さは段から渡す）。既定のリンクは変えない。 */
  emphasis?: 'row-step'
  external?: boolean
  /** 本文の中のリンク。矢印なし・周りの文字の大きさのまま。 */
  inline?: boolean
  /** 短い操作名を1行で省略する。文字の全文は title に残す。 */
  truncate?: boolean
  href: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <Link href={href} data-tone={tone} data-icon-tone={iconTone} data-emphasis={emphasis} data-inline={inline || undefined} data-truncate={truncate || undefined} title={title ?? (truncate && typeof children === 'string' ? children : undefined)} className={[styles.root, className].filter(Boolean).join(' ')} {...rest} target={external ? '_blank' : rest.target} rel={external || rest.target === '_blank' ? 'noopener noreferrer' : rest.rel}>
      <span className={styles.label}>{children}</span>
      {inline ? null : external || rest.target === '_blank' ? <ArrowUpRight size={16} aria-hidden="true" data-external-icon className={styles.arrow} /> : <ArrowRight size={16} aria-hidden="true" className={styles.arrow} />}
    </Link>
  )
}
