'use client'

/*
 * ★V8 会話の頭（ XqSvX「会話の頭」）。LINE の会話もメールの会話も同じ形にする
 * （オーナー指摘：メールと LINE で頭の形がばらばら）。
 *
 *   顔28・名前15/600・その下に補足（LINE・2時間前／メール・件名）
 *   右に 担当：名前 ⌄・☆（LINE だけ）・● 対応状況 ⌄・🔍（LINE だけ）・右の列の出し入れ
 *   担当・対応状況を持たない媒体（Instagram）は、その2つを渡さなければ出さない。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, MoreHorizontal, PanelRight, Search, Star } from 'lucide-react'
import type { OperatorOption } from '@/components/chats/inbox-dropdown'
import Avatar from '@/components/shared/avatar'
import IconButton from './icon-button'
import ActionMenu from './action-menu'
import { HeadOperatorMenu, HeadStatusMenu, type HeadStatus } from './inbox-head-menus'
import styles from './inbox-conversation-head.module.css'

export default function ConversationHead({
  name,
  pictureUrl,
  sub,
  subTitle,
  onBack,
  attention,
  operator,
  status,
  search,
  panel,
  extra,
}: {
  name: string
  pictureUrl?: string | null
  /** 名前の下の1行（LINE・2時間前／メール・件名） */
  sub: string
  subTitle?: string
  /** 狭い幅で一覧へ戻る */
  onBack?: () => void
  attention?: { on: boolean; saving: boolean; onToggle: () => void; lockedReason?: string; disabled?: boolean }
  /** 担当。担当を持たない会話（店舗のメール）では渡さず、欄ごと出さない。変えられない人には lockedReason を渡して灰色にする。 */
  operator?: { value: string; operators: OperatorOption[]; onChange: (next: string) => void; lockedReason?: string }
  status?: { value: HeadStatus; onChange: (next: HeadStatus) => void; lockedReason?: string }
  search?: { open: boolean; onToggle: () => void }
  panel?: { open: boolean; onToggle: () => void }
  /** 頭の右端の前に足すもの（あれば） */
  extra?: ReactNode
}) {
  const [width, setWidth] = useState(1000)
  const [moreOpen, setMoreOpen] = useState(false)
  const headRef = useRef<HTMLDivElement>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!headRef.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(headRef.current)
    return () => observer.disconnect()
  }, [])
  const compact = width < 570
  const foldAttention = width < 450
  return (
    <div ref={headRef} className={styles.chead} data-inbox-v8="conversation-head">
      <div className={styles.cheadWho}>
        {onBack ? (
          <button type="button" className={`${styles.cheadBack} lg:hidden`} aria-label="戻る" onClick={onBack}>
            <ChevronLeft aria-hidden="true" />
          </button>
        ) : null}
        {/* 顔は共通の Avatar（一覧の行と同じ色・頭文字の決まり）。 */}
        <Avatar name={name} src={pictureUrl} size={28} />
        <div className={styles.cheadText}>
          <span className={styles.cheadName} title={name}>{name}</span>
          <p className={styles.cheadSub} title={subTitle ?? sub}>{sub}</p>
        </div>
      </div>
      <div className={styles.cheadTools}>
        {operator ? <HeadOperatorMenu compact={compact} value={operator.value} operators={operator.operators} onChange={operator.onChange} lockedReason={operator.lockedReason} /> : null}
        {attention && !foldAttention ? (
          <IconButton
            variant="plain"
            data-part="attention-star"
            aria-label={attention.on ? '注目から外す' : '注目にする'}
            title={attention.on ? '注目から外す' : '注目にする'}
            pressed={attention.on}
            disabled={attention.saving || attention.disabled}
            lockedReason={attention.lockedReason}
            onClick={attention.onToggle}
          >
            <Star aria-hidden="true" />
          </IconButton>
        ) : null}
        {status ? <HeadStatusMenu value={status.value} onChange={status.onChange} lockedReason={status.lockedReason} /> : null}
        {extra}
        {search ? <IconButton variant="plain" aria-label="会話の中を探す" title="検索" aria-expanded={search.open} onClick={search.onToggle}><Search aria-hidden="true" /></IconButton> : null}
        {attention && foldAttention ? <><IconButton ref={moreRef} variant="plain" aria-label="その他の操作" aria-expanded={moreOpen} onClick={() => setMoreOpen(now => !now)}><MoreHorizontal aria-hidden="true" /></IconButton><ActionMenu open={moreOpen} anchorRef={moreRef} ariaLabel="その他の操作" onClose={() => setMoreOpen(false)} items={[{ id: 'attention', label: attention.on ? '注目から外す' : '注目にする', disabled: attention.saving || attention.disabled, lockedReason: attention.lockedReason, onSelect: () => { setMoreOpen(false); attention.onToggle() } }]} /></> : null}
        {panel ? (
          <button
            type="button"
            className={styles.cheadSquare}
            data-inbox-v6="customer-info-toggle"
            aria-expanded={panel.open}
            onClick={panel.onToggle}
          >
            <PanelRight aria-hidden="true" />
            <span className="sr-only">{panel.open ? '顧客情報を閉じる' : '顧客情報を表示'}</span>
          </button>
        ) : null}
      </div>

    </div>
  )
}
