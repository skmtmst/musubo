'use client'

import { Children, Fragment, isValidElement, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { FolderNarrowContext, folderRowIds } from './folder-narrow-context'
import ActionMenu, { type ActionMenuItem } from './action-menu'
import HelpTip from './help-tip'
import { usePermissionLockTip } from './permission-lock-tip'
import { folderDisplayColor } from './folder-dot'
import { ArrowDown, ArrowUp, Ellipsis, Folder, FolderOpen, FolderPlus, Inbox, Palette, Pencil, Star, Trash2 } from 'lucide-react'
import { RowMenu } from './row-actions'
import styles from './folder-panel.module.css'
import noteStyles from './managed-folder-panel.module.css'

/** テンプレート一覧を正とする、全画面共通のフォルダ欄幅。 */
export const FOLDER_RAIL_WIDTH = '15.75rem'
export const FOLDER_RAIL_STYLE = {
  '--folder-rail-width': FOLDER_RAIL_WIDTH,
} as CSSProperties

/**
 * 一覧の左に置くフォルダの縦パネル。
 *
 * Pencil V5 の `Pw4WX`（共通 フォルダレール）。
 *
 * 設計ではタグ（タグ・友だち情報欄）がどちらもこの形をしている。
 * 以前は一覧の上に横の帯として並べていたが、分類が増えると折り返して
 * 2段3段になり、その下の検索や表が押し下げられていた。縦なら増えても
 * 幅が変わらない。
 *
 * 中身の作り（何を数えるか、消せるか）は画面ごとに違うので、
 * 行の一覧だけ受けて、下に足すものは children で受ける。
 */
export interface FolderPanelRow {
  id: string
  label: string
  /** V8 共通部品 faSbC。未指定の古い呼び方は「すべて」「未分類」の名前から判定する。 */
  kind?: 'all' | 'unfiled' | 'folder' | 'frequent'
  /**
   * このフォルダに属する件数。`null` は「数えていない」（#631）。
   *
   * 母集団が確立できていない口では、`0` と嘘をつくより出さない方がよい。
   * `null` のときは何も出さない（★管理画面：以前の `—` は並ぶと意味の無い記号の列に見えた）。
   */
  count: number | null
  /**
   * フォルダの色（#RRGGBB）。115 で folders.color を足した。
   * 未設定は null。色はフォルダに付き、属するタグに出る。
   */
  color?: string | null
  /** V8 の分類の印。all・unfiled では無視し、共通部品で決める。 */
  icon?: ReactNode
  /** フォルダ全体の選択など、行の右に置く操作。 */
  trailing?: ReactNode
  /** 選ぶ窓（dJZ7Q）のフォルダごと選ぶチェック。行の左に置き、readOnly でも出す。 */
  leading?: ReactNode
  /** 行ごとの追加操作。今の操作の前に置き、その後に区切りを入れる。 */
  leadingActions?: ActionMenuItem[]
  /**
   * 直せる行だけ渡す。「すべて」「未分類」は直せない。
   *
   * 以前は × を出して消すだけだった。名前も色も変えられず、
   * 直したいときに作り直すしかなかった。
   */
  onEdit?: () => void
  /** 権限がない時も行操作を残すための理由。 */
  lockedReason?: string
  /** 権限未確定などの普通の無効状態。 */
  actionsDisabled?: boolean
  /** 色を持たないフォルダ（統括のひな形の分類など）は false。「色を変える」を出さない。 */
  colorEditable?: boolean
  /**
   * 並び順を動かす。**端の行には渡さない**（押せない口を置かない）。
   * 設計 `CzndJ` の「並び順を上へ／下へ」。
   */
  onMoveUp?: () => void
  onMoveDown?: () => void
  /** 消す。設計 `CzndJ` の「フォルダを削除」。 */
  onDelete?: () => void
  /**
   * 消す前に読ませる一言。**中身がどうなるかを、押す前に書く。**
   *
   * 設計 `CzndJ` は「削除しても、中のテンプレートは未分類に残ります。」。
   * **この部品はテンプレートにも属性にも使う**ので、言葉は呼ぶ側が決める。
   * ここで「テンプレート」と書くと、ほかの画面で嘘になる。
   */
  deleteNote?: string
  /** 画像確認で、この行の操作メニューを開くための実Node。 */
  qaOpen?: string
}

/**
 * フォルダ行の操作メニューの中身（★管理画面 共通 ActionMenu）。
 * できることは変えない。端の行にはコールバックが渡らないため、
 * 押せない項目も出ない。削除は区切りの後・赤で最後に置く。
 */
function folderMenuItems(
  row: FolderPanelRow,
  runAction: (action: (() => void) | undefined) => void,
): ActionMenuItem[] {
  /*
   * ★V8（V8.pen 共通部品4 の H・nH0fZ、 2026-10-08）：言葉は 名前を変える・色を変える・並べ替える・消す。
   * 印を左に付ける。並べ替えは隣と入れ替える口なので、上へ・下へを括弧で添える。互換経路は今までの言葉のまま。
   */
  const label = { rename: '名前を変更する', color: '色を変更する', up: '並べ替える（上へ）', down: '並べ替える（下へ）', remove: '消す' }
  const icon = (node: ReactNode) => (node)
  const items: ActionMenuItem[] = []
  if (row.onEdit) {
    items.push(
      { id: `${row.id}-rename`, label: label.rename, icon: icon(<Pencil size={16} aria-hidden="true" />), onSelect: () => runAction(row.onEdit) },
    )
    if (row.colorEditable !== false) {
      items.push({ id: `${row.id}-color`, label: label.color, icon: icon(<Palette size={16} aria-hidden="true" />), onSelect: () => runAction(row.onEdit) })
    }
  }
  if (row.onMoveUp) {
    items.push({ id: `${row.id}-up`, label: label.up, icon: icon(<ArrowUp size={16} aria-hidden="true" />), onSelect: () => runAction(row.onMoveUp) })
  }
  if (row.onMoveDown) {
    items.push({ id: `${row.id}-down`, label: label.down, icon: icon(<ArrowDown size={16} aria-hidden="true" />), onSelect: () => runAction(row.onMoveDown) })
  }
  if (row.onDelete) {
    items.push({
      id: `${row.id}-delete`,
      label: label.remove,
      icon: icon(<Trash2 size={16} aria-hidden="true" />),
      tone: 'danger',
      dividerBefore: items.length > 0,
      onSelect: () => runAction(row.onDelete),
    })
  }
  const leading = row.leadingActions ?? []
  return [...leading.map((item) => ({ ...item, onSelect: () => runAction(item.onSelect) })),
    ...items.map((item, index) => ({ ...item, lockedReason: row.lockedReason, disabled: item.disabled || row.actionsDisabled, ...(index === 0 && leading.length ? { dividerBefore: true } : {}) }))]
}

const FOLDER_DELETE_HELP = 'フォルダを消しても、中の項目は未分類に残ります。'

/** Legacy notes belong to the common explanation; operational notices stay in the footer. */
function takeFolderNotes(nodes: ReactNode): { content: ReactNode[]; help: ReactNode[] } {
  const content: ReactNode[] = [], help: ReactNode[] = []
  for (const node of Children.toArray(nodes)) {
    if (isValidElement<{ children?: ReactNode }>(node) && node.type === FolderPanelNote) {
      const extra = typeof node.props.children === 'string'
        ? node.props.children.replace(/(?:フォルダを)?(?:消しても|削除しても)[^。]*未分類に残ります[。]?/gu, '').trim()
        : node.props.children
      if (extra) help.push(extra)
    } else if (isValidElement<{ children?: ReactNode }>(node) && node.type === Fragment) {
      const nested = takeFolderNotes(node.props.children)
      content.push(...nested.content); help.push(...nested.help)
    } else content.push(node)
  }
  return { content, help }
}

export default function FolderPanel({
  rows,
  activeId,
  onSelect,
  total,
  heading = 'フォルダ',
  showHeading = true,
  headingAfterAll = false,
  headingHelp,
  onAddFolder,
  addFolderLabel = 'フォルダを追加する',
  addFolderDisabled = false,
  addFolderLockedReason,
  addFolderTitle,
  hideNarrowAdd = false,
  addFolderNote,
  children,
  createAction,
  readOnly = false,
  reserveCreateSpace = readOnly || createAction !== undefined,
  disabled = false,
}: {
  /** V8: 作る操作はフォルダ列の先頭に置く。 */
  createAction?: ReactNode
  /** 作る操作をnullにして隠すときは、既定で同じ場所を空ける。選ぶだけの列では空けない。V8 のみ。 */
  reserveCreateSpace?: boolean
  /** 選ぶ窓用。行の選択は保ち、作成・編集・並べ替えなどの操作を出さない。 */
  readOnly?: boolean
  /** 読み込み・確定処理の間は選択も止める。 */
  disabled?: boolean
  rows: FolderPanelRow[]
  activeId: string
  onSelect: (id: string) => void
  /*
   * 見出しの右に出す総数。単位は画面ごとに違うので文字で受ける。
   * 「すべて」の行が同じ数を出すので、重ねて出さない画面では渡さない
   * （1画面に同じ数を何度も書かない）。渡さないときは見出しだけ出す。
   */
  total?: string
  /** 予約管理の「メニュー」など、分類の呼び名が異なる画面で使う。 */
  heading?: string
  /** 小窓で区画の見出しを外側に置くときだけ省く。 */
  showHeading?: boolean
  /** 選ぶ窓（S2Vgi）：見出しを「よく使う」「すべて」の下、フォルダの行の上に置く。 */
  headingAfterAll?: boolean
  headingHelp?: ReactNode
  /** 一覧の下に置く追加操作。道具列へ重複して置かない。 */
  onAddFolder?: () => void
  addFolderLabel?: string
  addFolderDisabled?: boolean
  /** 畳んだ選択欄には追加を出さない。広い列の権限表示は保つ。 */
  hideNarrowAdd?: boolean
  /** 入力不足とは別の権限理由。 */
  addFolderLockedReason?: string
  addFolderTitle?: string
  /** テンプレート画面と同じ位置に出す、追加操作の補足。 */
  addFolderNote?: ReactNode
  /** 下に足すもの（分類の追加など）。 */
  children?: ReactNode
}) {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)
  const registerNarrowAction = useContext(FolderNarrowContext)
  const narrowKey = useRef(Symbol('folder-add'))
  const latestAdd = useRef(onAddFolder)
  latestAdd.current = onAddFolder
  const rowIds = folderRowIds(rows)
  const canRegisterAdd = Boolean(onAddFolder || addFolderLockedReason)
  useLayoutEffect(() => {
    if (!registerNarrowAction || readOnly || hideNarrowAdd || !canRegisterAdd) return
    return registerNarrowAction({ key: narrowKey.current, rowIds, label: addFolderLabel, disabled: disabled || addFolderDisabled, lockedReason: addFolderLockedReason, run: () => latestAdd.current?.() })
  }, [registerNarrowAction, rowIds, addFolderLabel, disabled, addFolderDisabled, addFolderLockedReason, readOnly, hideNarrowAdd, canRegisterAdd])
  const addLock = usePermissionLockTip<HTMLButtonElement>(addFolderLockedReason)
  const notes = takeFolderNotes(children), addNotes = takeFolderNotes(addFolderNote)
  const hasExplanation = (!readOnly && heading === 'フォルダ') || headingHelp || notes.help.length > 0 || addNotes.help.length > 0

  const runAction = (action: (() => void) | undefined) => {
    setOpenMenuId(null)
    action?.()
  }

  return (
    // **読み上げ名を持つ。** 帯が何の分類かを、見出しの外からも辿れるように。
    <aside aria-label="フォルダ" className={`${styles.panel} overflow-visible`}>
      {createAction ? <div className={styles.create}>{createAction}</div> : reserveCreateSpace ? <div className={`${styles.create} ${styles.createPlaceholder}`} aria-hidden="true" /> : null}
      {showHeading && !headingAfterAll ? <div className={`${styles.heading} flex items-center justify-between`}>
        {hasExplanation ? <p className=" font-semibold">{heading}<HelpTip label={`${heading}の説明`}>
          {heading === 'フォルダ' ? <span>{FOLDER_DELETE_HELP}</span> : null}
          {headingHelp ? <span>{headingHelp}</span> : null}
          {[...notes.help, ...addNotes.help].map((help, index) => <span key={index}>{help}</span>)}
        </HelpTip></p>
          : <p className=" font-semibold">{heading}</p>}
        {total === undefined ? null : <span className="text-ink-faint">{total}</span>}
      </div> : null}
      <nav aria-label={heading} className={styles.rows}>
        {rows.map((row) => {
          const isActive = activeId === row.id
          const kind = row.kind ?? (row.label === 'すべて' ? 'all' : row.label === '未分類' ? 'unfiled' : 'folder')
          const menuRow = kind === 'all' && (onAddFolder || addFolderLockedReason) && !addFolderDisabled ? { ...row, leadingActions: [
            ...(row.leadingActions ?? []), { id: 'add-folder', label: addFolderLabel, icon: <FolderPlus size={16} aria-hidden="true" />, onSelect: onAddFolder, lockedReason: addFolderLockedReason },
          ] } : row
          const hasActions = !readOnly && Boolean(menuRow.leadingActions?.length || row.onEdit || row.onMoveUp || row.onMoveDown || row.onDelete)

          const afterAll = headingAfterAll && showHeading && kind === 'all' && rows.some((candidate) => (candidate.kind ?? 'folder') === 'folder' || candidate.kind === 'unfiled')
          return (
            <Fragment key={row.id}>
            <div
              className={`${styles.row} group relative flex items-center`}
              data-active={isActive || undefined}
              data-menu-open={openMenuId === row.id || undefined}
              data-has-actions={hasActions || undefined}
            >
              {row.leading ? <span className={styles.leading}>{row.leading}</span> : null}
              <button
                type="button"
                onClick={() => {
                  setOpenMenuId(null)
                  onSelect(row.id)
                }}
                disabled={disabled}
                title={row.label}
                aria-pressed={readOnly ? isActive : undefined}
                aria-current={activeId === row.id ? 'true' : undefined}
                data-part="folder-row"
                data-folder-select
                className={`${styles.select} flex min-w-0 flex-1 items-center gap-2 text-left transition-colors ${
 activeId === row.id
 ? ' '
 : ' hover:bg-canvas-sunken'
 }`}
              >
                {/* 色が付いているフォルダは丸で出す。フォルダの形を塗ると、
                    色が面で乗って名前より目立ってしまう。 */}
                <span className={styles.folderIcon} aria-hidden="true">{kind === 'all' ? <Inbox size={16} style={{ color: 'var(--color-ink)' }} /> : kind === 'frequent' ? <Star size={16} style={{ color: 'var(--color-ink)' }} /> : kind === 'unfiled' ? <FolderOpen size={16} style={{ color: 'var(--color-ink-secondary)' }} /> : <Folder size={16} fill="currentColor" style={{ color: folderDisplayColor({ name: row.label, color: row.color }) }} />}</span>
                <span className={`${styles.label} min-w-0 flex-1 truncate`}>{row.label}</span>
                {row.count === null ? null : <span className={`${styles.count} text-ink-faint shrink-0`}>{row.count}</span>}
              </button>
              {/* 操作は設計どおり1つの「…」へまとめる。行に5個の小さな口を
                  並べると、選択との押し間違いが増え、短い名前も狭くなる。 */}
              {/* I3L41O：選んだ行には絵どおり「…」の場所を取る。操作なしの
                  選んだ行（すべて・未分類）は空きの場所取りを置く。 */}
              {!readOnly && row.trailing}
              {isActive && !hasActions && !row.trailing && !readOnly ? (
                <div className={styles.menuSlot} aria-hidden="true" />
              ) : null}
              {hasActions && (
                <div className={`${styles.menu} shrink-0`}>
                  <button
                    type="button"
                    data-qa-open={row.qaOpen}
                    onClick={() => setOpenMenuId((current) => (current === row.id ? null : row.id))}
                    aria-label={`フォルダ「${row.label}」の操作`}
                    aria-haspopup="menu"
                    aria-expanded={openMenuId === row.id}
                    title={`フォルダ「${row.label}」の操作`}
                    // R37: 狭い幅ではホバーが無いため「…」を常に出す。
                    // 出さないとスマホから名前変更・削除に届かない。
                    className={`${styles.menuButton} text-ink-faint hover:text-action min-h-8 min-w-8 text-lg leading-none transition-opacity`}
                  >
                    <Ellipsis size={16} aria-hidden="true" />
                  </button>
                  {/*
                    ★V7（m13g）：フォルダの操作も共通 ActionMenu にそろえる。
                    できること（名前・色・並び順・削除・消す前の注意）は変えない。
                  */}
                  <ActionMenu
                    open={openMenuId === row.id}
                    onClose={() => setOpenMenuId(null)}
                    ariaLabel={`フォルダ「${row.label}」の操作`}
                    items={folderMenuItems(menuRow, runAction)}
                  />
                </div>
              )}
            </div>
            {afterAll ? <p className={styles.inlineHeading}>{heading}</p> : null}
            </Fragment>
          )
        })}
        {/*
          フォルダの最後の行と同じ形の「行」にする（Apple の Finder・メモの脇の列と同じ）。
          地の塗りなし・左端と印の位置・文字の大きさ・行の高さをフォルダの行にそろえる。
          乗せた時だけ行と同じ薄い地にする。選ぶ専用の窓では出さない。
        */}
        {!readOnly && (onAddFolder || addFolderDisabled || addFolderLockedReason) && (
          <button
            type="button"
            onClick={onAddFolder}
            disabled={addFolderDisabled}
            ref={addLock.ref}
            title={addFolderLockedReason ? undefined : addFolderTitle}
            {...addLock.handlers}
            className={styles.add}
          >
            <span className={styles.addIcon} aria-hidden="true"><FolderPlus size={16} /></span>
            <span className={styles.addLabel}>{addFolderLabel}</span>
          </button>
        )}
      </nav>
      {!readOnly ? addLock.node : null}
      {!readOnly && (addNotes.content.length > 0 || notes.content.length > 0) && (
        <div className={styles.footer}>
          {addNotes.content}
          {notes.content}
        </div>
      )}
    </aside>
  )
}

/** フォルダを消した後の案内。文字の形も列の持ち主へ寄せる。 */
export function FolderPanelNote({ itemLabel, children }: { itemLabel?: string; children?: ReactNode }) {
  return <p className={noteStyles.note}>{children ?? `フォルダを消しても、中の${itemLabel}は未分類に残ります`}</p>
}

/** フォルダ列を畳んだときも、追加操作を同じメニューへ残す。 */
export function CollapsedFolderActions({ row }: { row: FolderPanelRow }) {

  return <RowMenu label={`フォルダ「${row.label}」の操作`} items={folderMenuItems(row, (action) => action?.())} />
}
