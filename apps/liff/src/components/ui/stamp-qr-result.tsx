import type {VisitStampCard,VisitStampWallet} from '@line-crm/shared';
import {VISIT_STAMP_DEFAULT_COLOR,visitStampDarkInk} from '@line-crm/shared';
import Icon from './icon.js';
import styles from './stamp-qr-result.module.css';

/** 押した結果のカード。保存済みの設定・残高だけで描き、未取得を見本の数字で補わない。 */
export function StampQrCard({card,wallet,awarded=0}:{card:VisitStampCard;wallet:VisitStampWallet;awarded?:number}) {
 const rewards=card?.settings?.rewards;
 const validRewards=Array.isArray(rewards)&&rewards.every(r=>r&&Number.isSafeInteger(r.stamps)&&r.stamps>0);
 const slots=card?.settings?.slotCount??(validRewards?Math.max(...rewards.map(r=>r.stamps)):NaN);
 if(!validRewards||!Number.isSafeInteger(slots)||slots<1||slots>10000||!wallet||!Number.isSafeInteger(wallet.balance)||wallet.balance<0) return <p role="status">スタンプの数を確認できません。お店にお問い合わせください。</p>;
 const color=card.settings.backgroundColor??VISIT_STAMP_DEFAULT_COLOR;
 const ink=visitStampDarkInk(color)?'var(--color-ink)':'var(--color-canvas)';
 return <div className={styles.card} style={{backgroundColor:color,color:ink}}>
   {card.settings.backgroundImageUrl?<img className={styles.background} src={card.settings.backgroundImageUrl} alt=""/>:null}
   <div className={styles.content}>
     <div className={styles.cardTitle} style={card.settings.backgroundImageUrl?{backgroundColor:color}:undefined}><strong title={card.name}>{card.name}</strong><span>{`${wallet.balance} / ${slots}`}</span></div>
     <div className={styles.slots} role="list" aria-label={`${slots}個中 ${wallet.balance}個たまっています`}>
       {Array.from({length:slots},(_,i)=>{const n=i+1,done=n<=wallet.balance,reward=card.settings.rewards.find(r=>r.stamps===n),fresh=done&&n>wallet.balance-awarded;return <span key={n} role="listitem" aria-label={`${n}個目${done?' 済み':reward?' 特典':''}`} className={`rounded-full ${styles.slot} ${done?styles.done:''} ${fresh?styles.fresh:''}`}>
         {done?<Icon name="check" className="h-4.5 w-4.5"/>:reward?<Icon name="gift" className="h-4.5 w-4.5"/>:n}
       </span>})}
     </div>
   </div>
 </div>;
}
export function StampQrMessage({icon,title,description,children}:{icon:'check'|'hourglass'|'user-plus'|'qr-code';title:string;description?:string;children?:React.ReactNode}) {
 return <div className={styles.message}><span className={`rounded-full ${styles.mark} ${icon==='check'||icon==='user-plus'?styles.success:icon==='hourglass'?styles.wait:''}`} aria-hidden="true"><Icon name={icon} className="h-7 w-7"/></span><h1 className={styles.heading}>{title}</h1>{description?<p className={styles.description}>{description}</p>:null}{children}</div>;
}
