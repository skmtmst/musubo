'use client'
import { markNameRequirement } from '@/v8/tags/public/mark-requirement/index'

import { describeApiFailure, permissionDeniedMessage } from '@/components/shared/api-error-message'
import { useTenantWideAccess, useStaffRole } from '@/lib/staff-role'
import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import type { FriendField, Folder, HqFriendAttributeDetail, HqFriendAttributeInput, HqFriendAttributeTemplate, HqFriendAttributeType, HqFriendAttributeListStats, HqTemplateFolder, HqMarkDefinition } from '@line-crm/shared'
import { ClipboardList, List, Flag, History, Loader, Users, CircleDot, Pencil, Plus } from 'lucide-react'
import { hqFriendAttributesApi as api } from '@/lib/hq-friend-attributes-api'
import { hqTemplatesApi } from '@/lib/hq-templates-api'
import { requestUnsavedAction } from '@/lib/unsaved-action'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { usePageCrumbs, usePageTitle } from '@/components/shell/page-chrome'
import { ListPage, CreatePage } from '@/components/templates'
import Card from '@/components/shared/card'
import Button from '@/components/shared/button'
import Notice from '@/components/shared/notice'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import FolderEditorDialog from '@/components/shared/folder-editor-dialog'
import { FOLDER_SELECT_COLORS } from '@line-crm/shared'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import { FieldsTab } from '@/v8/tags/public/fields-tab/index'
import { MarksTab } from '@/v8/tags/public/marks-tab/index'
import { FieldEditor, type FieldEditorValues } from '@/v8/tags/public/field-editor/index'
import { MarkBasicFields } from '@/v8/tags/public/mark-basic-fields/index'
import type { AttributeListHost } from '@/v8/tags/public/attribute-host/index'
import { AttributeTabs, type AttributeTabKey } from './attribute-tabs'
import AttributeDistribution from './attribute-distribution'
import { fieldOf, fieldDefinition, markOf } from './attribute-model'
import listStyles from '@/v8/tags/list.module.css'
import createStyles from '@/v8/tags/create.module.css'
import { folderDisplayColor } from '@/components/shared/folder-dot'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import { PageExplanationProvider, PageExplanationToggle } from '@/components/shared/page-explanation'
import { ToggleField } from '@/components/shared/toggle'

type Attempt = { input: HqFriendAttributeInput; requestId: string; distribute: boolean }
type Entry = { row: HqFriendAttributeTemplate; detail: HqFriendAttributeDetail }
const title = 'タグ'
const description = 'タグ・友だち情報欄・対応マークのひな形を作り、各 LINE アカウントへ配ります。'
const errorText = (cause: unknown) => (cause && typeof cause === 'object' && 'status' in cause && cause.status === 403 ? permissionDeniedMessage('hq') : describeApiFailure(cause, '読み込み', { scope: 'hq' }))

export default function HqAttributes({ type, tab, onTab }: { type: HqFriendAttributeType; tab: 'fields' | 'marks'; onTab: (tab: AttributeTabKey) => void }) {
  const saveErrors = useSaveFormErrors()
  const role = useStaffRole()
  const canEdit = useTenantWideAccess()
  const [entries, setEntries] = useState<Entry[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error' | 'forbidden'>('loading')
  const [folders, setFolders] = useState<HqTemplateFolder[]>([])
  const [foldersFailed, setFoldersFailed] = useState(false)
  const [stats, setStats] = useState<HqFriendAttributeListStats | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [editor, setEditor] = useState<HqFriendAttributeDetail | 'new' | null>(null)
  const [distribution, setDistribution] = useState<{ detail: HqFriendAttributeDetail; saved: boolean } | null>(null)
  const [deleting, setDeleting] = useState<Entry | null>(null)
  const [folderDialog, setFolderDialog] = useState<HqTemplateFolder | 'new' | null>(null)
  const [folderName, setFolderName] = useState('')
  const [folderColor, setFolderColor] = useState<string | null>(FOLDER_SELECT_COLORS[0].value)
  const [folderError, setFolderError] = useState('')
  const depth = useContext(OverlayDepthContext)
  const folderGuard = useUnsavedGuard({
    dirty: folderDialog !== null && (folderName !== (folderDialog === 'new' ? '' : folderDialog.name) || folderColor !== (folderDialog === 'new' ? FOLDER_SELECT_COLORS[0].value : folderDisplayColor(folderDialog)) || busy),
    busy: folderDialog !== null && busy,
    onDiscard: () => setFolderDialog(null),
  })
  const [deletingFolder, setDeletingFolder] = useState<HqTemplateFolder | null>(null)
  const folderDeleteTicket = useRef<object | null>(null)
  const renderedFolderDeleteTicket = folderDeleteTicket.current
  const [uncertain, setUncertain] = useState(false)
  const [restored, setRestored] = useState<Attempt | null>(null)
  const scopeKey = useRef<string | null>(null)
  const attempt = useRef<Attempt | null>(null)
  const saveIntent = useRef(true)
  const lock = useRef(false)
  const alive = useRef(true)
  const sequence = useRef(0)
  usePageTitle(editor ? `${type === 'friend_field' ? '友だち情報欄' : '対応マーク'}のひな形を${editor === 'new' ? '作る' : '編集'}` : title)
  usePageCrumbs(editor || distribution ? [{ label: title, href: `/hq/friend-attributes?tab=${tab}`, onSelect: () => { if (!busy && !uncertain) requestUnsavedAction(() => { setEditor(null); setDistribution(null) }) } }] : [{ label: 'ホーム', href: '/' }])
  const load = useCallback(async () => {
    const request = ++sequence.current
    setStatus('loading')
    try {
      const rows = await api.list(type)
      const loaded = await Promise.all(rows.map(async (row) => ({ row, detail: await api.get(row.id) })))
      if (!alive.current || request !== sequence.current) return
      if (loaded.some((entry) => entry.detail.template.template_type !== type)) throw new Error('ひな形の種類を確認できません')
      loaded.sort((a, b) => {
        const order = (detail: HqFriendAttributeDetail) => 'field' in detail.definition ? detail.definition.field.displayOrder ?? 0 : detail.definition.mark.displayOrder ?? 0
        return order(a.detail) - order(b.detail)
      })
      setEntries(loaded); setStatus('ready')
    } catch (cause) {
      const fieldFailure = saveErrors.capture(cause);
 if (alive.current && request === sequence.current) { setStatus(cause && typeof cause === 'object' && 'status' in cause && cause.status === 403 ? 'forbidden' : 'error'); { if (!fieldFailure) setError(errorText(cause)) } }
  }
  }, [type, saveErrors])
  const loadFolders = useCallback(async () => {
    try { const rows = await api.folders.list(); if (alive.current) { setFolders(rows); setFoldersFailed(false) } }
    catch (saveFailure) {
      saveErrors.capture(saveFailure);
 if (alive.current) setFoldersFailed(true) }
  }, [saveErrors])
  useEffect(() => {
    alive.current = true
    void load(); void loadFolders()
    void api.listStats(type).then((value) => { if (alive.current) setStats(value) }, () => { if (alive.current) setStats(null) })
    void hqTemplatesApi.context().then((scope) => {
      if (!alive.current) return
      const key = `lh_hq_attribute_create:${scope.tenantId}:${scope.actorId}:${type}`
      scopeKey.current = key
      const raw = window.sessionStorage.getItem(key)
      if (raw) {
        const record = JSON.parse(raw) as Attempt
        if (!record.requestId || typeof record.distribute !== 'boolean' || record.input?.type !== type || record.input.definition?.schemaVersion !== 1) throw new Error('前回の作成依頼を確認できません。保存内容を確認してください。')
        attempt.current = record; setRestored(record); setUncertain(true); setEditor('new')
      }
    }).catch((cause) => { scopeKey.current = null; if (alive.current) setError(errorText(cause)) })
    return () => { alive.current = false }
  }, [type, load, loadFolders])
  const perform = async (action: () => Promise<void>) => {
    if (lock.current || !canEdit) return
    lock.current = true; setBusy(true); setError('')
    try { await action() } catch (cause) {
      const fieldFailure = saveErrors.capture(cause);
 if (alive.current) { if (!fieldFailure) setError(errorText(cause)) } }
    finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  const open = (id: string, distribute = false) => void perform(async () => {
    const detail = await api.get(id)
    if (detail.template.template_type !== type) throw new Error('ひな形の種類を確認できません')
    if (!alive.current) return
    if (distribute) setDistribution({ detail, saved: false }); else { setEditor(detail); setRestored(null) }
  })
  const save = (input: HqFriendAttributeInput, distribute: boolean) => perform(async () => {
    if (!scopeKey.current) throw new Error('ログイン中の所属先を確認できません。再読み込みしてください。')
    let detail: HqFriendAttributeDetail
    if (editor && editor !== 'new') detail = await api.update(editor.template.id, { ...input, expectedRevision: editor.template.revision })
    else {
      const currentScope = await hqTemplatesApi.context()
      if (scopeKey.current !== `lh_hq_attribute_create:${currentScope.tenantId}:${currentScope.actorId}:${type}`) throw new Error('ログイン中の所属先が変わりました。元の利用者で開き直してください。')
      const record = attempt.current ?? { input, requestId: crypto.randomUUID(), distribute }
      window.sessionStorage.setItem(scopeKey.current, JSON.stringify(record)); attempt.current = record
      try { detail = await api.create(record.input, record.requestId) }
      catch (cause) {
        saveErrors.capture(cause);

        if (!uncertain && cause && typeof cause === 'object' && 'requestNotApplied' in cause && cause.requestNotApplied === true) { window.sessionStorage.removeItem(scopeKey.current); attempt.current = null }
        else { setUncertain(true); setRestored(record) }
        throw cause
      }
      distribute = record.distribute
      window.sessionStorage.removeItem(scopeKey.current); attempt.current = null; setUncertain(false); setRestored(null)
    }
    if (!alive.current) return
    setEditor(null)
    if (distribute) setDistribution({ detail, saved: true })
    await load(); void api.listStats(type).then((value) => { if (alive.current) setStats(value) }, () => undefined)
  })
  const order = async (ids: string[]) => perform(async () => {
    try {
      for (const [index, id] of ids.entries()) {
        const entry = entries.find((item) => item.row.id === id)
        if (!entry) throw new Error('一覧が変わりました。読み直してください。')
        const definition = entry.detail.definition
        const next: HqFriendAttributeInput = 'field' in definition
          ? { type: 'friend_field', name: entry.row.name, folderId: entry.row.folder_id, description: entry.row.description ?? '', definition: { ...definition, field: { ...definition.field, displayOrder: index } } }
          : { type: 'mark', name: entry.row.name, folderId: entry.row.folder_id, description: entry.row.description ?? '', definition: { ...definition, mark: { ...definition.mark, displayOrder: index } } }
        await api.update(id, { ...next, expectedRevision: entry.row.revision })
      }
    } finally { await load() }
  })
  const saveFolder = async () => {
    if (!folderDialog || !folderName.trim() || busy || lock.current || !canEdit) return
    lock.current = true
    setBusy(true); setFolderError('')
    try {
      if (folderDialog === 'new') await api.folders.create(folderName.trim(), folderColor)
      else await api.folders.update(folderDialog.id, folderName.trim(), folderDialog.revision, folderColor)
      setFolderDialog(null); await loadFolders()
    } catch (cause) {
      const fieldFailure = saveErrors.capture(cause)
 { if (!fieldFailure) setFolderError(errorText(cause)) } }
    finally { lock.current = false; setBusy(false) }
  }

  const folderRows: Folder[] = folders.map((folder, index) => ({ id: folder.id, name: folder.name, kind: 'friend_field', color: folder.color ?? null, parentId: null, displayOrder: index, createdAt: '', updatedAt: '' }))
  const fieldRows = entries.filter((entry): entry is Entry & { detail: Extract<HqFriendAttributeDetail, { template: { template_type: 'friend_field' } }> } => entry.detail.template.template_type === 'friend_field').map((entry) => fieldOf(entry.detail, entry.row.friend_count))
  const markRows = type === 'mark' ? entries.map((entry) => markOf(entry.detail, entry.row.friend_count)) : []
  /* 対応マーク：受信箱の対応状況（友だち人数）と、記録に残ったマーク変更は別の数（API 組5 の stats）。取れなければ「—」。 */
  const markStats = stats as unknown as { supportStatus?: import('@/lib/api/helpers/feature-wait').HqMarkListStats['supportStatus']; markChanges?: import('@/lib/api/helpers/feature-wait').HqMarkListStats['markChanges'] } | null
  const kpis = type === 'friend_field' ? [
    { title: '項目', icon: List, value: status === 'ready' ? stats?.totalTemplates ?? entries.length : null, unit: '件', detail: '使っている —' },
    { title: '入力済みの友だち', icon: Users, value: null, unit: '人', detail: '1つ以上入っている' },
    { title: '回答フォームで集める', icon: ClipboardList, value: null, unit: '件', detail: '回答で自動で入る' },
    { title: '今月の変更', icon: Pencil, value: null, unit: '件', detail: '追加・名前の変更' },
  ] : [
    { title: 'マーク', icon: Flag, value: status === 'ready' ? stats?.totalTemplates ?? entries.length : null, unit: '種類', detail: status !== 'ready' || entries.some((entry) => entry.row.friend_count == null) ? '使っている —' : `使っている ${entries.filter((entry) => (entry.row.friend_count ?? 0) > 0).length}` },
    { title: '未対応', icon: CircleDot, value: markStats?.supportStatus?.unhandledFriendCount ?? null, unit: '人', detail: markStats?.supportStatus ? `受信箱の ${markStats.supportStatus.unhandledPercent == null ? '—' : `${markStats.supportStatus.unhandledPercent.toFixed(1)}%`}` : '受信箱の —' },
    { title: '対応中', icon: Loader, value: markStats?.supportStatus?.inProgressFriendCount ?? null, unit: '人', detail: '担当が付いている' },
    { title: '過去7日の変更', icon: History, value: markStats?.markChanges?.count ?? null, unit: '回', detail: markStats?.markChanges ? '記録に残った分・手動と自動' : '手動・自動' },
  ]
  const band = <KpiBand data-design="KPIs" className={listStyles.kpis}>{kpis.map((kpi) => <KpiCard key={kpi.title} presentation="band" title={kpi.title} icon={<kpi.icon size={16} />} value={kpi.value} unit={kpi.value == null ? '' : kpi.unit} detail={kpi.detail} />)}</KpiBand>
  const hostBase: Omit<AttributeListHost<FriendField>, 'items'> = {
    status, busy, error, reload: () => { void load(); void loadFolders() }, onCreate: () => { if (!busy && canEdit) { setEditor('new'); setRestored(null); setError('') } },
    onEdit: (id) => open(id), onRemove: (id) => setDeleting(entries.find((entry) => entry.row.id === id) ?? null), onDistribute: (id) => open(id, true), onOrder: order, kpis: band,
    folders: folderRows, foldersFailed, onAddFolder: () => { setFolderName(''); setFolderColor(FOLDER_SELECT_COLORS[0].value); setFolderError(''); setFolderDialog('new') },
    onEditFolder: (id) => { const folder = folders.find((row) => row.id === id); if (folder) { setFolderName(folder.name); setFolderColor(folderDisplayColor(folder)); setFolderError(''); setFolderDialog(folder) } },
    onRemoveFolder: (id) => { const folder = folders.find((row) => row.id === id) ?? null; folderDeleteTicket.current = folder ? {} : null; setDeletingFolder(folder) },
  }
  const notices = <>{role !== null && !canEdit ? <ReadOnlyNotice>閲覧のみで見ています。変える操作は管理者に頼んでください。</ReadOnlyNotice> : null}{error ? <Notice tone="danger" message={error} action={editor && editor !== 'new' ? <Button disabled={busy} onClick={() => open(editor.template.id)} busy={Boolean(busy)} busyLabel="処理中…">最新の内容を読み込む</Button> : undefined} /> : null}</>
  if (distribution && !distribution.saved) return <SaveErrorScope errors={saveErrors}><AttributeDistribution key={distribution.detail.template.id} detail={distribution.detail} canEdit={canEdit} onClose={() => { setDistribution(null); void load() }} /></SaveErrorScope>
  if (editor && canEdit) {
    const current = editor === 'new' ? null : editor
    const input = restored?.input
    const editing = current !== null
    const footer = (submit: () => void, cancel: () => void) => <><Button disabled={busy || uncertain} onClick={cancel}>キャンセル</Button><Button disabled={busy || uncertain} onClick={() => { saveIntent.current = false; submit() }}>下書きを保存</Button><Button variant="primary" disabled={busy || !canEdit} busy={busy} onClick={() => { if (uncertain && attempt.current) void save(attempt.current.input, attempt.current.distribute); else { saveIntent.current = true; submit() } }}>{uncertain ? '前回の保存を再確認' : '保存する'}</Button></>
    if (type === 'friend_field') {
      const definition = current && 'field' in current.definition ? current.definition : input && input.type === 'friend_field' ? input.definition : null
      const initial = definition ? fieldOf({ template: current?.template ?? { id: 'new', name: definition.field.name, description: null, template_type: 'friend_field', revision: 0, updated_at: '', folder_id: input?.folderId }, definition } as Extract<HqFriendAttributeDetail, { template: { template_type: 'friend_field' } }>) : null
      return <SaveErrorScope errors={saveErrors}><FieldEditor key={`${current?.template.id ?? 'new'}:${current?.template.revision ?? 'new'}`} host={{ title: editing ? '友だち情報欄のひな形を編集' : '友だち情報欄のひな形を作る', notice: notices, footer }} mode={editing ? 'edit' : 'create'} field={initial} locked={uncertain} folders={folderRows} foldersState={foldersFailed ? 'error' : 'ready'} onRetryFolders={() => void loadFolders()} onCreateFolder={async (name, color) => { const folder = await api.folders.create(name, color); await loadFolders(); return { value: folder.id, label: folder.name, color: folder.color } }} siblings={fieldRows} siblingsReady={status === 'ready'} saving={busy} backHref="/hq/friend-attributes?tab=fields" onCancel={() => setEditor(null)} onSubmit={(values: FieldEditorValues) => {
        const definition = fieldDefinition(values, current && 'field' in current.definition ? current.definition : null, folders, Boolean(current && (current.template.folder_id ?? '') === values.folderId))
        if (!current) definition.field.displayOrder = entries.length
        void save({ type: 'friend_field', name: values.name, description: current?.template.description ?? '', folderId: values.folderId || null, definition }, saveIntent.current)
      }} /></SaveErrorScope>
    }
    const definition = current && 'mark' in current.definition ? current.definition : input?.type === 'mark' ? input.definition : { schemaVersion: 1 as const, mark: { name: '', color: '#EF4B55', displayOrder: entries.length } }
    return <SaveErrorScope errors={saveErrors}> <HqMarkEditor key={`${current?.template.id ?? 'new'}:${current?.template.revision ?? 'new'}`} definition={definition} busy={busy} locked={uncertain} notices={notices} footer={footer} onCancel={() => setEditor(null)} onSave={(definition) => void save({ type: 'mark', name: definition.mark.name, description: current?.template.description ?? '', folderId: current?.template.folder_id ?? null, definition }, saveIntent.current)} /></SaveErrorScope>
  }
  const page = <SaveErrorScope errors={saveErrors}> <ListPage boardId={tab === 'fields' ? 'y0sapC' : 'Qgjmc'} headingSize="regular" title={title} help={description} explanationToggle={<PageExplanationToggle />}
    actions={type === 'mark' && canEdit ? <Button variant="primary" disabled={busy || status !== 'ready'} onClick={hostBase.onCreate}><Plus size={16} aria-hidden="true" />マークを作る</Button> : undefined}
    tabs={<AttributeTabs tab={tab} onSelect={onTab} />} overlays={<>
      {distribution?.saved ? <AttributeDistribution key={distribution.detail.template.id} detail={distribution.detail} canEdit={canEdit} saved onClose={() => { setDistribution(null); void load() }} /> : null}
      <ConfirmDialog open={!!deleting} title="ひな形を削除" deleteName={deleting?.row.name ?? ''} description={`「${deleting?.row.name ?? ''}」を削除します。配布済みのアカウントの情報と履歴は残ります。`} destructive confirmLabel="削除する" busy={busy} error={error || undefined} onCancel={() => { if (!busy) setDeleting(null) }} onConfirm={() => perform(async () => { if (!deleting) return; await api.remove(deleting.row.id, deleting.row.revision); setDeleting(null); await load() })}><OperationTargetSummary accounts={[]} externalTarget={{ label: '統括ひな形', name: deleting?.row.name }} /></ConfirmDialog>
      <OverlayDepthContext.Provider value={depth + 2}><UnsavedLeaveDialog open={folderGuard.leaveTarget !== null} busy={busy} onConfirm={folderGuard.confirmLeave} onCancel={folderGuard.cancelLeave} /></OverlayDepthContext.Provider>
      <FolderEditorDialog open={folderDialog !== null} title={folderDialog === 'new' ? 'フォルダを追加' : 'フォルダを直す'}
        name={folderName} onNameChange={setFolderName} color={folderColor} onColorChange={setFolderColor}
        busy={busy} error={folderError || undefined} confirmLabel={folderDialog === 'new' ? '追加する' : '保存する'}
        onCancel={() => { if (!busy) setFolderDialog(null) }} onConfirm={() => saveFolder()} />
      <ConfirmDialog open={!!deletingFolder} title="フォルダを削除" deleteName={deletingFolder?.name ?? ''} description="中のひな形は未分類に残ります。" destructive confirmLabel="削除する" busy={busy} error={error || undefined} onCancel={() => { if (!busy && !lock.current) { folderDeleteTicket.current = null; setDeletingFolder(null) } }} onConfirm={() => { if (!deletingFolder || !renderedFolderDeleteTicket || renderedFolderDeleteTicket !== folderDeleteTicket.current) return; return perform(async () => { await api.folders.remove(deletingFolder.id, deletingFolder.revision); if (renderedFolderDeleteTicket !== folderDeleteTicket.current) return; folderDeleteTicket.current = null; setDeletingFolder(null); await loadFolders(); await load() }) }}><OperationTargetSummary accounts={[]} externalTarget={{ label: '統括のフォルダ', name: deletingFolder?.name }} /></ConfirmDialog>
    </>}>
    {notices}
    {type === 'friend_field' ? <FieldsTab accountId={null} canEdit={canEdit && !busy} host={{ ...hostBase, items: fieldRows }} explanation /> : <MarksTab accountId={null} canEdit={canEdit && !busy} host={{ ...hostBase, items: markRows }} explanation />}
  </ListPage></SaveErrorScope>
  return <PageExplanationProvider pageKey={type === 'mark' ? 'hq:marks' : 'hq:fields'}>{page}</PageExplanationProvider>
}

function HqMarkEditor({ definition, busy, locked, notices, footer, onCancel, onSave }: { definition: HqMarkDefinition; busy: boolean; locked: boolean; notices: React.ReactNode; footer: (submit: () => void, cancel: () => void) => React.ReactNode; onCancel: () => void; onSave: (definition: HqMarkDefinition) => void }) {
  const [name, setName] = useState(definition.mark.name)
  const [color, setColor] = useState(definition.mark.color ?? '#3B82F6')
  const [isDefault, setIsDefault] = useState(definition.mark.isDefault ?? false)
  const [autoOnInbound, setAutoOnInbound] = useState(definition.mark.autoOnInbound ?? false)
  const [error, setError] = useState('')
  const dirty = name !== definition.mark.name || color !== (definition.mark.color ?? '#3B82F6') || isDefault !== (definition.mark.isDefault ?? false) || autoOnInbound !== (definition.mark.autoOnInbound ?? false)
  const { leaveTarget, confirmLeave, cancelLeave, guarded } = useUnsavedGuard({ dirty, busy: busy || locked })
  const submit = () => {
    if (markNameRequirement.check(name)) { setError('マーク名を入力してください'); requestAnimationFrame(() => { const input = document.querySelector<HTMLElement>('[aria-labelledby="mark-basic"] input'); input?.focus(); input?.scrollIntoView({ block: 'center' }) }); return }
    onSave({ ...definition, mark: { ...definition.mark, name: name.trim(), color, isDefault, autoOnInbound } })
  }
  return <><CreatePage title="対応マークのひな形" notice={notices} footerActions={footer(submit, () => guarded(onCancel))} dirty={false}>
    <MarkBasicFields name={name} color={color} onName={setName} onColor={setColor} disabled={busy || locked} error={error || undefined} />
    <Card variant="form" gap="normal"><h2 className={createStyles.cardTitle}>自動で変えるきまり</h2><SaveErrorField names={["autoOnInbound","auto_on_inbound"]}><ToggleField checked={autoOnInbound} onChange={setAutoOnInbound} disabled={busy || locked}>新しいメッセージが来たらこのマークに変える</ToggleField></SaveErrorField><SaveErrorField names={["isDefault","is_default"]}><ToggleField checked={isDefault} onChange={setIsDefault} disabled={busy || locked}>新しい友だちに最初から付ける</ToggleField></SaveErrorField></Card>
  </CreatePage><UnsavedLeaveDialog open={leaveTarget !== null} subject="マークへの変更" onConfirm={confirmLeave} onCancel={cancelLeave} /></>
}
