'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ListPageSection } from '@/components/templates'
import ListState from '@/components/shared/list-state'
import Notice from '@/components/shared/notice'
import SegmentedControl from '@/components/shared/segmented'
import { DataTable, TableHeadRow, Td, Th, Tr } from '@/components/shared/table'
import { ValueBarChart } from '@/components/shared/charts'
import { inboxResponseApi, type InboxResponseResult } from '@/lib/api/helpers/gap3'

const choices = [{value:'7',label:'過去7日'},{value:'30',label:'過去30日'},{value:'90',label:'過去90日'}] as const
function range(days:number) {
  const today = new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Tokyo'})
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - (days-1)*86400000).toLocaleDateString('en-CA',{timeZone:'UTC'})
  return {from,to:today}
}
const minutes = (value:number|null) => value === null ? '—' : `${Math.round(value*10)/10}分`
export default function InboxResponse({accountId}:{accountId:string}) {
  const [days,setDays]=useState('30')
  const [data,setData]=useState<InboxResponseResult|null>(null)
  const [error,setError]=useState<unknown>(null)
  const [loading,setLoading]=useState(true)
  const [loadedKey,setLoadedKey]=useState('')
  const requestVersion=useRef(0)
  const load=useCallback(async()=>{
    const version=++requestVersion.current
    setLoading(true);setData(null);setError(null)
    try { const dates=range(Number(days));const res=await inboxResponseApi.get(accountId,dates.from,dates.to);if(version===requestVersion.current)setData(res.data) }
    catch (reason) { if(version===requestVersion.current)setError(reason) } finally { if(version===requestVersion.current){setLoadedKey(`${accountId}:${days}`);setLoading(false)} }
  },[accountId,days])
  useEffect(()=>{void load();return ()=>{requestVersion.current++}},[load])
  return <ListPageSection>
    <SegmentedControl aria-label="集計する期間" options={[...choices]} value={days} onChange={setDays} />
    <Notice tone="info" message="集計開始後の記録を表示します。自動応答は担当者の返信と分けて数えます。" />
    {loading || loadedKey !== `${accountId}:${days}` ? <ListState kind="loading" title="返事の速さを読み込んでいます" /> : error ? <ListState kind="error" error={error} onRetry={()=>void load()} /> : !data || (!data.byStaff.length && !data.automatic.count) ? <ListState kind="empty" title="この期間の会話はありません" emptyPreset="readonly" /> : <>
      <DataTable><thead><TableHeadRow><Th grow>担当者</Th><Th align="right">最初の返事までの中央値</Th><Th align="right">期限内の割合</Th><Th align="right">件数</Th></TableHeadRow></thead><tbody>
        {data.byStaff.map((row)=><Tr key={row.staffId??'unknown'}><Td grow>{row.name}</Td><Td align="right">{minutes(row.medianFirstResponseMinutes)}</Td><Td align="right">{row.withinSlaRate===null?'—':`${Math.round(row.withinSlaRate*10)/10}%`}</Td><Td align="right">{row.count}件</Td></Tr>)}
        {data.automatic.count!==null ? <Tr><Td grow>自動応答（送信数）</Td><Td align="right">—</Td><Td align="right">—</Td><Td align="right">{data.automatic.count}件</Td></Tr> : null}
      </tbody></DataTable>
      <ValueBarChart label="週ごとの最初の返事までの時間" unit="分" items={data.weekly.map(row=>({key:row.week,label:row.week,value:row.medianFirstResponseMinutes}))} />
    </>}
  </ListPageSection>
}
