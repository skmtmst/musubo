'use client'

import TextLink from '@/components/shared/text-link'
import choiceStyles from './choice-field.module.css'
import { usePermissionLockTip } from './permission-lock-tip'
import { type EntityPickerItem, type EntityPickerFolder, type EntityPickerCategory, type SingleProps, type EntityPickerWindowProps, type MultiBodyProps, type MultiProps, type FieldBase, type SingleField, type MultiField } from './entity-picker-types'
export { type EntityPickerItem, type EntityPickerFolder, type EntityPickerCategory, type EntityPickerWindowProps } from './entity-picker-types'

import { ChevronDown, ArrowUpRight, Plus, X, type LucideIcon } from 'lucide-react'
import { folderDisplayColor, FolderDot } from './folder-dot'
import { useFieldContext, joinDescribedBy } from './field-context'
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import Button from './button'
import IconButton from './icon-button'
import Checkbox from './checkbox'
import FolderPanel, { type FolderPanelRow } from './folder-panel'
import SearchField from './search-field'
import Select from './select'
import { SelectValueText, filterHead, isAllOption } from './select-menu'
import StatusBadge, { type StatusBadgeTone } from './status-badge'
import shell from './source-picker-dialog.module.css'
import styles from './entity-picker.module.css'
import Dialog from './dialog'
import TagPill from './tag-pill'
import { TextField } from './text-field'
import useNarrow from './use-picker-narrow'
import { formatNumber } from '@/lib/format'

/** フォルダの列の「すべて」「未分類」の値。 */
export const PICKER_ALL = ''
export const PICKER_UNFILED = '__none__'
const ALL = PICKER_ALL
const UNFILED = PICKER_UNFILED

function folderOf(item: EntityPickerItem, folders: EntityPickerFolder[]) {
  return item.folderId ? folders.find((folder) => folder.id === item.folderId) ?? null : null
}
const FREQUENT = '__frequent__'
function inFolder(item: EntityPickerItem, folder: string) {
  if (folder === FREQUENT) return Boolean(item.frequent)
  return !folder || (folder === UNFILED ? !item.folderId : item.folderId === folder)
}
function matches(item: EntityPickerItem, query: string) {
  const q = query.trim().toLocaleLowerCase()
  return !q || item.name.toLocaleLowerCase().includes(q) || Boolean(item.keywords?.toLocaleLowerCase().includes(q)) || Boolean(item.content?.toLocaleLowerCase().includes(q))
}

/** 指定なしは従来のまま。指定時は保持した処理と最新の描画の双方で許可を確かめる。 */
function usePickerChangeAccess(access: { canChangeNow?: () => boolean; disabled?: boolean; lockedReason?: string }, enabled = access.canChangeNow !== undefined) {
  const captured = { ...access, enabled }
  const latest = useRef(captured)
  latest.current = captured
  const permits = (value: typeof captured) => !value.enabled || (!value.disabled && !value.lockedReason && value.canChangeNow?.() !== false)
  return () => permits(captured) && permits(latest.current)
}

function CreateLink({ href, label, lockedReason, disabled, canChangeNow }: { href?: string; label?: string; lockedReason?: string; disabled?: boolean; canChangeNow?: () => boolean }) {
  if (!href || !label) return null
  if (lockedReason) return <Button variant="text" size="inline" lockedReason={lockedReason}>{`作る画面へ：${label}`}<ArrowUpRight size={16} aria-hidden="true" /></Button>
  if (disabled) return <Button variant="text" size="inline" disabled>{`作る画面へ：${label}`}<ArrowUpRight size={16} aria-hidden="true" /></Button>
  return <TextLink href={href} target="_blank" rel="noopener" onClick={canChangeNow ? event => { if (!canChangeNow()) { event.preventDefault(); event.stopPropagation() } } : undefined}>{`作る画面へ：${label}`}</TextLink>
}

export function EntityPickerWindow(props: EntityPickerWindowProps) {
  const body = props.preview ? <div className={styles.withPreview}>
    {props.children}
    <section className={styles.preview} aria-label="テンプレートの中身">
      <header className={styles.previewHeader}>
        <h2 className={styles.previewTitle} title={props.preview.title}>{props.preview.title}</h2>
        <IconButton aria-label="中身の表示を閉じる" onClick={props.preview.onClose}><X size={16} aria-hidden="true" /></IconButton>
      </header>
      <div className={styles.previewBody}>{props.preview.content}</div>
      {props.preview.actions ? <footer className={styles.previewActions}>{props.preview.actions}</footer> : null}
    </section>
  </div> : props.children
  const content = props.navigation ? <><div className={styles.navigation}>{props.navigation}</div>{body}</> : body
  return <Dialog open dirty={false} title={props.title} description={props.description}
    designNode={props.designNode} designWidth={props.preview || props.wide ? undefined : 640} widthPreset={props.preview || props.wide ? undefined : 'picker'} size={props.preview || props.wide ? 'wide' : undefined} designHeaderPadding="var(--tpl-inbox-tp-head-pad)"
    contentLayout={props.scrollBody ? 'form' : undefined} designContentPadding={props.scrollBody ? '0' : undefined}
    busy={props.busy} initialFocusId={props.initialFocusId} onCancel={props.onCancel} headerAction={props.headerAction}
    footer={<>
      {props.scrollBody ? null : content}
      {props.error ? <p className={styles.tpError} role="alert">{props.error}</p> : null}
      {props.band}
      <div className={styles.tpFoot}>{props.footer}</div>
    </>}>{props.scrollBody ? content : null}</Dialog>
}

export function EntityPickerDialog(props: SingleProps | EntityPickerWindowProps) {
  return 'children' in props ? <EntityPickerWindow {...props} /> : <SingleEntityPickerDialog {...props} />
}

/** 行を選ぶ間は仮の選択。確定したときだけ呼ぶ側の値を変える。 */
function SingleEntityPickerDialog({
  title, description, scrollBody = false, confirmLabel = '選ぶ', items, folders = [], foldersFailed = false, categories = [], initialId = '',
  state, listFooter, preview, error, busy = false, confirmDisabled = false, confirmLockedReason, readOnly = false, createHref, createLabel,
  searchPlaceholder = '名前で探す', designNode = 'M0393', query: controlledQuery, onQueryChange, createAction, onSelect, onConfirm, onCancel, canChangeNow,
}: SingleProps) {
  const canConfirmNow = usePickerChangeAccess({ canChangeNow, disabled: confirmDisabled, lockedReason: confirmLockedReason })
  const changeDisabled = canChangeNow !== undefined && !confirmLockedReason && (confirmDisabled || canChangeNow() === false)
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState('')
  const creatingRef = useRef(false)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const runCreate = async () => {
    if (!createAction || !canConfirmNow() || creatingRef.current) return
    creatingRef.current = true; setCreateBusy(true); setCreateError('')
    try { await createAction.onCreate(query.trim()) }
    catch { if (mounted.current && canConfirmNow()) setCreateError('作れませんでした。もう一度お試しください。') }
    finally { creatingRef.current = false; if (mounted.current) setCreateBusy(false) }
  }
  const id = useId()
  const [panelRef, narrow] = useNarrow(560)
  const [selected, setSelected] = useState(initialId)
  const [ownQuery, setOwnQuery] = useState('')
  const query = controlledQuery ?? ownQuery
  const setQuery = (value: string) => { setOwnQuery(value); onQueryChange?.(value) }
  const [folder, setFolder] = useState(ALL)
  const [category, setCategory] = useState('')
  const [limit, setLimit] = useState(20)
  useEffect(() => { setLimit(20) }, [query, folder, category])

  const hasFolders = folders.length > 0 || items.some((item) => item.folderId !== undefined)
  const listState = Boolean(state)
  const folderItems = items.filter((item) => folder === '__frequent__' ? item.frequent : inFolder(item, folder))
  const rows = folderItems.filter((item) => (!category || item.category === category) && (controlledQuery !== undefined || matches(item, query)))
  const visibleLimit = controlledQuery !== undefined ? rows.length : limit
  const picked = items.find((item) => item.id === selected) ?? null
  const folderRows = pickerFolderRows(items, folders, listState)
  if (items.some((item) => item.frequent !== undefined)) folderRows.unshift ({id: '__frequent__', label: 'よく使う', kind: 'frequent', count: listState ? null : items.filter((item) => item.frequent).length })
  const previewNode = typeof preview === 'function' ? preview(picked) : preview

  return <EntityPickerDialog scrollBody={scrollBody} title={title} description={description} busy={busy || createBusy} error={error || createError} designNode={designNode} onCancel={onCancel} initialFocusId={`${id}-search`}
    footer={<>
      <div className={styles.tpFootLead}>
        {!readOnly ?
      <CreateLink href={createHref} label={createLabel} lockedReason={confirmLockedReason} disabled={changeDisabled} canChangeNow={canChangeNow ? canConfirmNow : undefined} /> : null}
      <span className={styles.selection} title={picked?.name}>{picked ? `選んだもの：${picked.name}` : 'まだ選んでいません'}</span>
      </div>
      <div className={styles.tpFootActions}>
      <Button disabled={busy || createBusy} onClick={onCancel}>{readOnly ? '閉じる' : 'キャンセル'}</Button>
      {readOnly ? null : <Button variant="primary" widthReserve="idle" busy={busy || createBusy} lockedReason={confirmLockedReason} disabled={busy || createBusy || !picked || picked.disabled || listState || confirmDisabled || changeDisabled} title={confirmLockedReason ? undefined : listState ? '候補を読み込める状態になってから選んでください。' : !picked ? '候補を選んでください。' : picked.disabled ? picked.meta : confirmDisabled ? error : undefined} onClick={() => { if (canConfirmNow()) onConfirm(selected) }}>{confirmLabel}</Button>}
    </div>
    </>}
  >
    <div ref={panelRef} className={`${shell.body} ${scrollBody ? styles.tpBody : styles.singleBody}`}>
      {hasFolders && !narrow ? <div className={shell.folders}>
        <FolderPanel readOnly reserveCreateSpace={false} headingAfterAll disabled={busy || listState} rows={folderRows} activeId={folder} onSelect={setFolder} />
      </div> : null}
      <section className={styles.tpList} aria-label="候補の一覧">
        <div className={styles.searchRow}><SearchField id={`${id}-search`} aria-label={`${title}：${searchPlaceholder}`} placeholder={searchPlaceholder} value={query} onChange={setQuery} onClear={() => setQuery('')} />
        {categories.length ? <div className={shell.categories} aria-label="候補の絞り込み">
          <Select aria-label="候補の絞り込み" value={category} onChange={setCategory} disabled={busy || listState} options={[{ id: '', label: 'すべて' }, ...categories].map((c) => ({ value: c.id, label: listState ? c.label : `${c.label} ${formatNumber(folderItems.filter((item) => !c.id || item.category === c.id).length)}` }))} />
        </div> : null}</div>
        {foldersFailed ? <p className={styles.note}>フォルダを読み込めませんでした。すべての候補から選べます。</p> : null}
        <div className={styles.tpCards}>
          {state || (rows.length ? rows.slice(0, visibleLimit).map((item) => <label key={item.id} className={styles.tpCard} data-selected={selected === item.id || undefined} data-disabled={busy || item.disabled || undefined}>
            <input type="radio" name={`${id}-candidate`} className={styles.cardRadio} aria-label={item.name} value={item.id} checked={selected === item.id} disabled={busy || item.disabled} onChange={() => { setSelected(item.id); onSelect?.(item.id) }} />
            {hasFolders ? <FolderDot folder={folderOf(item, folders)} /> : null}
            <span className={styles.tpCardText}>
              <span className={styles.tpCardName} title={item.name}>
                {item.name}</span>
              {item.content || item.meta ? <span className={styles.tpCardBody} title={item.content ?? item.meta}>{item.content ?? item.meta}</span> : null}
            </span>{item.categoryLabel ? <StatusBadge tone={item.tone} dot={false} size="compact">{item.categoryLabel}</StatusBadge> : null}</label>) : <p className={styles.tpNote}>当てはまる候補がありません。</p>)}
        </div>
        {createAction && !readOnly && query.trim() && !items.some((item) => item.name === query.trim()) ? <Button disabled={busy || listState || createBusy || changeDisabled} busy={canChangeNow ? createBusy : undefined} lockedReason={confirmLockedReason} onClick={() => { if (canChangeNow) void runCreate(); else if (!confirmLockedReason) createAction.onCreate(query.trim()) }}>{createAction.label(query.trim())}</Button> : null}
        {!listState ? <div className={shell.more}><span>{`${formatNumber(rows.length)}件中 ${rows.length ? 1 : 0}〜${Math.min(visibleLimit, rows.length)}件`}</span>{rows.length > visibleLimit ? <Button size="compact" onClick={() => setLimit((value) => value + 20)}>続きを読み込む</Button> : null}</div> : null}
      {listFooter}
        {preview !== undefined && picked ? <div className={styles.itemPreview} aria-label="選んだ候補の見え方">{previewNode}</div> : null}
    </section></div></EntityPickerDialog>
}

/** フォルダの列の行（すべて・各フォルダ・未分類）。件数は候補の数。 */
export function pickerFolderRows(items: EntityPickerItem[], folders: EntityPickerFolder[], hideCounts = false, leading?: (ids: string[], label: string) => ReactNode): FolderPanelRow[] {
  const count = (folder: string) => (hideCounts ? null : items.filter((item) => inFolder(item, folder)).length)
  const ids = (folder: string) => items.filter((item) => inFolder(item, folder) && !item.disabled && !item.locked).map((item) => item.id)
  const showUnfiled = folders.length > 0 || items.some((item) => item.folderId === null)
  const rows: FolderPanelRow[] = [
    { id: ALL, label: 'すべて', kind: 'all', count: count(ALL) },
    ...folders.map((folder) => ({ id: folder.id, label: folder.name, kind: 'folder' as const, color: folder.color ?? null, count: count(folder.id) })),
    ...(showUnfiled ? [{ id: UNFILED, label: '未分類', kind: 'unfiled' as const, count: count(UNFILED) }] : []),
  ]
  return leading ? rows.map((row) => ({ ...row, leading: leading(ids(row.id), row.label) })) : rows
}

/**
 * まとめて選ぶ中身（フォルダの列＋一覧）。窓の中にも、ほかの窓の中にも埋め込める。
 * フォルダの横のチェックは、そのフォルダの選べる候補をまとめて付け外しする。
 */
export function EntityMultiSelect({ items, folders = [], foldersFailed = false, selected, onChange, query, onlySelected = false, readOnly = false, busy = false, state, listFooter, rowExtra, searchSlot, listLabel = '候補の一覧', folder: controlledFolder, onFolder, folderHeading, initialFolder, embedded = false, stacked = false, disabled, lockedReason, canChangeNow }: MultiBodyProps) {
  const canSelectNow = usePickerChangeAccess({ canChangeNow, disabled, lockedReason }, canChangeNow !== undefined || disabled !== undefined || lockedReason !== undefined)
  const changeDisabled = Boolean(!lockedReason && (disabled || canChangeNow?.() === false))
  const id = useId()
  const [ownFolder, setOwnFolder] = useState(initialFolder ?? ALL)
  const folder = controlledFolder ?? ownFolder
  const setFolder = (value: string) => { setOwnFolder(value); onFolder?.(value) }
  const [panelRef, narrow] = useNarrow(560)
  const hasFolders = folders.length > 0 || items.some((item) => item.folderId !== undefined)
  const set = useMemo(() => new Set(selected), [selected])
  const toggleMany = (ids: string[], on: boolean) => { if (canSelectNow()) onChange(on ? [...new Set([...selected, ...ids])] : selected.filter((value) => !ids.includes(value))) }
  const groupCheck = (ids: string[], label: string) => {
    const count = ids.filter((value) => set.has(value)).length
    return <Checkbox aria-label={`${label}をまとめて選ぶ`} checked={ids.length > 0 && count === ids.length} indeterminate={count > 0 && count < ids.length}
      disabled={readOnly || busy || changeDisabled || ids.length === 0} lockedReason={lockedReason} onCheckedChange={(on) => toggleMany(ids, on)} />
  }
  const folderRows = pickerFolderRows(items, folders, Boolean(state), groupCheck)
  // S2Vgi：利用の記録がある種類は先頭に「よく使う」。
  if (items.some((item) => item.frequent !== undefined)) folderRows.unshift({ id: FREQUENT, label: 'よく使う', kind: 'frequent', count: state ? null : items.filter((item) => item.frequent).length, leading: groupCheck(items.filter((item) => item.frequent && !item.disabled && !item.locked).map((item) => item.id), 'よく使う') })
  const rows = items.filter((item) => inFolder(item, folder) && matches(item, query) && (!onlySelected || set.has(item.id)))
  return <div ref={panelRef} className={embedded ? `${shell.body} ${styles.embedded}` : `${shell.body} ${styles.multiBody}`}>
    {hasFolders && !narrow ? <div className={shell.folders}>
      <FolderPanel readOnly reserveCreateSpace={false} heading={folderHeading} headingAfterAll={!embedded} disabled={busy || Boolean(state)} rows={folderRows} activeId={folder} onSelect={setFolder} />
    </div> : null}
    <section className={`${styles.tpList} ${styles.multiList}`} aria-label={listLabel}>
      {searchSlot}
      {hasFolders && narrow ? <Select disabled={busy || Boolean(state)} aria-label="候補のフォルダ" value={folder} onChange={setFolder} options={folderRows.map((row) => ({ value: row.id, label: `${row.label}（${row.count ?? '—'}）` }))} /> : null}
      {foldersFailed ? <p className={styles.note}>フォルダを読み込めませんでした。すべての候補から選べます。</p> : null}
      <div className={styles.multiRows}>
        {state || (rows.length ? rows.map((item) => {
          const checked = set.has(item.id)
          const inputId = `${id}-${item.id}`
          if (stacked) return <div key={item.id} className={styles.multiRow} data-stacked="" data-selected={checked || undefined} data-disabled={item.disabled || undefined}>
            <Checkbox id={inputId} aria-label={item.name} checked={checked} disabled={readOnly || busy || changeDisabled || item.locked || (item.disabled && !checked)} lockedReason={lockedReason} onCheckedChange={(on) => toggleMany([item.id], on)} />
            <label className={styles.multiStack} htmlFor={inputId}>
              <span className={styles.multiName} title={item.name}>
                {hasFolders ? <FolderDot folder={folderOf(item, folders)} /> : null}
                <span className={styles.multiNameText}>{item.name}</span>
              </span>
              {item.meta || rowExtra ? <small className={styles.multiSub}>{item.meta ? <span className={styles.multiSubText} title={item.meta}>{item.meta}</span> : null}{rowExtra ? rowExtra(item) : null}</small> : null}
            </label>
          </div>
          return <div key={item.id} className={styles.multiRow} data-selected={checked || undefined} data-disabled={item.disabled || undefined}>
            <Checkbox id={inputId} aria-label={item.name} checked={checked} disabled={readOnly || busy || changeDisabled || item.locked || (item.disabled && !checked)} lockedReason={lockedReason} onCheckedChange={(on) => toggleMany([item.id], on)} />
            <label className={styles.multiName} htmlFor={inputId} title={item.name}>
              {hasFolders ? <FolderDot folder={folderOf(item, folders)} /> : null}
              <span className={styles.multiNameText}>{item.name}</span>
            </label>
            {rowExtra ? <span className={styles.multiExtra}>{rowExtra(item)}</span> : null}
            {item.meta ? <small className={styles.multiMeta} title={item.meta}>{item.meta}</small> : null}
          </div>
        }) : <p className={shell.empty}>{onlySelected ? 'まだ何も選んでいません。' : '当てはまる候補がありません。'}</p>)}
      </div>
      {listFooter}
    </section>
  </div>
}

/** まとめて選ぶ窓。確定するまでは呼ぶ側の値を変えない。 */
export function EntityMultiPickerDialog({ title, description, items, folders, foldersFailed, initialIds, unit = '件', state, listFooter, error, busy = false, readOnly = false, createHref, createLabel, createAction, note, searchPlaceholder = '名前で探す', allowEmpty = true, rowExtra, initialFolder, stacked, query: controlledQuery, onQueryChange, maxSelected, onConfirm, onCancel, confirmDisabled, confirmLockedReason, canChangeNow }: MultiProps) {
  const permissionProvided = canChangeNow !== undefined || confirmDisabled !== undefined || confirmLockedReason !== undefined
  const canConfirmNow = usePickerChangeAccess({ canChangeNow, disabled: confirmDisabled, lockedReason: confirmLockedReason }, permissionProvided)
  const changeDisabled = Boolean(!confirmLockedReason && (confirmDisabled || canChangeNow?.() === false))
  const mounted = useRef(true)
  const creatingRef = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const [selected, setSelected] = useState(initialIds)
  const [ownQuery, setOwnQuery] = useState('')
  const query = controlledQuery ?? ownQuery
  const setQuery = (value: string) => { setOwnQuery(value); onQueryChange?.(value) }
  const [onlySelected, setOnlySelected] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const [created, setCreated] = useState<EntityPickerItem[]>([])
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [createError, setCreateError] = useState('')
  const allItems = created.length ? [...items, ...created.filter((item) => !items.some((own) => own.id === item.id))] : items
  const runCreate = async () => {
    const name = newName.trim()
    if (!name || !createAction || createBusy || !canConfirmNow() || (permissionProvided && creatingRef.current)) return
    creatingRef.current = true
    setCreateBusy(true); setCreateError('')
    try {
      const item = await createAction.onCreate(name)
      if (permissionProvided && (!mounted.current || !canConfirmNow())) return
      if (!item) { setCreateError('作れませんでした。名前を確かめて、もう一度お試しください。'); return }
      setCreated((now) => [...now, item]); setSelected((now) => [...new Set([...now, item.id])]); setCreating(false); setNewName('')
    } catch { if (!permissionProvided || (mounted.current && canConfirmNow())) setCreateError('作れませんでした。もう一度お試しください。') }
    finally { creatingRef.current = false; if (!permissionProvided || mounted.current) setCreateBusy(false) }
  }
  const countText = `${formatNumber(selected.length)}件`
  const pickedNames = selected.map((value) => allItems.find((item) => item.id === value)?.name ?? '見つからないもの').join('・')
  const footNote = note ?? (maxSelected !== undefined ? `${maxSelected}${unit === '件' ? '件' : ` ${unit}`}まで選べます` : 'いくつでも選べます')
  // S2Vgi（正の形）：頭に「＋〇〇を作る」、一覧の下に「選んだもの」の帯、下の段は案内と［キャンセル］［選ぶ（N件）］。
  return <EntityPickerDialog title={title} description={description} designNode="dJZ7Q" busy={busy} error={error} onCancel={onCancel}
    headerAction={!readOnly && createAction ? <Button size="compact" disabled={busy || creating || changeDisabled} lockedReason={confirmLockedReason} onClick={() => { if (canConfirmNow()) { setCreating(true); setCreateError('') } }}><Plus size={16} aria-hidden="true" />{createAction.label}</Button> : undefined}
    band={selected.length ? <div className={styles.pickedBand} aria-live="polite">
      <strong className={styles.pickedLabel}>選んだもの：</strong>
      <span className={styles.pickedNames} title={pickedNames}>{pickedNames}</span>
      <strong className={styles.pickedCount}>{`${formatNumber(selected.length)} 件`}</strong>
    </div> : undefined}
    footer={<>
      <div className={styles.tpFootLead}>
        {!readOnly ?
      <CreateLink href={createHref} label={createLabel} lockedReason={confirmLockedReason} disabled={changeDisabled} canChangeNow={canChangeNow ? canConfirmNow : undefined} /> : null}
      <span className={styles.tpFootText}>
        <span className={styles.tpFootNote}>{footNote}</span>
        <button type="button" className={styles.textButton} aria-pressed={onlySelected} onClick={() => setOnlySelected((value) => !value)}>{onlySelected ? 'すべて見る' : '選んだものだけ見る'}</button>
      </span>
      </div>
      <div className={styles.tpFootActions}>
        <Button disabled={busy} onClick={onCancel}>{readOnly ? '閉じる' : 'キャンセル'}</Button>
      {readOnly ? null : <Button variant="primary" widthReserve="idle" busy={busy} disabled={busy || changeDisabled || Boolean(state) || (maxSelected !== undefined && selected.length > maxSelected) || (!allowEmpty && selected.length === 0)} lockedReason={confirmLockedReason} onClick={() => { if (canConfirmNow()) onConfirm(selected) }}>{`選ぶ（${countText}）`}</Button>}
    </div>
    </>}
  >
    <EntityMultiSelect items={maxSelected && selected.length >= maxSelected ? allItems.map((item) => ({ ...item, disabled: item.disabled || !selected.includes(item.id) })) :allItems} folders={folders} foldersFailed={foldersFailed} selected={selected} onChange={setSelected} query={query} onlySelected={onlySelected} readOnly={readOnly} busy={busy || createBusy} state={state} listFooter={listFooter} rowExtra={rowExtra} initialFolder={initialFolder} stacked={stacked} disabled={changeDisabled} lockedReason={confirmLockedReason} canChangeNow={canChangeNow ? canConfirmNow : undefined}
      searchSlot={<>
        <SearchField ref={searchRef} aria-label={`${title}：${searchPlaceholder}`} placeholder={searchPlaceholder} value={query} onChange={setQuery} onClear={() => setQuery('')} />
        {creating && createAction ? <div className={styles.createRow}>
          <TextField aria-label={createAction.placeholder ?? '新しい名前'} placeholder={createAction.placeholder ?? '名前'} value={newName} invalid={Boolean(createError)} autoFocus disabled={changeDisabled || Boolean(confirmLockedReason)}
            onChange={(event) => { if (canConfirmNow()) setNewName(event.target.value) }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void runCreate() } }} />
          <Button busy={createBusy} disabled={createBusy || !newName.trim() || changeDisabled} lockedReason={confirmLockedReason} onClick={() => void runCreate()}>作る</Button>
          <Button disabled={createBusy} onClick={() => { setCreating(false); setNewName(''); setCreateError('') }}>やめる</Button>
        </div> : null}
        {createError ? <p className={styles.tpError} role="alert">{createError}</p> : null}
      </>} />
  </EntityPickerDialog>
}

/** 欄の1行だけ（窓は呼ぶ側が開く）。一括配信の送るアカウントのように窓を自前で持つ画面が使う。 */
export function EntityPickerSummary({ label, noun, icon: Icon, name, color, meta, placeholder, disabled = false, disabledReason, lockedReason, readOnly = false, invalid = false, id, buttonRef, describedBy, 'aria-describedby': ariaDescribedBy, onOpen, onClear, selection, ariaLabel, valuePrefix, prefixedValue, compact = false, actionHidden = false }: {
  label: string; noun: string; icon?: LucideIcon
  name?: string; meta?: string; placeholder?: string
  color?: string | null
  disabled?: boolean; readOnly?: boolean; invalid?: boolean; id?: string
  disabledReason?: string
  lockedReason?: string
  buttonRef?: Ref<HTMLButtonElement>
  describedBy?: string
  'aria-describedby'?: string
  onOpen: () => void
  onClear?: () => void
  selection?: ReactNode
  ariaLabel?: string
  valuePrefix?: string
  /** 「見出し：値」を分けて描く（絞り込みの既定は灰・選んだら太字）。 */
  prefixedValue?: { head: string; value: string; filterState?: 'default' | 'active' }
  compact?: boolean
  /** 互換用の指定。閉じた欄の右の印は共通の位置へ統一する。 */
  actionHidden?: boolean | 'label'
}) {
  const field = useFieldContext()
  const lock = usePermissionLockTip<HTMLButtonElement>(readOnly ? undefined : lockedReason, joinDescribedBy(describedBy, ariaDescribedBy, field?.describedBy))
  const clearLock = usePermissionLockTip<HTMLButtonElement>(lockedReason)
  const setButtonRef = (element: HTMLButtonElement | null) => {
    lock.ref.current = element
    if (typeof buttonRef === 'function') return buttonRef(element)
    if (buttonRef) buttonRef.current = element
  }
  const empty = !name
  const actionLabel = readOnly ? '見る' : empty ? '選ぶ' : '変える'
  const isInvalid = invalid || Boolean(field?.invalid)
  return <div className={`${styles.field} ${choiceStyles.frame}`} data-choice-field data-choice-surface="select" data-choice-active={prefixedValue?.filterState === 'active' || undefined} data-choice-invalid={isInvalid || undefined} data-choice-disabled={disabled || Boolean(lockedReason && !readOnly) || undefined} data-entity-picker-field data-value-prefix={valuePrefix ? '' : undefined} data-filter-active={prefixedValue?.filterState === 'active' || undefined} data-empty={empty || undefined} data-invalid={isInvalid || undefined} data-disabled={disabled || Boolean(lockedReason && !readOnly) || undefined} data-multiple={selection ? '' : undefined}>
    {readOnly && empty ? null : <button type="button" data-choice-trigger className={styles.fieldTrigger} ref={lockedReason ? setButtonRef : buttonRef} id={id ?? field?.controlId}
      disabled={disabled} title={disabled && !lockedReason ? disabledReason : undefined} aria-label={ariaLabel ?? `${label}：${actionLabel}`} aria-haspopup="dialog"
      aria-invalid={isInvalid || undefined} aria-describedby={joinDescribedBy(describedBy, ariaDescribedBy, field?.describedBy)} onClick={onOpen} {...lock.handlers} />}
    {Icon ? <Icon className={styles.fieldIcon} size={16} aria-hidden="true" /> : null}
    {selection ? <span data-choice-selection className={styles.fieldChips}>{selection}</span> :
    <span className={styles.fieldValue}>
      {empty ? <span className={styles.fieldPlaceholder} title={placeholder ?? `${noun}を選ぶ`}>{placeholder ?? `${noun}を選ぶ`}</span> : <>
        <>{valuePrefix ? <span data-choice-value className={styles.fieldName} title={name}>{prefixedValue ? <SelectValueText {...prefixedValue} /> : name}</span> : <span data-choice-value className={styles.fieldName} title={name} aria-label={`選択中の${noun}：${name}`}>{name}</span>}</>
        {meta ? <small className={styles.fieldMeta} title={meta}>{meta}</small> : null}
      </>}
    </span>}
    {onClear && !empty && !readOnly ? <button type="button" className={styles.fieldClear} disabled={disabled} title={disabled && !lockedReason ? disabledReason : undefined} aria-label={`${label}を外す`} onClick={onClear} ref={clearLock.ref} {...clearLock.handlers}>外す</button> : null}
    {readOnly && empty ? null : <ChevronDown data-choice-chevron aria-hidden="true" size={16} />}
    {lock.node}{clearLock.node}
  </div>
}

/** 選んでいるものの名前と補足（欄の1行に出す文）。 */
export function describePicked(items: EntityPickerItem[], folders: EntityPickerFolder[], value: string | string[] | null | undefined, unit = '件', summarize?: (items: EntityPickerItem[]) => string, noun?: string, candidatesStatus?: 'loading' | 'ready' | 'error') {
  if (Array.isArray(value)) {
    if (!value.length) return { name: '', meta: '', missing: false }
    const chosen = items.filter((item) => value.includes(item.id))
    return { name: `${value.length}${unit === '件' ? '件' : ` ${unit}`}`, meta: summarize ? summarize(chosen) : chosen.map((item) => item.name).join('・'), missing: false }
  }
  if (!value) return { name: '', meta: '', missing: false }
  if (candidatesStatus === 'loading') return { name: '読み込み中…', meta: '', missing: false }
  if (candidatesStatus === 'error') return { name: `${noun ?? '候補'}を読み込めませんでした`, meta: '', missing: false }
  const item = items.find((candidate) => candidate.id === value)
  if (!item) {
    if (candidatesStatus === 'ready') return { name: noun ? `${noun}は今は選べません` : '選べなくなっています', meta: '選び直してください。', missing: true }
    return items.length ? { name: '現在は選べません', meta: '選び直してください。', missing: true } : { name: '読み込み中…', meta: '', missing: false }
  }
  const folder = item.folderId ? folders.find((entry) => entry.id === item.folderId) : null
  return { name: item.name, meta: item.folderId === null ? 'フォルダ：未分類' : folder ? `フォルダ：${folder.name}` : item.meta ?? '', missing: false }
}

/** 画面の欄。「選んだもの（印・名前・補足）＋［選ぶ］／［変える］」の1行。押すと窓が開く。 */
export function EntityPickerField(props: SingleField | MultiField) {
  const { label, noun, icon, items, folders = [], foldersFailed, onOpen, state, placeholder, disabled = false, disabledReason, lockedReason, readOnly = false, invalid = false, createHref, createLabel, description, id, buttonRef, describedBy } = props
  const canChangeNow = usePickerChangeAccess({ canChangeNow: props.canChangeNow, disabled, lockedReason })
  const changeDisabled = props.canChangeNow ? !lockedReason && (disabled || (!readOnly && props.canChangeNow() === false)) : disabled
  const [open, setOpen] = useState(props.defaultOpen ??false)
  const title = props.title ?? `${noun}を選ぶ`
  const picked = describePicked(items, folders, props.value, props.multiple ? props.unit : undefined, props.multiple ? props.summarize : undefined, props.multiple ? undefined : noun, props.candidatesStatus)
  const pickedColor = props.multiple ? undefined : items.find(item => item.id === props.value)?.color
  const allItem = props.valuePrefix && !props.multiple ? items.find((item) => isAllOption({ value: item.id, label: item.name })) : undefined
  const prefixedValue = props.valuePrefix && !props.multiple && picked.name
    ? { head: props.valuePrefix, value: picked.name, filterState: allItem ? (props.value === allItem.id ? 'default' as const : 'active' as const) : undefined }
    : undefined
  const currentLock = useRef(lockedReason)
  currentLock.current = lockedReason
  useEffect(() => { if (lockedReason && !readOnly && !props.canChangeNow) setOpen(false) }, [lockedReason, readOnly, props.canChangeNow])
  const close = () => { setOpen(false); props.onClose?.() }
  const pills = props.multiple && props.value.length ? props.value.map((value) => {
        const item = items.find((candidate) => candidate.id === value)
        const folder = item ? folderOf(item, folders) : null
        const missingName = props.candidatesStatus === 'loading' ? '読み込み中…'
          : props.candidatesStatus === 'error' ? `${noun}を読み込めませんでした`
          : props.candidatesStatus === 'ready' ? `${noun}は今は選べません` : '現在は選べません'
        const name = item?.name ?? missingName
        return <TagPill key={value} name={name} color={folder ? folderDisplayColor(folder) : null} lockedReason={lockedReason}
          onRemove={readOnly || (!props.canChangeNow && disabled && !lockedReason) || item?.locked ? undefined : () => { if (!currentLock.current && canChangeNow()) props.onChange(props.value.filter((id) => id !== value)) }} />
      }) : undefined
  const selection = props.canChangeNow && changeDisabled && pills ? <fieldset disabled className="contents">{pills}</fieldset> : pills
  return <>
    <EntityPickerSummary label={label} noun={noun} icon={icon} name={picked.name ? (props.valuePrefix ? `${filterHead(props.valuePrefix)}${picked.name}` : picked.name) : picked.name} color={pickedColor} meta={picked.meta} placeholder={placeholder} disabled={changeDisabled} disabledReason={disabledReason} lockedReason={lockedReason} readOnly={readOnly}
      ariaLabel={props.ariaLabel} valuePrefix={props.valuePrefix} prefixedValue={prefixedValue} compact={props.compact} actionHidden={props.actionHidden}
      selection={selection}
      invalid={invalid || picked.missing} id={id} buttonRef={buttonRef} describedBy={joinDescribedBy(describedBy, props['aria-describedby'])} onOpen={() => { if (!readOnly && (currentLock.current || !canChangeNow())) return; onOpen?.(); setOpen(true) }}
      onClear={!props.multiple && props.clearable ? () => { if (!currentLock.current && canChangeNow()) props.onChange('') } : undefined} />
    {open ? props.multiple
      ? <EntityMultiPickerDialog title={title} description={description} items={items} folders={folders} foldersFailed={foldersFailed} initialIds={props.value} unit={props.unit} state={state} listFooter={props.listFooter} readOnly={readOnly}
        query={props.query} onQueryChange={props.onQueryChange} maxSelected={props.maxSelected}
        createHref={createHref} createLabel={createLabel} createAction={props.headerCreate ? { ...props.headerCreate, onCreate: (name) => {
          if (currentLock.current || !canChangeNow()) return Promise.reject(new Error(currentLock.current || '権限が変わったため中止しました。'))
          const pending = props.headerCreate!.onCreate(name)
          return props.canChangeNow ? pending.then(item => canChangeNow() ? item : null) : pending
        } } : undefined} note={props.note} allowEmpty={props.allowEmpty} rowExtra={props.rowExtra} searchPlaceholder={props.searchPlaceholder}
        canChangeNow={props.canChangeNow ? canChangeNow : undefined} confirmDisabled={props.canChangeNow ? changeDisabled : undefined} confirmLockedReason={props.canChangeNow ? lockedReason : undefined}
        onCancel={close} onConfirm={(ids) => { if (currentLock.current || !canChangeNow()) return; props.onChange(ids); close() }} />
      : <EntityPickerDialog title={title} description={description} items={items} folders={folders} foldersFailed={foldersFailed} categories={props.categories} initialId={props.value ?? ''} state={state} listFooter={props.listFooter}
        query={props.query} onQueryChange={props.onQueryChange}
        createAction={props.createAction ? { ...props.createAction, onCreate: (query) => {
          if (currentLock.current || !canChangeNow()) return
          const pending = props.createAction?.onCreate(query)
          if (props.canChangeNow) return Promise.resolve(pending).then(() => { if (canChangeNow()) close() })
          close()
        } } : undefined}
        canChangeNow={props.canChangeNow ? canChangeNow : undefined} confirmLockedReason={props.canChangeNow ? lockedReason : undefined}
        preview={props.preview} readOnly={readOnly} createHref={createHref} createLabel={createLabel} confirmLabel={props.confirmLabel} onSelect={props.onSelect ? (item) => { if (props.canChangeNow || !currentLock.current || readOnly) props.onSelect?.(item) } : undefined} confirmDisabled={props.confirmDisabled || (props.canChangeNow ? changeDisabled : false)}
        searchPlaceholder={props.searchPlaceholder} designNode="dJZ7Q" onCancel={close} onConfirm={(value) => { if (currentLock.current || !canChangeNow()) return; props.onChange(value); close() }} />
      : null}
  </>
}
