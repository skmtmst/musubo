'use client'

import choiceStyles from './choice-field.module.css'
import { usePermissionLockTip } from './permission-lock-tip'
import { pageSizeLabel } from './page-size-options'
import { ArrowUpDown, ChevronDown, ChevronUp } from 'lucide-react'
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { isImeComposing } from './ime'
import { joinDescribedBy, useFieldContext } from './field-context'
import { SELECT_MENU_ROW_STRIDE, SelectMenu, SelectMenuAction, SelectMenuOption, SelectMenuSpacer, SelectValueText, isAllOption, splitOptionHeads } from './select-menu'
import styles from './select.module.css'
import pillStyles from './status-pill.module.css'
import { useSelectContentWidth } from './use-select-content-width'
import IconButton from './icon-button'
import { FolderNarrowActionsContext, uniqueFolderAction } from './folder-narrow-context'

import type { SelectCreateAction, SelectCreateContext, SelectOption, SelectProps } from './select-types'
export type { SelectOption, SelectCreateContext, SelectCreateAction, SelectProps } from './select-types'

/*
 * 候補が多い（タグ 2,000 個など）ときは、開いた一覧のうち見えている所の前後だけ描く
 * （2026-10-07 速さ。全部描くと 2,000 個で 8,000 要素・開くまで 0.4 秒）。
 * 行の高さは 38px で決まっているので、位置は計算で出す。
 * 読み上げには「全 n 件中 m 件目」を aria-setsize / aria-posinset で渡す。
 * キーボードで動かした先が描かれていなければ、そこまでスクロールしてから描く。
 */
const WINDOW_THRESHOLD = 100
const WINDOW_OVERSCAN = 12

/** Pencil V5 `rpot9` / `Gfsb4` を正本にした単一選択。 */
export default function Select({
  'aria-label': ariaLabel,
  narrowFolderPicker = false,
  className,
  defaultOpen = false,
  openCreateSignal,
  disabled = false,
  lockedReason,
  error,
  invalid: invalidProp = false,
  id,
  label,
  name,
  onChange,
  icon,
  valueAlign,
  showChevron = true,
  iconOnly = false,
  options: suppliedOptions,
  textSize,
  size = 'standard',
  pageSizeControl = false,
  value,
  width,
  treatment = 'box',
  createAction: explicitCreateAction,
  menuHeading,
  menuAlign,
  menuPlacement,
}: SelectProps) {
  const narrowFolderActions = React.useContext(FolderNarrowActionsContext)
  const narrowFolderAction = narrowFolderPicker ? uniqueFolderAction(narrowFolderActions, action => (JSON.parse(action.rowIds) as string[]).every(id => suppliedOptions.some(option => option.value === id))) : undefined
  const createAction: SelectCreateAction | undefined = explicitCreateAction ?? (narrowFolderAction ? { label: narrowFolderAction.label, disabled: narrowFolderAction.disabled, lockedReason: narrowFolderAction.lockedReason, onSelect: narrowFolderAction.run } : undefined)
  // Width is a visual preset; a duration selector may use it too. The role
  // comes from the explicit flag or the control's accessible page-size name.
  const isPageSizeControl = pageSizeControl || /表示件数|1ページ|件表示/.test(ariaLabel ?? label ?? '')
  const options = useMemo(() => isPageSizeControl
    ? suppliedOptions.map(option => /^\d+$/.test(option.value) ? { ...option, label: pageSizeLabel(Number(option.value)) } : option)
    : suppliedOptions, [suppliedOptions, isPageSizeControl])
  // Field の中に置くと、欄の誤り（赤）と説明の読み上げを受け取る。
  const field = useFieldContext()
  const invalid = Boolean(error) || invalidProp || Boolean(field?.invalid)
  const generatedId = useId()
  const buttonId = id ?? field?.controlId ?? `${generatedId}-button`
  const listboxId = `${generatedId}-listbox`
  const rootRef = useRef<HTMLDivElement>(null)
  const lock = usePermissionLockTip<HTMLButtonElement>(lockedReason, joinDescribedBy(field?.describedBy))
  const triggerRef = lock.ref
  const currentLock = useRef(lockedReason)
  currentLock.current = lockedReason
  const [open, setOpen] = useState(defaultOpen)
  // 'create' は「＋ 〇〇」を押した後（同じ板で名前を入れている）。閉じたら一覧へ戻す。
  const [mode, setMode] = useState<'list' | 'create'>('list')
  // 作る板の回。閉じる・一覧へ戻る・ほかを選ぶ・作り直すで進め、古い回の遅い応答に今の選択を上書きさせない。
  const createSessionRef = useRef(0)
  const createPermission = { disabled: Boolean(createAction?.disabled), reason: createAction?.lockedReason }
  const currentCreatePermission = useRef(createPermission)
  if (currentCreatePermission.current.disabled !== createPermission.disabled || currentCreatePermission.current.reason !== createPermission.reason) {
    createSessionRef.current += 1
  }
  currentCreatePermission.current = createPermission
  const menuRef = useRef<HTMLDivElement>(null)
  const enabledOptions = options.filter((option) => !option.disabled)
  const selectedIndex = Math.max(0, enabledOptions.findIndex((option) => option.value === value))
  const [activeIndex, setActiveIndex] = useState(selectedIndex)
  const selected = options.find((option) => option.value === value) ?? options[0]
  // 候補ごとに「使える候補の中で何番目か」を1回で引く（行ごとに探すと 2,000 個で 400 万回）。
  const enabledIndexOf = useMemo(() => {
    const map = new Map<string, number>()
    enabledOptions.forEach((option, index) => map.set(option.value, index))
    return map
  }, [enabledOptions])
  const windowed = options.length > WINDOW_THRESHOLD
  /*
   * ★V8 は開いた中身を共通部品 select-menu（StFE7）で描く（2026-10-08 ）。
   * 選択肢の「並び：」などの頭は外して上の見出しにし、閉じたボタンは今のまま。
   */

  const OPTION_HEIGHT = SELECT_MENU_ROW_STRIDE
  const heads = useMemo(() => splitOptionHeads(options, label), [options, label])
  /* 閉じた欄の見出し。label か、選択肢が持つ頭（「フォルダ：すべて」の「フォルダ」）。 */
  const valueHead = label ?? (selected && /^[^：:]{1,12}[:：]/.test(selected.label) ? heads.heading : undefined)
  const filterState: 'default' | 'active' | undefined = valueHead && options.some(isAllOption) && selected ? (isAllOption(selected) ? 'default' : 'active') : undefined
  useSelectContentWidth(rootRef, { size, selectedLabel: selected?.label, label, treatment, showChevron, iconOnly, icon })
  // 一覧は器（MenuPortal）が後から描くので、ref ではなく描かれた時に受け取る。
  const [listEl, setListEl] = useState<HTMLUListElement | null>(null)
  const [scrollWindow, setScrollWindow] = useState({ top: 0, height: 0 })

  // 開いている間、器（MenuPortal）のスクロールを追う。
  useLayoutEffect(() => {
    if (!open || !windowed) return
    const list = listEl
    const scroller = list?.closest<HTMLElement>('[data-menu-portal]')
    if (!list || !scroller) return
    let frame = 0
    const read = () => {
      frame = 0
      const top = scroller.scrollTop - list.offsetTop
      const height = scroller.clientHeight || 400
      setScrollWindow((prev) => (prev.top === top && prev.height === height ? prev : { top, height }))
    }
    // 開いたときは選んでいる候補が見える所から。
    const selectedAt = options.findIndex((option) => option.value === value)
    if (selectedAt > 0) scroller.scrollTop = list.offsetTop + selectedAt * OPTION_HEIGHT
    read()
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(read) }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, windowed, listEl])

  // キーボードで動かした候補が見える所にあるようにする（描かれていなければ描いてから）。
  useLayoutEffect(() => {
    if (!open || !windowed) return
    const list = listEl
    const scroller = list?.closest<HTMLElement>('[data-menu-portal]')
    const option = enabledOptions[activeIndex]
    if (!list || !scroller || !option) return
    const at = options.findIndex((candidate) => candidate.value === option.value)
    const top = list.offsetTop + at * OPTION_HEIGHT
    if (top < scroller.scrollTop) scroller.scrollTop = top
    else if (top + OPTION_HEIGHT > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + OPTION_HEIGHT - scroller.clientHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, open, windowed, listEl])

  let windowStart = 0
  let windowEnd = options.length
  if (open && windowed) {
    const height = scrollWindow.height || 400
    windowStart = Math.max(0, Math.floor(scrollWindow.top / OPTION_HEIGHT) - WINDOW_OVERSCAN)
    windowEnd = Math.min(options.length, Math.ceil((scrollWindow.top + height) / OPTION_HEIGHT) + WINDOW_OVERSCAN)
  }

  useEffect(() => {
    if (disabled || lockedReason) setOpen(false)
  }, [disabled, lockedReason])

  useEffect(() => {
    if (open) return
    createSessionRef.current += 1
    setMode('list')
  }, [open])

  const hasCreate = Boolean(createAction)
  // キーボードで動く行の数。「＋ 〇〇」は使える候補の後ろの1行。
  const rowCount = enabledOptions.length + (hasCreate ? 1 : 0)
  const createActive = hasCreate && activeIndex === enabledOptions.length
  const startCreate = () => {
    if (currentLock.current) return
    const permission = currentCreatePermission.current
    if (permission.disabled || permission.reason) {
      if (permission.reason) menuRef.current?.querySelector<HTMLButtonElement>('[data-select-menu-action]')?.focus()
      return
    }
    if (createAction?.onSelect) { setOpen(false); createAction.onSelect(); return }
    createSessionRef.current += 1
    setMode('create')
  }
  const previousCreateSignal = useRef(openCreateSignal)
  useEffect(() => {
    if (openCreateSignal === previousCreateSignal.current) return
    previousCreateSignal.current = openCreateSignal
    if (openCreateSignal === undefined || disabled || currentLock.current || !createAction || currentCreatePermission.current.disabled || currentCreatePermission.current.reason) return
    createSessionRef.current += 1
    setMode('create')
    setOpen(true)
  }, [openCreateSignal, disabled, createAction])
  const backToList = () => {
    createSessionRef.current += 1
    // 焦点を先にボタンへ戻す（入力欄が消えて焦点が迷子になり閉じるのを防ぐ）。
    triggerRef.current?.focus()
    setMode('list')
  }
  // 板に渡す受け口は、その回の番号を覚える。回が終わった後に届いた完了は選ばず・焦点も動かさず・閉じない。
  const createContext = (session: number): SelectCreateContext => ({
    back: () => {
      if (session === createSessionRef.current) backToList()
    },
    finish: (next: string) => {
      if (currentLock.current || currentCreatePermission.current.disabled || currentCreatePermission.current.reason || session !== createSessionRef.current) return
      createSessionRef.current += 1
      onChange(next)
      triggerRef.current?.focus()
      setOpen(false)
    },
  })

  useEffect(() => {
    setActiveIndex(selectedIndex)
  }, [selectedIndex])

  const choose = (option: SelectOption) => {
    if (currentLock.current || option.disabled) return
    createSessionRef.current += 1
    onChange(option.value)
    setOpen(false)
  }

  const move = (direction: 1 | -1) => {
    if (rowCount === 0) return
    setActiveIndex((current) => (current + direction + rowCount) % rowCount)
  }

  const revealMenuBelow = () => {
    if (menuPlacement !== 'down') return
    const trigger = triggerRef.current
    const menuHeight = options.length * SELECT_MENU_ROW_STRIDE + (heads.heading ?? menuHeading ? 32 : 0) + 24
    if (trigger && window.innerHeight - trigger.getBoundingClientRect().bottom - 8 < menuHeight) {
      trigger.scrollIntoView({ block: 'start', behavior: 'auto' })
    }
  }

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    // 日本語の変換中のキー（確定の Enter・候補の上下）は選ぶ欄で使わない。
    if (isImeComposing(event)) return
    // ＋行だけが権限ロックの時は、Tabで理由を読める行へ渡す。未指定時の順序は変えない。
    if (event.key === 'Tab' && !event.shiftKey && open && currentCreatePermission.current.reason) {
      const action = menuRef.current?.querySelector<HTMLButtonElement>('[data-select-menu-action]')
      if (action) { event.preventDefault(); action.focus(); return }
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) { revealMenuBelow(); setOpen(true) }
      else move(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (open && createActive) startCreate()
      else if (open && enabledOptions[activeIndex]) choose(enabledOptions[activeIndex])
      else { revealMenuBelow(); setOpen(true) }
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
    }
  }

  const Trigger = iconOnly ? IconButton : 'button'
  return (
    <div
      ref={rootRef}
      className={[
        styles.root,
        styles[size === 'page-size' ? 'pageSize' : size],
        open ? styles.open : null,
        disabled || lockedReason ? styles.disabled : null,
        error || invalid ? styles.invalid : null,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={width ? { width: `${width}px`, minWidth: `${width}px` } : undefined}
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        if (rootRef.current?.contains(next)) return
        // 板の中（「名前を入れる」の欄）へ焦点が移ったときは閉じない。
        if (next && menuRef.current?.contains(next)) return
        // 板の中で焦点が外れただけ（入れ替わり）。外を押したときは器が閉じる。
        if (!next && menuRef.current?.contains(event.target as Node)) return
        setOpen(false)
      }}
      data-design-node={open ? 'Gfsb4' : size === 'page-size' ? 'niGPF' : 'rpot9'}
      data-list-page-size={isPageSizeControl || undefined}
      data-select-icon-only={iconOnly || undefined}
    >
      {name ? <input type="hidden" name={name} value={value} disabled={disabled} /> : null}
      <Trigger
        ref={triggerRef}
        id={buttonId}
        type="button"
        className={iconOnly ? undefined : `${choiceStyles.frame} ${styles.trigger} ${open ? styles.openTrigger : styles.closedTrigger} ${treatment === 'text' ? styles.textTrigger : treatment === 'pill' ? `${pillStyles.pill} ${pillStyles.control}` : ''}`}
        data-choice-field={!iconOnly || undefined}
        data-choice-surface={!iconOnly && treatment !== 'text' && treatment !== 'pill' ? 'select' : undefined}
        data-choice-active={filterState === 'active' || undefined}
        data-choice-invalid={Boolean(error) || invalid || undefined}
        data-choice-disabled={disabled || Boolean(lockedReason) || undefined}
        data-tone={treatment === 'pill' ? selected?.tone ?? 'neutral' : undefined}
        data-filter-active={filterState === 'active' || undefined}
        data-value-align={valueAlign}
        data-text-size={textSize}
        data-chevron={!iconOnly || undefined}
        data-icon-only={iconOnly || undefined}
        title={lockedReason ? undefined : iconOnly ? ariaLabel : undefined}
        aria-label={ariaLabel}
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-invalid={Boolean(error) || invalid || undefined}
        aria-describedby={joinDescribedBy(field?.describedBy)}
        disabled={disabled}
        onClick={() => {
          if (!open) revealMenuBelow()
          setOpen((current) => !current)
        }}
        onKeyDown={onButtonKeyDown}
        {...lock.handlers}
      >
        {treatment === 'text' ? (
          <ArrowUpDown className={styles.directionIcon} aria-hidden="true" />
        ) : null}
        {icon ? (
          <span className={styles.leadingIcon} aria-hidden="true">
            {icon}
          </span>
        ) : null}
        {/* 省略表示（…）のとき、ホバーで全文を確認できる（#640）。 */}
        <span className={styles.value} hidden={iconOnly} data-select-value data-text-size={textSize} title={selected?.label ?? undefined}>
          {valueHead ? <SelectValueText head={valueHead} value={selected ? heads.labelOf(selected) : ''} filterState={filterState} /> : selected?.label ?? ''}
        </span>
        {!iconOnly && (open ? (
          <ChevronUp data-choice-chevron className={styles.chevron} aria-hidden="true" />
        ) : (
          <ChevronDown data-choice-chevron className={styles.chevron} aria-hidden="true" />
        ))}
      </Trigger>
      {open ? (
        <SelectMenu textSize={textSize}
          open={open}
          getAnchor={() => triggerRef.current}
          onClose={() => setOpen(false)}
          align={menuAlign}
          placement={menuPlacement}
          listboxId={listboxId}
          labelledBy={buttonId}
          heading={heads.heading ?? menuHeading}
          listRef={setListEl}
          innerRef={menuRef}
          onEscape={mode === 'create' ? backToList : undefined}
          onPanelBlur={(event) => {
            const next = event.relatedTarget as Node | null
            if (!next || menuRef.current?.contains(next) || rootRef.current?.contains(next)) return
            setOpen(false)
          }}
          panel={hasCreate && mode === 'create' && createAction?.render ? createAction.render(createContext(createSessionRef.current)) : undefined}
          footer={hasCreate && createAction ? (
            <SelectMenuAction
              label={createAction.label}
              active={createActive}
              disabled={createAction.disabled}
              lockedReason={createAction.lockedReason}
              onHover={() => setActiveIndex(enabledOptions.length)}
              onSelect={startCreate}
            />
          ) : undefined}
        >
          {windowStart > 0 ? <SelectMenuSpacer rows={windowStart} /> : null}
          {options.slice(windowStart, windowEnd).map((option, offset) => {
            const optionIndex = enabledIndexOf.get(option.value) ?? -1
            return (
              <SelectMenuOption
                key={option.value}
                label={heads.labelOf(option)}
                trailing={option.trailing}
                leading={option.leading}
                description={windowed ? undefined : option.description}
                selected={option.value === value}
                active={optionIndex >= 0 && optionIndex === activeIndex}
                disabled={option.disabled}
                setSize={windowed ? options.length : undefined}
                posInSet={windowed ? windowStart + offset + 1 : undefined}
                onHover={() => {
                  if (optionIndex >= 0) setActiveIndex(optionIndex)
                }}
                onSelect={() => choose(option)}
              />
            )
          })}
          {windowEnd < options.length ? <SelectMenuSpacer rows={options.length - windowEnd} /> : null}
        </SelectMenu>
      ) : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {lock.node}
    </div>
  )
}
