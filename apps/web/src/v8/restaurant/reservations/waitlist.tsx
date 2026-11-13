'use client'
import {useCallback,useEffect,useRef,useState} from 'react'
import Dialog from '@/components/shared/dialog'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import Button from '@/components/shared/button'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import {DataTable,TableHeadRow,Td,Th,Tr} from '@/components/shared/table'
import {restaurantTestApi,type SeatWaitlistEntry} from '@/lib/restaurant-test-api'
import {formatDate} from '@/lib/format'
import {describeActionFailure,useActionError} from '@/lib/use-action-error'
import { withHonorific } from '@line-crm/shared'
/** 既存の席の待ちを読む。招待・期限・先着順は共通処理に任せる。 */
export default function SeatWaitlistDialog({accountId,storeId,onClose}:{accountId:string;storeId:string;onClose:()=>void}) {
 const [rows,setRows]=useState<SeatWaitlistEntry[]|null>(null),[error,setError]=useState(''),[cancel,setCancel]=useState<SeatWaitlistEntry|null>(null),[busy,setBusy]=useState(false)
 const key=JSON.stringify([accountId,storeId]),scope=useRef({key,generation:1}),cancelGeneration=useRef(0)
 if(scope.current.key!==key)scope.current={key,generation:scope.current.generation+1}
 const generation=scope.current.generation
 const [loadedGeneration,setLoadedGeneration]=useState(0)
 const action=useActionError(`${accountId}:${storeId}`)
 const load=useCallback(async()=>{const request=scope.current.generation;try{const response=await restaurantTestApi.listSeatWaitlist(accountId,{storeId});if(request!==scope.current.generation)return;setRows(response.data.waitlist.filter(r=>['waiting','invited'].includes(r.status)));setLoadedGeneration(request);setError('')}catch{if(request!==scope.current.generation)return;setError('キャンセル待ちを読み込めませんでした。')}},[accountId,storeId])
 useEffect(()=>{setCancel(null);setBusy(false);setRows(null);setLoadedGeneration(0);void load();const timer=setInterval(()=>void load(),30000);return()=>clearInterval(timer)},[load])
 const remove=async()=>{if(!cancel||busy||cancelGeneration.current!==scope.current.generation||loadedGeneration!==scope.current.generation)return;const request=scope.current.generation;setBusy(true);action.clear();try{if(!Number.isSafeInteger(cancel.confirmation_revision))throw new Error('確認した版がありません');await restaurantTestApi.cancelSeatWaitlist(accountId,cancel.id,cancel.confirmation_revision);if(request!==scope.current.generation)return;setCancel(null);await load()}catch(caught){if(request!==scope.current.generation)return;action.setError(describeActionFailure(caught,'取り消し'));await load()}finally{if(request===scope.current.generation)setBusy(false)}}
 return <><Dialog open title="キャンセル待ち" description="登録の早い順に1組ずつ案内します。仮押さえは30分、2時間前からは10分。1人3件まで、1時間前に受付を締めます。" onCancel={onClose}>
  {error?<Notice tone="danger" message={error} action={rows?<Button size="inline" onClick={()=>void load()}>もう一度読み込む</Button>:undefined}/>:null}
  {!rows||loadedGeneration!==generation?<ListState kind={error?'error':'loading'} onRetry={()=>void load()}/>:rows.length===0?<ListState kind="empty" title="キャンセル待ちはありません"/>:<DataTable><thead><TableHeadRow><Th>日時・お名前</Th><Th>人数</Th><Th>状態</Th><Th>操作</Th></TableHeadRow></thead><tbody>{rows.map(r=><Tr key={r.id}><Td>{formatDate(r.starts_at,{style:'detail'})}<br/>{r.customer_name}</Td><Td>{r.guest_count}名</Td><Td>{r.status==='invited'?`案内中・${formatDate(r.hold_expires_at,{style:'time'})}まで`:'空き待ち'}</Td><Td><Button size="inline" onClick={()=>{if(loadedGeneration!==scope.current.generation)return;cancelGeneration.current=scope.current.generation;action.clear();setCancel(r)}}>取り消す</Button></Td></Tr>)}</tbody></DataTable>}
 </Dialog><Dialog open={!!cancel&&cancelGeneration.current===generation} title="キャンセル待ちを取り消しますか？" description={`${withHonorific(cancel?.customer_name??'')}の待ちを取り消します。案内中の枠は次の方へ回ります。`} confirmLabel="取り消す" tone="destructive" confirmation busy={busy} error={action.error} onCancel={()=>{action.clear();setCancel(null)}} onConfirm={()=>void remove()}><OperationTargetSummary accounts={[{id:accountId}]} store={{id:storeId}}/></Dialog></>
}
