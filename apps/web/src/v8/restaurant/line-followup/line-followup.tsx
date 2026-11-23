'use client'
import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { useAccount } from '@/contexts/account-context'
import { useStaffRole } from '@/lib/staff-role'
import { RestaurantFrame } from '@/v8/restaurant/common-a/public/frame/index'
import { FollowupBoard } from './followup-board'
/** 別の店・アカウントの遅い返事や未保存内容を引き継がない。 */
function LineFollowupContent(){
 const {selectedAccountId}=useAccount(),role=useStaffRole(),params=useSearchParams()
 const initialStoreId=params.get('store_id')??'',repairForm=params.get('repair_form')==='1'
 return <RestaurantFrame key={`${selectedAccountId}:${initialStoreId}`} initialStoreId={initialStoreId} boardId="n9vvGx" title="LINE来店フォロー" description="お店でよく使う予約の受付と7つの送り方を設定できます。保存すると止めた下書きが作られ、テスト送信と承認のあとに送り始めます。" pickerAs="select" banner={false} bodyPadTop={0} subtitle={store=>store?`${store.name}・スタイル：飲食店`:''} actions={()=>null}>
  {ctx=>ctx.store&&selectedAccountId?<FollowupBoard key={`${selectedAccountId}:${ctx.store.id}`} accountId={selectedAccountId} storeId={ctx.store.id} storeName={ctx.store.name} role={role} repairForm={repairForm}/>:<p className="text-body">店とLINE公式アカウントを選んでください。</p>}
 </RestaurantFrame>
}

export default function LineFollowupV8(){
 return <Suspense fallback={<p className="text-body" role="status">LINE来店フォローを読み込んでいます…</p>}><LineFollowupContent/></Suspense>
}
