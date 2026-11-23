'use client'
import { useCallback,useEffect,useMemo,useRef,useState } from 'react'
import type { RestaurantFollowupTrigger,RestaurantReservationForm } from '@line-crm/shared'
import Card from '@/components/shared/card'
import Button from '@/components/shared/button'
import Toggle from '@/components/shared/toggle'
import StatusBadge from '@/components/shared/status-badge'
import Notice, { NoticeStack } from '@/components/shared/notice'
import Dialog from '@/components/shared/dialog'
import ReadOnlyNotice from '@/components/shared/read-only-notice'
import StickyBar from '@/components/shared/sticky-bar'
import { ListPageCards } from '@/components/templates/list-page'
import { SaveErrorScope,useSaveFormErrors } from '@/components/shared/save-form-errors'
import { readSaveFieldErrors } from '@/lib/api/helpers/field-errors'
import { describeSaveFailure } from '@/lib/api/transport/errors'
import { followupBoardApi,type FollowupBoardSnapshot } from '@/lib/api/helpers/restaurant-followup-board'
import { useSharedGuide } from '@/v8/onboarding/public/guide-shared/index'
import { emitGuideSignal } from '@/v8/onboarding/public/guide-overlay/index'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { boardRows,draftInput,FOLLOWUP_NAMES,followupTimingLabel,rowContentKey,rowVersionKey,type FollowupCardModel } from './board-model'
import { FollowupEditor } from './followup-editor'
import { ReservationFormEditor,ReservationFormSample } from './reservation-form-editor'
import { FollowupMessageSample } from './message-sample'
import { TestStartDialog } from './test-start-dialog'
import styles from './board.module.css'
const isRecommended = (trigger: RestaurantFollowupTrigger) => trigger === 'reservation_created' || trigger === 'reservation_24h'
type Progress={key:string;name:string;state:'pending'|'done'|'failed';description?:string}
export function FollowupBoard({accountId,storeId,storeName,role,repairForm=false}:{accountId:string;storeId:string;storeName:string;role:string|null;repairForm?:boolean}){
 const { guide } = useSharedGuide() ?? {}
 const guiding = guide?.phase === 'active' && guide.stepKey === 'followup'
 const [dismissedRecommendations, setDismissedRecommendations] = useState(false)
 const [snapshot,setSnapshot]=useState<FollowupBoardSnapshot|null>(null),[rows,setRows]=useState<FollowupCardModel[]>([]),[form,setForm]=useState<RestaurantReservationForm|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 const [editor,setEditor]=useState<FollowupCardModel|null>(null),[formEditor,setFormEditor]=useState(false),[test,setTest]=useState<RestaurantFollowupTrigger|null>(null),[progress,setProgress]=useState<Progress[]|null>(null),[notUsing,setNotUsing]=useState(false)
 const saveErrors=useSaveFormErrors(),fieldFailure=useRef<{error:unknown;row?:FollowupCardModel}|null>(null)
 const errorFields=['messageBubbles','timing','timing.offsetMinutes','timing.offsetDays','timing.sendAtTime','definition','title','definition.title','completionMessage','definition.completionMessage',...Array.from({length:5},(_,i)=>`messageBubbles.${i}.content.text`),...Array.from({length:6},(_,i)=>`definition.fields.${i}.label`)]
 useEffect(()=>{
  if(!(editor||formEditor)||!fieldFailure.current)return
  const failure=fieldFailure.current;let next=0
  // Dialogがportalへ移った後の実際の欄へ理由を結ぶ。
  const frame=requestAnimationFrame(()=>{next=requestAnimationFrame(()=>{saveErrors.capture(failure.error);if(fieldFailure.current===failure)fieldFailure.current=null})})
  return ()=>{cancelAnimationFrame(frame);cancelAnimationFrame(next)}
 },[editor,formEditor,saveErrors.capture])
 function revealFieldFailure(){if(!permission.current)return;const failure=fieldFailure.current;if(failure){if(failure.row)openEditor(failure.row);else openFormEditor()}}
 function rememberFieldFailure(error:unknown,row?:FollowupCardModel){
  const names=Object.keys(readSaveFieldErrors(error))
  if(!fieldFailure.current&&names.some(name=>errorFields.includes(name)&&(row?/^(timing|messageBubbles)/.test(name):!/^(timing|messageBubbles)/.test(name))))fieldFailure.current={error,row}
 }
 const [formRepairAccepted,setFormRepairAccepted]=useState(false)
 const lock=useRef(false),alive=useRef(true),canManage=role==='owner'||role==='admin',permission=useRef(canManage)
 permission.current=canManage
 const lockedReason=role&&!canManage?'オーナーか管理者が決めます':undefined
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 const install=useCallback((next:FollowupBoardSnapshot)=>{const nextRows=boardRows(next),nextForm=structuredClone(next.form.definition);setFormRepairAccepted(false);setSnapshot(next);setRows(nextRows);setForm(nextForm);if(repairForm&&next.formError)setFormEditor(true)},[repairForm])
 const load=useCallback(async()=>{setLoading(true);setError('');try{const next=await followupBoardApi.read(accountId,storeId);if(alive.current)install(next)}catch(e){if(alive.current)setError(describeSaveFailure(e));throw e}finally{if(alive.current)setLoading(false)}},[accountId,storeId,install])
 useEffect(()=>{void load().catch(()=>{})},[load])
 const savedRows=useMemo(()=>snapshot?boardRows(snapshot):[],[snapshot])
 const changed=rows.filter(row=>rowContentKey(row)!==rowContentKey(savedRows.find(saved=>saved.trigger===row.trigger)!))
 const formChanged=!!form&&!!snapshot&&(JSON.stringify(form)!==JSON.stringify(snapshot.form.definition)||!!snapshot.formError&&formEditor===false&&formRepairAccepted)
 const dirty=changed.length>0||formChanged
 const recommend = guiding && canManage && !dismissedRecommendations && snapshot?.page.bindings.length === 0 &&
  snapshot.board.engines.length === 0 && !snapshot.page.template && !snapshot.page.setup?.decidedAt &&
  rows.filter(row => isRecommended(row.trigger) && row.editable && !row.enabled).length === 2
 const displayedRows = recommend ? rows.map(row => isRecommended(row.trigger) ? { ...row, enabled: true } : row) : rows

 const editingFollowup=editor!==null||formEditor
 const guard=useUnsavedGuard({dirty:editingFollowup?false:dirty,busy:editingFollowup?false:busy,onDiscard:()=>{if(snapshot)install(snapshot)}})
 function openEditor(row:FollowupCardModel){guard.cancelLeave();setEditor(row)}
 function openFormEditor(){guard.cancelLeave();setFormEditor(true)}
 const update = (row: FollowupCardModel) => {
  if (recommend) setDismissedRecommendations(true)
  setRows(current => (recommend ? displayedRows : current).map(item => item.trigger === row.trigger ? row : item))
 }
 function assertCurrent(){if(!alive.current||!permission.current)throw new Error('操作する権限を確認してください。読み直してからお試しください')}
 async function save(){
  if(lock.current||!canManage||!snapshot||!form||(!dirty&&!recommend))return false
  lock.current=true;setBusy(true);setError('');saveErrors.reset();fieldFailure.current=null
  const base=snapshot,draftRows=displayedRows.map(row=>structuredClone(row)),draftForm=structuredClone(form),first=base.board.engines.length===0
  const workRows=first&&(changed.length||recommend)?draftRows:changed
  const records:Progress[]=[...(formChanged?[{key:'form',name:'予約の回答フォーム',state:'pending' as const}]:[]),...workRows.map(row=>({key:row.trigger,name:FOLLOWUP_NAMES[row.trigger],state:'pending' as const}))]
  setProgress(records)
  const done=new Set<string>()
  const mark=(keys:string[],state:Progress['state'],description:string)=>{if(alive.current)setProgress(current=>current?.map(item=>keys.includes(item.key)?{...item,state,description}:item)??null)}
  try{
   if(formChanged){try{assertCurrent();await followupBoardApi.saveForm(accountId,storeId,base.form.version,draftForm,base.form.repairToken);done.add('form');mark(['form'],'done','予約の受付画面の設定を保存しました')}catch(e){saveErrors.capture(e);rememberFieldFailure(e);mark(['form'],'failed',describeSaveFailure(e))}}
   if(workRows.length){
    if(first){
     try{
      assertCurrent();const fresh=boardRows(await followupBoardApi.read(accountId,storeId))
      if(draftRows.some(row=>rowVersionKey(row)!==rowVersionKey(fresh.find(item=>item.trigger===row.trigger)??row)))throw new Error('ほかの担当者が設定を変えました。読み直してください')
      if(draftRows.some(row=>row.enabled&&!row.editable))throw new Error('詳しい構成の送り方があります。詳細画面で確認するか、オフにしてから保存してください')
      await followupBoardApi.initialize(accountId,storeId,draftRows.map(row=>({trigger:row.trigger,input:draftInput(row)})))
      draftRows.forEach(row=>{done.add(row.trigger);mark([row.trigger],'done',row.enabled?`${['reservation_24h','reservation_2h','anniversary_before'].includes(row.trigger)?'リマインダ':'オートメーション'}に、止めた下書きを作りました`:'オフのまま保存しました')})
     }catch(e){saveErrors.capture(e);mark(workRows.map(row=>row.trigger),'failed',describeSaveFailure(e))}
    }else for(const row of workRows){
     try{assertCurrent();const fresh=boardRows(await followupBoardApi.read(accountId,storeId)).find(item=>item.trigger===row.trigger)!
      if(!fresh||rowVersionKey(row)!==rowVersionKey(fresh))throw new Error('ほかの担当者が設定を変えました。読み直してください')
      await followupBoardApi.saveRow(accountId,storeId,row.trigger,draftInput(row));done.add(row.trigger);mark([row.trigger],'done',row.enabled?'同じ実物の下書きを更新しました。まだ送っていません':'送り方を止めて保存しました')
     }catch(e){saveErrors.capture(e);rememberFieldFailure(e,row);mark([row.trigger],'failed',describeSaveFailure(e))}
    }
   }
   const latest=await followupBoardApi.read(accountId,storeId)
   const latestRows=boardRows(latest)
   if(alive.current){setSnapshot(latest);if(done.has('form'))setFormRepairAccepted(false);setRows(latestRows.map(row=>done.has(row.trigger)?row:draftRows.find(item=>item.trigger===row.trigger)??row));setForm(done.has('form')?latest.form.definition:draftForm)}
   return records.every(item=>done.has(item.key))
  }catch(e){saveErrors.capture(e);if(alive.current)setError(`保存の結果を読み直せませんでした。もう一度読み直してから操作してください。${describeSaveFailure(e)}`);return false}
  finally{lock.current=false;if(alive.current){setBusy(false);revealFieldFailure()}}
 }
 async function decideNotUsing(){
  if(lock.current||!canManage||!snapshot||dirty||rows.some(row=>row.enabled))return
  lock.current=true;setBusy(true);setError('')
  try{assertCurrent();await followupBoardApi.notUsing(accountId,storeId,snapshot.page.setup?.version??0);if(alive.current){setNotUsing(false);await load();emitGuideSignal('followup.save')}}catch(e){if(alive.current)setError(describeSaveFailure(e))}finally{lock.current=false;if(alive.current)setBusy(false)}
 }
 if(loading&&!snapshot)return <p className="text-body" role="status">LINE来店フォローを読み込んでいます…</p>
 if(!snapshot||!form)return <Notice tone="danger" action={<Button variant="secondary" onClick={()=>void load().catch(()=>{})}>読み直す</Button>}>{error||'設定を読み込めませんでした'}</Notice>
 const testRow=rows.find(row=>row.trigger===test)
 const selectedOn=displayedRows.filter(row=>row.enabled).length
 const alreadySelected = rows.some(row => row.enabled)
 return <SaveErrorScope errors={saveErrors}><div className={styles.stack}>
  <NoticeStack>
  {role==='viewer'&&<ReadOnlyNotice/>}
  <Notice tone="info">主要な送り方をかんたんに作れます。<Button variant="text" size="inline" textTone="accent" href="/reminders">リマインダ</Button>・<Button variant="text" size="inline" textTone="accent" href="/automations">オートメーション</Button>でも細かく設定できます。</Notice>
  {error&&<Notice tone="danger" action={<Button variant="secondary" disabled={busy} onClick={()=>guard.guarded(()=>void load().catch(()=>{}))}>読み直す</Button>}>{error}</Notice>}
  {snapshot.formError&&<Notice tone="warn" action={<Button variant="secondary" disabled={!canManage||busy} lockedReason={lockedReason} onClick={openFormEditor}>予約フォームを直す</Button>}>{snapshot.formError}</Notice>}
  {snapshot.page.template?.sending_status==='pending'&&<Notice tone="info" action={<Button href="/restaurant-test/approvals">承認の状況を見る →</Button>}>以前の送り方は承認を待っています。新しい送り方を保存した後は、この画面でテスト送信と承認を進めてください。</Notice>}
  {snapshot.page.setup?.notUsing&&<Notice tone="info">この店では、今は使わないと設定しています。送り方をオンにして保存すると、この設定は外れます。</Notice>}
  </NoticeStack>
  <ListPageCards columns={4} narrowColumns={2} inset="parent">
   <Card as="article" padding="default" gap="tight" layout="vertical" aria-label="予約の回答フォーム">
    <div className={styles.head}><h2>予約の回答フォーム</h2></div>
    <div className={styles.timing}><p>リッチメニューの「予約」で開く</p><Button variant="text" size="inline" textTone="accent" disabled={!canManage||busy} lockedReason={lockedReason} onClick={openFormEditor}>変える</Button></div>
    <div className={styles.sample} data-guide-overview={guiding||undefined}>
     {guiding ? <span className={styles.sampleLabel}>ご予約の内容（見本）</span> : <ReservationFormSample definition={form} storeName={storeName} compact/>}
    </div>
   </Card>
   {displayedRows.map(row=><Card as="article" key={row.trigger} padding="default" gap="tight" layout="vertical" aria-label={FOLLOWUP_NAMES[row.trigger]}>
    <div className={styles.head}><h2>{FOLLOWUP_NAMES[row.trigger]}</h2><Toggle label={`${FOLLOWUP_NAMES[row.trigger]}を使う`} checked={row.enabled} disabled={!canManage||busy||!row.enabled&&!row.editable} lockedReason={lockedReason} onChange={enabled=>{if(!enabled)update({...row,enabled:false});else if(row.editable)openEditor({...row,enabled:true})}}/></div>
    <div className={styles.timing}><p title={followupTimingLabel(row.trigger,row.timing)}>{followupTimingLabel(row.trigger,row.timing)}</p><Button variant="text" size="inline" textTone="accent" disabled={!canManage||busy||!row.editable} lockedReason={lockedReason} disabledReason={!row.editable?'詳細画面で変更できます':undefined} onClick={()=>openEditor(row)}>変える</Button></div>
    <StatusBadge help={row.enabled&&!row.sending?row.reason??undefined:undefined} tone={row.enabled&&row.sending?'success':'neutral'}>{recommend && isRecommended(row.trigger) ? 'おすすめ' : rowContentKey(row)!==rowContentKey(savedRows.find(saved=>saved.trigger===row.trigger)!)?'未保存':!row.enabled?'止めています':row.sending?'送っています':!row.editable?'中身を確認してください':'準備済み・送信停止中'}</StatusBadge>
    <div className={styles.sample} data-guide-overview={guiding||undefined} data-muted={!row.enabled||undefined}>
     {row.bubbles.length ? <FollowupMessageSample bubbles={row.bubbles} storeName={storeName} compact overview={guiding}/> : <p className={styles.support}>詳細で中身を確認してから試してください。</p>}
    </div>
    {row.detailPath&&<div className={styles.row}><Button variant="text" size="inline" textTone="accent" href={row.detailPath}>詳しく設定する →</Button><Button variant="text" size="inline" textTone="accent" disabled={!canManage||busy||dirty||!row.enabled||!row.targetId} lockedReason={lockedReason} disabledReason={dirty?'先に変更を保存してください':!row.enabled||!row.targetId?'送り方をオンにして保存してください':undefined} onClick={()=>setTest(row.trigger)}>試す・送り始める</Button></div>}
    {row.trigger==='review_request'&&<p className={styles.support} role="status">{snapshot.reviewCount==null?'送信履歴は読めませんでした':`送信履歴 ${snapshot.reviewCount}件`}</p>}
   </Card>)}
  </ListPageCards>
  <StickyBar status={`オン ${selectedOn}つ${recommend ? "（おすすめの初期設定）" : ""}・変更 ${changed.length+(formChanged?1:0)}件`} actions={<><Button variant="secondary" disabled={!canManage||busy||dirty||alreadySelected} lockedReason={lockedReason} disabledReason={dirty?'先に変更を保存してください':alreadySelected?'オンの送り方を止めて保存してから選べます':undefined} onClick={()=>setNotUsing(true)}>今は使わない</Button><Button variant="secondary" disabled={!canManage||busy||!dirty} lockedReason={lockedReason} onClick={()=>install(snapshot)}>元に戻す</Button>{/* 開店準備ガイド⑧の手順1/1（枠14 wcvyI）は保存できた時に進む。 */}<Button data-guide-anchor="followup.save" variant="primary" disabled={!canManage||busy||(!dirty&&!recommend)} lockedReason={lockedReason} busy={busy} onClick={()=>void save().then(ok=>{if(ok)emitGuideSignal('followup.save')})}>保存して作る</Button></>}/>
  {editor&&<FollowupEditor key={editor.trigger} row={editor} accountId={accountId} storeName={storeName} pageDirty={dirty} pageBusy={busy} onDiscardPage={()=>{install(snapshot);saveErrors.reset();setEditor(null)}} onCancel={()=>{saveErrors.reset();setEditor(null)}} onConfirm={row=>{if(permission.current){update(row);setEditor(null)}}}/>}
  {formEditor&&<ReservationFormEditor definition={form} storeName={storeName} pageDirty={dirty} pageBusy={busy} onDiscardPage={()=>{install(snapshot);saveErrors.reset();setFormEditor(false)}} onCancel={()=>{saveErrors.reset();setFormEditor(false)}} onConfirm={next=>{if(permission.current){setForm(next);setFormRepairAccepted(true);setFormEditor(false)}}}/>}
  {testRow&&<TestStartDialog key={testRow.trigger} row={testRow} accountId={accountId} storeId={storeId} storeName={storeName} recipient={snapshot.board.testRecipient} canManage={canManage} lockedReason={lockedReason} onCancel={()=>{setTest(null);void load().catch(()=>{})}} onStarted={load}/>}
  {notUsing&&<Dialog open title="今は使わないと設定しますか" guideSlot="followup.save" description="この店の『LINE来店フォローを確認する』を済みにします。送り方はすべてオフのままです。" confirmLabel="今は使わない" onCancel={()=>setNotUsing(false)} onConfirm={()=>void decideNotUsing()} busy={busy}/>}
  {progress&&!editor&&!formEditor&&<Dialog open title={busy?'保存しています…':'保存の結果'} busy={busy} onCancel={()=>setProgress(null)}>
   <div className={styles.stack}><Notice tone="info">作った場所と保存できた内容を確認してください。まだ送っていません。テスト送信と承認のあと送り始めます。</Notice><ul className={styles.list}>{progress.map(item=><li key={item.key}><strong>{item.name}</strong> <StatusBadge tone={item.state==='done'?'success':item.state==='failed'?'danger':'neutral'}>{item.state==='done'?'保存しました':item.state==='failed'?'保存できませんでした':'保存待ち'}</StatusBadge>{item.description&&<p className="text-body">{item.description}</p>}</li>)}</ul></div>
  </Dialog>}
  <UnsavedLeaveDialog open={!editingFollowup&&guard.leaveTarget !== null} subject="LINE来店フォローの変更" onConfirm={guard.confirmLeave} onCancel={guard.cancelLeave} busy={busy}/>
 </div></SaveErrorScope>
}
