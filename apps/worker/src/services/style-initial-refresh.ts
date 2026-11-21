import { styleMenuActionData } from './style-menu-action-data.js';
import { initialMenuImageKey, type AccountStyle, type RestaurantGuideMenu } from '@line-crm/shared';
import { initialMenuButtons, type PlannedInitialForms } from './style-initial-buttons.js';

/** 作成済みの4面下書きだけ。店が編集したかどうかは呼出側の写しの照合で守る。 */
export async function initialMenuNeedsRefresh(db:D1Database,account:string,id:string,style:AccountStyle,planned?:PlannedInitialForms,preset?:RestaurantGuideMenu) {
 const page=await db.prepare("SELECT p.id,p.image_r2_key FROM rich_menu_groups g JOIN rich_menu_pages p ON p.id=g.default_page_id WHERE g.id=? AND g.account_id=? AND g.status='draft'").bind(id,account).first<{id:string;image_r2_key:string|null}>();
 if(!page||page.image_r2_key!==initialMenuImageKey(account,style,preset))return false;
 const rows=(await db.prepare('SELECT bounds_x x,bounds_y y,bounds_width width,bounds_height height,action_type actionType,action_data actionData,intent,label,form_id formId FROM rich_menu_areas WHERE page_id=? ORDER BY bounds_y,bounds_x').bind(page.id).all()).results;
 const buttons=await initialMenuButtons(db,account,style,planned,preset);
 if(rows.length!==buttons.length)return false;
 const expected=buttons.map(button=>({...button.bounds,actionType:button.actionType,actionData:styleMenuActionData(button),intent:button.intent,label:button.label,formId:button.formId??null}));
 expected.sort((a,b)=>(a.y??0)-(b.y??0)||(a.x??0)-(b.x??0));
 return JSON.stringify(rows)!==JSON.stringify(expected);
}
