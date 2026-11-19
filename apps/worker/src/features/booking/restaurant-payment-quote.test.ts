import {beforeEach,afterEach,expect,it} from 'vitest';
import {gapFixture} from '../../test-utils/gap1.js';
import {restaurantPaymentQuote} from './restaurant-payment-quote.js';
let f:ReturnType<typeof gapFixture>;
const base={accountId:'a',friendId:'f',storeId:'store',courseId:'course',guestCount:3,startsAt:'2099-10-20T01:00:00Z',timezone:'Asia/Tokyo'};
beforeEach(()=>{f=gapFixture();f.raw.exec(`INSERT INTO rt_organizations(id,account_id,name) VALUES('org','a','組織');
 INSERT INTO rt_stores(id,organization_id,name,code,line_account_id) VALUES('store','org','店','s','a');
 INSERT INTO rt_menu_items(id,store_id,kind,name,price,duration_minutes,allergens_json) VALUES('course','store','course','コース',8400,90,'[]');
 INSERT INTO booking_payment_configs(line_account_id,mode,provider,hold_minutes,created_at,updated_at) VALUES('a','online','stripe',10,datetime('now'),datetime('now'));`);});
afterEach(()=>f.raw.close());
it('コース単価×人数を全額先払いにする',async()=>{expect(await restaurantPaymentQuote(f.db,base)).toMatchObject({unitPrice:8400,total:25200,amount:25200,remaining:0,kind:'online'});});
it('予約金の割合を人数込みの合計から計算する',async()=>{
 const rule={kind:'percent',value:30,conditions:{always:true,minPeople:null,weekdays:null,timeBand:null}};
 f.raw.prepare('INSERT INTO booking_deposit_rules(account_id,scope_id,rule_json,inherit,updated_at) VALUES(?,?,?,?,datetime(\'now\'))').run('a','course:course',JSON.stringify(rule),0);
 expect(await restaurantPaymentQuote(f.db,base)).toMatchObject({unitPrice:8400,total:25200,amount:7560,remaining:17640,kind:'deposit'});
});
it('別の店のコースと、お客さまが選ぶ方法の省略を拒む',async()=>{
 await expect(restaurantPaymentQuote(f.db,{...base,storeId:'other'})).rejects.toMatchObject({code:'invalid_course'});
 f.raw.exec("UPDATE booking_payment_configs SET mode='customer_choice' WHERE line_account_id='a'");
 await expect(restaurantPaymentQuote(f.db,base)).rejects.toMatchObject({code:'payment_method_required'});
 expect(await restaurantPaymentQuote(f.db,{...base,paymentMethod:'onsite'})).toMatchObject({total:25200,amount:0});
});
