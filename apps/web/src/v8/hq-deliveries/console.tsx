'use client'

import HqMessageBody from '@/components/shared/hq-message-inserts'
import { replaceHqAutoReplyActions } from './auto-reply-actions-model'
import HqAutoReplyEditor from './auto-reply-editor'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useListNavigationRouter as useRouter } from '@/components/shared/list-navigation'
import { usePageTitle } from '@/components/shell/page-chrome'
import { ListPage, CreatePage } from '@/components/templates'
import { DistributionPage } from '@/components/templates/distribution-page'
import KpiBand from '@/components/shared/kpi-band'
import KpiCard from '@/components/shared/kpi-card'
import FolderPanel from '@/components/shared/folder-panel'
import SearchField from '@/components/shared/search-field'
import ResourceTable from '@/components/shared/resource-table'
import { RowMenu } from '@/components/shared/row-actions'
import { DistributionTable, DistributionProgress, DistributionAccountName, DistributionToolbar } from '@/components/shared/distribution-table'
import Checkbox from '@/components/shared/checkbox'
import { Tabs } from '@/components/shared/tabs'
import { Plus, Send } from 'lucide-react'
import type { HqTemplateFolder } from '@line-crm/shared'
import { useDistributionFolders, accountsInFolder, distributionFolderRows } from '@/v8/hq-templates/public/distribution-accounts/index'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import Button from '@/components/shared/button'
import PermissionGatedButton from '@/components/shared/permission-gated-button'
import Notice from '@/components/shared/notice'
import EmptyList from '@/components/shared/empty-list'
import Select from '@/components/shared/select'
import { OptionalBadge, RequiredBadge } from '@/components/shared/form-controls'
import { TextField } from '@/components/shared/text-field'
import { hqTemplatesApi } from '@/lib/hq-templates-api'
import { hqDeliveriesApi, type HqDeliveryTemplate, type HqDeliveryTemplateDetail } from '@/lib/api/helpers/hq-deliveries'
import { canManageRole, useStaffRole } from '@/lib/staff-role'
import type { HqDeliveryTemplateType } from '@line-crm/shared'
import styles from './console.module.css'

const TYPES: Array<{ id: HqDeliveryTemplateType; label: string }> = [
  { id: 'auto_reply', label: '自動応答' },
  { id: 'friend_add_rule', label: '友だち追加時の配信' },
  { id: 'reminder', label: 'リマインダ' },
]
const titleOf = (type: HqDeliveryTemplateType) => TYPES.find((item) => item.id === type)?.label ?? '配信設定'
const initialSettings = (type: HqDeliveryTemplateType) => type === 'auto_reply'
  ? { name: '', keyword: '', matchType: 'contains', responseType: 'text', responseContent: '', templateId: null, activeFrom: null, activeUntil: null, cooldownMinutes: null, skipWhenOperatorActive: false, priority: 0, messageKinds: null, receiveSources: ['line'], friendConditions: null, actions: null, responseWeekdays: null, responseHolidayRule: null, oncePerFriend: false, keywords: null, respondToAll: false, keywordMatchMode: 'any', normalizeKeywords: true, internalMemo: null, replyDelaySeconds: null, unmatchedAction: null }
  : type === 'friend_add_rule'
    ? { name: '', friendKind: 'first_time', priority: 0, definition: { routeIds: [], scenarioId: null, messageType: 'text', messageText: '', timing: 'immediate', friendCondition: '', actions: [], activeFrom: null, activeUntil: null, returningMode: 'none', startPosition: 'beginning', deliveryChoices: { sendWelcomeMessage: true, startScenario: false, runActions: false }, resendSuppressionHours: null, unknownRouteAction: { sendCommonGuidance: false, notifyStaff: false } } }
    : { name: '', description: '', lineAccountId: '', triggerType: 'event', deliveryMode: 'time', triggerOffsetMinutes: null, sendAtTime: null, stopConditions: {}, steps: [] }

export default function HqDeliveryConsole({ type }: { type: HqDeliveryTemplateType }) {
  const router = useRouter()
  const saveErrors = useSaveFormErrors()
  const savedSnapshot = useRef('')
  const staffRole = useStaffRole()
  const canEdit = staffRole !== null && canManageRole(staffRole)
  const [query, setQuery] = useState('')
  const [accountFolder, setAccountFolder] = useState('all')
  const [folderFilter, setFolderFilter] = useState('all')
  const [folders, setFolders] = useState<HqTemplateFolder[]>([])
  const [accountsReady, setAccountsReady] = useState(false)
  const [rowsReady, setRowsReady] = useState(false)
  const [foldersFailed, setFoldersFailed] = useState(false)
  const [accountsFailed, setAccountsFailed] = useState(false)
  const [rows, setRows] = useState<HqDeliveryTemplate[]>([])
  const [selected, setSelected] = useState<HqDeliveryTemplateDetail | null>(null)
  const [view, setView] = useState<'list' | 'edit' | 'accounts' | 'preflight' | 'result'>('list')
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }>>([])
  const [selectedAccounts, setSelectedAccounts] = useState<string[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [preflight, setPreflight] = useState<Awaited<ReturnType<typeof hqDeliveriesApi.preflight>> | null>(null)
  const [distributionResult, setDistributionResult] = useState<Awaited<ReturnType<typeof hqDeliveriesApi.distribute>> | null>(null)
  const accountFolders = useDistributionFolders(view==='accounts' || view==='preflight' || view==='result')
  const dirty = view === 'edit' && JSON.stringify(selected) !== savedSnapshot.current
  const guard = useUnsavedGuard({ dirty, busy, onDiscard: () => setSelected(null) })
  /* 作る・直す画面のパンくずは画面の題の種類名（絵 「自動応答」）。一覧は今までどおり「〜を配る」。 */
  usePageTitle(view === 'edit' ? titleOf(type) : `${titleOf(type)}を配る`)

  const load = useCallback(async () => {
    setLoading(true); setRowsReady(false); setError('')
    try { setRows(await hqDeliveriesApi.list(type)); setRowsReady(true) }
    catch { setError('ひな形を読み込めませんでした。もう一度お試しください。') }
    finally { setLoading(false) }
  }, [type])
  useEffect(() => { void load(); void hqTemplatesApi.accounts().then((data) => { setAccounts(data); setAccountsFailed(false); setAccountsReady(true) }).catch(() => { setAccounts([]); setAccountsFailed(true); setAccountsReady(false) }); void hqTemplatesApi.folders.list().then((data)=>{setFolders(data);setFoldersFailed(false)}).catch(() => {setFolders([]);setFoldersFailed(true)}) }, [load])

  const edit = async (row: HqDeliveryTemplate) => {
    setError(''); setNotice(''); setBusy(true)
    try { const loaded = await hqDeliveriesApi.detail(row.id); savedSnapshot.current = JSON.stringify(loaded); saveErrors.reset(); setSelected(loaded); setPreflight(null); setSelectedAccounts([]); setAccountFolder('all'); setQuery(''); setView('edit'); return true }
    catch { setError('ひな形を開けませんでした。一覧を読み直してください。'); return false }
    finally { setBusy(false) }
  }
  const create = () => {
    const settings = initialSettings(type)
    const created: HqDeliveryTemplateDetail = { template: { id: '', name: '', description: null, template_type: type, revision: 0, distributed_account_names: [], distributed_account_more: 0, distributed_account_count: 0, content_summary: '' }, definition: { schemaVersion: 1, settings, references: [] } }
    savedSnapshot.current = JSON.stringify(created); setSelected(created); saveErrors.reset(); setAccountFolder('all'); setQuery(''); setPreflight(null); setSelectedAccounts([]); setError(''); setNotice(''); setView('edit')
  }
  const settings = selected?.definition.settings as Record<string, unknown> | undefined
  const updateSetting = (key: string, value: unknown) => {
    if (!selected) return
    setSelected({ ...selected, definition: { ...selected.definition, settings: { ...selected.definition.settings, [key]: value } } })
  }
  /* 必須・任意の札。ほかの作る画面と同じく、題の右に置く。 */
  const req = (label: string, required: boolean) => <span className={styles.fieldLabel}>{label}{canEdit ? (required ? <RequiredBadge /> : <OptionalBadge />) : null}</span>
  const OPTIONAL_KEYS = new Set(['description'])
  const field = (key: string, label: string, multiline = false) => {
    const nested = type === 'friend_add_rule' && key === 'messageText'
    const value = String(nested ? (settings?.definition as Record<string, unknown>)?.[key] ?? '' : settings?.[key] ?? '')
    const change = (text: string) => nested ? updateSetting('definition', { ...(settings?.definition as object), [key]: text }) : updateSetting(key, text)
    return <label className={styles.field} key={key}>{req(label, !OPTIONAL_KEYS.has(key))}<SaveErrorField names={[key, `definition.settings.${nested ? 'definition.' : ''}${key}`]}>{multiline
      ? <HqMessageBody value={value} label={label} onChange={change} readOnly={!canEdit} disabled={busy}/>
      : canEdit ? <TextField value={value} onChange={(event) => change(event.target.value)} /> : <span>{String(value)}</span>}</SaveErrorField></label>
  }
  const save = async () => {
    if (!canEdit || !selected || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      const input = { name: selected.template.name.trim(), description: selected.template.description ?? undefined, definition: selected.definition }
      const result = selected.template.id
        ? await hqDeliveriesApi.update(selected.template.id, { ...input, expectedRevision: selected.template.revision })
        : await hqDeliveriesApi.create({ ...input, type, folderId: null, requestId: crypto.randomUUID() } as never)
      savedSnapshot.current = JSON.stringify(result); guard.disarm(); setSelected(result); setNotice('下書きを保存しました。配布先を選べます。'); setPreflight(null); setView('accounts'); await load()
    } catch (cause) { if (!saveErrors.capture(cause)) setError('保存できませんでした。内容を確認してもう一度お試しください。') }
    finally { setBusy(false) }
  }
  const prepare = async () => {
    if (!canEdit || !selected?.template.id || selectedAccounts.length === 0 || busy) return
    setBusy(true); setError('')
    try {
      const result = await hqDeliveriesApi.preflight(selected.template.id, selectedAccounts)
      setPreflight(result)
      const defaults: Record<string, string> = {}
      result.stores.forEach((store) => store.items.forEach((item) => { if (item.allowedModes.length === 1) defaults[`${store.accountId}:${item.sourceId}`] = item.allowedModes[0] }))
      setChoices(defaults)
      setView('preflight')
    } catch { setError('配る前の確認ができませんでした。選んだアカウントを確認してください。') }
    finally { setBusy(false) }
  }
  const distribute = async () => {
    if (!canEdit || !selected?.template.id || !preflight || busy) return
    const resolutions = preflight.stores.flatMap((store) => store.items.map((item) => ({ accountId: store.accountId, sourceId: item.sourceId, mode: choices[`${store.accountId}:${item.sourceId}`] as 'create' | 'overwrite' | 'alias' })).filter((item) => item.mode))
    if (resolutions.length !== preflight.stores.reduce((count, store) => count + store.items.length, 0)) { setError('各アカウントの配り方を選んでください。'); return }
    setBusy(true); setError('')
    try {
      const result = await hqDeliveriesApi.distribute(selected.template.id, preflight.preflightId, resolutions)
      setDistributionResult(result)
      setNotice(result.status === 'completed' ? '配布が完了しました。店には下書きとして届きました。' : result.status === 'running' ? '配布を受け付けました。状態を確認しています。' : '配布を完了できないアカウントがあります。結果を確認してください。')
      setPreflight(null); setView('result'); await load()
    } catch { setError('配布結果を確認できませんでした。配布履歴から状態を確認してください。') }
    finally { setBusy(false) }
  }

  const back = () => guard.guarded(() => { setSelected(null); setPreflight(null); setNotice(''); setView('list') })
  const notices = <><ConfirmDialog open={guard.leaveTarget !== null} title="入力を破棄しますか？" description="保存していないひな形の変更があります。" primaryAction="cancel" cancelLabel="編集を続ける" confirmLabel="保存せずに移る" busy={busy} onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} />{foldersFailed && <Notice tone="warn">フォルダを読み込めませんでした。ページを再読み込みしてください。</Notice>}{!canEdit && <Notice tone="info">閲覧のみで見ています。変更や配布は統括の管理者に頼んでください。</Notice>}{error && <Notice tone="warn">{error}</Notice>}{notice && <Notice tone="success">{notice}</Notice>}{accountsFailed && <Notice tone="warn">配布先を読み込めませんでした。ページを再読み込みしてください。</Notice>}</>
  const stats = <KpiBand>
    <KpiCard title="ひな形" value={!rowsReady ? null : rows.length} unit="件" detail={titleOf(type)} />
    <KpiCard title="配布先" value={!accountsReady ? null : accounts.length} unit="アカウント" detail="配ることのできるアカウント" />
    <KpiCard title="選んだアカウント" value={selectedAccounts.length} unit="アカウント" detail="この内容を配る先" />
    <KpiCard title="配ったひな形" value={!rowsReady ? null : rows.filter(row => (row.distributed_account_count ?? 0) > 0).length} unit="件" detail="1つ以上のアカウントへ配った" />
  </KpiBand>
  const folderRows = [
    {id:'all', label:'すべて', count:loading ? null : rows.length},
    ...folders.map(folder=>({id:folder.id,label:folder.name,color:folder.color,count:loading ? null : rows.filter(row=>row.folder_id===folder.id).length})),
    {id:'none',label:'未分類',count:loading ? null : rows.filter(row=>!row.folder_id).length},
  ]
  if (view === 'list') {
    const shown = rows.filter(row => (folderFilter === 'all' || (row.folder_id ?? 'none') === folderFilter) && `${row.name} ${row.content_summary ?? ''}`.includes(query.trim()))
    return <SaveErrorScope errors={saveErrors}><ListPage boardId="LRc93" title={`${titleOf(type)}を配る`} help="設定のひな形を保存して各アカウントへ下書きとして配ります。" stats={stats}
      tabs={<Tabs label="配る設定の種類" items={[{id:'template',label:'メッセージなど',onClick:()=>router.push('/hq/templates')},...TYPES.map(item=>({id:item.id,label:item.label,current:item.id===type,onClick:()=>router.push(`/hq/templates?type=${item.id}`)}))]} />}
      folders={<><PermissionGatedButton allowed={canEdit} variant="primary" className="v8-folder-create w-full" disabled={busy} onClick={create}><Plus size={16} />ひな形を作る</PermissionGatedButton><FolderPanel rows={folderRows} activeId={folderFilter} onSelect={setFolderFilter} /></>}
      folderNav={{rows:folderRows,activeId:folderFilter,onSelect:setFolderFilter,createAction:canEdit ? <Button variant="primary" onClick={create}>ひな形を作る</Button> : undefined}}
      toolbar={<SearchField aria-label="ひな形を検索" placeholder="ひな形を探す" value={query} onChange={setQuery} />}>
      {notices}
      {loading ? <p role="status">読み込み中…</p> : shown.length ? <ResourceTable updatedLabel="版" canEdit={canEdit} rows={shown.map(row=>({id:row.id,name:<Button variant="text" textTone="ink" onClick={()=>void edit(row)}>{row.name}</Button>,summary:row.content_summary || titleOf(type),folder:folders.find(folder=>folder.id===row.folder_id),references:null,updated:`版 ${row.revision}`,destinations:row.distributed_account_count == null ? '—' : row.distributed_account_count ? `${row.distributed_account_count} アカウント` : 'まだ配っていない',actions:<RowMenu label={`「${row.name}」の操作`} items={[{id:'distribute',label:'アカウントへ配る',icon:<Send size={16} aria-hidden="true" />,emphasis:true,disabled:busy || accountsFailed,onSelect:()=>{void (async()=>{if (await edit(row)) setView('accounts')})()}}]} />}))} /> : <EmptyList icon={<Send aria-hidden="true" />} title={`まだ${titleOf(type)}のひな形がありません`} description="ひな形を保存すると、各アカウントへ下書きとして配れます。" create={{ label: 'ひな形を作る', onClick: create }} canCreate={canEdit} filtered={rows.length > 0} onClearFilters={() => { setQuery(''); setFolderFilter('all') }} />}
    </ListPage></SaveErrorScope>
  }
  /* 自動応答は店と同じ手順の段で作る。ほかの種類は今の1枚の画面。 */
  if (view === 'edit' && selected && type === 'auto_reply') return <SaveErrorScope errors={saveErrors}><HqAutoReplyEditor
    title={`${titleOf(type)}のひな形を${selected.template.id ? '編集する' : '作る'}`} help="保存した設定は、配布先で下書きとして受け取れます。" notice={notices}
    canEdit={canEdit} busy={busy} name={selected.template.name} description={selected.template.description ?? ''} settings={settings} references={selected.definition.references}
    onName={(value) => setSelected({ ...selected, template: { ...selected.template, name: value } })}
    onDescription={(value) => setSelected({ ...selected, template: { ...selected.template, description: value } })}
    onActions={(actions, resources) => { if (canEdit && !busy) setSelected(previous => previous ? { ...previous, definition: replaceHqAutoReplyActions(previous.definition, actions, resources) } : previous) }}
    onSetting={updateSetting} onCancel={back} onSave={() => void save()} /></SaveErrorScope>
  if (view === 'edit' && selected) return <SaveErrorScope errors={saveErrors}><CreatePage dirty={false} busy={busy} boardId="X4JcOf" title={`${titleOf(type)}のひな形を${selected.template.id ? '編集する' : '作る'}`} help="保存した設定は、配布先で下書きとして受け取れます。" notice={notices}
    footerActions={<><Button disabled={busy} onClick={back}>キャンセル</Button><PermissionGatedButton allowed={canEdit} variant="primary" disabled={busy || !selected.template.name.trim()} title={!selected.template.name.trim() ? '統括での名前を入力してください。' : undefined} onClick={()=>void save()} busy={busy} busyLabel="保存中…">下書きを保存する</PermissionGatedButton></>}>
      <div className={styles.fields}>
        <label className={styles.field}>{req('統括での名前', true)}<SaveErrorField names={["name"]}>{canEdit ? <TextField value={selected.template.name} onChange={(event) => setSelected({ ...selected, template: { ...selected.template, name: event.target.value } })} /> : <span>{String(selected.template.name)}</span>}</SaveErrorField></label>
        <label className={styles.field}>{req('説明', false)}<SaveErrorField names={["description"]}>{canEdit ? <TextField value={selected.template.description ?? ''} onChange={(event) => setSelected({ ...selected, template: { ...selected.template, description: event.target.value } })} /> : <span>{String(selected.template.description ?? '')}</span>}</SaveErrorField></label>
        {field('name', '店に届く名前')}
        {type === 'auto_reply' && <>{field('keyword', 'キーワード')}
          <label className={styles.field}>{req('一致方法', true)}{canEdit ? <Select aria-label="一致方法" value={String(settings?.matchType ?? 'contains')} options={[{ value: 'contains', label: '含む' }, { value: 'exact', label: '完全一致' }]} onChange={(value) => updateSetting('matchType', value)} /> : <span>{settings?.matchType === 'exact' ? '完全一致' : '含む'}</span>}</label>
          {field('responseContent', '返信内容', true)}</>}
        {type === 'friend_add_rule' && <>
          <label className={styles.field}><span>対象</span>{canEdit ? <Select aria-label="対象" value={String(settings?.friendKind ?? 'first_time')} options={[{ value: 'first_time', label: '初めての友だち' }, { value: 'returning', label: '再び追加した友だち' }]} onChange={(value) => updateSetting('friendKind', value)} /> : <span>{settings?.friendKind === 'returning' ? '再び追加した友だち' : '初めての友だち'}</span>}</label>
          {field('messageText', '最初に送る内容', true)}
        </>}
        {type === 'reminder' && <>{field('description', '説明')}
          <label className={styles.field}><span>配信方式</span>{canEdit ? <Select aria-label="配信方式" value={String(settings?.deliveryMode ?? 'time')} options={[{ value: 'time', label: '日時で送る' }, { value: 'countdown', label: '予定日から数えて送る' }]} onChange={(value) => updateSetting('deliveryMode', value)} /> : <span>{settings?.deliveryMode === 'countdown' ? '予定日から数えて送る' : '日時で送る'}</span>}</label>
          {field('sendAtTime', '送る時刻')}
          {(Array.isArray(settings?.steps)?settings.steps:[]).map((raw,index)=>{const step=raw as Record<string,unknown>;return <HqMessageBody key={String(step.stableStepId??index)} label={`${index+1}通目の本文`} value={String(step.messageContent??'')} readOnly={!canEdit} disabled={busy} onChange={messageContent=>updateSetting('steps',(settings?.steps as unknown[]).map((entry,i)=>i===index?{...step,messageContent}:entry))}/>})}
          <PermissionGatedButton allowed={canEdit} disabled={busy} onClick={()=>updateSetting('steps',[...(Array.isArray(settings?.steps)?settings.steps:[]),{stableStepId:crypto.randomUUID(),messageType:'text',messageContent:'',offsetMinutes:-60,offsetDays:null,sendAtTime:null}])}>通知を足す</PermissionGatedButton></>}
      </div>
  </CreatePage></SaveErrorScope>
  const shownAccounts = accountsInFolder(accounts, accountFolder, accountFolders.membership).filter(account=>account.name.includes(query.trim()))
  const targets = view === 'result' ? distributionResult?.stores.map(store=>store.accountId) ?? selectedAccounts : selectedAccounts
  const accountFolderRows = distributionFolderRows({accounts, folders:accountFolders.folders, membership:accountFolders.membership, selected:selectedAccounts, onChange:setSelectedAccounts, disabled:busy || view!=='accounts'})
  return <SaveErrorScope errors={saveErrors}><DistributionPage boardId="meBRB" title={`アカウントへ配る：${selected?.template.name ?? ''}`} help="配った設定は下書きで届きます。公開や送信は各店で確認します。" stats={stats} notices={notices}
    toolbar={<DistributionToolbar><SearchField aria-label="アカウントを検索" placeholder="アカウント名で探す" value={query} onChange={setQuery} /><Select aria-label="アカウントのフォルダ" value={accountFolder} onChange={setAccountFolder} options={accountFolderRows.map(row=>({value:row.id,label:row.label}))} />{accountFolderRows.find(row=>row.id===accountFolder)?.leading}{accountFolders.failed && <Notice tone="warn">アカウントのフォルダを読み込めませんでした。</Notice>}</DistributionToolbar>}
    actions={<><Button disabled={busy} onClick={view==='preflight' ? ()=>setView('accounts') : back}>{view==='preflight' ? 'アカウントを選び直す' : 'キャンセル'}</Button>{canEdit && view!=='result' && <Button variant="primary" disabled={busy || accountsFailed || !targets.length} onClick={()=>void (view==='accounts' ? prepare() : distribute())}>{view==='accounts' ? `選んだ${targets.length}アカウントを確かめる` : '選んだ内容で配る'}</Button>}{view==='result' && <Button variant="primary" onClick={back}>完了する</Button>}</>}>
    <div className={styles.distribution}>
      <DistributionTable selectAll={canEdit ? <Checkbox aria-label="表示中のアカウントをすべて選ぶ" checked={shownAccounts.length>0 && shownAccounts.every(account=>targets.includes(account.id))} indeterminate={shownAccounts.some(account=>targets.includes(account.id)) && !shownAccounts.every(account=>targets.includes(account.id))} disabled={busy || view!=='accounts'} onCheckedChange={checked=>setSelectedAccounts(old=>checked ? [...new Set([...old,...shownAccounts.map(account=>account.id)])] : old.filter(id=>!shownAccounts.some(account=>account.id===id)))} /> : null}>
        {shownAccounts.map(account=>{
          const chosen=targets.includes(account.id)
          const store=preflight?.stores.find(store=>store.accountId===account.id)
          return <tr key={account.id} data-selected={chosen || undefined}>
            <td>{canEdit ? <Checkbox id={`delivery-${account.id}`} aria-label={account.name} checked={chosen} disabled={busy || view!=='accounts'} onCheckedChange={checked=>setSelectedAccounts(old=>checked ? [...new Set([...old,account.id])] : old.filter(id=>id!==account.id))} /> : null}</td>
            <td><DistributionAccountName name={account.name} note={chosen ? '配る' : '配らない'} htmlFor={`delivery-${account.id}`} folder={accountFolders.membership?.get(account.id)?.folder} /></td>
            <td>{chosen ? selected?.template.content_summary || titleOf(type) : '—'}</td>
            <td>{chosen ? store?.items[0]?.expectedRevision ? `版 ${store.items[0].expectedRevision}` : store ? '未配布' : '確認前' : '—'}</td>
            <td>{!chosen ? '—' : view==='result' ? distributionResult?.stores.find(store=>store.accountId===account.id)?.status === 'succeeded' ? '配布済み' : '確認が必要' : store ? store.items.map(item=>canEdit ? <Select key={item.sourceId} aria-label={`${account.name}：${item.name}の配り方`} disabled={busy} value={choices[`${account.id}:${item.sourceId}`] ?? ''} options={[{value:'',label:'選んでください'},...item.allowedModes.map(mode=>({value:mode,label:mode==='create' ? '新しく作る' : mode==='overwrite' ? '下書きを上書きする' : '別名で作る'}))]} onChange={value=>setChoices(old=>({...old,[`${account.id}:${item.sourceId}`]:value}))} /> : <span key={item.sourceId}>{String(choices[`${account.id}:${item.sourceId}`] ?? '')}</span>) : '確認のあとで選ぶ'}</td>
          </tr>
        })}
      </DistributionTable>
      {distributionResult && view==='result' && <DistributionProgress finished={distributionResult.stores.filter(store=>store.status==='succeeded').length} total={distributionResult.stores.length}>
        <p>{distributionResult.stores.map(store=>`${store.accountName ?? accounts.find(account=>account.id===store.accountId)?.name ?? 'アカウント'}：${store.status==='succeeded' ? '完了' : store.reason ?? '確認中'}`).join('・')}</p>
      </DistributionProgress>}
    </div>
  </DistributionPage></SaveErrorScope>
}
