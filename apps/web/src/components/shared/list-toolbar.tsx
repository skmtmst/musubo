'use client'
import type React from 'react'
import { ChevronDown } from 'lucide-react'

import { useRef, useState, useLayoutEffect, Fragment, Children, isValidElement, cloneElement, createContext, useContext, type ReactNode, type HTMLAttributes } from 'react'
import Select, { type SelectProps } from './select'
import EntitySelect from './entity-select'
import SearchField from './search-field'
import FilterChip from './filter-chip'
import { FilterPopover } from './filter-popover'
import { RowMenu } from './row-actions'
import PageSizeSelect from './page-size-select'
import styles from './list-toolbar.module.css'
import { toolbarContentFit, fitToolbarWrap, measureToolbarOptionalWidth, fitToolbarOptionalWidth, fitToolbarOverflowPanel, observeToolbarContent } from './list-toolbar-fit.mjs'
import { formatNumber } from '@/lib/format'

/**
 * 札の組は組の中で縦に積まない。
 * 並び・件数と1段に収まらない時だけ、組をまるごと次の段の左へ下げる。
 * 組そのものが1段の幅より長い時は、CSS が組の中で折り返す。
 */
function placeChipGroups(toolbar: HTMLElement, slotClass: string, choicesClass: string) {
  const slots = Array.from(toolbar.querySelectorAll<HTMLElement>(`.${slotClass}:has(> .${choicesClass}), .${slotClass}:has(> [role="group"])`))
  if (!slots.length) return
  // 段の切り替えは transition の途中値を読まないよう、測る間だけ止める。
  const measured = Array.from(toolbar.querySelectorAll<HTMLElement>(`.${slotClass}, [data-toolbar-chip-unit]`))
    .map(slot => ({ slot, value: slot.style.getPropertyValue('transition'), priority: slot.style.getPropertyPriority('transition') }))
  for (const { slot } of measured) slot.style.setProperty('transition', 'none', 'important')
  const css = getComputedStyle(toolbar)
  const gap = parseFloat(css.columnGap) || 0
  const lineLeft = toolbar.getBoundingClientRect().left + (parseFloat(css.paddingLeft) || 0)
  const flexItems = Array.from(toolbar.querySelectorAll<HTMLElement>(`.${slotClass}, [data-toolbar-chip-unit]`))
  const placed = new Set<HTMLElement>()
  try {
    for (const slot of slots) {
      const group = slot.querySelector<HTMLElement>(`:scope > .${choicesClass}, :scope > [role="group"]`)
      if (!group || group.hasAttribute('data-filter-collapsed') || group.querySelector(':scope > [data-filter-collapsed]') || group.getBoundingClientRect().width <= 0) continue
      const target = slot.closest<HTMLElement>('[data-toolbar-chip-unit]') ?? slot
      const endSlot = slot.closest('[data-toolbar-row]')?.querySelector<HTMLElement>('[data-toolbar-end]')?.closest<HTMLElement>(`.${slotClass}`)
      if (!endSlot || endSlot === slot || endSlot.contains(target) || placed.has(target)) continue
      placed.add(target)
      const end = endSlot.getBoundingClientRect(), here = target.getBoundingClientRect()
      if (Math.abs(end.top - here.top) < 2) { target.removeAttribute('data-toolbar-chips-drop'); continue }
      if (!target.hasAttribute('data-toolbar-chips-drop')) { target.setAttribute('data-toolbar-chips-drop', ''); continue }
      // 下げている段で、並び・件数の段の空きに戻せるか（組の実幅で比べる）。
      const width = [...target.children].filter(child => getComputedStyle(child).display !== 'none')
        .reduce((sum, child, index) => sum + child.getBoundingClientRect().width + (index > 0 ? gap : 0), 0)
      let used = lineLeft, beside = false
      for (const item of flexItems) {
        if (item === endSlot || item === target || target.contains(item) || endSlot.contains(item)) continue
        const rect = item.getBoundingClientRect()
        if (rect.width <= 0 || Math.abs(rect.top - end.top) >= 2) continue
        beside = true
        used = Math.max(used, rect.right)
      }
      // 並び・件数が絞り込みと同じ段にあり、その空きに組が収まる時だけ戻す。
      if (beside && width <= end.left - used - gap + 0.5) target.removeAttribute('data-toolbar-chips-drop')
    }
  } finally {
    for (const { slot, value, priority } of measured) {
      if (value) slot.style.setProperty('transition', value, priority)
      else slot.style.removeProperty('transition')
    }
  }
}

function useToolbarFit() {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const toolbar = ref.current
    if (!toolbar || !window.ResizeObserver) return
    const measure = () => {
      placeChipGroups(toolbar, styles.slotTool, styles.filterChoices)
      // この継承値を使うのは、入れ子を含む枠内の検索欄だけ。
      const slotSearches = toolbar.querySelectorAll(`.${styles.slotTool}[data-toolbar-role="search"]`)
      if (Array.from(slotSearches).some(slot => slot.closest(`.${styles.slots}`))) {
        const leading = toolbar.querySelector<HTMLElement>('[data-toolbar-leading]')
        const width = `${Math.ceil(leading?.getBoundingClientRect().width ?? 0)}px`
        if (toolbar.style.getPropertyValue('--toolbar-leading-width') !== width) toolbar.style.setProperty('--toolbar-leading-width', width)
      }
      if (toolbar.dataset.toolbarLayout?.includes('stacked')) {
        for (const row of toolbar.querySelectorAll<HTMLElement>('[data-toolbar-row]')) fitToolbarWrap(row)
      } else fitToolbarWrap(toolbar)
    }
    let frame = 0
    const queue = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure) }
    const observer = new ResizeObserver(queue)
    const observe = () => {
      observer.disconnect()
      observer.observe(toolbar)
      for (const tool of toolbar.querySelectorAll<HTMLElement>('[data-toolbar-search], [data-toolbar-tool], [data-list-sort], [data-filter-width], button[aria-haspopup="listbox"]')) observer.observe(tool)
      measure()
    }
    const mutations = new MutationObserver(observe)
    mutations.observe(toolbar, { childList: true, subtree: true, characterData: true })
    observe()
    void document.fonts?.ready.then(measure)
    return () => { mutations.disconnect(); cancelAnimationFrame(frame); observer.disconnect() }
  }, [])
  return ref
}



/** 一覧型が狭い板の「作る・フォルダ」を検索と同じ段へ渡す。 */
const LeadingContext = createContext<{ leading: ReactNode; persistent?: boolean; trailingAccessory?: ReactNode }>({ leading: null })
const FrameContext = createContext(false)
/** 画面幅で切り替える包みの中にも道具があれば、枠と操作を重ねて作らない。 */
function containsToolbarLayout(nodes: ReactNode): boolean {
  return Children.toArray(nodes).some(node => isValidElement<{ children?: ReactNode }>(node)
    && (node.type === ListToolbar || node.type === ListToolbarFrame || containsToolbarLayout(node.props.children)))
}
export function ListToolbarLeading({ children, leading, persistent, accessory, trailingAccessory }: { children: ReactNode; leading: ReactNode; persistent?: boolean; accessory?: ReactNode; trailingAccessory?: ReactNode }) {
  // 旧い断片の道具も、型の口で役目をそろえる。フォームのRowはそのまま保つ。
  const flatten = (items: ReactNode, prefix = ''): ReactNode[] => Children.toArray(items).flatMap((node, index) => {
    if (!isValidElement<{ children?: ReactNode }>(node)) return [node]
    const key = `${prefix}${node.key ?? index}`
    return node.type === Fragment ? flatten(node.props.children, `${key}/`) : [cloneElement(node, { key })]
  })
  const nodes = flatten(children)
  const containsTool = (node: ReactNode): boolean => isValidElement<{ children?: ReactNode }>(node)
    && ([ListToolbarRow, ListToolbarSearchSlot, SearchField, Select, PageSizeSelect].includes(node.type as typeof ListToolbarRow)
      || Children.toArray(node.props.children).some(containsTool))
  const needsFrame = nodes.some(containsTool) && !containsToolbarLayout(nodes)
  // 案内文は道具より前の段。作る・フォルダ・検索の間に挟まない。
  const notices = needsFrame ? nodes.filter(node => isValidElement(node) && node.type === 'p') : []
  const tools = needsFrame ? <>{notices}<ListToolbarFrame>{[...nodes.filter(node => !notices.includes(node)), accessory].map((node, index) => {
    if (!node) return null
    if (isValidElement<{ children?: ReactNode }>(node) && node.type === 'span' && node.props.children == null) return null
    if (isValidElement(node) && node.type === ListToolbarRow || !containsTool(node) && node !== accessory) return node
    return <ListToolbarRow key={isValidElement(node) ? node.key ?? index : index}>{node}</ListToolbarRow>
  })}</ListToolbarFrame></> : <>{children}{accessory}</>
  return <LeadingContext.Provider value={{ leading: contentSizedSelects(leading), persistent, trailingAccessory }}>{tools}</LeadingContext.Provider>
}

export type ListToolbarSearch = {
  placeholder: string
  value: string
  onChange: (value: string) => void
  /**
   * 読み上げ名。渡さないときは placeholder と同じ文にする
   * （検索欄は見た目に常設ラベルが無いため）。
   */
  label?: string
  /** 入力の上限（貼り付けの制限）。渡さないときは付けない。 */
  maxLength?: number
  /** ★V8 探す欄の幅（板ごとの絵の幅。例：リマインダ  は 200）。渡さないときは部品の 280。 */
  width?: number
  /** 検索中。渡すと虫眼鏡の代わりに回る印が出る。 */
  loading?: boolean
  /** 入力直後の操作も同じ検索条件を使う画面で指定する。 */
  updateMode?: 'debounced' | 'immediate'
}

/**
 * 一覧の上の道具の並び。★管理画面 `Xn1Mz`。
 *
 * どの一覧も同じ2行にする。画面ごとに手で並べない。
 *
 * - 1行目：検索（幅320・虫眼鏡つき・狭い時も240まで）→ `actions`
 *   （保存した検索・この条件を保存）。検索を横いっぱいに伸ばさない。
 *   検索を枠付きの箱（カード）で包まない。
 * - 2行目：左に `filters`（札・日付などの絞り込み）、右端に
 *   `trailing`（並び順と表示件数）。表示件数だけの行を作らない。
 *   入りきらない幅では右の2つが下へ折り返す。
 *
 * 画面の上からの順もそろえる：数のカード → 説明の開閉（Disclosure）→
 * ＋ ○○を作る（左）→ この部品 → フォルダと表。
 */
export default function ListToolbar({
  search,
  searchSlot,
  actions,
  filters,
  trailing,
  secondary,
  sort,
  layout = 'band',
  preserveFilterChips = false,
}: {
  sort?: ListToolbarSortProps
  search?: ListToolbarSearch
  /** 既存の検索フォームの動きを保って共通の段へ移す口。 */
  searchSlot?: ReactNode
  /** 1行目。検索の右に置く、動くものだけ（保存した検索・この条件を保存）。 */
  actions?: ReactNode
  /** 2行目・左。札・日付などの絞り込み。 */
  filters?: ReactNode
  /** 札を選ぶ欄へ畳まず、直接押せる形を保つ。既定は従来の実寸判定。 */
  preserveFilterChips?: boolean
  /** 2行目・右端。並び順と表示件数。 */
  trailing?: ReactNode
  /** 友だち・一斉配信の状態など、足してよい2段目。 */
  secondary?: ReactNode
  /**
   * 並べ方。既定 'band' は1本の帯（c4n9Kr）。
   * 'stacked' は2段（ 予約管理：1段目＝探す・担当・経路・CSV、
   * 2段目＝札）。段の間10・段の中の間6。
   */
  layout?: 'band' | 'stacked'
}) {
  const ref = useToolbarFit()
  const { leading, persistent, trailingAccessory } = useContext(LeadingContext)
  return (
    <div ref={ref} className={styles.toolbar} data-shared-part="list-toolbar" data-list-toolbar data-toolbar-layout={layout} style={search?.width ? ({ '--list-search-width': `${search.width}px` } as React.CSSProperties) : undefined}>
      <div className={styles.row1} data-toolbar-tools data-toolbar-row>
        {leading ? <span className={styles.leading} data-toolbar-leading data-toolbar-persistent={persistent || undefined}>{leading}</span> : null}
        {search ? <div className={styles.search} data-toolbar-search><SearchField
          placeholder={search.placeholder}
          aria-label={search.label ?? search.placeholder}
          value={search.value}
          onChange={search.onChange}
          onClear={() => search.onChange('')}
          maxLength={search.maxLength}
          loading={search.loading}
          updateMode={search.updateMode}
        /></div> : searchSlot ? <div className={styles.search} data-toolbar-search>{searchSlot}</div> : null}
      </div>
      {filters || secondary || actions || trailing || sort || trailingAccessory ? (
        <div className={styles.row2} data-toolbar-row>
          {filters || secondary ? <div className={styles.filters} data-toolbar-tools>{compactFilterGroups(filters, preserveFilterChips)}{secondary}</div> : null}
          {actions ? <span className={styles.actions} data-toolbar-actions>{actions}</span> : null}
          {trailing || sort || trailingAccessory ? <div className={styles.trailing} data-toolbar-tools data-toolbar-trailing data-toolbar-end>{orderedTrailingTools(<>{sort ? <ListToolbarSort {...sort} /> : null}{compactFilterGroups(trailing)}</>, trailingAccessory)}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

/** 検索の送信・保存条件などを持つ一覧でも、段の見た目を画面に持たせない。 */
export function ListToolbarFrame({ children, layout = 'band', singleRow = false, conversation = false, ...props }: HTMLAttributes<HTMLDivElement> & { conversation?: boolean; layout?: 'band' | 'stacked'; /** 狭い板でも道具を 1 行に並べる（検索は縮み、折り返さない）。既定は狭い板で 2 段。 */ singleRow?: boolean }) {
  const ref = useToolbarFit()
  const { leading, persistent } = useContext(LeadingContext)
  const ownsLeading = !containsToolbarLayout(children)
  if (conversation) return <div {...props} ref={ref} className={styles.conversation} data-shared-part="list-toolbar" data-list-toolbar>{children}</div>
  return <FrameContext.Provider value><div {...props} ref={ref} className={styles.slots} data-shared-part="list-toolbar" data-list-toolbar data-toolbar-layout={layout === 'stacked' ? 'slots-stacked' : 'slots'} data-toolbar-single-row={singleRow || undefined}>
    {ownsLeading && leading ? <span className={styles.leading} data-toolbar-leading data-toolbar-persistent={persistent || undefined}>{leading}</span> : null}
    {ownsLeading ? <span className={styles.rowBreak} aria-hidden="true" /> : null}{children}
  </div></FrameContext.Provider>
}

export function ListToolbarRow({ children, as: Tag = 'div', ...props }: HTMLAttributes<HTMLElement> & { as?: 'div' | 'form' }) {
  const { leading, persistent } = useContext(LeadingContext)
  const inFrame = useContext(FrameContext)
  const items = Children.toArray(compactFilterGroups(children))
  const slots = items.map((child, index) => <span key={isValidElement(child) ? child.key ?? index : index} className={styles.slotTool} data-toolbar-role={toolbarRole(child)}>{child}</span>)
  const endIndex = items.findIndex(node => isValidElement(node) && node.type === ListToolbarEnd)
  const chipIndex = items.findIndex(containsFilterChips)
  // 札の組と、その右に続く件数などは1つのまとまりとして段を決める（組の中で積まない）。
  const unit = endIndex > chipIndex && chipIndex >= 0
  return <Tag {...props} className={styles.slotsRow} data-shared-part="list-toolbar" data-list-toolbar data-toolbar-layout="slots-row" data-toolbar-tools data-toolbar-row>
    {!inFrame && leading ? <span className={styles.leading} data-toolbar-leading data-toolbar-persistent={persistent || undefined}>{leading}</span> : null}
    {!inFrame ? <span className={styles.rowBreak} aria-hidden="true" /> : null}
    {unit
      ? <>{slots.slice(0, chipIndex)}<span key="chip-unit" className={styles.chipUnit} data-toolbar-chip-unit>{slots.slice(chipIndex, endIndex)}</span>{slots.slice(endIndex)}</>
      : slots}
  </Tag>
}

function containsFilterChips(node: ReactNode): boolean {
  if (!isValidElement<{ children?: ReactNode }>(node)) return false
  if (node.type === ResponsiveFilterChips) return true
  return Children.toArray(node.props.children).some(containsFilterChips)
}

/** 保存検査の包みを含め、部品の役目から並べる。画面CSSで順序を上書きしない。 */
function toolbarRole(node: ReactNode): 'search' | 'filter' | 'sort' | 'count' | 'action' {
  if (!isValidElement<{ children?: ReactNode; 'aria-label'?: string; label?: string }>(node)) return 'filter'
  if (node.type === ListToolbarSearchSlot || node.type === SearchField) return 'search'
  if (node.type === RowMenu) return 'action'
  if (node.type === PageSizeSelect) return 'count'
  if (node.type === ListToolbarSort) return 'sort'
  if (/表示件数|1ページ|件表示/.test(node.props['aria-label'] ?? node.props.label ?? '')) return 'count'
  if (/並び/.test(node.props['aria-label'] ?? node.props.label ?? '')) return 'sort'
  const roles = Children.toArray(node.props.children).map(toolbarRole)
  return roles.find(role => role !== 'filter') ?? 'filter'
}

export function ListToolbarSearchSlot({ children, width, search, flexible = false }: { children?: ReactNode; width?: number; search?: ListToolbarSearch; flexible?: boolean }) {
  return <div className={styles.searchSlot} data-toolbar-search data-flexible={flexible || undefined} style={width ? ({ '--list-search-width': `${width}px` } as React.CSSProperties) : undefined}>{search ? <SearchField value={search.value} onChange={search.onChange} onClear={() => search.onChange('')} placeholder={search.placeholder} aria-label={search.label ?? search.placeholder} maxLength={search.maxLength} loading={search.loading} updateMode={search.updateMode} /> : children}</div>
}

export function ListToolbarEnd({ children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  const { trailingAccessory } = useContext(LeadingContext)
  return <span {...props} className={styles.slotsEnd} data-toolbar-trailing data-toolbar-end>{orderedTrailingTools(children, trailingAccessory)}</span>
}

/** : the shared end owns order; keep each control and its handler intact. */
function orderedTrailingTools(nodes: ReactNode, accessory?: ReactNode): ReactNode[] {
  const flatten = (items: ReactNode, prefix = ''): ReactNode[] => Children.toArray(items).flatMap((node, index) => {
    if (!isValidElement<{ children?: ReactNode }>(node)) return [node]
    const key = `${prefix}${node.key ?? index}`
    return node.type === Fragment ? flatten(node.props.children, `${key}/`) : [cloneElement(node, { key })]
  })
  const rank = (node: ReactNode) => ({ search: 0, filter: 0, sort: 1, count: 2, action: 3 })[toolbarRole(node)]
  const tools = flatten(nodes).sort((a, b) => rank(a) - rank(b))
  if (!accessory) return tools
  // 一覧の操作の説明（？）は、絞り込み・並びのあと、件数の直前（・）。
  const at = tools.findIndex(node => rank(node) === 2)
  const keyed = isValidElement(accessory) && accessory.key == null ? cloneElement(accessory, { key: 'list-help' }) : accessory
  return at < 0 ? [...tools, keyed] : [...tools.slice(0, at), keyed, ...tools.slice(at)]
}

/** : retain named tools; an overflow group keeps its explicit name. */
export function ListToolbarOptional({ children, label = 'ほかの絞り込み', collapse }: { children: ReactNode; label?: string; compact?: boolean; collapse?: 'overflow' }) {
  return collapse === 'overflow' ? <OverflowTools label={label}>{children}</OverflowTools> : <InlineOptional>{children}</InlineOptional>
}
function InlineOptional({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const item = ref.current
    if (!item || !window.ResizeObserver) return
    const measure = () => fitToolbarOptionalWidth(item)
    const observer = new ResizeObserver(measure)
    observer.observe(item)
    for (const child of item.querySelectorAll('button')) observer.observe(child)
    measure()
    return () => observer.disconnect()
  }, [children])
  return <span ref={ref} className={styles.optional} data-toolbar-tool data-toolbar-optional><span data-toolbar-optional-content>{children}</span></span>
}

function OverflowTools({ children, label }: { children: ReactNode; label: string }) {
  const ref = useRef<HTMLDetailsElement>(null), expandedWidth = useRef(0)
  const contentObserver = useRef<ReturnType<typeof observeToolbarContent> | null>(null)
  const measuredChildren = useRef(children)
  const [collapsed, setCollapsed] = useState(false)
  useLayoutEffect(() => {
    const item = ref.current
    const owner = item?.closest<HTMLElement>('[data-toolbar-layout="band"], [data-toolbar-layout="slots"], [data-toolbar-layout="stacked"], [data-toolbar-layout="slots-stacked"]')
    const row = item?.closest<HTMLElement>('[data-toolbar-row]')
    const flat = row && getComputedStyle(row).display === 'contents'
    const toolbar = flat ? owner : row ?? owner
    if (!item || !toolbar || !window.ResizeObserver) return
    const measure = () => {
      if (!item.isConnected) return
      if (item.hasAttribute('data-collapsed') && item.open) fitToolbarOverflowPanel(item, toolbar)
      const width = measureToolbarOptionalWidth(item)
      const growing = width !== null && width > 0 && parseFloat(getComputedStyle(item).flexGrow) > 0
      if (width !== null) expandedWidth.current = width
      // A non-growing box's min-width affects geometry; fit after committing that width.
      if (width !== null && !growing) fitToolbarOptionalWidth(item, width)
      const snapshot = growing ? { optional: { element: item, width: expandedWidth.current } } : undefined
      const collapsed = !toolbarContentFit(toolbar, item, expandedWidth.current, false, Boolean(flat && (owner?.closest('[data-page-template]')?.getBoundingClientRect().width ?? Infinity) < 1100), snapshot).fits
      if (growing) fitToolbarOptionalWidth(item, width)
      setCollapsed(collapsed)
    }
    const observer = observeToolbarContent(item, () => [toolbar, ...toolbar.querySelectorAll('button,input')], measure, true)
    contentObserver.current = observer
    return () => { contentObserver.current = null; observer.stop() }
  }, [])
  useLayoutEffect(() => {
    if (measuredChildren.current !== children) { measuredChildren.current = children; contentObserver.current?.refresh() }
  }, [children])
  return <details ref={ref} className={styles.optional} data-toolbar-tool data-toolbar-optional data-toolbar-overflow-group data-collapsed={collapsed || undefined} open={collapsed ? undefined : true}
    onKeyDown={event => { if (event.key === 'Escape' && collapsed) { event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() } }}>
    <summary aria-label={label}>{label}<ChevronDown size={16} aria-hidden="true" /></summary><div data-toolbar-optional-content role="group" aria-label={label}>{children}</div>
  </details>
}

export type ListToolbarSortProps = Omit<SelectProps, 'aria-label' | 'label'> & { label?: string; 'aria-label'?: string }
/** 並びの名前と選ぶ操作はこの欄にそろえる。見た目は表示件数と同じ箱に固定する。 */
export function ListToolbarSort(props: ListToolbarSortProps) {
  if (props.options.length === 0) return null
  const options = props.options.map(option => ({ ...option, label: option.label.replace('使われている数が多い順', '使用数が多い順') }))
  return <span data-list-sort><Select {...props} options={options} size="content" width={undefined} treatment="box" label="並び" aria-label="並び" /></span>
}

/** /192/205：入らない札と狭い列だけを選ぶ欄へ畳む。 */
type ToolbarControlProps = { iconOnly?: boolean; size?: string; width?: number; pageSizeControl?: boolean }

function contentSizedControl(child: React.ReactElement<ToolbarControlProps>) {
  if (child.type === Select) {
    const select = child as React.ReactElement<SelectProps>
    return cloneElement(select, { size: 'content', width: undefined, pageSizeControl: select.props.pageSizeControl || toolbarRole(select) === 'count' })
  }
  return cloneElement(child, { size: 'content', width: undefined })
}

function isContentSizedControl(node: ReactNode): node is React.ReactElement<ToolbarControlProps> {
  return isValidElement<ToolbarControlProps>(node)
    && (node.type === Select || node.type === EntitySelect)
    && !node.props.iconOnly
}

/** 畳んだ欄の入力だけを直し、作る操作や子のキーはそのまま渡す。 */
function contentSizedSelects(node: ReactNode): ReactNode {
  if (Array.isArray(node)) {
    const children = node.map(contentSizedSelects)
    return children.every((child, index) => child === node[index]) ? node : children
  }
  if (isValidElement(node) && node.type === FilterPopover) return node
  if (isContentSizedControl(node)) return contentSizedControl(node)
  if (isValidElement<{ children?: ReactNode }>(node) && node.props.children) {
    const children = contentSizedSelects(node.props.children)
    return children === node.props.children ? node : Array.isArray(children) ? cloneElement(node, {}, ...children) : cloneElement(node, {}, children)
  }
  return node
}

function compactFilterGroups(node: ReactNode, preserveChips = false): ReactNode {
  const children = Children.toArray(node)
  if (children.length > 1 && children.every(child => isValidElement(child) && child.type === FilterChip))
    return <ResponsiveFilterChips preserveChips={preserveChips}>{children}</ResponsiveFilterChips>
  return children.map(child => {
    if (isValidElement(child) && (child.type === ResponsiveFilterChips || child.type === FilterPopover)) return child
    if (isContentSizedControl(child)) return contentSizedControl(child)
    if (isValidElement<{ children?: ReactNode }>(child) && child.props.children) {
      const nested = compactFilterGroups(child.props.children, preserveChips)
      // Field wrappers receive one control, not a one-element children array.
      return cloneElement(child, {}, Array.isArray(nested) && nested.length === 1 ? nested[0] : nested)
    }
    return child
  })
}
export function ResponsiveFilterChips({ children, label = '状態', preserveChips = false }: { children: ReactNode; label?: string; preserveChips?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null)
  const unfoldedWidth = useRef(0)
  const contentObserver = useRef<ReturnType<typeof observeToolbarContent> | null>(null)
  const measuredChildren = useRef(children)
  const [collapsed, setCollapsed] = useState(false)
  useLayoutEffect(() => {
    const choices = ref.current
    const owner = choices?.closest<HTMLElement>('[data-toolbar-layout="band"], [data-toolbar-layout="slots"], [data-toolbar-layout="stacked"], [data-toolbar-layout="slots-stacked"]')
    const row = choices?.closest<HTMLElement>('[data-toolbar-row]')
    const flat = row && getComputedStyle(row).display === 'contents'
    const toolbar = owner?.dataset.toolbarLayout?.includes('stacked') && !flat ? row ?? owner : owner
    // 左にフォルダの列がある一覧は、幅で札を選ぶ欄へ変えない（畳むのは列だけ）。
    const inFolderList = Boolean(choices?.closest('[data-list-folders]'))
    if (preserveChips || inFolderList || !choices || !toolbar || !window.ResizeObserver) return
    const measure = () => {
      const wide = choices.querySelector<HTMLElement>('[data-filter-chips]')!
      if (wide.getBoundingClientRect().width > 0) unfoldedWidth.current = Math.max(wide.scrollWidth, wide.getBoundingClientRect().width)
      const width = String(unfoldedWidth.current)
      const collapsed = !toolbarContentFit(toolbar, null, 0, true, Boolean(flat && (owner?.closest('[data-page-template]')?.getBoundingClientRect().width ?? Infinity) < 1100), { filter: { element: choices, width: unfoldedWidth.current } }).fits
      if (choices.dataset.filterWidth !== width) choices.dataset.filterWidth = width
      setCollapsed(collapsed)
    }
    const observer = observeToolbarContent(choices, () => [toolbar, choices], measure)
    contentObserver.current = observer
    return () => { contentObserver.current = null; observer.stop() }
  }, [preserveChips])
  useLayoutEffect(() => {
    if (measuredChildren.current !== children) { measuredChildren.current = children; contentObserver.current?.refresh() }
  }, [children])
  const chips = Children.toArray(children).filter(isValidElement<React.ComponentProps<typeof FilterChip>>)
  const text = (node: ReactNode): string => Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child) ? text(child.props.children) : String(child)).join('')
  const selected = chips.map((child,index) => child.props.selected ? index : -1).filter(index => index >= 0)
  const allIndex = chips.findIndex(child => /^すべて(?:$|\s|[\d（(])/.test(text(child.props.children)))
  const current = selected.length > 1 ? 'multiple' : selected.length === 1 ? String(selected[0]) : allIndex >= 0 ? String(allIndex) : 'all'
  return <span ref={ref} className={styles.filterChoices} data-filter-collapsed={!preserveChips && collapsed || undefined}>
    <span className={styles.filterWide} data-filter-chips>{allIndex >= 0 ? chips.map(chip => cloneElement(chip, { showCheck: false })) : children}</span>
    {!preserveChips ? <span className={styles.filterNarrow}><Select size="content" label={label} aria-label={label} value={current}
      options={[...(allIndex >= 0 ? [] : [{ value: 'all', label: 'すべて', disabled: selected.length > 1 }]), ...(selected.length > 1 ? [{ value: 'multiple', label: `${formatNumber(selected.length)}件の条件`, disabled: true }] : []), ...chips.map((child,index) => ({ value: String(index), label: text(child.props.children), disabled: child.props.disabled }))]}
      onChange={next => { if (next === 'all') { if (selected.length === 1) chips[selected[0]].props.onChange(false) } else { const chip = chips[Number(next)]; chip?.props.onChange(!chip.props.selected) } }} /></span> : null}
  </span>
}
