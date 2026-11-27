'use client'
import { useContext,useEffect,useRef,useState } from 'react'
import Dialog from '@/components/shared/dialog'
import { useUnsavedGuard } from '@/lib/use-unsaved-guard'
import { UnsavedLeaveDialog } from '@/lib/unsaved-leave-dialog'
import { OverlayDepthContext } from '@/components/shared/overlay-utils'
import { DetailColumns } from '@/components/templates/detail-columns'
import { Field } from '@/components/shared/form-controls'
import { TextField } from '@/components/shared/text-field'
import Notice from '@/components/shared/notice'
import { FollowupMessageEditor } from './message-editor'
import { FollowupMessageSample } from './message-sample'
import { FollowupTimingFields } from './timing-fields'
import { FOLLOWUP_NAMES,followupTimingError,type FollowupCardModel } from './board-model'
import styles from './board.module.css'
import { followupHasMessage, type FollowupDraftContent } from './followup-guide-draft'
const origins={reservation_created:'予約が完了した人',reservation_24h:'予約が完了した人',reservation_2h:'予約が完了した人',post_visit:'退店した人',review_request:'退店した人',waitlist_invited:'キャンセル待ちで席が空いた人',anniversary_before:'記念日が登録されている人'}
export function FollowupEditor({row,initialDraft,accountId,storeName,pageDirty,pageBusy,guideSlot,onDraftChange,onDiscardPage,onCancel,onConfirm}:{row:FollowupCardModel;initialDraft?:FollowupDraftContent;accountId:string;storeName:string;pageDirty:boolean;pageBusy:boolean;guideSlot?:'followup.body'|'followup.confirm';onDraftChange?:(next:FollowupCardModel)=>void;onDiscardPage:()=>void;onCancel:()=>void;onConfirm:(next:FollowupCardModel)=>void}){
 const [draft,setDraft]=useState(()=>structuredClone(initialDraft ? {...row,timing:initialDraft.timing,bubbles:initialDraft.bubbles} : row)),[expanded,setExpanded]=useState(false),[error,setError]=useState('')
 function changeDraft(next: FollowupCardModel) {
  setError('')
  setDraft(next)
  onDraftChange?.(next)
 }
 const depth=useContext(OverlayDepthContext)
 const localDirty=JSON.stringify(row)!==JSON.stringify(draft)
 const pageGuard=useUnsavedGuard({dirty:pageDirty||localDirty,busy:pageBusy,onDiscard:onDiscardPage})
 const alive=useRef(true),current=useRef({busy:pageBusy,target:pageGuard.leaveTarget})
 const [editor,setEditor]=useState<HTMLDivElement|null>(null)
 current.current={busy:pageBusy,target:pageGuard.leaveTarget}
 useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[])
 useEffect(() => {
  if (guideSlot !== 'followup.body' || !window.matchMedia('(width < 1152px)').matches) return
  const content = editor?.closest<HTMLElement>('[data-dialog-content]')
  const panel = content?.closest('[role="dialog"]')
  const body = editor?.querySelector('[data-guide-anchor="followup.body"]')
  if (!content || !panel || !body || typeof ResizeObserver === 'undefined') return
  const observer = new ResizeObserver(() => {
   if (!panel.querySelector('[data-guide-balloon="followup:2"]')) return
   const contentBounds = content.getBoundingClientRect()
   const bodyBounds = body.getBoundingClientRect()
   if (bodyBounds.bottom > contentBounds.bottom - 8) {
    content.scrollTop += Math.min(bodyBounds.bottom - contentBounds.bottom + 8, bodyBounds.top - contentBounds.top - 8)
   }
   observer.disconnect()
  })
  observer.observe(content)
  return () => observer.disconnect()
 }, [editor, guideSlot])
 function discardAndLeave(){
  const target=pageGuard.leaveTarget
  if(!alive.current||current.current.busy||!target||current.current.target!==target)return
  current.current.target=null
  // 同じ描画が持つ行き先を、解除直後に一度だけ実行する。
  pageGuard.disarm();pageGuard.confirmLeave()
 }
 const timingError=followupTimingError(row.trigger,draft.timing)
 const hasBody = followupHasMessage(draft.bubbles)
 return <><Dialog open size="wide" title={`${FOLLOWUP_NAMES[row.trigger]}を変える`} dirty={localDirty} onCancel={onCancel} guideSlot={guideSlot} guideSlotNarrow confirmLabel="この内容でオンにする" confirmDisabled={!!timingError} confirmDisabledReason={timingError?'送る時期を直してから確定してください':undefined} error={error} onConfirm={()=>{
  if(timingError)return
  if(!hasBody){setError('送る本文を入れるか、テンプレートを選んでください');return}
  onConfirm({...draft,enabled:true})
 }}>
  <DetailColumns variant="followup-editor" asideLabel="届き方" expanded={expanded} onExpandedChange={setExpanded} aside={<FollowupMessageSample trigger={row.trigger} bubbles={draft.bubbles} storeName={storeName}/>}>
   <div className={styles.stack} ref={setEditor}>
    <Field label="だれに（きっかけ）"><TextField readOnly value={origins[row.trigger]}/></Field>
    <FollowupTimingFields trigger={row.trigger} value={draft.timing} onChange={timing=>changeDraft({...draft,timing})}/>
    <Field label="送るもの" help="テンプレートなら、リッチメッセージ・カードタイプ・カルーセル・クーポンも選べます。"><FollowupMessageEditor bubbles={draft.bubbles} accountId={accountId} storeName={storeName} guideReady={guideSlot === 'followup.body' ? hasBody && !timingError : undefined} onChange={bubbles=>changeDraft({...draft,bubbles})}/></Field>
    {row.trigger==='reservation_24h'&&<Notice tone="info">来店の返事のボタンを含めて、吹き出しは5つ以内です。</Notice>}
    {guideSlot && <div className={styles.guideSlot} data-guide-slot={guideSlot}/>}
   </div>
  </DetailColumns>
 </Dialog>
 <OverlayDepthContext.Provider value={depth+1}><UnsavedLeaveDialog open={pageGuard.leaveTarget !== null} subject="LINE来店フォローの変更" onConfirm={discardAndLeave} onCancel={pageGuard.cancelLeave} busy={pageBusy}/></OverlayDepthContext.Provider>
 </>
}
