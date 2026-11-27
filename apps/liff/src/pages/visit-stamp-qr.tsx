import { liffErrorMessage } from '../lib/api-error.js';
import {useCallback,useEffect,useRef,useState} from 'react';
import {useNavigate,useSearchParams} from 'react-router-dom';
import liff from '@line/liff';
import type {VisitStampQrResult} from '@line-crm/shared';
import {api,visitStampsApi} from '../lib/api.js';
import LiffHeader from '../components/ui/liff-header.js';
import LiffLookScope from '../components/liff-look-scope.js';
import LoadingView from '../components/loading-view.js';
import LoadErrorView from '../components/load-error-view.js';
import Button from '../components/ui/button/index.js';
import {StampQrCard,StampQrMessage} from '../components/ui/stamp-qr-result.js';
import styles from './visit-stamp-qr.module.css';

/** 来店スタンプのQRを読んだ後の画面。QRの個数・友だちIDは渡さず、サーバの押印結果だけを表示。 */
export default function VisitStampQr() {
 const [params]=useSearchParams();
 return <VisitStampQrResult key={JSON.stringify([params.get('accountId'),params.get('token')])}/>;
}

function VisitStampQrResult() {
 const [params]=useSearchParams(),navigate=useNavigate();
 const token=params.get('token')??'',account=params.get('accountId')??'';
 const [result,setResult]=useState<VisitStampQrResult|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[shop,setShop]=useState<{accountId:string;accountName:string;botBasicId:string}|null>(null),[adding,setAdding]=useState(false);
 const request=useRef({identity:'',id:crypto.randomUUID()}),sequence=useRef(0);
 const load=useCallback(async(visitId?:string)=>{
   const identity=account+':'+token;if(request.current.identity!==identity)request.current={identity,id:crypto.randomUUID()};
   const current=++sequence.current;setBusy(true);setError('');
   try {
     const config=await api.liffConfig();
     if(current!==sequence.current)return;
     setShop(config.data);
     if(config.data.accountId!==account||!token) {setResult({status:'invalid',reason:'invalid'});return;}
     const response=await visitStampsApi.redeemQr(account,token,request.current.id,visitId);
     if(!response?.data || !['success','limited','visit_required','invalid','friend_required'].includes(response.data.status))throw new Error('Invalid stamp result');
     if(current===sequence.current)setResult(response.data);
   }catch(e){if(current===sequence.current){setError(liffErrorMessage((e as {body?:unknown})?.body,'押印を確認できませんでした。読み直してください。'));}}
   finally{if(current===sequence.current)setBusy(false);}
 },[account,token]);
 useEffect(()=>{void load();return()=>{sequence.current++}},[load]);
 // 友だち追加から戻った時も、同じ読み取り依頼をもう一度確認する。
 useEffect(()=>{if(!adding)return;const reload=()=>{if(document.visibilityState==='visible')void load()};window.addEventListener('focus',reload);document.addEventListener('visibilitychange',reload);return()=>{window.removeEventListener('focus',reload);document.removeEventListener('visibilitychange',reload)}},[adding,load]);
 const close=()=>{if(liff.isInClient())liff.closeWindow();else {const back=new URLSearchParams(params);back.delete('token');if(result?.status==='success'||result?.status==='limited')back.set('card',result.card.id);navigate(`/visit-stamps?${back}`)}};
 const add=()=>{if(!shop?.botBasicId)return;setAdding(true);liff.openWindow({url:`https://line.me/R/ti/p/${encodeURIComponent(shop.botBasicId)}`,external:true})};
 if(!result&&!error)return <LiffLookScope className={styles.screen}><LiffHeader title="来店スタンプ"/><main className={styles.content}><LoadingView/></main></LiffLookScope>;
 if(error)return <LiffLookScope className={styles.screen} designNode="zz9R3"><LiffHeader title="来店スタンプ"/><main className={styles.content}><LoadErrorView compact message={error} onRetry={()=>{if(!busy)void load()}}/><div className={styles.spacer}/><Button variant="primary" onClick={close}>LINE に戻る</Button></main></LiffLookScope>;
 const board=result?.status==='success'?'eSJ8v':result?.status==='limited'?'e9lZv':result?.status==='friend_required'?'ZhddO':'xLyNh';
 const next=result?.status==='success'?result.nextReward:null;
 const retry=result?.status==='limited'?new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(result.retryAt)):'';
 return <LiffLookScope className={styles.screen} designNode={board}>
   <LiffHeader title="来店スタンプ"/>
   <main className={styles.content}>
     {result?.status==='success'?<><StampQrMessage icon="check" title={result.alreadyCounted?"この来店は押印済みです":`${result.awarded} 個たまりました`}/><StampQrCard card={result.card} wallet={result.wallet} awarded={result.awarded}/><strong className={styles.next}>{next?`あと ${next.stamps-result.wallet.balance} 個で ${next.name}`:'特典が使えます'}</strong>{result.wallet.expiresAt?<p className={styles.sub}>{`有効期限 ${new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo'}).format(new Date(result.wallet.expiresAt))}`}</p>:null}</>:null}
     {result?.status==='limited'?<><StampQrMessage icon="hourglass" title={result.dailyLimit===false?"次の押印までお待ちください":"今日はもう押しました"} description={`${retry} からまた押せます。`}/><p className={styles.sub}>{result.card.settings.stampInterval?.mode==='hours'?`${result.dailyLimit===false?"":"このカードは1日1回まで・"}前の押印から${result.card.settings.stampInterval.hours}時間です`:'このカードは 1日1回までです'}</p><StampQrCard card={result.card} wallet={result.wallet}/></>:null}
     {result?.status==='visit_required'?<><StampQrMessage icon="check" title="今日の来店を選んでください" description="台帳と同じ来店として確認し、二重に数えません。来店前の予約は、店員に来店を記録してもらってください。"/>{result.visits.map(v=><Button key={v.id} variant="secondary" disabled={busy||!v.arrived} onClick={()=>void load(v.id)}>{`${v.storeName}・${new Intl.DateTimeFormat('ja-JP',{timeZone:'Asia/Tokyo',hour:'2-digit',minute:'2-digit'}).format(new Date(v.startsAt))}${v.arrived?'':'（来店の記録待ち）'}`}</Button>)}</>:null}
     {result?.status==='invalid'?<StampQrMessage icon="qr-code" title="この QR は使えません" description="期限が切れたか、もう使われた QR です。店員にもう一度出してもらってください。"/>:null}
     {result?.status==='friend_required'?<StampQrMessage icon="user-plus" title={'友だち追加すると\nスタンプがたまります'} description={`${shop?.accountName??'このお店'}を友だちに追加してから、もう一度 QR を読み取ってください。`}/>:null}
     <div className={styles.spacer}/>
     {result?.status==='friend_required'?<><Button variant="primary" disabled={!shop?.botBasicId||busy} onClick={add}>友だち追加</Button>{!shop?.botBasicId?<p className={styles.sub}>LINE公式アカウントから友だち追加して、読み直してください。</p>:null}{adding||!shop?.botBasicId?<Button variant="secondary" disabled={busy} onClick={()=>void load()}>追加したので読み直す</Button>:null}</>:<Button variant="primary" onClick={close}>LINE に戻る</Button>}
   </main>
 </LiffLookScope>;
}
