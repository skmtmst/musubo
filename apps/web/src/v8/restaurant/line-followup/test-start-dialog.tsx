'use client'
import { useEffect,useRef,useState } from 'react'
import { withHonorific,type ReminderTestRecipientStatus } from '@line-crm/shared'
import Dialog, { DialogActions } from '@/components/shared/dialog'
import Notice, { NoticeStack } from '@/components/shared/notice'
import Button from '@/components/shared/button'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import { ApiError,describeSaveFailure } from '@/lib/api/transport/errors'
import { followupBoardApi,type FollowupTestResult } from '@/lib/api/helpers/restaurant-followup-board'
import { FOLLOWUP_NAMES,type FollowupCardModel } from './board-model'
import { FollowupMessageSample } from './message-sample'
import styles from './board.module.css'
export function TestStartDialog({row,accountId,storeId,storeName,recipient,canManage,lockedReason,onCancel,onStarted}:{row:FollowupCardModel;accountId:string;storeId:string;storeName:string;recipient:ReminderTestRecipientStatus|null;canManage:boolean;lockedReason?:string;onCancel:()=>void;onStarted:()=>Promise<void>}){
 const [busy,setBusy]=useState(false),[proof,setProof]=useState<FollowupTestResult|null>(null),[error,setError]=useState(''),[unconfirmed,setUnconfirmed]=useState(false),[started,setStarted]=useState(false)
 const active=useRef(true),lock=useRef(false),permission=useRef(canManage)
 permission.current=canManage
 useEffect(()=>{active.current=true;return()=>{active.current=false}},[])
 const self=recipient?.recipientKind==='self',ready=recipient?.state==='ready'
 const testLabel=self?'自分の LINE で試す':'登録済みのテスト宛先で試す'
 async function run(){
  if(!active.current||lock.current||!permission.current||!ready||unconfirmed)return
  lock.current=true;setBusy(true);setError('')
  try{
   if(!proof){const result=await followupBoardApi.test(accountId,storeId,row.trigger,row.targetVersion);if(active.current&&permission.current)setProof(result)}
   else{await followupBoardApi.start(accountId,storeId,row.trigger,row.targetVersion,proof.contentHash);if(!active.current)return;setStarted(true);try{await onStarted()}catch{setError('公開と承認は完了しましたが、状態を読み直せませんでした。閉じてから読み直してください')}}
  }catch(e){if(active.current){setError(describeSaveFailure(e));if(e instanceof ApiError&&e.code==='delivery_unconfirmed')setUnconfirmed(true)}}finally{lock.current=false;if(active.current)setBusy(false)}
 }
 return <Dialog open size="large" title={`${FOLLOWUP_NAMES[row.trigger]}を試す・送り始める`} busy={busy} onCancel={()=>{active.current=false;onCancel()}}
  footer={started?null:<DialogActions><Button variant="secondary" disabled={busy} onClick={()=>{active.current=false;onCancel()}}>キャンセル</Button><Button variant="primary" busy={busy} disabled={!permission.current||!ready||unconfirmed} lockedReason={lockedReason} disabledReason={unconfirmed?'送信結果を確認できないため、送り直しません':!ready?'本人の LINE か、登録済みのテスト送信先を設定してください':undefined} onClick={()=>void run()}>{proof?'この内容で送り始める':testLabel}</Button></DialogActions>}>
  <div className={styles.stack}>
   <OperationTargetSummary accounts={[{id:accountId}]} store={{id:storeId,name:storeName}} />
   <NoticeStack>
    {started&&<Notice tone="success">公開と承認が完了しました。この内容で送り始めます。</Notice>}
    {unconfirmed?<Notice tone="warn">送信結果が分からないため、送り直しません。履歴を確認し、サポートへお問い合わせください。</Notice>:error?<Notice tone="danger" role="alert">{error}</Notice>:!started?(proof?<Notice tone="success">{withHonorific(proof.recipientName)}へテスト送信できました。同じ版を公開し、承認してからお客さまへ送り始めます。</Notice>:<Notice tone="info">まだお客さまへ送っていません。{ready?`${self?'自分のLINE':'登録済みテスト宛先'}（${recipient.recipient?.displayName}）へ、見本の予約情報を使って試します。`:'本人のLINEを接続するか、登録済みのテスト送信先を設定してください。'}</Notice>):null}
   </NoticeStack>
   <FollowupMessageSample bubbles={row.bubbles} storeName={storeName}/>
  </div>
 </Dialog>
}
