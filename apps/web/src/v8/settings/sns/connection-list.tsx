'use client'

/**
 * SNS 連携の接続一覧（行）。承認デザイン（設定SNS連携 複数接続 第1段 v7）の F1・F2 の一覧。
 * 1サービスぶんの接続を縦に積み、行ごとに名前・状態の札・控えめな1行・操作を出す。
 *
 * 決まり：
 * - 札の言葉と色は connection-slots の connectionStatusLabel（元は status-labels の表）だけを読む。
 *   並びは絵のとおり「主連携」→状態の札。印の丸は絵に無いので出さない。
 * - 行の右端は、絵のとおり［主連携にする］／［つなぎ直す］→「⋯」の順に置く。
 *   行の中に出した操作は「⋯」から外す（同じ操作を2か所に置かない）。
 * - 閲覧しかできない人には操作を消さず、押せない理由を添えて置く（AGENTS.md §15・F8）。
 * - 「主連携にする」は接続が2件以上あって、その行がまだ主連携でないときだけ出す。
 *   接続が1件のときは選ぶ意味がないので出さない（要件 §4-3）。
 * - 「つなぎ直す」を行の中に出すのは、つなぎ直しで直せる状態（期限切れ・権限なし）の行だけ。
 *   それ以外の行は「⋯」の中に置く。
 */

import { ArrowRight } from 'lucide-react'
import Link from 'next/link'
import type { ActionMenuItem } from '@/components/shared/action-menu'
import Button from '@/components/shared/button'
import { RowMenu } from '@/components/shared/row-actions'
import StatusBadge from '@/components/shared/status-badge'
import {
  connectionStatusLabel,
  type SnsConnectionState,
  type SnsConnectionView,
  type SnsServiceSlots,
} from './connection-slots'
import styles from './sns.module.css'

/** つなぎ直しで直せる状態。絵（F1）はこの行にだけ行の中の［つなぎ直す］を出す。 */
const NEEDS_RECONNECT: SnsConnectionState[] = ['expired', 'error']

export type SnsConnectionListProps = {
  slots: SnsServiceSlots
  /** 操作ができるか。できないときは理由を添えて押せない状態で置く。 */
  canManage: boolean
  /** 押せない理由（権限・読み込み中）。 */
  lockedReason?: string
  /** いま処理中の接続。その行の操作だけ止める。 */
  busyId?: string | null
  onReconnect?: (connection: SnsConnectionView) => void
  onSetPrimary?: (connection: SnsConnectionView) => void
  onDisconnect?: (connection: SnsConnectionView) => void
  /** 行の中の移動先（Google の「営業時間へ」）。無い行は出さない。 */
  rowLink?: (connection: SnsConnectionView) => { href: string; label: string } | null
}

export default function SnsConnectionList({
  slots,
  canManage,
  lockedReason,
  busyId,
  onReconnect,
  onSetPrimary,
  onDisconnect,
  rowLink,
}: SnsConnectionListProps) {
  if (!slots.connections.length) return null
  const multiple = slots.connections.length > 1

  return (
    <ul className={styles.list}>
      {slots.connections.map((connection) => {
        const status = connectionStatusLabel(connection.state)
        const link = rowLink?.(connection) ?? null
        const busy = busyId === connection.id
        const items: ActionMenuItem[] = []

        /* 絵（F1）は異常な行にだけ［つなぎ直す］を行の中に出す。 */
        const quickReconnect = Boolean(onReconnect) && NEEDS_RECONNECT.includes(connection.state)
        /* 主連携は選べる相手が2件以上あるときだけ入れ替えられる（要件 §4-3）。 */
        const quickPrimary = Boolean(onSetPrimary) && multiple && !connection.primary

        if (onReconnect && !quickReconnect) {
          items.push({
            id: 'reconnect',
            group: 'manage',
            label: 'つなぎ直す',
            disabled: busy,
            onSelect: () => onReconnect(connection),
          })
        }
        if (onDisconnect) {
          items.push({
            id: 'disconnect',
            group: 'destructive',
            label: '解除する',
            tone: 'danger',
            disabled: busy,
            onSelect: () => onDisconnect(connection),
          })
        }

        return (
          <li key={connection.id} className={styles.conn} data-connection-id={connection.id}>
            <div className={styles.nameRow}>
              <span className={styles.name}>{connection.name}</span>
              {connection.primary ? (
                <StatusBadge tone="info" size="compact" dot={false}>
                  主連携
                </StatusBadge>
              ) : null}
              <StatusBadge tone={status.tone} size="compact" dot={false}>
                {status.label}
              </StatusBadge>
              <span className={styles.rowSpacer} />
              {quickPrimary ? (
                <Button
                  variant="secondary"
                  size="compact"
                  presentation="row-action"
                  lockedReason={canManage ? undefined : lockedReason}
                  disabled={!canManage || busy}
                  onClick={() => onSetPrimary?.(connection)}
                >
                  主連携にする
                </Button>
              ) : null}
              {quickReconnect ? (
                <Button
                  size="compact"
                  lockedReason={canManage ? undefined : lockedReason}
                  disabled={!canManage || busy}
                  onClick={() => onReconnect?.(connection)}
                >
                  つなぎ直す
                </Button>
              ) : null}
              {items.length ? (
                <RowMenu
                  label={`${connection.name}の操作`}
                  items={items}
                  showGroupHeadings={false}
                  appearance="box"
                  size="row"
                  lockedReason={canManage ? undefined : lockedReason}
                />
              ) : null}
            </div>
            {connection.meta.length ? <p className={styles.meta}>{connection.meta.join('・')}</p> : null}
            {link ? (
              <div className={styles.btnRow}>
                <Link className={styles.link} href={link.href}>
                  {link.label}
                  <ArrowRight size={16} aria-hidden />
                </Link>
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
