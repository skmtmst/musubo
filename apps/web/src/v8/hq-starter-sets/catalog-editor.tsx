'use client'
import { useCallback, useEffect, useState } from 'react'
import { STARTER_CATALOG_KINDS, type AccountStyle, type StarterCatalogOption, type StarterCatalogSelection } from '@line-crm/shared'
import Button from '@/components/shared/button'
import CategoryPanel from '@/components/shared/category-panel'
import ConfirmDialog from '@/components/shared/confirm-dialog'
import { EntityPickerField } from '@/components/shared/entity-picker'
import { GridTable, GridHeadRow, GridRow, GridCell } from '@/components/shared/grid-table'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import StatusBadge from '@/components/shared/status-badge'
import { ToggleField } from '@/components/shared/toggle'
import { Tabs } from '@/components/shared/tabs'
import { notifySaved } from '@/components/shared/toast'
import { SettingsPage } from '@/components/templates/settings-page'
import { PageContent } from '@/components/templates/page-frame'
import { describeApiFailure } from '@/components/shared/api-error-message'
import { hqStyleApi, type StyleStarterSet } from '@/lib/api/helpers/styles'
import { useTenantWideAccess, useStaffRole } from '@/lib/staff-role'
import { usePageTitle } from '@/components/shell/page-chrome'
import { STYLE_CHOICES, styleLabel } from '@/v8/onboarding/public/model/index'
import { hqTemplateTabsForStarterSets } from '@/v8/hq-templates/public/store-list/index'
import { FormLeaveGuard } from '@/components/shared/form-leave-guard'
import { SaveErrorField, SaveErrorScope, useSaveFormErrors } from '@/components/shared/save-form-errors'
import { LegacyDetails } from './legacy-details'
import { removeLegacyItem } from './legacy-removal'
import { CatalogDetails } from './catalog-details'
import { DistributionDialog } from './distribution-dialog'
import { useDistribute } from './use-distribute'
import styles from './catalog-editor.module.css'

type SwitchTarget = AccountStyle | 'save' | null
export default function CatalogStarterSets() {
  usePageTitle('スタイルの初期セット')
  const saveErrors = useSaveFormErrors()
  const role = useStaffRole(), canEdit = useTenantWideAccess()
  const lock = role === null ? undefined : !canEdit ? '初期セットを変更できるのは統括の管理者だけです' : undefined
  const [sets, setSets] = useState<StyleStarterSet[] | null>(null)
  const [options, setOptions] = useState<StarterCatalogOption[] | null>(null)
  const [active, setActive] = useState<AccountStyle>('restaurant')
  const [selected, setSelected] = useState<StarterCatalogSelection[]>([])
  const [auto, setAuto] = useState(true), [dirty, setDirty] = useState(false)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [confirm, setConfirm] = useState<SwitchTarget>(null), [viewLegacy, setViewLegacy] = useState(false)
  const [viewSelection,setViewSelection]=useState<StarterCatalogSelection|null>(null)
  const [legacyDefinition,setLegacyDefinition]=useState<import('@/lib/api/helpers/styles').StarterSetItem[]|null>(null)
  const current = sets?.find(row => row.style === active)
  const catalogMode = current?.definition.mode === 'catalog'
  const load = useCallback(async () => {
    const [nextSets, nextOptions] = await Promise.all([hqStyleApi.listStarterSets(), hqStyleApi.catalog()])
    if(!nextSets.success||!nextOptions.success)throw new Error('catalog_load_failed')
    setSets(nextSets.data); setOptions(nextOptions.data)
    return nextSets.data
  }, [])
  const populate = (list: StyleStarterSet[], style: AccountStyle) => {
    const row = list.find(item => item.style === style)
    setSelected(row?.definition.mode === 'catalog' ? row.definition.selections ?? [] : [])
    setAuto(row?.autoInsert ?? true); setDirty(false); setError(''); saveErrors.reset()
  }
  useEffect(() => { let valid = true; void load().then(list => { if (valid) populate(list, 'restaurant') }).catch(caught => { if (valid) setError(describeApiFailure(caught, '読み込み', {scope:'hq'})) }); return () => { valid = false } }, [load])
  const share=useDistribute(active,current?.version??null,()=>void load())
  const switchStyle = (style: AccountStyle) => {
    if (style === active || busy || share.busy) return
    if (dirty) { setConfirm(style); return }
    setActive(style); populate(sets ?? [], style)
  }
  const requestSave=async()=>{
    if(!canEdit||busy)return
    if(!catalogMode){try{setLegacyDefinition(current?.definition.items??(await hqStyleApi.defaultStarterSet(active)).data.definition.items);setConfirm('save')}catch(err){saveErrors.capture(err);setError(describeApiFailure(err,'読み込み',{scope:'hq'}))}}
    else if(selected.length===0)setConfirm('save');else void save()
  }
  const save = async () => {
    if (!canEdit || busy || !sets || !options) return
    setBusy(true); setError(''); saveErrors.reset()
    try {
      const saved=await hqStyleApi.saveStarterSet(active, { expectedVersion: current?.version ?? 0, name: styleLabel(active), autoInsert: auto,
        definition: { mode: 'catalog', items: [], selections: selected }, confirmed: true })
      if(!saved.success)throw new Error('catalog_save_failed')
      populate(await load(), active); setConfirm(null); notifySaved('初期セットを保存しました')
    } catch (caught) { saveErrors.capture(caught); setError(describeApiFailure(caught, '保存', {scope:'hq'})) }
    finally { setBusy(false) }
  }
  const rows = STYLE_CHOICES.map(row => ({id:row.value,label:styleLabel(row.value),count:sets?.find(set=>set.style===row.value)?.accountCount ?? null}))
  const viewCurrent=async()=>{setViewLegacy(true);setLegacyDefinition(null);try{setLegacyDefinition(current?.definition.items??(await hqStyleApi.defaultStarterSet(active)).data.definition.items)}catch(err){setError(describeApiFailure(err,'読み込み',{scope:'hq'}))}}
  const loaded = sets !== null && options !== null
  return <SaveErrorScope errors={saveErrors}><SettingsPage title="スタイルの初期セット" heightMode="content" contentLayout="wide" readOnly={role!==null && !canEdit ? 'hq' : undefined}
    help="スタイルごとに、統括のカタログから最初に入れる物を選びます。保存だけでは既存のアカウントには配りません。"
    tabs={<Tabs size="compact" label="テンプレートの種類" items={hqTemplateTabsForStarterSets()} />}
    navigation={<CategoryPanel heading="スタイル" showHeading rows={rows} activeId={active} onSelect={id=>switchStyle(id as AccountStyle)} />}
    saveActions={<><Button disabled={busy || !dirty} onClick={()=>populate(sets ?? [],active)}>キャンセル</Button>
      <Button variant="primary" lockedReason={lock} disabled={busy || !loaded || (!dirty && catalogMode) || role===null} busy={busy} busyLabel="保存しています…"
        onClick={()=>void requestSave()}>変更を保存</Button></>}>
    <PageContent>
      <div className={styles.compactNav}><EntityPickerField label="スタイルを切り替える" noun="スタイル" items={rows.map(row=>({id:row.id,name:row.label}))} value={active} onChange={id=>switchStyle(id as AccountStyle)} disabled={busy||share.busy}/></div>
      {error ? <Notice tone="danger" action={!loaded ? <Button onClick={()=>void load().then(list=>populate(list,active)).catch(caught=>setError(describeApiFailure(caught,'読み込み',{scope:'hq'})))}>もう一度試す</Button> : undefined}>{error}</Notice> : null}
      {!loaded ? error ? null : <ListState kind="loading" /> : <>
        <div className={styles.head}><h2 className={styles.title}>{styleLabel(active)}の初期セット</h2>
          <StatusBadge tone="neutral">{catalogMode ? 'カタログから選択' : '従来の初期セット'}</StatusBadge>
          <Button lockedReason={lock} disabled={busy || dirty || !current || role===null} disabledReason={canEdit && dirty ? '変更を保存してから配ってください。' : undefined} onClick={()=>share.setDraft({target:'style',accounts:[],editedAction:'notify'})}>使っているアカウントへ配る</Button>
          {!catalogMode ? <Button onClick={()=>void viewCurrent()}>現在の中身を見る</Button> : null}</div>
        <SaveErrorField names={['autoInsert']}><ToggleField checked={auto} disabled={busy || role===null} lockedReason={lock} onChange={value=>{setAuto(value);setDirty(true)}}
          description="新しいアカウントでこのスタイルを選んだときに入ります。">新しいアカウントへ自動で入れる</ToggleField></SaveErrorField>
        <GridTable label="最初に入れる物" design={{columns:'minmax(170px, 1fr) minmax(0, 1.7fr)',gap:'var(--space-16)',rowPadding:'var(--space-8) var(--space-16)',rowHeight:'auto',fontSize:'var(--text-body)'}}>
          <GridHeadRow><GridCell role="columnheader">種類</GridCell><GridCell role="columnheader">統括のカタログから選ぶ</GridCell></GridHeadRow>
          {STARTER_CATALOG_KINDS.map(spec => {
            const choices = options.filter(option=>option.kind===spec.kind)
            const values = selected.filter(row=>row.kind===spec.kind).map(row=>row.versionId)
            const items = choices.map(option=>({id:option.versionId,name:spec.multiple?`${option.name}（版${option.version}）`:option.name,meta:spec.multiple?undefined:`版${option.version}`}))
            for (const id of values) if (!items.some(item=>item.id===id)) items.push({id,name:'選択済みの見本を読み込めません',meta:'選び直してください'})
            const update = (ids:string[]) => {
              if(!canEdit || busy)return
              const next = ids.map(id=>choices.find(option=>option.versionId===id)).filter((option):option is StarterCatalogOption=>Boolean(option))
              setSelected(old=>[...old.filter(row=>row.kind!==spec.kind),...Array.from(new Map(next.map(row=>[row.templateId,row])).values()).map(({kind,templateId,versionId})=>({kind,templateId,versionId}))]);setDirty(true)
            }
            const fieldNames=selected.flatMap((row,index)=>row.kind===spec.kind?['kind','templateId','versionId'].map(key=>`definition.selections.${index}.${key}`):[])
            const picker=<EntityPickerField label={`${spec.label}を選ぶ`} title={`統括の${spec.label}を選ぶ`} noun={spec.label}
                placeholder={choices.length ? '未設定' : 'まだありません'} items={items} disabled={busy || role===null} lockedReason={lock} canChangeNow={()=>canEdit&&!busy}
                state={choices.length ? undefined : <ListState kind="empty" title="まだありません" description="統括のカタログに登録されると、ここから選べます。" emptyPreset="readonly" />}
                {...(spec.multiple ? {multiple:true as const,value:values,onChange:update,allowEmpty:true} : {value:values[0] ?? null,onChange:(id:string)=>update(id?[id]:[]),clearable:true})} />
            return <GridRow key={spec.kind}><GridCell><span className={styles.name} title={spec.label}>{spec.label}</span></GridCell><GridCell>
              <div className={styles.selection}>{fieldNames.length?<SaveErrorField names={fieldNames}>{picker}</SaveErrorField>:picker}
              {selected.filter(row=>row.kind===spec.kind).map(row=>{
                const option=choices.find(item=>item.versionId===row.versionId)
                const label=option?`${option.name}（版${option.version}）`:'選択済みの見本'
                return <div key={row.versionId} className={styles.preview}><span className={styles.name} title={label}>{label}</span><Button size="compact" aria-label={`${label}の中身を見る`} onClick={()=>setViewSelection(row)}>中身を見る</Button></div>
              })}</div>
            </GridCell></GridRow>
          })}
        </GridTable>
        {!catalogMode ? <Notice tone="info">保存すると、これから作るアカウントは選んだ物だけを使います。今のお店の内容は変わりません。</Notice> : null}
      </>}
    </PageContent>
    {viewLegacy?<LegacyDetails items={legacyDefinition} busy={busy} error={error} lockedReason={lock} canRemove={Boolean(current)} onClose={()=>setViewLegacy(false)} onRemove={async key=>{
      if(!canEdit||!current||!legacyDefinition)return
      setBusy(true);setError('');saveErrors.reset()
      try{await hqStyleApi.saveStarterSet(active,{expectedVersion:current.version,name:current.name,autoInsert:current.autoInsert,definition:{items:removeLegacyItem(legacyDefinition,key)}});await load();setViewLegacy(false)}
      catch(err){saveErrors.capture(err);setError(describeApiFailure(err,'保存',{scope:'hq'}));throw err}finally{setBusy(false)}
    }}/>:null}
    <FormLeaveGuard dirty={dirty} busy={busy}/>
    <DistributionDialog share={share} lockedReason={lock}/>
    {viewSelection?<CatalogDetails selection={viewSelection} onClose={()=>setViewSelection(null)}/>:null}
    <ConfirmDialog open={confirm!==null} title={confirm==='save' ? '初期セットを保存しますか？' : '入力を破棄しますか？'}
      description={confirm==='save' ? selected.length===0 ? '何も入れない組として保存します。既存のお店の内容は変わりません。' : '従来の初期セットを、選んだカタログの組へ切り替えます。以前の組は履歴に残り、既存のお店の内容は変わりません。' : '保存していない選択があります。別のスタイルへ移ると、この変更は残りません。'}
      primaryAction={confirm==='save'?'confirm':'cancel'}
      confirmLabel={confirm==='save' ? '保存する' : '破棄して移る'} busy={busy} error={error || undefined}
      onCancel={()=>setConfirm(null)} onConfirm={()=>{if(confirm==='save')return save();else if(confirm){setActive(confirm);populate(sets ?? [],confirm);setConfirm(null)}}}>
      {confirm==='save' && !catalogMode && legacyDefinition?.length ? <ul>{legacyDefinition.map(item=><li key={item.key}>{item.name}</li>)}</ul> : null}
    </ConfirmDialog>
  </SettingsPage></SaveErrorScope>
}
