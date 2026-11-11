'use client'

import { MoreHorizontal } from 'lucide-react'
import { useRef, useState, type ButtonHTMLAttributes, type MouseEvent, type ReactNode, type RefObject } from 'react'
import ActionMenu, { orderActionMenuItems, type ActionMenuItem } from './action-menu'
import Button from './button'
import IconButton from './icon-button'
import ReorderHandle, { type ReorderDirection } from './reorder-handle'
export { default as ReorderHandle, useReorder } from './reorder-handle'
import { usePermissionLockTip } from './permission-lock-tip'
import styles from './row-actions.module.css'

type Base = { className?: string } & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'>

function RowIconButton({
  label,
  tone,
  grip,
  className,
  buttonRef,
  children,
  ...rest
}: Base & { label: string; tone?: 'danger'; grip?: boolean; buttonRef?: RefObject<HTMLButtonElement | null>; children: ReactNode }) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      title={label}
      data-hit-area={grip ? '' : undefined}
      className={[styles.action, tone === 'danger' && styles.danger, grip && styles.grip, className]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {children}
    </button>
  )
}

/**
 * 並び替えハンドル。Pencil V5 の `K65Uhe`。★V5 で75回。
 *
 * **行の先頭に置く。** 右の操作列に混ぜない。
 *
 * 中身は共通の並び替え部品（./reorder-handle）の `icon` の見た目。
 * 新しい画面は ReorderHandle と useReorder を直接使う（ドラッグ・上下キー・「…」を1つにする）。
 */
export function DragHandle({ label = '並び替える', ...rest }: Base & { label?: string; onMove?: (direction: ReorderDirection) => void }) {
  if (rest.disabled || (!rest.onMove && !rest.onKeyDown) || !rest.onDragStart) return null
  return <ReorderHandle look="icon" label={label} ariaLabel={label} title={label} {...rest} />
}

/**
 * 削除。Pencil V5 の `Ls12y`。★V5 で75回。
 *
 * 押した先では必ず確認を出す。消える件数と、参照している場所を先に見せる。
 */
export function DeleteAction({ label = '削除する', ...rest }: Base & { label?: string }) {
  return (
    <RowIconButton label={label} tone="danger" {...rest}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
        <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </RowIconButton>
  )
}

/**
 * その他操作（…）。Pencil V5 の `H0V8EK`。
 */
export function MoreAction({ label = 'そのほかの操作', buttonRef, ...rest }: Base & { label?: string; buttonRef?: RefObject<HTMLButtonElement | null> }) {
  return (
    <RowIconButton label={label} buttonRef={buttonRef} {...rest}>
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <circle cx="5" cy="12" r="1.8" />
        <circle cx="12" cy="12" r="1.8" />
        <circle cx="19" cy="12" r="1.8" />
      </svg>
    </RowIconButton>
  )
}

/* ------------------------------------------------------------- 「…」 */

/**
 * 危ない操作（tone: 'danger'）を最後へ集め、最初の1つの前に区切りを入れる。
 * 「危険な操作は赤字で区切りの下」は部品の中で決める（画面ごとに並べない）。
 */
export function orderRowMenuItems(items: ActionMenuItem[]): ActionMenuItem[] {
  return orderActionMenuItems(items)
}

type RowMenuTriggerProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-expanded' | 'aria-haspopup' | 'aria-label' | 'children' | 'className' | 'onClick' | 'type'
> & {
  [key: `data-${string}`]: string | undefined
}

export type RowMenuProps = {
  /** 権限で開けない理由。未確認の間は triggerProps.disabled で止める。 */
  lockedReason?: string
  /** 「…」の中の項目。危ない操作（tone: 'danger'）は部品が最後・区切りの下へ回す。 */
  items: ActionMenuItem[]
  /** 「…」ボタンの読み上げ名（例：「春のセールの操作」）。 */
  label: string
  /** メニューの読み上げ名。省略時は label。 */
  menuLabel?: string
  /** メニューの下に出す補足（例：閲覧専用の理由）。 */
  note?: string
  /**
   * 開いているか（画面が持つとき）。右クリックの ContextMenu と同じ行の
   * 「…」を1つの状態で開け閉めするときなどに渡す。渡さなければ部品が持つ。
   */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /**
   * 見た目。'plain' は一覧の標準操作、'box' は行内の小さい印ボタン。
   * 通常は線なし、乗せたときだけ薄い灰を見せる。
   */
  appearance?: 'box' | 'plain' | 'outlined'
  /**
   * 「…」の大きさ（'box' のときだけ）。'row' は 28角（★V8  など、行の「その他の操作」が 28 の板）。
   * 省略時は KspUx の 36角（友だち一覧  など 36 の板）。板ごとに絵の大きさを選ぶ。
   */
  size?: 'row' | 'small'
  /** 「…」ボタンの大きさなど、画面の絵に合わせる class。 */
  className?: string
  /** 「…」ボタンの title。省略時は label。 */
  title?: string
  /** 「…」ボタンへ渡す追加属性（撮影入口の data-qa-open・disabled など）。 */
  triggerProps?: RowMenuTriggerProps
}

/**
 * 行の右端の「…」（★V8 hnuY9 その他操作メニュー）。全部の画面がこれを使う。
 *
 * 部品の中で決めていること：
 * - 押した「…」から開く（位置の基準は押したボタン。下に場所が無ければ上へ）
 * - Esc・外を押す・Tab で閉じ、閉じたら「…」へ戻る。矢印・Home・End で項目を移る
 * - 「…」と項目の押下は行（tr の詳細へ行く押下など）へ伝えない
 * - 危ない操作は赤字で、区切りの下・最後
 */
export function RowMenu({
  lockedReason,
  items,
  label,
  menuLabel,
  note,
  open: openProp,
  onOpenChange,
  appearance = 'plain',
  size,
  className,
  title,
  triggerProps,
}: RowMenuProps) {
  const [openState, setOpenState] = useState(false)
  const open = lockedReason ? false : openProp ?? openState
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenState(next)
    onOpenChange?.(next)
  }
  const lock = usePermissionLockTip<HTMLButtonElement>(lockedReason, triggerProps?.['aria-describedby'])
  const triggerRef = lock.ref
  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    /* R13: 「…」自体の押下も行の詳細遷移へ伝えない。 */
    event.stopPropagation()
    if (!lockedReason && !triggerProps?.disabled) setOpen(!open)
  }
  const common = {
    ...triggerProps,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': open,
    onClick: toggle,
    ...lock.handlers,
    ...(lockedReason ? { title: undefined } : {}),
  }
  return (
    <>
      {appearance === 'plain' ? (
        <MoreAction {...common} label={label} buttonRef={triggerRef} className={className} data-size={size} data-row-menu="" />
      ) : (
        <IconButton {...common} ref={triggerRef} aria-label={label} title={lockedReason ? undefined : title ?? label} className={className} size={size} variant={appearance === 'outlined' ? undefined : 'plain'} data-row-menu="">
          <MoreHorizontal size={size === 'row' ? 14 : 16} aria-hidden="true" />
        </IconButton>
      )}
      {lock.node}
      <ActionMenu
        open={open}
        ariaLabel={menuLabel ?? label}
        onClose={() => setOpen(false)}
        items={orderRowMenuItems(items)}
        note={note ?? (items.length ? undefined : 'この行に使える操作はありません')}
        anchorRef={triggerRef}
      />
    </>
  )
}

/* ------------------------------------------------------------- よく使う1つ */

export type RowQuickActionProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label' | 'children' | 'className' | 'type' | 'style'> & {
  /** 見せる文字（1語。例：「配る」）。 */
  label: string
  /** 読み上げ名（例：「秋の新商品を配る」）。行の名前を入れて、どの行の操作か分かるようにする。 */
  ariaLabel: string
  /** 文字の前の印（lucide。大きさは部品が 13 にそろえる）。 */
  icon?: ReactNode
  /** 権限で使えない理由。 */
  lockedReason?: string
}

/**
 * ★V8 行の右端の「…」の左に置く、よく使う1つの操作（統括の一覧の［配る］：絵の）。
 * 幅60・高さ28・角丸8・薄い枠。同じ操作は「…」の中にも残してよい。
 * 権限で使えない人にもlockedReasonを付けて操作を残し、理由を伝える。
 * 押下は行（tr の詳細へ行く押下など）へ伝えない。見た目は部品が決める（className・style は受け取らない）。
 */
export function RowQuickAction({ label, ariaLabel, icon, onClick, title, lockedReason, ...rest }: RowQuickActionProps) {
  const lock = usePermissionLockTip<HTMLButtonElement>(lockedReason, rest['aria-describedby'])
  return (<>
    <button
      type="button"
      aria-label={ariaLabel}
      className={styles.quickAction}
      ref={lock.ref}
      data-row-quick-action=""
      onClick={(event) => {
        event.stopPropagation()
        onClick?.(event)
      }}
      {...rest}
      {...lock.handlers}
      title={lockedReason ? undefined : title ?? ariaLabel}
    >
      {icon}
      {label}
    </button>
    {lock.node}
  </>)
}

/* ------------------------------------------------------------- LAY-18 */

/*
 * #985 LAY-18: 一覧の操作はアプリ全体で同じルールにする。
 *
 * - 「詳細」は右端操作欄の先頭。閲覧する画面がない機能には置かない。
 * - 編集は行の「…」へ入れる。
 * - 複製・停止・アーカイブなどは「⋯」へ同じ順序で集約する。
 * - 削除など元に戻せない操作は区切りの後・赤で必ず最後に置く。
 *   ただし実装・許可されている操作だけを出す。全機能に削除を足さない。
 * - 権限で許可されない操作はlockedReasonで理由を伝える（サーバ側の権限判定は維持）。
 * - 使用中等で押せない操作は disabledReason で理由を示す。
 * - タッチ端末では「⋯」を含め操作領域44pxを確保する（CSS側）。
 */

/** 「詳細」「編集」のような先頭に出す操作。遷移か実行かのどちらか。 */
export type RowAction = {
  /** 既定は役割の名前（「詳細」「編集」）。行き先が役割と違うときだけ明記する。 */
  label?: string
  disabled?: boolean
  /** 権限で使えない理由。 */
  lockedReason?: string
} & ({ href: string; onClick?: never } | { onClick: () => void; href?: never })

/** 「⋯」の中へ入れる削除などの操作。色と区切りは部品側で固定する。 */
export type RowActionDestructiveItem = Omit<ActionMenuItem, 'tone' | 'dividerBefore'>

export type RowActionsProps = {
  /** 主操作を1つ表示する。詳細もある場合はメニューへ移す。 */
  primary?: RowAction
  /** 行うことなど、枠付きの小さなメニューを使う行。既定は一覧の枠なし。 */
  menuAppearance?: RowMenuProps['appearance']
  menuSize?: RowMenuProps['size']

  /** 先頭の操作。既定ラベルは「詳細」。 */
  detail?: RowAction
  /** 編集は「…」に入れる。許可されない場合もlockedReasonを付けて残す。 */
  edit?: RowAction
  /** 「⋯」に集約する複製・停止・アーカイブなど。 */
  menuItems?: ActionMenuItem[]
  /** 削除など元に戻せない操作。区切りの後に赤で最後へ置く。 */
  destructiveItem?: RowActionDestructiveItem
  /** メニューの下に出す補足（例：閲覧専用の理由）。 */
  menuNote?: string
  /** aria名に使う行の名前（例：テンプレート名）。 */
  subjectName?: string
  /** 「⋯」ボタンへ渡す追加属性（撮影入口の data-qa-open など）。 */
  menuButtonProps?: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-expanded' | 'aria-label' | 'children' | 'className' | 'onClick' | 'type'> & {
    [key: `data-${string}`]: string | undefined
  }
  className?: string
}

function RowActionButton({ action, defaultLabel, primary = false }: { action: RowAction; defaultLabel: string; primary?: boolean }) {
  const label = action.label ?? defaultLabel
  const props =
    'href' in action && action.href !== undefined
      ? { href: action.href }
      : { onClick: action.onClick, disabled: action.disabled }
  return (
    <Button {...props} variant={primary ? 'primary' : 'secondary'} size="compact" className={styles.rowButton} lockedReason={action.lockedReason}>
      {label}
    </Button>
  )
}

/**
 * 一覧行の右端に置く操作の並び。「詳細」のボタンと、編集を含む
 * それ以外を集約する「⋯」メニューを同じ順・同じ見た目で出す。
 */
export function RowActions({
  menuAppearance = 'plain',
  menuSize,
  primary,
  detail,
  edit,
  menuItems = [],
  destructiveItem,
  menuNote,
  subjectName,
  menuButtonProps,
  className,
}: RowActionsProps) {
  const editItem: ActionMenuItem[] = edit ? [{
    id: 'edit', label: edit.label ?? '編集する', disabled: edit.disabled, lockedReason: edit.lockedReason,
    disabledReason: edit.disabled ? 'ほかの操作を反映しています' : undefined,
    onSelect: () => {
      if (edit.href !== undefined) window.location.assign(edit.href)
      else edit.onClick?.()
    },
  }] : []
  const detailItems: ActionMenuItem[] = primary && detail ? [{
    id: 'detail', label: detail.label ?? '詳細', disabled: detail.disabled, lockedReason: detail.lockedReason,
    disabledReason: detail.disabled ? 'ほかの操作を反映しています' : undefined,
    onSelect: () => { if (detail.href !== undefined) window.location.assign(detail.href); else detail.onClick?.() },
  }] : []
  const normalItems = [...detailItems, ...editItem, ...menuItems.filter((item) => (!edit || item.id !== 'edit') && (!detailItems.length || item.id !== 'detail'))]
  const items: ActionMenuItem[] = destructiveItem
    ? [...normalItems, { ...destructiveItem, tone: 'danger' }]
    : normalItems
  return (
    <span data-row-actions="" className={[styles.rowActions, className].filter(Boolean).join(' ')}>
      {primary ? <RowActionButton action={primary} defaultLabel="承認する" primary /> : detail ? <RowActionButton action={detail} defaultLabel="詳細" /> : null}
      <RowMenu appearance={menuAppearance} size={menuSize} items={items}
        label={subjectName ? `${subjectName}のその他操作` : 'そのほかの操作'}
        menuLabel={subjectName ? `${subjectName}の操作` : '操作'}
        note={menuNote ?? (items.length ? undefined : 'この行に使える操作はありません')}
        triggerProps={menuButtonProps} />
    </span>
  )
}

/** 設定行の札と操作。操作の幅と右端、札との縦の中心をそろえる。 */
export function RowStatusActions({ status, children }: { status?: ReactNode; children: ReactNode }) {
  return <span className={styles.statusActions} data-shared-part="row-status-actions">
    {status}
    <span className={styles.statusAction}>{children}</span>
  </span>
}
