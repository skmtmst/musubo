'use client'

import { UNASSIGNED, unreadLookup } from '@/components/chats/assignee-unread'
import EntitySelect, { entityOptionMetadata } from '@/components/shared/entity-select'
import type { ChatStatus } from './inbox-dropdown'
import type { InboxStats } from '@/lib/api'
import { useOverlayFocus } from '@/components/shared/overlay-utils'
import Checkbox from '@/components/shared/checkbox'

import Select from '@/components/shared/select'
import { Filter, X } from 'lucide-react'
import Button from '@/components/shared/button'
import type { ReactNode, RefObject } from 'react'
import MenuPortal from '@/components/shared/menu-portal'

/**
 * 受信箱の絞り込みパネル（設計 Pencil `bXyEA` 受信箱 絞り込みパネル）。
 *
 * 以前は担当者・種別・並び順が一覧の上に並んだままで、**「絞り込みを開く」
 * という操作そのものがありませんでした。** 条件が増えるほど一覧の上が
 * 埋まり、会話が見える面積が減ります。設計は右から出るパネルにまとめます。
 *
 * 期限は一覧と同じ quickFilter へ即時に反映します。
 * まだ連携していない呼び出し元には期限の操作を出しません。
 */

export type InboxFilterValue = {
  status: 'all' | ChatStatus
  assignee: string
  channel: 'all' | 'line' | 'email'
  unreadOnly: boolean
  /** 一覧の期限条件。未指定の既存呼び出し元には操作を出さない。 */
  quickFilter?: 'all' | 'reply' | 'overdue'
}

const STATUS_OPTIONS: { value: InboxFilterValue['status']; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'unread', label: '未対応' },
  { value: 'in_progress', label: '対応中' },
  { value: 'on_hold', label: '保留' },
  { value: 'resolved', label: '対応済み' },
]

const CHANNEL_OPTIONS: { value: InboxFilterValue['channel']; label: string }[] = [
  { value: 'all', label: 'LINE・MAIL' },
  { value: 'line', label: 'LINE' },
  { value: 'email', label: 'MAIL' },
]

/** 設計の「表示するメッセージ種別」6つ。**まだ絞り込めない。** */
const MESSAGE_KINDS = ['受信', '送信', '自動応答', 'シナリオ・配信', 'フォロー / ブロック', 'システム通知']

const labelClass = 'text-ink-secondary text-xs font-medium'

export default function InboxFilterPanel({
  open,
  value,
  operators,
  unassignedUnreadCount = null,
  assigneeUnread = null,
  assigneeUnreadStatus = 'loading',
  slaEnabled = false,
  quickCounts,
  emailInboxEnabled = true,
  auxiliaryActions,
  anchorRef,
  onChange,
  onReset,
  onClose,
}: {
  open: boolean
  value: InboxFilterValue
  operators: { id: string; name: string }[]
  /** 未取得・取得失敗は null。取得済みの0件とは区別する。 */
  unassignedUnreadCount?: number | null
  /** 担当者ごとの未読数。未取得・失敗時は名前の後ろを「—」にする。 */
  assigneeUnread?: InboxStats['assigneeUnread'] | null
  assigneeUnreadStatus?: 'error' | 'ready' | 'loading'
  /** 実際の対応期限を使う場合は「期限超過」、それ以外は「1時間以上待ち」。 */
  slaEnabled?: boolean
  quickCounts?: { all: number; reply: number; overdue: number | null } | null
  emailInboxEnabled?: boolean
  /** 対応ルールなど、画面が持つ補助操作。 */
  auxiliaryActions?: ReactNode
  anchorRef?: RefObject<HTMLElement | null>
  onChange: (next: InboxFilterValue) => void
  onReset: () => void
  onClose: () => void
}) {
  /*
   * INBOX-02: 共通のオーバーレイ約束。開いたらパネル内へフォーカスを移し、
   * Tab が背面へ抜けないように循環させ、背景スクロールを止め、
   * 閉じたあとは「絞り込み」ボタンへフォーカスを戻す。
   */
  const ref = useOverlayFocus(open, onClose)

  if (!open) return null
  const set = (patch: Partial<InboxFilterValue>) => onChange({ ...value, ...patch })
  const unassignedCount = unassignedUnreadCount ?? (assigneeUnreadStatus === 'error' ? null : unreadLookup(assigneeUnread)(UNASSIGNED))
  const unassignedDescription = unassignedCount === null ? '未読 —' : `未読 ${unassignedCount}件`

  const panel = (
    <div className={anchorRef ? "" : "fixed inset-0 z-50"} role="presentation">
      {/*
        INBOX-03: 閉じる操作は背景そのものに繋ぐ。以前は外枠の
        `target === currentTarget` を見ていたが、背景は子要素が全面を覆う
        ためその判定に届かず、灰色部分を押しても閉じなかった。
      */}
      {!anchorRef ? <div className="bg-ink/20 absolute inset-0" aria-hidden="true" onMouseDown={onClose} /> : null}
      {/*
        狭い幅では画面の内側16pxいっぱいのシートにする(#982 LAY-04)。
        以前は top/right/width を固定していたため、390pxでは右120pxの
        余白込みで左側が画面外へ消え、下の「この条件で絞り込む」も
        切れていた。
        広い幅では右上寄りのポップオーバーにするが、幅は
        min(420px, 100vw-32px)、高さは 100dvh-80px までに収め、
        ヘッダーとフッターは固定・条件部分だけがスクロールする。
      */}
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="絞り込み"
        className={anchorRef ? "bg-canvas rounded-panel flex w-[min(420px,calc(100vw-2rem))] max-h-[calc(100dvh-5rem)] flex-col overflow-hidden shadow-overlay" : "bg-canvas rounded-panel fixed inset-4 flex w-auto flex-col overflow-hidden shadow-overlay sm:inset-auto sm:top-16 sm:right-6 sm:w-[min(420px,calc(100vw-2rem))] sm:max-h-[calc(100dvh-5rem)] lg:right-10"}
      >
        <header className="border-hairline flex h-14 shrink-0 items-center gap-2 border-b px-5">
          <Filter aria-hidden="true" size={20} className="text-ink" />
          <h2 className="text-ink text-base font-bold">絞り込み</h2>
          <button type="button" onClick={onClose} aria-label="絞り込みを閉じる" className="text-ink-faint hover:bg-canvas-sunken ml-auto rounded-control p-1">
            <X aria-hidden="true" size={20} />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          <div>
            <span className={labelClass}>対応状況</span>
            <Select
              aria-label="対応状況で絞り込む"
              size="full"
              value={value.status}
              onChange={(next) => set({ status: next as InboxFilterValue['status'] })}
              options={STATUS_OPTIONS}
            />
          </div>

          <div>
            <span className={labelClass}>担当</span>
            <div className="mt-1.5">
              <EntitySelect clearable size="full"
                aria-label="担当者で絞り込む"
                placeholder="すべて"
                value={value.assignee === 'all' ? '' : value.assignee}
                onChange={(next) => set({ assignee: next || 'all' })}
                options={[
                  { value: 'unassigned', label: '未割り当て', description: unassignedDescription },
                  ...operators.map((operator) => {
                    // 未読数は集計の口から渡す。画面の行から数えない（ページ送りで落ちる）。
                    const unread = assigneeUnreadStatus === 'error' ? null : unreadLookup(assigneeUnread)(operator.id)
                    return { ...entityOptionMetadata(operator), value: operator.id, label: `${operator.name}（${unread === null ? '—' : unread}）` }
                  }),
                ]}
                className="w-full"
              />
            </div>
          </div>

          {emailInboxEnabled && <div>
            <span className={labelClass}>受信経路</span>
            {/* 候補も画面内へ描く共通の選択部品を使う。 */}
            <div className="mt-1.5">
              <Select
                aria-label="受信経路で絞り込む"
                size="full"
                value={value.channel}
                onChange={(next) => set({ channel: next as InboxFilterValue['channel'] })}
                options={CHANNEL_OPTIONS}
              />
            </div>
          </div>}

          {value.quickFilter !== undefined ? (
            <div>
              <span className={labelClass}>期限</span>
              <Select
                aria-label="期限で絞り込む"
                size="full"
                value={value.quickFilter}
                onChange={(next) => set({ quickFilter: next as InboxFilterValue['quickFilter'] })}
                options={[
                  { value: 'all', label: `すべて${quickCounts ? ` (${quickCounts.all})` : ''}` },
                  { value: 'reply', label: `要返信${quickCounts ? ` (${quickCounts.reply})` : ''}` },
                  { value: 'overdue', label: `${slaEnabled ? '期限超過' : '1時間以上待ち'}${quickCounts?.overdue != null ? ` (${quickCounts.overdue})` : ''}` },
                ]}
              />
            </div>
          ) : null}

          {/*
            INBOX-16: まだ絞り込めない条件は、使える条件の下へ畳む。
            無効なまま並べると、使える条件と同じ重さで占有し、
            狭い画面では閉じる操作まで画面外へ追いやられる。
            仕組みができたら畳みを外して有効化する。
          */}
          <details className="border-hairline rounded-control border px-3 py-2.5">
            <summary className="text-ink-faint cursor-pointer text-xs font-medium">
              まだ使えない条件（メッセージ種別）
            </summary>
            <div className="mt-3 space-y-4">
              <div>
                <span className={labelClass}>表示するメッセージ種別</span>
                <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-2">
                  {MESSAGE_KINDS.map((kind) => (
                    <Checkbox key={kind} checked readOnly disabled onCheckedChange={() => {}}>{kind}</Checkbox>
                  ))}
                </div>
                <p className="text-ink-faint mt-1 text-micro">メッセージ種別での絞り込みには対応していません</p>
              </div>
            </div>
          </details>

          <Checkbox
            checked={value.unreadOnly}
            onCheckedChange={(checked) => set({ unreadOnly: checked })}
            aria-label="未読だけ表示"
            className="border-hairline border-t pt-3"
          >未読だけ表示</Checkbox>
          {auxiliaryActions ? <div className="flex items-center justify-center gap-2">{auxiliaryActions}</div> : null}
        </div>

        {/*
          INBOX-01: 条件は選んだ時点ですぐ一覧へ反映される（即時適用）。
          「この条件で絞り込む」と書くと、押すまで反映されない・閉じると
          捨てられると読めるため、閉じる操作と実態を一致させる。
          リセットも同じく即時に反映される。
        */}
        <footer className="border-hairline shrink-0 border-t px-5 py-3">
          <p className="text-ink-faint mb-2 text-micro">条件は選ぶとすぐ一覧に反映されます</p>
          <div className="flex items-center justify-between gap-3">
            <Button variant="secondary" className="text-ink-secondary px-4 py-2 h-auto whitespace-normal" type="button" onClick={onReset}>
              リセット
            </Button>
            <Button variant="primary" className="px-5 py-2 font-bold border-0 h-auto whitespace-normal" type="button" onClick={onClose}>
              閉じる
            </Button>
          </div>
        </footer>
      </section>
    </div>
  )
  return anchorRef ? <MenuPortal open={open} align="start" placement="down" getAnchor={() => anchorRef.current} getPositionRect={() => {
    const anchor = anchorRef.current?.getBoundingClientRect()
    if (!anchor) return null
    const list = anchorRef.current?.closest('[data-inbox-v4="conversation-list"]')?.getBoundingClientRect()
    const left = Math.max(anchor.left, list?.right ?? anchor.left)
    return { top: anchor.top, bottom: anchor.bottom, left, right: left, width: 0 }
  }} onClose={onClose} keepOpenOnModal>{panel}</MenuPortal> : panel
}
