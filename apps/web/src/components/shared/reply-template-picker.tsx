'use client'

import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, ChevronLeft, Folder, List, MoreHorizontal, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import { api, type OpsSupportReplyTemplate, type OpsSupportTemplateCatalog } from '@/lib/api'
import { useOverlayFocus, useOverlayLayer } from '@/components/shared/overlay-utils'
import { opsCall } from '@/components/ops/ops-ui'
import Button from '@/components/shared/button'
import { TextArea, TextField } from '@/components/shared/text-field'
import EntitySelect from '@/components/shared/entity-select'
import styles from './reply-template-picker.module.css'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { notifySaved } from '@/components/shared/toast'

type View = 'list' | 'folders' | 'newFolder' | 'newTemplate' | 'editTemplate'

export default function SupportTemplatePicker({ open, onClose, onInsert, writable }: {
  open: boolean
  onClose: () => void
  onInsert: (body: string) => boolean
  writable: boolean
}) {
  const layer = useOverlayLayer(open)
  const [mounted, setMounted] = useState(false)
  const [view, setView] = useState<View>('list')
  const [catalog, setCatalog] = useState<OpsSupportTemplateCatalog | null>(null)
  const [folderId, setFolderId] = useState('contracts')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [folderName, setFolderName] = useState('')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [actionsOpen, setActionsOpen] = useState(false)
  const [editing, setEditing] = useState<OpsSupportReplyTemplate | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<OpsSupportReplyTemplate | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const guard = useUnsavedGuard({ dirty: open && (view === 'newFolder' ? folderName.trim().length > 0 : view === 'newTemplate' ? (title.trim().length > 0 || body.trim().length > 0) : view === 'editTemplate' && editing ? folderId !== editing.folderId || title !== editing.title || body !== editing.body : false), busy, subject: '作りかけのテンプレート' })
  const guardedClose = () => guard.guarded(onClose)
  const ref = useOverlayFocus<HTMLElement>(open, guardedClose)
  const deleteRef = useOverlayFocus<HTMLElement>(Boolean(deleteTarget), () => { if (!busy) setDeleteTarget(null) }, busy)

  useEffect(() => setMounted(true), [])
  useEffect(() => {
    if (!actionsOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); setActionsOpen(false)
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && !target.closest(`.${styles.templateAction}, .${styles.desktopActionMenu}, .${styles.mobileActionSheet}`)) setActionsOpen(false)
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true); document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [actionsOpen])
  useEffect(() => {
    if (!open) return
    let active = true
    setView('list'); setError(''); setQuery(''); setActionsOpen(false); setEditing(null); setDeleteTarget(null)
    void opsCall(api.ops.support.templates()).then((result) => {
      if (!active) return
      if (result.success && result.data && Array.isArray(result.data.folders) && Array.isArray(result.data.templates)) { setCatalog(result.data); setSelectedId(result.data.templates.find((item) => item.folderId === 'contracts')?.id ?? null) }
      else setError(!result.success ? result.error || 'テンプレートを読み込めませんでした' : 'テンプレートを読み込めませんでした')
    })
    return () => { active = false }
  }, [open])

  const filtered = useMemo(() => (catalog?.templates ?? []).filter((item) =>
    (folderId === 'all' || item.folderId === folderId) && (!query.trim() || `${item.title} ${item.body}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  ), [catalog, folderId, query])
  const selected = filtered.find((item) => item.id === selectedId) ?? filtered[0] ?? null
  const activeFolder = catalog?.folders.find((item) => item.id === folderId)

  const chooseFolder = (id: string) => {
    setFolderId(id); setSelectedId(null); setView('list'); setError(''); setActionsOpen(false)
  }
  const createFolder = async () => {
    if (!writable || busy) return
    if (!folderName.trim()) { setError('フォルダ名を入力してください'); return }
    setBusy(true); setError('')
    const result = await opsCall(api.ops.support.createTemplateFolder(folderName.trim()))
    setBusy(false)
    if (!result.success) { setError(result.error || 'フォルダを作成できませんでした'); return }
    setCatalog((current) => current && { ...current, folders: [...current.folders, result.data] })
    setFolderId(result.data.id); setFolderName(''); setSelectedId(null); setView('list')
  }
  const createTemplate = async () => {
    if (!writable || busy) return
    if (!title.trim() || !body.trim()) { setError('テンプレート名と本文を入力してください'); return }
    setBusy(true); setError('')
    const result = await opsCall(api.ops.support.createTemplate({ folderId: folderId === 'all' ? 'contracts' : folderId, title: title.trim(), body: body.trim() }))
    setBusy(false)
    if (!result.success) { setError(result.error || 'テンプレートを保存できませんでした'); return }
    setCatalog((current) => current && { ...current, templates: [result.data, ...current.templates] })
    setFolderId(result.data.folderId); setSelectedId(result.data.id); setTitle(''); setBody(''); setView('list')
  }
  const beginEdit = () => {
    if (!writable || !selected) return
    setEditing(selected); setFolderId(selected.folderId); setTitle(selected.title); setBody(selected.body)
    setError(''); setActionsOpen(false); setView('editTemplate')
  }
  const saveEdit = async () => {
    if (!writable || busy || !editing) return
    if (!title.trim() || !body.trim()) { setError('テンプレート名と本文を入力してください'); return }
    setBusy(true); setError('')
    const result = await opsCall(api.ops.support.updateTemplate(editing.id, { folderId, title: title.trim(), body: body.trim(), expectedUpdatedAt: editing.updatedAt }))
    setBusy(false)
    if (!result.success) { setError(result.error || 'テンプレートを保存できませんでした'); return }
    setCatalog((current) => current && { ...current, templates: current.templates.map((item) => item.id === result.data.id ? result.data : item) })
    setFolderId(result.data.folderId); setSelectedId(result.data.id); setEditing(null); setView('list')
    notifySaved('テンプレートの変更を保存しました')
  }
  const beginDelete = () => {
    if (!writable || !selected) return
    setDeleteTarget(selected); setDeleteError(''); setActionsOpen(false)
  }
  const deleteTemplate = async () => {
    if (!writable || busy || !deleteTarget) return
    setBusy(true); setDeleteError('')
    const result = await opsCall(api.ops.support.deleteTemplate(deleteTarget.id, deleteTarget.updatedAt))
    setBusy(false)
    if (!result.success) { setDeleteError(result.error || 'テンプレートを削除できませんでした'); return }
    setCatalog((current) => current && { ...current, templates: current.templates.filter((item) => item.id !== deleteTarget.id) })
    setSelectedId(null); setDeleteTarget(null)
    notifySaved('テンプレートを削除しました')
  }
  const insert = () => {
    if (!selected || !writable) return
    if (onInsert(selected.body)) onClose()
    else setError('返信が4,000文字を超えます。本文を短くしてから引用してください')
  }

  if (!open) return null
  const back = () => { guard.guarded(() => { setError(''); if (view === 'list') onClose(); else { if (view === 'editTemplate' && editing) { setFolderId(editing.folderId); setSelectedId(editing.id); setEditing(null) } setView('list') } }) }
  const panel = <><div className={styles.overlay} style={{ zIndex: layer }} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) guardedClose() }}>
    <section className={`${styles.panel} ${view === 'newFolder' ? styles.panelNewFolder : view === 'newTemplate' || view === 'editTemplate' ? styles.panelNewTemplate : ''}`} role="dialog" aria-modal="true" aria-label={view === 'folders' ? 'フォルダを選択' : view === 'newFolder' ? 'フォルダ作成' : view === 'newTemplate' ? 'テンプレート作成' : view === 'editTemplate' ? 'テンプレートを編集' : 'テンプレート引用'} ref={ref} tabIndex={-1}>
      <header className={styles.mobileHeader}>
        <button type="button" className={styles.back} onClick={back}><ChevronLeft aria-hidden="true" />{view === 'list' ? '返信に戻る' : 'テンプレート引用'}</button>
      </header>
      <header className={styles.desktopHeader}>
        <div><h2>{view === 'newFolder' ? 'フォルダを作成' : view === 'newTemplate' ? 'テンプレートを作成' : view === 'editTemplate' ? 'テンプレートを編集' : 'テンプレート引用'}</h2>
          {view === 'list' ? <p>フォルダとテンプレートを選び、内容を確認して返信文へ挿入します。</p> : view === 'newFolder' ? <p>初期フォルダに加えて、用途に合わせたフォルダを作成できます。</p> : view === 'newTemplate' ? <p>よく使う応対文を保存します。引用後はチケットごとに編集できます。</p> : view === 'editTemplate' ? <p>保存すると、次回から更新後の文面を引用できます。</p> : null}</div>
        <button type="button" aria-label="閉じる" className={styles.close} onClick={guardedClose}><X aria-hidden="true" /></button>
      </header>
      <div className={styles.content}>
        {view === 'list' ? <>
          <h2 className={styles.mobileTitle}>テンプレート引用</h2>
          <div className={styles.mobileSearch}><Search aria-hidden="true" /><input aria-label="テンプレートを検索" placeholder="テンプレートを検索" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          <div className={styles.desktopPicker}>
            <aside className={styles.desktopFolders} aria-label="フォルダ">
              <strong>フォルダ</strong>
              <button type="button" aria-current={folderId === 'all' ? 'true' : undefined} onClick={() => chooseFolder('all')}>すべて</button>
              {catalog?.folders.map((folder) => <button type="button" key={folder.id} aria-current={folderId === folder.id ? 'true' : undefined} onClick={() => chooseFolder(folder.id)}><Folder aria-hidden="true" />{folder.name}</button>)}
              <Button variant="text" disabled={!writable} onClick={() => setView('newFolder')}><Plus aria-hidden="true" />フォルダを作成</Button>
            </aside>
            <div className={styles.desktopTemplates}>
              <div className={styles.desktopToolbar}><div className={styles.search}><Search aria-hidden="true" /><input aria-label="テンプレートを検索" placeholder="テンプレートを検索" value={query} onChange={(e) => setQuery(e.target.value)} /></div><Button disabled={!writable} onClick={() => setView('newTemplate')}><Plus aria-hidden="true" />テンプレートを作成</Button></div>
              <div className={styles.desktopSplit}><div className={styles.templateColumn}><strong>{activeFolder ? `${activeFolder.name}のテンプレート` : 'テンプレート'}</strong><TemplateList templates={filtered} selectedId={selected?.id} onSelect={(id) => { setSelectedId(id); setActionsOpen(false) }} /></div><Preview title={selected?.title} body={selected?.body} writable={writable} actionsOpen={actionsOpen} onToggleActions={() => setActionsOpen((current) => !current)} onEdit={beginEdit} onDelete={beginDelete} /></div>
              <p className={styles.insertHint}>返信文のカーソル位置に挿入します。既存の文は残り、引用後も編集できます。</p>
            </div>
          </div>
          <div className={styles.mobileFolders}><div className={styles.sectionHead}><strong>フォルダ</strong><button type="button" disabled={!writable} onClick={() => setView('newFolder')}>＋ フォルダ作成</button></div>
            <button type="button" className={styles.folderSelect} onClick={() => setView('folders')}><Folder aria-hidden="true" />{folderId === 'all' ? 'すべて' : activeFolder?.name ?? 'フォルダを選択'}<ChevronDown aria-hidden="true" /></button></div>
          <div className={styles.mobileTemplates}><div className={styles.sectionHead}><strong>テンプレート</strong><button type="button" disabled={!writable} onClick={() => setView('newTemplate')}>＋ 作成</button></div><TemplateList templates={filtered} selectedId={selected?.id} onSelect={(id) => { setSelectedId(id); setActionsOpen(false) }} /><Preview title={selected?.title} body={selected?.body} writable={writable} actionsOpen={actionsOpen} onToggleActions={() => setActionsOpen((current) => !current)} onEdit={beginEdit} onDelete={beginDelete} /></div>
        </> : null}
        {view === 'folders' ? <><h2 className={styles.mobileTitle}>フォルダを選択</h2><div className={styles.folderChoices}>
          {[{ id: 'all', name: 'すべて' }, ...(catalog?.folders ?? [])].map((folder) => <button type="button" key={folder.id} aria-current={folderId === folder.id ? 'true' : undefined} onClick={() => chooseFolder(folder.id)}>{folder.id === 'all' ? <List aria-hidden="true" /> : <Folder aria-hidden="true" />}{folder.name}{folderId === folder.id ? <Check aria-hidden="true" /> : null}</button>)}
        </div></> : null}
        {view === 'newFolder' ? <><h2 className={styles.mobileTitle}>フォルダ作成</h2><label className={styles.field}>フォルダ名 <span>必須</span><TextField value={folderName} onChange={(e) => setFolderName(e.target.value)} placeholder="例：キャンペーン対応" maxLength={60} /></label><p className={styles.hint}>作成後、このフォルダにテンプレートを追加できます。</p></> : null}
        {view === 'newTemplate' || view === 'editTemplate' ? <><h2 className={styles.mobileTitle}>{view === 'editTemplate' ? 'テンプレートを編集' : 'テンプレート作成'}</h2><label className={styles.field}>保存先フォルダ <span>必須</span><EntitySelect size="full" aria-label="保存先フォルダ" value={folderId === 'all' ? 'contracts' : folderId} onChange={setFolderId} options={(catalog?.folders ?? []).map((folder) => ({ value: folder.id, label: folder.name }))} /></label><label className={styles.field}>テンプレート名 <span>必須</span><TextField value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例：解約手続きのご案内" maxLength={120} /></label><label className={styles.field}>本文 <span>必須</span><TextArea value={body} onChange={(e) => setBody(e.target.value)} placeholder={'お問い合わせありがとうございます。\n\nご契約の解約をご希望とのこと、承知しました。\n担当者が内容を確認し、必要な手続きをご案内します。'} maxLength={4000} /></label><p className={styles.hint}><span className={styles.desktopHint}>{view === 'editTemplate' ? '保存すると、次回から更新後の文面を引用できます。' : '送信前に、引用した内容を返信欄で確認・編集してください。'}</span><span className={styles.mobileHint}>{view === 'editTemplate' ? '保存すると、次回の引用から新しい文面になります。' : '引用後の返信欄で編集できます。'}</span></p></> : null}
        {error ? <p role="alert" className={styles.error}>{error}</p> : null}
      </div>
      {view !== 'folders' ? <footer className={styles.footer}>
        <div className={styles.desktopCancel}><Button onClick={back}>キャンセル</Button></div>
        <Button variant="primary" widthReserve="idle" disabled={busy || (view === 'list' ? !selected || !writable : !writable)} busy={busy} onClick={view === 'list' ? insert : view === 'newFolder' ? createFolder : view === 'editTemplate' ? saveEdit : createTemplate}>{view === 'list' ? '返信に引用する' : view === 'newFolder' ? 'フォルダを作成' : view === 'editTemplate' ? '変更を保存する' : 'テンプレートを保存'}</Button>
      </footer> : null}
    </section>
    {view === 'list' && actionsOpen && selected ? <div className={styles.mobileActionBackdrop} onMouseDown={(event) => { if (event.target === event.currentTarget) setActionsOpen(false) }}><section className={styles.mobileActionSheet} role="dialog" aria-modal="true" aria-label={`${selected.title}の操作`}><strong>{selected.title}</strong><button type="button" onClick={beginEdit}><Pencil aria-hidden="true" />編集する</button><button type="button" className={styles.dangerAction} onClick={beginDelete}><Trash2 aria-hidden="true" />削除する</button><button type="button" className={styles.cancelAction} onClick={() => setActionsOpen(false)}>キャンセル</button></section></div> : null}
    {deleteTarget ? <div className={styles.deleteLayer} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDeleteTarget(null) }}><section className={styles.deleteDialog} role="alertdialog" aria-modal="true" aria-label={`「${deleteTarget.title}」を削除しますか？`} ref={deleteRef} tabIndex={-1}><h2>「{deleteTarget.title}」を削除しますか？</h2><p>削除すると一覧から消え、今後引用できなくなります。すでに返信文へ引用した内容は変わりません。</p><div className={styles.deleteSubject}><strong>{deleteTarget.title}</strong><span>{catalog?.folders.find((folder) => folder.id === deleteTarget.folderId)?.name ?? '—'}</span></div>{deleteError ? <p role="alert" className={styles.error}>{deleteError}</p> : null}<div className={styles.deleteFooter}><Button disabled={busy} onClick={() => setDeleteTarget(null)}>キャンセル</Button><Button variant="danger" disabled={busy} busy={busy} onClick={deleteTemplate}>削除する</Button></div></section></div> : null}
  </div><UnsavedLeaveDialog open={guard.leaveTarget !== null} subject="作りかけのテンプレート" onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} busy={busy} /></>
  return mounted ? createPortal(panel, document.body) : panel
}

function TemplateList({ templates, selectedId, onSelect }: { templates: OpsSupportTemplateCatalog['templates']; selectedId?: string; onSelect: (id: string) => void }) {
  if (templates.length === 0) return <p className={styles.empty}>このフォルダにはテンプレートがありません。</p>
  return <div className={styles.templateList}>{templates.map((item) => <button type="button" key={item.id} aria-current={selectedId === item.id ? 'true' : undefined} onClick={() => onSelect(item.id)}><strong>{item.title}</strong><span>{item.body.replace(/\s+/g, ' ').slice(0, 44)}</span></button>)}</div>
}

function Preview({ title, body, writable, actionsOpen, onToggleActions, onEdit, onDelete }: {
  title?: string; body?: string; writable: boolean; actionsOpen: boolean
  onToggleActions: () => void; onEdit: () => void; onDelete: () => void
}) {
  const action = title ? <button type="button" className={styles.templateAction} aria-label={`${title}の操作`} aria-expanded={actionsOpen} aria-haspopup="menu" aria-disabled={!writable} title={writable ? `${title}の操作` : '閲覧のみのため編集・削除できません'} onClick={() => { if (writable) onToggleActions() }}><MoreHorizontal aria-hidden="true" /></button> : null
  return <div className={styles.preview}>
    <div className={styles.mobilePreviewHeading}><strong className={styles.mobilePreviewTitle}>内容を確認</strong>{action}</div>
    <div className={styles.previewCard}>
      <div className={styles.desktopPreviewHeading}><strong className={styles.desktopPreviewTitle}>選択中のテンプレート</strong>{action}</div>
      {actionsOpen && title ? <div className={styles.desktopActionMenu} role="menu" aria-label={`${title}の操作`}><button type="button" role="menuitem" onClick={onEdit}><Pencil aria-hidden="true" />編集する</button><button type="button" role="menuitem" className={styles.dangerAction} onClick={onDelete}><Trash2 aria-hidden="true" />削除する</button></div> : null}
      {title ? <h3>{title}</h3> : null}<p>{body || 'テンプレートを選ぶと本文を確認できます。'}</p>
    </div>
  </div>
}
