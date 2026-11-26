
'use client'

import { PageExplanationProvider, PageExplanationToggle, PageExplanationBody } from '@/components/shared/page-explanation'
import { Fragment, useCallback, useState, type CSSProperties, type ReactNode } from 'react'
import { CollapsedFolderActions, type FolderPanelRow } from '@/components/shared/folder-panel'
import Select from '@/components/shared/select'
import { ListToolbarLeading } from '@/components/shared/list-toolbar'
import HelpTip from '@/components/shared/help-tip'
import { PageFrame, PageHeading, type PageHeadingProps } from './page-frame'
import styles from './page-templates.module.css'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { ListFolderContext } from '@/components/shared/list-folder-context'
import { FolderNarrowContext, FolderNarrowActionsContext, folderRowIds, uniqueFolderAction, type FolderNarrowAction } from '@/components/shared/folder-narrow-context'

/**
 * 左の列（フォルダ・タグ・設定のメニュー）を、白い板が狭いとき（1100 未満）に
 * 道具の段の先頭へ畳んで出すための中身。絵の の1段目「作る・フォルダ：すべて」。
 * 画面は FolderPanel に渡しているのと同じ rows・activeId・onSelect・作るボタンを渡すだけ。
 * 閲覧のみの画面でも、権限に応じて押せない作るボタンを渡す。
 */
export interface ListFolderNav {
  rows: Array<Pick<FolderPanelRow, 'id' | 'label'> & Partial<FolderPanelRow>>
  activeId: string
  onSelect: (id: string) => void
  /** 作るボタン。広い板でフォルダの列の上に置いているものと同じ操作。 */
  createAction?: ReactNode
  /** 選ぶ欄の呼び名（「フォルダ」「タグ」など）。選択肢は「呼び名：名前」で出す。 */
  label?: string
  /** 畳んだ選ぶ欄の幅（px）。「種類：リッチメニュー」のように選択肢が長い画面だけ渡す。省くと共通の幅（150）。 */
  width?: number
}
export interface ListPageBodyProps {
  /** ：テンプレート一覧を基準にした段・寸法。窓や設定内の一覧は対象外。 */
  skeleton?: boolean
  readOnly?: boolean | 'hq'
  readOnlyNeed?: PageHeadingProps['readOnlyNeed']
  stats?: ReactNode
  folders?: ReactNode
  /** 狭い板でも同じフォルダ選択・作る操作へ到達できる口。渡すと folderNav より優先する。 */
  collapsedFolders?: ReactNode
  /**
   * collapsedFolders を渡さない画面のための口。型が「作る・フォルダを選ぶ欄」を組んで畳んだ段に出す。
   * 左の列に選ぶものが2つある画面（統括のテンプレートの種類と分類など）は配列で渡す。
   */
  folderNav?: ListFolderNav | ListFolderNav[]
  /** 左の列の左の余白を 24 にする（統括の画面。絵の ほか）。ふつうの一覧は 12。 */
  folderInset?: boolean
  /** 指定した板だけ、余白を含めた外寸にする。既定の列幅は変えない。 */
  folderWidth?: CSSProperties['width']
  /** 表以外の配布内容も一覧の道具列と同じ左右余白へ収める。 */
  contentInset?: boolean
  /** カードを置く一覧は本文を板の地とそろえる。 */
  contentSurface?: 'board'
  /** 表とページ送りを道具の段と同じ左右24の内側に置く板（絵が表を白い板の端まで伸ばさない：）。既定は  の領域いっぱい。 */
  tableInset?: boolean
  /** 窓の本文（左寄せの flex）でも、一覧の幅を窓いっぱいに広げる。 */
  fillWidth?: boolean
  /** 小窓の一覧は、ページの幅と独立してフォルダを横に並べる。 */
  dialogLayout?: boolean
  toolbar?: ReactNode
  /** 上下16の道具領域。statsは先頭が数の帯。見出しの直後では上の余白を一度だけ持つ。 */
  toolbarSpacing?: 'section' | 'stats'
  /** 案内の帯と道具の段の間を16にする固定絵。既定の段間は変えない。 */
  noticeSpacing?: 'section'
  /** 案内と道具を別の行に置く一覧。行同士はカードの間隔（16）。 */
  toolbarRowGap?: 'card'
  /** 表の操作説明。本文に長い文を置かず、道具の段の「？」から読む。 */
  explanation?: ReactNode
  /** 印なしの説明を本文の開始位置へそろえる板だけで指定する。 */
  explanationInset?: 'notice' | 'content'
  listHelp?: ReactNode
  /** 明示の道具のEndへ説明を渡す。既定は道具の外側。 */
  listHelpPlacement?: 'end'
  children: ReactNode
  pagination?: ReactNode
  overlays?: ReactNode
}
export interface ListPageProps extends PageHeadingProps, ListPageBodyProps {
  heightMode?: 'viewport' | 'content'
  boardId?: string
  layout?: 'event-list' | 'store-comparison'
  standalone?: boolean
  /** 明示された画面では、フォルダ機能を保ったまま主操作を題の右へ置く。 */
  createPlacement?: 'heading'
  tabs?: ReactNode
}

function listFolderNavs(folderNav: ListPageBodyProps['folderNav']) {
  return folderNav ? (Array.isArray(folderNav) ? folderNav : [folderNav]) : []
}
function hasListFolders({ folderNav, folders, collapsedFolders }: ListPageBodyProps) {
  const navs = listFolderNavs(folderNav)
  return navs.length ? navs.some(nav => nav.rows.length > 1) : !!(folders || collapsedFolders)
}
/** 数の帯を、一覧の共通の内側余白と次の段との間隔へ置く。 */
export function ListPageStats({ children }: { children: ReactNode }) {
  return <div className={styles.stats} data-template-region="stats">{children}</div>
}

/** 状態・取得処理を持つ子コンポーネントから使う、一覧型の本文。 */
export function ListPageBody({ readOnly, readOnlyNeed, skeleton, stats, folders, collapsedFolders, folderNav, folderInset, folderWidth, contentInset, contentSurface, tableInset, fillWidth, dialogLayout, toolbar, toolbarRowGap, toolbarSpacing, noticeSpacing, explanation, explanationInset = 'notice', listHelp, listHelpPlacement, children, pagination, overlays }: ListPageBodyProps) {
  const [folderActions, setFolderActions] = useState<FolderNarrowAction[]>([])
  const registerFolderAction = useCallback((action: FolderNarrowAction) => {
    setFolderActions(current => [...current.filter(item => item.key !== action.key), action])
    return () => setFolderActions(current => current.filter(item => item.key !== action.key))
  }, [])
  const availableFolderActions = readOnly ? [] : folderActions
  const navs = listFolderNavs(folderNav)
  const hasFolders = hasListFolders({ folderNav, folders, collapsedFolders, children })
  const noFolderChoices = navs.length > 0 && navs.every(nav => nav.rows.length <= 1)
  const visibleNavs = navs.filter(nav => nav.rows.length > 1 || nav.createAction || nav.rows.find(row=>row.id===nav.activeId)?.leadingActions?.length || availableFolderActions.some(action => action.rowIds === folderRowIds(nav.rows)))
  const collapsedContent = collapsedFolders ?? (visibleNavs.length > 0 ? visibleNavs.map((nav, index) => <CollapsedFolderNav key={nav.label ?? index} {...nav} addFolder={uniqueFolderAction(availableFolderActions, action => action.rowIds === folderRowIds(nav.rows))} />) : null)
  const collapsed = collapsedContent ? <FolderNarrowActionsContext.Provider value={availableFolderActions}>{collapsedContent}</FolderNarrowActionsContext.Provider> : null
  const help = listHelp ? <HelpTip label="一覧の操作の説明">{listHelp}</HelpTip> : null
  const helpAtEnd = listHelpPlacement === 'end' && Boolean(toolbar)
  return <FolderNarrowContext.Provider value={registerFolderAction}><ListFolderContext.Provider value={hasFolders}><div className={styles.listBody} data-list-folders={hasFolders} data-list-skeleton={skeleton ? 'templates' : undefined} data-dialog-layout={dialogLayout || undefined} data-table-inset={tableInset || undefined} style={fillWidth ? { width: '100%' } : undefined}>
    {readOnly ? <ReadOnlyNotice scope={readOnly === 'hq' ? 'hq' : 'store'} need={readOnlyNeed} /> : null}
    {stats ? <ListPageStats>{stats}</ListPageStats> : null}
    <div className={styles.split} data-template-region="body">
      {folders ? noFolderChoices ? <div hidden>{folders}</div> : <aside className={styles.folders} data-template-region="folders" data-shared-part="folder-column" data-folder-inset={folderInset || undefined} data-folder-width={folderWidth ? true : undefined} style={folderWidth ? { width: folderWidth, boxSizing: 'border-box' } : undefined}>{folders}</aside> : null}
      <div className={styles.main} data-content-surface={contentSurface}>
        {toolbar || collapsed || listHelp || explanation ? <div className={styles.toolbar} data-explanation-only={explanation && !toolbar && !collapsed && !listHelp || undefined} data-toolbar-row-gap={toolbarRowGap} data-toolbar-spacing={toolbarSpacing} data-notice-spacing={noticeSpacing} data-template-region="toolbar" data-list-toolbar={skeleton || undefined} data-collapsed-only={toolbar || listHelp || explanation || noFolderChoices ? undefined : ''}>
          {explanation ? <div className={styles.explanation}><PageExplanationBody keepMounted inset={explanationInset === 'notice' ? 'notice' : undefined}>{explanation}</PageExplanationBody></div> : null}
          {toolbar ? <ListToolbarLeading leading={collapsed} persistent={noFolderChoices} accessory={!helpAtEnd ? help : undefined} trailingAccessory={helpAtEnd ? help : undefined}>{toolbar}</ListToolbarLeading> : collapsed ? <div className={styles.collapsedFolders} data-template-region="collapsed-folders" data-toolbar-persistent={noFolderChoices || undefined}>{collapsed}</div> : null}
          {!toolbar ? help : null}
        </div> : null}
        <div className={styles.content} data-template-region="content" data-content-inset={contentInset || undefined}>{children}</div>
        {pagination ? <div className={styles.pagination} data-template-region="pagination">{pagination}</div> : null}
      </div>
    </div>{overlays}
  </div></ListFolderContext.Provider></FolderNarrowContext.Provider>
}
/** folderNav から組む、畳んだときの「作る・フォルダを選ぶ欄」。 */
function CollapsedFolderNav({ rows, activeId, onSelect, createAction, label = 'フォルダ', width, addFolder }: ListFolderNav & { addFolder?: FolderNarrowAction }) {
  const selected = rows.find((row) => row.id === activeId)
  return <>
    {createAction ? <span className={styles.collapsedCreate}>{createAction}</span> : null}
    {rows.length > 1 || addFolder ? <span className={styles.collapsedSelect} style={width ? { minWidth: width } : undefined}>
      <Select size="content" aria-label={label} value={activeId} onChange={onSelect} options={rows.map((row) => ({ value: row.id, label: `${label}：${row.label}` }))} createAction={addFolder ? { label: addFolder.label, disabled: addFolder.disabled, lockedReason: addFolder.lockedReason, onSelect: addFolder.run } : undefined} />
    </span> : null}
    {selected && (selected.leadingActions?.length || selected.onEdit || selected.onMoveUp || selected.onMoveDown || selected.onDelete) ? <CollapsedFolderActions row={{ ...selected, count: selected.count ?? null }} /> : null}
  </>
}
export function ListPage({ readOnly, readOnlyNeed, readOnlyBand, boardId, layout, heightMode, standalone, createPlacement, tabs, title, help, explanation, explanationKey, titleAccessory, explanationToggle, identity, actions, crumbs, subtitle, steps, headingSize, bottomSpacing, ...body }: ListPageProps) {
  const navs = listFolderNavs(body.folderNav)
  const headingCreates = createPlacement === 'heading' || !hasListFolders(body) ? navs.filter(nav => nav.createAction) : []
  const resolvedBody = headingCreates.length ? { ...body, collapsedFolders: undefined, folderNav: navs.map(nav => ({ ...nav, createAction: undefined })) } : body
  const headingActions = headingCreates.length ? <>{headingCreates.map((nav,index) => <Fragment key={index}>{nav.createAction}</Fragment>)}{actions}</> : actions
  const page = <PageFrame kind="list" createPlacement={createPlacement} boardId={boardId} layout={layout} heightMode={heightMode} standalone={standalone} skeleton={body.skeleton}>
    <PageHeading readOnlyBand={readOnly || readOnlyBand} readOnlyNeed={readOnlyNeed} noticeRow="full" {...{ title, help, titleAccessory, explanationToggle: explanationToggle !== undefined ? explanationToggle : explanation ? <PageExplanationToggle /> : undefined, identity, actions: headingActions, crumbs, subtitle, steps, headingSize, bottomSpacing }} />
    {tabs ? <div className={styles.tabs} data-template-region="tabs">{tabs}</div> : null}
    <ListPageBody {...resolvedBody} explanation={explanation} />
  </PageFrame>
  return explanation ? <PageExplanationProvider pageKey={explanationKey ?? `list:${typeof title === 'string' ? title : boardId ?? 'screen'}`}>{page}</PageExplanationProvider> : page
}

/** 読込・空・失敗の条件を画面側に残したままページ送りの余白を型へ寄せる。 */
export function ListPagePagination({ children }: { children: ReactNode }) {
  return <div className={styles.pagination} data-template-region="pagination"><div className={styles.paginationRow}>{children}</div></div>
}

/** ：件数とページ送りを右へそろえる。外側の余白は型の段が持つ。 */
export function ListPager({ children }: { children: ReactNode }) {
  return <div className={styles.paginationRow} data-list-pager>{children}</div>
}

/** Lists of cards use the same spacing as other groups of content. Cards in one row take the tallest height so their bottom actions line up. */
export function ListPageCards({ children, columns = 3, narrowColumns, inset }: { children: ReactNode; columns?: 1 | 3 | 4; narrowColumns?: 1 | 2 | 3; inset?: 'parent' }) {
  return <div className={styles.listCards} data-card-height="equal" data-card-columns={columns} data-card-narrow-columns={narrowColumns} data-card-inset={inset} style={{ '--tpl-list-card-columns': columns, '--tpl-list-card-narrow-columns': narrowColumns } as CSSProperties}>{children}</div>
}

/** カードなどの本文の余白と段の間を一覧型が持つ。 */
export function ListPageSection({ children }: { children: ReactNode }) {
  return <div className={styles.listSection}>{children}</div>
}
