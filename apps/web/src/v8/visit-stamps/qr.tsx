'use client'
import { describeApiFailure } from '@/components/shared/api-error-message'

import {useCallback,useEffect,useRef,useState} from 'react'
import {ArrowRight,Check,Minus,Plus,QrCode,RefreshCw} from 'lucide-react'
import type {VisitStampCard,VisitStampQr,VisitStampQrInput,VisitStampQrStatus} from '@line-crm/shared'
import Button from '@/components/shared/button'
import Dialog from '@/components/shared/dialog'
import IconButton from '@/components/shared/icon-button'
import SegmentedControl from '@/components/shared/segmented'
import HelpTip from '@/components/shared/help-tip'
import Notice from '@/components/shared/notice'
import OperationTargetSummary from '@/components/shared/operation-target-summary'
import {TextField} from '@/components/shared/text-field'
import {Field as FormField} from '@/components/shared/form-controls'
import QrDialog from '@/components/dashboard/qr-dialog'
import {qrToDataURL} from '@/lib/qr-image'
import {visitStampsApi} from '@/lib/visit-stamps-api'
import styles from './qr.module.css'
import { formatNumber } from '@/lib/format'
import { withHonorific } from '@line-crm/shared'

const requestId=()=>crypto.randomUUID()
const reason = (error: unknown) => describeApiFailure(error, 'QRの確認')
function useQrImage(url:string|undefined,width:number) {
  const [image,setImage]=useState<{url:string;src:string}|null>(null)
  const [error,setError]=useState('')
  useEffect(()=>{let live=true;setError('');if(url)void qrToDataURL(url,{width,margin:4,errorCorrectionLevel:'M'}).then(src=>{if(live)setImage({url,src})}).catch(()=>{if(live)setError('QRの画像を作れませんでした。もう一度開いてください。')});return()=>{live=false}},[url,width])
  return {src:image&&image.url===url?image.src:null,error}
}

export function StorefrontQr({card,accountId,shop,canManage}: {card:VisitStampCard;accountId:string;shop:string;canManage:boolean}) {
  const [qr,setQr]=useState<VisitStampQr|null>(null),[loaded,setLoaded]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false)
  const [confirm,setConfirm]=useState(false),[print,setPrint]=useState(false)
  const scope=JSON.stringify([card.id,card.version,accountId,qr?.id??null,canManage])
  const currentScope=useRef(scope),confirmTicket=useRef<object|null>(null)
  if(currentScope.current!==scope){currentScope.current=scope;confirmTicket.current=null}
  const renderedTicket=confirmTicket.current
  const [confirmScope,setConfirmScope]=useState('')
  const pending=useRef<VisitStampQrInput|null>(null),live=useRef(true)
  useEffect(()=>{let cancelled=false;live.current=true;setQr(null);setLoaded(false);setError('');pending.current=null;void visitStampsApi.storefrontQr(card.id,accountId).then(r=>{if(!cancelled){setQr(r.data);setLoaded(true)}}).catch(e=>{if(!cancelled){setError(reason(e));setLoaded(true)}});return()=>{cancelled=true;live.current=false}},[card.id,card.version,accountId])
  const image=useQrImage(qr?.status==='active'?qr.url:undefined,1024)
  const issue=async()=>{
    if(busy)return;setBusy(true);setError('')
    pending.current??={requestId:requestId(),expectedQrId:qr?.id??null}
    try {const r=await visitStampsApi.issueStorefrontQr(card.id,accountId,pending.current);if(live.current){setQr(r.data);setConfirm(false);pending.current=null}}
    catch(e){if(live.current){setError(reason(e));if((e as {status?:number}).status===409){pending.current=null;const latest=await visitStampsApi.storefrontQr(card.id,accountId).catch(()=>null);if(latest)setQr(latest.data)}}}
    finally{if(live.current)setBusy(false)}
  }
  const note=card.settings.stampInterval?.mode==='hours'?`1日1回まで・前の押印から${card.settings.stampInterval.hours}時間`:'1日1回まで'
  return <section className={styles.storefront} aria-label="店頭の QR（印刷用）">
    <div className={styles.titleLine}><h3>店頭の QR（印刷用）</h3><HelpTip label="店頭のQRの説明">店頭に貼るQRです。読んだ人に押します。同じ日は1回までです。作り直すと古いQRは使えません。</HelpTip></div>
    <div className={styles.storeRow}>{image.src?<img width={96} height={96} className={styles.thumb} src={image.src} alt="店頭のQR" />:null}
      <div className={styles.storeDetails}><span className={styles.sub}>{`${card.name}・この店で1つ`}</span>
        {qr?.status==='active'?<><div className={styles.actions}><Button variant="secondary" disabled={!image.src} onClick={()=>setPrint(true)}><QrCode size={16} aria-hidden="true" />保存・印刷</Button></div>
          <div className={styles.actions}>{canManage?<Button variant="text" onClick={()=>{pending.current=null;confirmTicket.current={};setConfirmScope(scope);setConfirm(true)}}><RefreshCw size={16} aria-hidden="true" />作り直す</Button>:null}<span className={styles.sub}>{`最後に作り直した日 ${new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric'}).format(new Date(qr.issuedAt))}`}</span></div></>
          :loaded?canManage?<Button variant="secondary" busy={busy} busyLabel="発行しています…" onClick={()=>issue()}>{qr?'店頭のQRを作り直す':'店頭のQRを作る'}</Button>:<span className={styles.sub}>店頭のQRは管理者が発行します。</span>:<span className={styles.sub}>QRを読み込んでいます…</span>}
      </div>
    </div>
    {error||image.error?<Notice tone="danger" message={error||image.error}/>:null}
    <Dialog open={confirm && confirmScope===scope && renderedTicket!==null} designNode="PYDUP" designWidth={560} tone="destructive" confirmation confirmIcon={<RefreshCw size={16} aria-hidden="true"/>} title="店頭の QR を作り直しますか？" confirmLabel="作り直す" busy={busy} error={error||undefined} onCancel={()=>{confirmTicket.current=null;setConfirm(false)}} onConfirm={()=>{if(renderedTicket && renderedTicket===confirmTicket.current && confirmScope===currentScope.current && canManage)return issue()}}>
      <OperationTargetSummary accounts={[{id:accountId}]} externalTarget={{label:'カード',name:card.name}} />
      <div className={styles.dialogBody}><p>今の店頭の QR は使えなくなります。印刷した紙を貼り替えてください。</p><p className={styles.sub}>新しい QR は、作り直したあとに［保存・印刷］から出せます。</p></div>
    </Dialog>
    {print&&qr?<QrDialog open onClose={()=>setPrint(false)} accountName={`${shop}・${card.name}`} baseLink={qr.url} routes={[]} direct={{title:"来店スタンプの店頭QR",description:note,downloads:true}}/>:null}
  </section>
}

export function StaffQr({card,accountId,shop,onClose}: {card:VisitStampCard;accountId:string;shop:string;onClose:()=>void}) {
  const [mode,setMode]=useState<'count'|'amount'>(card.settings.mode==='amount'?'amount':'count')
  const [count,setCount]=useState(1),[amount,setAmount]=useState(''),[view,setView]=useState<'input'|'qr'|'result'>('input')
  const [state,setState]=useState<{qr:VisitStampQr;receivedAt:number}|null>(null),[result,setResult]=useState<VisitStampQrStatus['result']>(null)
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[fieldError,setFieldError]=useState(''),[seconds,setSeconds]=useState(30)
  const session=useRef(requestId()),latest=useRef<VisitStampQr|null>(null),live=useRef(true),pending=useRef<VisitStampQrInput|null>(null),input=useRef<HTMLInputElement>(null)
  const amountNumber=Number(amount.replace(/[,，]/g,'')),preview=Number.isSafeInteger(amountNumber)&&amountNumber>=0?Math.min(card.settings.maxPerVisit,Math.floor(amountNumber/card.settings.amountUnit)):0
  const revoke=useCallback((qr:VisitStampQr|null)=>{if(qr)void visitStampsApi.revokeStaffQr(qr.id,accountId).catch(()=>{})},[accountId])
  useEffect(()=>{live.current=true;return()=>{live.current=false;revoke(latest.current)}},[revoke])
  const accept=useCallback(async(qr:VisitStampQr)=>{
    if(!live.current){revoke(qr);return}
    latest.current=qr;setState({qr,receivedAt:Date.now()})
    if(qr.status==='used') {const used=await visitStampsApi.staffQrStatus(qr.id,accountId);if(live.current){setResult(used.data.result);setView('result')}}
    else setView('qr')
  },[accountId,revoke])
  const issue=useCallback(async(continueAfterUse=false)=>{
    if(!pending.current)pending.current={requestId:requestId(),sessionId:session.current,previousQrId:latest.current?.id??null,...(mode==='amount'?{amount:amountNumber}:{count}),continueAfterUse}
    const response=await visitStampsApi.issueStaffQr(card.id,accountId,pending.current)
    pending.current=null;await accept(response.data)
  },[card.id,accountId,mode,amountNumber,count,accept])
  const open=async()=>{
    if(mode==='amount'&&(!amount.trim()||!Number.isSafeInteger(amountNumber)||amountNumber<0||amountNumber>100000000||preview<1)) {setFieldError('1個以上たまる会計金額を入れてください。');input.current?.focus();input.current?.scrollIntoView?.({block:'center'});return}
    setBusy(true);setError('');setFieldError('')
    try{await issue()}catch(e){setError(reason(e))}finally{if(live.current)setBusy(false)}
  }
  // 1つずつ状態確認→必要なら交換。処理が遅い場合も並行発行しない。閉じた後の発行結果は失効させる。
  useEffect(()=>{
    if(view!=='qr')return
    let cancelled=false;let timer:ReturnType<typeof setTimeout>
    const poll=async()=>{
      if(cancelled||!live.current||!latest.current)return
      try {
        const response=await visitStampsApi.staffQrStatus(latest.current.id,accountId)
        if(cancelled||!live.current)return
        const {qr,result:used}=response.data
        if(qr.status==='used'){setResult(used);setState({qr,receivedAt:Date.now()});setView('result');return}
        if(qr.status==='revoked'){setError('このQRは失効しました。閉じて、もう一度出してください。');setState({qr,receivedAt:Date.now()});return}
        if(qr.status==='expired'||pending.current)await issue()
        else setState({qr,receivedAt:Date.now()})
        if(!cancelled&&live.current)setError('')
      }catch(e){if(!cancelled&&live.current)setError(reason(e))}
      if(!cancelled&&live.current)timer=setTimeout(()=>void poll(),800)
    }
    timer=setTimeout(()=>void poll(),800)
    return()=>{cancelled=true;clearTimeout(timer)}
  },[view,accountId,issue])
  useEffect(()=>{if(!state?.qr.expiresAt)return;const tick=()=>setSeconds(Math.max(0,Math.ceil((Date.parse(state.qr.expiresAt!)-Date.parse(state.qr.serverTime)-(Date.now()-state.receivedAt))/1000)));tick();const id=setInterval(tick,250);return()=>clearInterval(id)},[state])
  const qr=state?.qr,image=useQrImage(view==='qr'&&qr?.status==='active'&&seconds>0?qr.url:undefined,680)
  const close=()=>{live.current=false;revoke(latest.current);onClose()}
  const more=async()=>{if(busy)return;setBusy(true);setError('');try{await issue(true);setResult(null)}catch(e){setError(reason(e))}finally{if(live.current)setBusy(false)}}
  if(view==='input')return <Dialog open designNode={mode==='amount'?'pYdrv':'l3wpv'} designWidth={560} title="QR を出す" description="友だちは選びません。QR を読んだ人に押します" confirmLabel="QR を出す" confirmIcon={<QrCode size={16} aria-hidden="true"/>} busy={busy} error={error||undefined} onCancel={close} onConfirm={()=>open()}>
    <div className={styles.dialogBody}><div className={styles.field}><span>押し方</span><div><SegmentedControl aria-label="押し方" value={mode} onChange={v=>{setMode(v);pending.current=null;setFieldError('')}} disabled={busy} options={[{value:'count',label:'個数で'},{value:'amount',label:'会計の金額で'}]}/></div></div>
      {mode==='count'?<div className={styles.field}><span>押す個数</span><div className={styles.actions}><IconButton aria-label="1個へらす" disabled={count<=1} onClick={()=>{setCount(n=>n-1);pending.current=null}}><Minus size={16}/></IconButton><strong className={styles.count}>{`${formatNumber(count)} 個`}</strong><IconButton aria-label="1個ふやす" disabled={count>=card.settings.maxPerVisit} onClick={()=>{setCount(n=>n+1);pending.current=null}}><Plus size={16}/></IconButton><span className={styles.sub}>{`1 から ${card.settings.maxPerVisit} 個まで`}</span></div></div>
        :<FormField label="会計の金額" optional={false} error={fieldError}><div className={styles.actions}><TextField ref={input} aria-label="会計の金額" inputMode="numeric" value={amount} onChange={e=>{setAmount(e.target.value);pending.current=null;setFieldError('')}}/><span>円</span><ArrowRight size={16} aria-hidden="true"/><strong className={styles.count}>{`${preview} 個`}</strong></div><span className={styles.sub}>{`${card.settings.amountUnit.toLocaleString('ja-JP')} 円ごとに 1 個・1回の上限 ${card.settings.maxPerVisit} 個（② たまる決まり）`}</span></FormField>}
    </div>
  </Dialog>
  return <QrDialog open onClose={close} accountName={`${shop}・${card.name}`} baseLink={qr?.url??''} routes={[]} direct={{title:'来店スタンプのQR',description:'LINEのカメラで読み取ってください。1回読まれると使えなくなります。',downloads:false,
    qrContent:view==='result'?<Check size={64} aria-label="押印済み"/>:seconds===0?<span>次のQRに替えています…</span>:undefined,
    content:<>{view==='result'&&result?<><h2 className={styles.resultTitle}>{`${withHonorific(result.friendName)}・${formatNumber(result.wallet.balance)} 個`}</h2><p>押印を確認しました。</p></>:<><strong className={styles.largeCount}>{`${qr?.count??count} 個`}</strong><div className={styles.timer}><progress max={30} value={seconds} aria-label="QRの残り時間"/><div className={styles.timerLabels}><span>30秒ごとに変わります</span><span>{`あと ${seconds} 秒`}</span></div></div><p className={styles.sub}>予約がある人は本人の来店済み予約を選びます。台帳と二重には押しません。</p></>}{error||image.error?<Notice tone="danger" message={error||image.error}/>:null}</>,
    footer:view==='result'?<><Button variant="secondary" onClick={close}>閉じる</Button><Button variant="primary" busy={busy} onClick={()=>void more()}>続けて出す</Button></>:undefined}}/>;
}
