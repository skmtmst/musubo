'use client'
import { useEffect, useRef, useState, useCallback, type Ref } from 'react'
import { ChevronRight, Plus, Tag as TagIcon } from 'lucide-react'
import { folderDisplayColor } from './folder-dot'
import { api } from '@/lib/api'
import { useTapActionAccount } from './use-tap-action-sources'
import Button from './button'
import Checkbox from './checkbox'
import SearchField from './search-field'
import { TextField } from './text-field'
import { FolderDot } from './folder-dot'
import TagPill from './tag-pill'
import FolderPickerShell from './folder-picker-shell'
import styles from './tag-picker-field.module.css'
import { formatNumber } from '@/lib/format'
import { usePermissionLockTip } from './permission-lock-tip'

type TagChangeAccess = { disabled?: boolean; lockedReason?: string; canChangeNow?: () => boolean }
/** 古い操作と現在の操作の両方を確認し、拒否した操作を後から復活させない。 */
function useTagChangeAccess(access: TagChangeAccess, enabled: boolean) {
  const captured = { ...access, enabled }
  const latest = useRef(captured)
  latest.current = captured
  const permits = (value: typeof captured) => !value.enabled || (!value.disabled && !value.lockedReason && value.canChangeNow?.() !== false)
  return () => permits(captured) && permits(latest.current)
}

export type TagPickerOption = { id: string; name: string; groupId?: string | null; isStarred?: boolean; lineAccountId?: string | null }
/** 案A：欄全体が押せる。窓を開いても、選ぶまで保存値は変えない。 */
export default function TagPickerField({ label = 'タグを付ける', value, onChange, options, accountId, readOnly = false, disabled = false, disabledReason, invalid = false, multiple = true, id: fieldId, buttonRef, describedBy, lockedReason, canChangeNow: suppliedCanChange, createDisabled, createLockedReason, canCreateNow }: {
  label?: string; value: string[]; onChange: (ids: string[]) => void; options?: readonly TagPickerOption[]
  accountId?: string | null; readOnly?: boolean; disabled?: boolean; invalid?: boolean; multiple?: boolean; id?: string; buttonRef?: Ref<HTMLButtonElement>; describedBy?: string
  disabledReason?: string
  lockedReason?: string
  /** 選ぶ値を変える直前の判定。読む GET と検索は止めない。 */
  canChangeNow?: () => boolean
  /** タグを作る権限は、既存のタグを選ぶ権限とは別に渡す。 */
  createDisabled?: boolean
  createLockedReason?: string
  canCreateNow?: () => boolean
}) {
  const permissionProvided = lockedReason !== undefined || suppliedCanChange !== undefined || createDisabled !== undefined || createLockedReason !== undefined || canCreateNow !== undefined
  const canChangeNow = useTagChangeAccess({ disabled, lockedReason, canChangeNow: suppliedCanChange }, permissionProvided)
  const changeDisabled = permissionProvided ? !lockedReason && (disabled || suppliedCanChange?.() === false) : disabled
  const lock = usePermissionLockTip<HTMLButtonElement>(lockedReason, describedBy)
  const account = useTapActionAccount()
  const id = accountId === undefined ? account?.selectedAccountId ?? null : accountId
  const [items, setItems] = useState<TagPickerOption[]>(() => [...(options ?? [])])
  const [folders, setFolders] = useState<Array<{ id: string; name: string; color?: string | null; accountId?: string | null }>>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(options ? 'ready' : 'loading')
  const [folderFailed, setFolderFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const request = useRef(0)
  const hasProvidedOptions = options !== undefined
  const hasSelection = value.length > 0
  const createdItems = useRef<TagPickerOption[]>([])
  useEffect(() => { if (options) setItems([...options, ...createdItems.current.filter(item => !options.some(option => option.id === item.id))]) }, [options])
  useEffect(() => { request.current += 1; createdItems.current = []; if (!hasProvidedOptions) { setItems([]); setStatus('loading') } setFolders([]); setOpen(false); return () => { request.current += 1 } }, [id, hasProvidedOptions])
  const load = useCallback(async () => {
    const current = ++request.current
    setStatus('loading')
    setFolderFailed(false)
    await Promise.allSettled([
      Promise.resolve().then(() => api.tags.list({ accountId: id })).then(res => {
        if (current !== request.current) return
        if (res.success) { setItems(res.data.filter(tag => (tag.status ?? 'active') === 'active')); setStatus('ready') } else setStatus('error')
      }, () => { if (current === request.current) setStatus('error') }),
      Promise.resolve().then(() => api.tagGroups.list(id ?? undefined)).then(res => {
        if (current !== request.current) return
        if (res.success) setFolders(res.data); else setFolderFailed(true)
      }, () => { if (current === request.current) setFolderFailed(true) }),
    ])
  }, [id])
  useEffect(() => { if (hasSelection && !hasProvidedOptions) void load() }, [id, hasSelection, hasProvidedOptions, load])
  const names = value.map(key => items.find(item => item.id === key)?.name ?? '選択済みのタグ')
  const selection = <span className={styles.selection}>{value.length ? value.map((key, index) => {
    const item = items.find(tag => tag.id === key)
    const folder = folders.find(group => group.id === item?.groupId)
    return <TagPill size="xs" key={key} name={names[index]} color={folder ? folderDisplayColor(folder) : null} />
  }) : <span className={styles.placeholder}>タグを選ぶ</span>}</span>
  return <>
    {readOnly ? <div className={styles.field}>{selection}</div> : <button data-input-field id={fieldId} ref={lockedReason ? node => { lock.ref.current = node; if (typeof buttonRef === 'function') buttonRef(node); else if (buttonRef) buttonRef.current = node } : buttonRef} aria-describedby={describedBy} type="button" className={styles.field} aria-label={`${label}：${value.length ? '変更する' : '選択する'}`} aria-haspopup="dialog" aria-invalid={invalid || undefined} disabled={changeDisabled} title={changeDisabled ? disabledReason : undefined} onClick={() => { if (!canChangeNow()) return; setOpen(true); void load() }} {...lock.handlers}>
      <TagIcon size={16} aria-hidden="true" />{selection}<span className={styles.change}>{value.length ? '変更する' : '選択する'}</span><ChevronRight size={16} aria-hidden="true" />
    </button>}
    {lock.node}
    {open ? <TagPickerDialog key={id ?? "hq"} multiple={multiple} disabled={permissionProvided ? changeDisabled : undefined} lockedReason={lockedReason} canChangeNow={permissionProvided ? canChangeNow : undefined} createDisabled={createDisabled} createLockedReason={createLockedReason} canCreateNow={canCreateNow} items={items} folders={folders} folderFailed={folderFailed} status={status} initialIds={value} accountId={id} onCreated={tag => { if (!canChangeNow()) return; createdItems.current.push(tag); setItems(current => [...current.filter(item => item.id !== tag.id), tag]) }} onCancel={() => setOpen(false)} onConfirm={ids => { if (!canChangeNow()) return; onChange(ids); setOpen(false) }} onRetry={() => void load()} /> : null}
  </>
}
function TagPickerDialog({ multiple, items, folders, folderFailed, status, initialIds, accountId, onCreated, onConfirm, onCancel, onRetry, disabled, lockedReason, canChangeNow, createDisabled, createLockedReason, canCreateNow }: {
  multiple: boolean; items: TagPickerOption[]; folders: Array<{ id: string; name: string; color?: string | null; accountId?: string | null }>
  folderFailed: boolean; status: 'loading' | 'ready' | 'error'; initialIds: string[]; accountId: string | null
  disabled?: boolean; lockedReason?: string; canChangeNow?: () => boolean
  createDisabled?: boolean; createLockedReason?: string; canCreateNow?: () => boolean
  onCreated: (tag: TagPickerOption) => void; onConfirm: (ids: string[]) => void; onCancel: () => void; onRetry: () => void
}) {
  const permissionProvided = canChangeNow !== undefined || createDisabled !== undefined || createLockedReason !== undefined || canCreateNow !== undefined
  const canSelect = useTagChangeAccess({ disabled, lockedReason, canChangeNow }, permissionProvided)
  const creationReason = lockedReason || createLockedReason
  const canCreate = useTagChangeAccess({ disabled: disabled || createDisabled, lockedReason: creationReason, canChangeNow: () => canSelect() && canCreateNow?.() !== false }, permissionProvided)
  const selectionDisabled = !lockedReason && (disabled || canChangeNow?.() === false)
  const creationDisabled = !creationReason && (disabled || createDisabled || canChangeNow?.() === false || canCreateNow?.() === false)
  const creatingRef = useRef(false)
  const [selected, setSelected] = useState(initialIds)
  const [query, setQuery] = useState('')
  const [folder, setFolder] = useState('all')
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const rows = [
    { id: 'frequent', kind: 'folder' as const, label: 'よく使う', count: items.filter(item => item.isStarred).length },
    { id: 'all', kind: 'all' as const, label: 'すべて', count: status === 'ready' ? items.length : null },
    ...folders.map(group => ({ id: group.id, kind: 'folder' as const, label: group.name, color: group.color, count: items.filter(item => item.groupId === group.id).length })),
    { id: 'none', kind: 'unfiled' as const, label: '未分類', count: status === 'ready' ? items.filter(item => !item.groupId).length : null },
  ]
  const shown = items.filter(item => (folder === 'all' || (folder === 'frequent' ? item.isStarred : folder === 'none' ? !item.groupId : item.groupId === folder)) && item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()))
  const create = async () => {
    if (!name.trim() || busy || (permissionProvided && creatingRef.current) || !canCreate()) return
    // 統括は店のタグを複製して配る。所属なしのタグを新しく作らない。
    const sourceIds = [...new Set(items.flatMap(item => item.lineAccountId ? [item.lineAccountId] : []))]
    const sourceAccountId = accountId ?? folders.find(group => group.id === folder)?.accountId ?? (sourceIds.length === 1 ? sourceIds[0] : null)
    if (!sourceAccountId) { setError('タグを作る店舗を決めるため、左の店舗のフォルダを選んでください。'); return }
    if (permissionProvided) creatingRef.current = true
    setBusy(true); setError('')
    try {
      const res = await api.tags.create({ name: name.trim(), groupId: ['all', 'frequent', 'none'].includes(folder) ? null : folder, lineAccountId: sourceAccountId })
      if (!mounted.current || !canCreate()) return
      if (!res.success) { setError('タグを作れませんでした。名前とフォルダを確認してください。'); return }
      onCreated(res.data); setSelected(current => multiple ? [...new Set([...current, res.data.id])] : [res.data.id]); setCreating(false); setName('')
    } catch { if (mounted.current && canCreate()) setError('タグを作れませんでした。もう一度お試しください。') }
    finally { creatingRef.current = false; if (mounted.current) setBusy(false) }
  }
  return <FolderPickerShell busy={busy} title="タグを選ぶ" onClose={() => { if (!busy) onCancel() }} rows={rows} activeId={folder} onFolder={setFolder}
    search={<div className={styles.searchRow}><SearchField ref={inputRef} aria-label="タグ名で探す" placeholder="タグ名で探す" value={query} onChange={setQuery} onClear={() => setQuery('')} />{!creating && status === 'ready' ? <Button variant="text" disabled={creationDisabled} lockedReason={creationReason} onClick={() => { if (canCreate()) setCreating(true) }}><Plus size={16} />その場でタグを作る</Button> : null}</div>}
    sideNote={folderFailed ? <p className={styles.error}>フォルダを読み込めませんでした</p> : null}
    footer={<><span className={styles.count} aria-live="polite">{formatNumber(selected.length)}件選んでいます</span><Button disabled={busy} onClick={onCancel}>キャンセル</Button><Button variant="primary" disabled={busy || status !== 'ready' || selectionDisabled} lockedReason={lockedReason} onClick={() => { if (canSelect()) onConfirm(selected) }}>選択する（{formatNumber(selected.length)}件）</Button></>}
  >
    {status === 'loading' ? <p>タグを読み込んでいます。</p> : status === 'error' ? <><p role="alert" className={styles.error}>タグを読み込めませんでした。</p><Button onClick={onRetry}>もう一度読み込む</Button></> : <>
      {creating ? <div className={styles.create}><TextField aria-label="新しいタグの名前" placeholder="タグの名前" value={name} disabled={creationDisabled || Boolean(creationReason)} onChange={event => { if (canCreate()) setName(event.target.value) }} invalid={Boolean(error)} /><Button busy={busy} disabled={busy || !name.trim() || creationDisabled} lockedReason={creationReason} onClick={() => void create()}>作る</Button><Button disabled={busy} onClick={() => setCreating(false)}>やめる</Button></div> : null}
      <div className={styles.rows}>{selected.filter(key => !items.some(item => item.id === key)).map(key => <div key={key} className={styles.item} data-permission-locked={lockedReason ? '' : undefined}><Checkbox checked disabled={busy || selectionDisabled} lockedReason={lockedReason} aria-label="見つからないタグを外す" onCheckedChange={() => { if (canSelect()) setSelected(current => current.filter(id => id !== key)) }}>見つからないタグ（選び直してください）</Checkbox></div>)}{shown.map(item => <div key={item.id} className={styles.item} data-selected={selected.includes(item.id) || undefined} data-permission-locked={lockedReason ? '' : undefined}>
        <Checkbox aria-label={item.name} checked={selected.includes(item.id)} disabled={busy || selectionDisabled} lockedReason={lockedReason} onCheckedChange={on => { if (canSelect()) setSelected(current => on ? multiple ? [...new Set([...current, item.id])] : [item.id] : current.filter(key => key !== item.id)) }}><span className={styles.tagName}><FolderDot folder={folders.find(group => group.id === item.groupId) ?? null} /><span title={item.name}>{item.name}</span></span></Checkbox>
      </div>)}{!shown.length ? <p>当てはまるタグがありません。</p> : null}</div>

      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    </>}
  </FolderPickerShell>
}
