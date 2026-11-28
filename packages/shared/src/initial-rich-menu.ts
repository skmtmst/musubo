import type { AccountStyle } from './style-api.js';
import type { RestaurantGuideMenu } from './restaurant-guide-menu.js';

/** 初期セットの4面。画像・座標・投入・顧客の入口はこの順序を共有する。 */
export type InitialMenuTarget = 'booking' | 'history' | 'menu' | 'access' | 'contact' | 'about' | 'classes' | 'schedule' | 'news' | 'application' | 'guide' | 'products' | 'mypage';
export type InitialMenuButton = { label: string; feature: string; target: InitialMenuTarget; icon: 'calendar' | 'check' | 'list' | 'pin' | 'message' | 'shop' | 'person' | 'book' };
export const INITIAL_MENU_VERSION = 1;
export const INITIAL_MENU_SIZE = { width: 2500, height: 1686 } as const;
export const INITIAL_MENUS: Record<AccountStyle, { color: string; ink: string; buttons: InitialMenuButton[] }> = {
 restaurant: { color: '#f3e8db', ink: '#684b36', buttons: [
  {label:'予約する',feature:'booking',target:'booking',icon:'calendar'}, {label:'予約の確認と変更',feature:'booking',target:'history',icon:'check'},
  {label:'メニュー',feature:'content',target:'menu',icon:'list'}, {label:'アクセス',feature:'content',target:'access',icon:'pin'}]},
 salon: {color:'#f5e8ed',ink:'#765363',buttons:[
  {label:'予約する',feature:'booking',target:'booking',icon:'calendar'}, {label:'予約の確認と変更',feature:'booking',target:'history',icon:'check'},
  {label:'メニュー・料金',feature:'content',target:'menu',icon:'list'}, {label:'アクセス',feature:'content',target:'access',icon:'pin'}]},
 consult: {color:'#e4edf4',ink:'#3b607b',buttons:[
  {label:'面談を予約する',feature:'booking',target:'booking',icon:'calendar'}, {label:'予約の確認と変更',feature:'booking',target:'history',icon:'check'},
  {label:'ご相談内容を送る',feature:'contact',target:'contact',icon:'message'}, {label:'会社のこと',feature:'content',target:'about',icon:'shop'}]},
 lesson: {color:'#e7efe3',ink:'#4e6942',buttons:[
  {label:'クラスを予約する',feature:'booking',target:'classes',icon:'calendar'}, {label:'予約の確認と変更',feature:'booking',target:'history',icon:'check'},
  {label:'スケジュール',feature:'classCapacity',target:'schedule',icon:'list'}, {label:'教室のこと',feature:'content',target:'about',icon:'shop'}]},
 standard: {color:'#e6eeeb',ink:'#3e6658',buttons:[
  {label:'お知らせ',feature:'content',target:'news',icon:'list'}, {label:'お申し込み',feature:'content',target:'application',icon:'calendar'},
  {label:'お問い合わせ',feature:'contact',target:'contact',icon:'message'}, {label:'ご利用ガイド',feature:'content',target:'guide',icon:'book'}]},
 ec: {color:'#f4ecdd',ink:'#77603b',buttons:[
  {label:'商品を見る',feature:'content',target:'products',icon:'shop'}, {label:'マイページ',feature:'contact',target:'mypage',icon:'person'},
  {label:'お問い合わせ',feature:'contact',target:'contact',icon:'message'}, {label:'ご利用ガイド',feature:'content',target:'guide',icon:'book'}]},
};
export function initialMenuBounds(index: number) {
 if (!Number.isInteger(index) || index<0 || index>3) throw new Error('invalid_initial_menu_area');
 return {x:(index%2)*1250,y:Math.floor(index/2)*843,width:1250,height:843};
}
export function initialFormKey(style: AccountStyle, target: InitialMenuTarget) { return `initial-${style}-${target}`; }
export function initialMenuImageKey(accountId: string, style: AccountStyle, preset?: RestaurantGuideMenu) {
 return `rich-menus/${accountId}/initial/${style}/v${INITIAL_MENU_VERSION}${preset ? `-${preset}` : ''}.png`;
}

const DOCUMENT_TARGETS: readonly InitialMenuTarget[] = ['menu','access','about','news','guide','products'];
export const initialMenuIsDocument = (target: InitialMenuTarget) => DOCUMENT_TARGETS.includes(target);
export const initialMenuFormTargets = (style: AccountStyle) => INITIAL_MENUS[style].buttons
  .filter(({ target }) => style !== 'restaurant' || target !== 'menu')
  .filter(({ target }) => initialMenuIsDocument(target) || ['booking', 'application', 'contact'].includes(target))
  .map(({ target }) => target);
export function initialMenuDestination(style: AccountStyle, target: InitialMenuTarget): string {
 if(target==='booking') return '予約用の回答フォーム';
 if(target==='history') return style==='restaurant'?'自分の席予約一覧':style==='lesson'?'自分のクラス予約':'自分の予約一覧';
 if(target==='classes'||target==='schedule')return '開催するクラスの一覧';
 if(target==='mypage')return 'マイページ';
 if(target==='application')return 'お申し込みフォーム';
 if(target==='contact')return 'お問い合わせフォーム';
 if(style==='restaurant' && target==='menu') return '料理メニュー';
 return target==='access'?'住所と行き方':target==='menu'?'メニューのご案内':target==='products'?'商品のご案内':'ご案内ページ';
}


/** ご案内の下書きにだけ置く文章。公開前の確認でも同じ値を使う。 */
export function initialMenuDocumentText(target:InitialMenuTarget):string {
 const text:Partial<Record<InitialMenuTarget,string>>={menu:'メニューと料金を入力してください。',access:'住所と行き方を入力してください。',about:'お店・会社・教室のご案内を入力してください。',news:'お知らせを入力してください。',guide:'ご利用方法をご案内してください。',products:'商品のご案内と、お店のオンラインストアへのリンクを入力してください。'};
 return text[target]??'';
}
