import { initialRestaurantStore } from './style-initial-store.js';
import { INITIAL_MENUS, RESTAURANT_GUIDE_MENUS, type RestaurantGuideMenu, initialMenuBounds, initialFormKey, initialMenuFormTargets, initialMenuIsDocument, initialMenuDestination, liffActionUrl, type AccountStyle, type InitialMenuTarget } from '@line-crm/shared';

export type StyleMenuButton = {label:string;feature:string;target?:InitialMenuTarget;actionType:string;actionData:string;intent:string;formId?:string|null;bounds?:{x:number;y:number;width:number;height:number};ready?:boolean;reason?:string;destination?:string};
export type PlannedInitialForms = Map<string,string>;
type FormTarget = {id:string;is_active:number;status:string;current_published_version_id:string|null};
async function formTarget(db:D1Database,account:string,style:AccountStyle,target:InitialMenuTarget,planned?:PlannedInitialForms):Promise<FormTarget|null> {
 const key=initialFormKey(style,target), id=planned?.get(key);
 if(id)return {id,is_active:0,status:'active',current_published_version_id:null};
 return db.prepare(`SELECT f.id,f.is_active,f.status,f.current_published_version_id FROM style_starter_items i JOIN forms f ON f.id=i.target_id
   WHERE i.line_account_id=? AND i.item_key=? AND i.kind='form' AND f.status!='archived'
   AND EXISTS(SELECT 1 FROM form_accounts a WHERE a.form_id=f.id AND a.line_account_id=?)
   AND (SELECT COUNT(*) FROM form_accounts a WHERE a.form_id=f.id)=1`).bind(account,key,account).first<FormTarget>();
}
async function restaurantHistory(db:D1Database,account:string,base:string,planned?:PlannedInitialForms):Promise<string> {
 const store=await initialRestaurantStore(db,account);
 if(!store)return '';
 const prepared=planned?.get('restaurant-history-token');
 const link=prepared?{token:prepared}:await db.prepare('SELECT token FROM rt_reservation_links WHERE store_id=?').bind(store).first<{token:string}>();
 return link?`${base}/?${new URLSearchParams({page:'restaurant',token:link.token,view:'mine'})}`:'';
}
/** 1面も詰め直さない。準備中の移動先は未設定の下書きに保ち、公開の門で止める。 */
export async function initialMenuButtons(db:D1Database,account:string,style:AccountStyle,planned?:PlannedInitialForms,preset?:RestaurantGuideMenu):Promise<StyleMenuButton[]> {
 const line=await db.prepare('SELECT liff_id FROM line_accounts WHERE id=? AND is_active=1 AND archived_at IS NULL').bind(account).first<{liff_id:string|null}>();
 const base=line?.liff_id?`https://liff.line.me/${encodeURIComponent(line.liff_id)}`:'';
 const forms=new Set(initialMenuFormTargets(style));
 const buttons = await Promise.all(INITIAL_MENUS[style].buttons.map(async (button,index) => {
   let actionData='',formId:string|null=null,intent='url',ready=false,reason='LINEのページを設定してください';
   if(forms.has(button.target)) {
     const form=await formTarget(db,account,style,button.target,planned);formId=form?.id??null;
     if(!initialMenuIsDocument(button.target))intent='form';
     if(base&&form) actionData=initialMenuIsDocument(button.target)?`${base}/information/${encodeURIComponent(form.id)}`:liffActionUrl({kind:'form',liffId:line!.liff_id!,formId:form.id});
     ready=!!actionData && form?.is_active===1 && form.status==='active' && !!form.current_published_version_id;
     reason=form?'ページの内容を確認して公開してください':'初期セットを保存するとページの下書きが入ります';
   } else if(base) {
     if(button.target==='history') actionData=style==='restaurant'?await restaurantHistory(db,account,base,planned):style==='lesson'?`${base}/events/me`:liffActionUrl({kind:'booking_history',liffId:line!.liff_id!});
     else if(button.target==='classes'||button.target==='schedule')actionData=`${base}/events`;
     else if(button.target==='mypage')actionData=`${base}/mypage`;
     ready=!!actionData; reason='店舗とLINEのページを確認してください';
   }
   return {...button,actionType:'uri',actionData,intent,formId,bounds:initialMenuBounds(index),ready,reason,destination:initialMenuDestination(style,button.target)};
 }));
 if (!preset) return buttons;

 const history = buttons.find(button => button.target === 'history')?.actionData;
 const bookingUrl = history ? new URL(history) : null;
 bookingUrl?.searchParams.delete('view');
 return RESTAURANT_GUIDE_MENUS[preset].areas.map(({ target, ...bounds }) => {
   const button = buttons.find(item => item.target === target);
   if (target === 'booking' && button) {
     const actionData = bookingUrl?.toString() ?? '';
     return { ...button, bounds, actionData, intent: 'url', formId: null, ready: Boolean(actionData), destination: 'LINEで席を予約' };
   }
   if (button) return { ...button, bounds };
   const label = target === 'coupon' ? 'クーポン' : target === 'stamp' ? 'ショップカード' : 'お電話';
   const actionData = target === 'stamp' && line?.liff_id ? liffActionUrl({ kind: 'visit_stamp', liffId: line.liff_id }) : '';
   return { label, feature: target, bounds, actionType: 'uri', actionData, intent: 'url',
     ready: Boolean(actionData), reason: '公開前にボタンの行き先を設定してください', destination: label };
 });
}
