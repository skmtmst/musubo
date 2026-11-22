import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../worker-env.js';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { seedAssignmentFixture } from '../test-utils/assignment-fixture.js';
import { useSqliteClock } from '../test-utils/sqlite-clock.js';
import { paymentPeriod, paymentSummary } from '../features/booking/booking-payment-admin.js';
const access=vi.hoisted(()=>({allow:true}));
vi.mock('../services/account-access.js',()=>({
  canAccessAllLineAccounts:vi.fn(async()=>access.allow),canAccessLineAccount:vi.fn(async()=>access.allow),
  getVisibleLineAccountScope:vi.fn(async()=>({ids:['a'],isAccountScoped:true})),
}));
import { bookingPaymentAdmin } from './booking-payment-admin.js';
import { restaurantTest } from './restaurant-test.js';
let f:SqliteD1;
let role:'owner'|'admin'|'staff'='owner',readOnly=false;
const now=new Date('2026-10-15T04:00:00Z');
function request(path:string,method='GET',body?:unknown,extra:Record<string,string>={}) {
  const app=new Hono<Env>();
  app.use('*',async(c,next)=>{c.set('staff',{id:'login',name:'試験',role,readOnly});await next();});
  app.route('/',bookingPaymentAdmin);app.route('/',restaurantTest);
  return app.request(path,{method,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})},
    {DB:f.db,RESTAURANT_TEST_ENABLED:'true',DEPLOY_ENV:'test',...extra} as Env['Bindings']);
}
const path=(part:string)=>`/api/booking/admin/${part}?account_id=a`;
let sequence=0;
function booking(id:string,account='a',status='requested',starts='2026-10-15T03:00:00Z') {
  const n=++sequence;
  f.raw.prepare(`INSERT INTO bookings(id,line_account_id,friend_id,staff_id,menu_id,starts_at,ends_at,block_ends_at,status,price_at_booking,requested_at)
    VALUES(?,?,?,?,?,?,?,?,?,1000,?)`).run(id,account,account==='a'?'f':'fb',account==='a'?'s1':'other',account==='a'?'m':'mb',
    starts,`2026-10-16T${String(n).padStart(2,'0')}:00:00Z`,`2026-10-16T${String(n).padStart(2,'0')}:00:00Z`,status,'2026-10-10T04:00:00Z');
}
function payment(id:string,status='paid',account='a',created='2026-10-10T04:00:00Z',paid:string|null='2026-10-10T04:00:00Z',updated='2026-10-10T04:00:00Z') {
  booking(id+'b',account);
  // 期限切れが無関係な試験へ混ざらないよう、既定の fixture は有効にし、期限・時計ずれの試験だけで個別指定する。
  f.raw.prepare(`INSERT INTO booking_payments(id,line_account_id,booking_id,amount,status,provider,provider_payment_id,idempotency_key,created_at,updated_at,paid_at,hold_until)
    VALUES(?,?,?,1000,?,'stripe',?,?,?,?,?,?)`).run(id,account,id+'b',status,`pi_test_${id}b`,id+'b',created,updated,paid,'2099-12-31T00:00:00Z');
}
beforeEach(()=>{
  vi.useFakeTimers();vi.setSystemTime(now);vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('外部通信は禁止');}));
  f=createTestD1({now:()=>new Date()});seedAssignmentFixture(f);access.allow=true;role='owner';readOnly=false;sequence=0;
  f.raw.exec(`INSERT INTO friends(id,line_user_id,display_name,line_account_id) VALUES('f','Utest','山田','a'),('fb','Uother','別店の秘密','b');
    INSERT INTO menus(id,line_account_id,name,duration_minutes,base_price) VALUES('mb','b','別店のメニュー',30,1000);
    INSERT INTO events(id,line_account_id,name) VALUES('ev','a','試験クラス'),('evb','b','別クラス');
    INSERT INTO rt_menu_items(id,store_id,kind,name,price) VALUES('course','store','course','コース',1000),('other-course','other-store','course','別コース',1000);`);
});
afterEach(()=>{f.raw.close();vi.useRealTimers();vi.unstubAllGlobals();});

describe('支払い管理の読取・集計・書出し',()=>{
  it('顧客を削除した決済を区別し、他の決済には印を付けない',async()=>{
    payment('removed');payment('normal');
    f.raw.exec("UPDATE booking_payments SET booking_id=NULL,customer_redacted_at='2026-10-12T00:00:00Z' WHERE id='removed'");
    const body=await (await request(path('payments'))).json() as {data:{items:Array<{id:string;customerRedacted:number;friendName:string|null}>}};
    expect(body.data.items).toEqual(expect.arrayContaining([expect.objectContaining({id:'removed',customerRedacted:1,friendName:null}),expect.objectContaining({id:'normal',customerRedacted:0,friendName:'山田'})]));
  });
  it('模擬Stripeを実接続として表示せず、鍵・日時・アカウントを捏造しない',async()=>{
    const r=await request(path('payment-connection'),'GET',undefined,{STRIPE_TEST_WEBHOOK_SECRET:'fixture-secret'});
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({success:true,data:{connected:false,testMode:true,accountIdTail:null,connectedAt:null,dashboardUrl:null}});
  });
  it('所属する生きたメニューの上書きだけを返す',async()=>{
    f.raw.exec(`INSERT INTO booking_payment_menu_settings VALUES('m','a','customer_choice','stripe','2026-10-01','2026-10-01'),('mb','b','online','stripe','2026-10-01','2026-10-01')`);
    expect(await (await request(path('menu-payments'))).json()).toEqual({success:true,data:{menus:[{menuId:'m',mode:'customer_choice'}]}});
    f.raw.exec("UPDATE menus SET deleted_at='2026-10-15' WHERE id='m'");
    expect(await (await request(path('menu-payments'))).json()).toMatchObject({data:{menus:[]}});
  });
  it('ページ・検索・状態・方法の条件を付け、別アカウントの支払いを混ぜない',async()=>{
    payment('p');payment('wait','unpaid');payment('foreign','paid','b');
    const r=await request(path('payments')+'&limit=1');const data=(await r.json() as {data:{total:number;items:unknown[]}}).data;
    expect(data.total).toBe(2);expect(data.items).toHaveLength(1);
    expect(await (await request(path('payments')+'&status=pending&method=online&q=山田')).json())
      .toMatchObject({data:{total:1,items:[{id:'wait',status:'pending',method:'online',friendName:'山田',receiptUrl:null}]}});
    expect(await (await request(path('payments')+'&offset=1&limit=1')).json()).toMatchObject({data:{items:[{id:'wait'}]}});
    expect(await (await request(path('payments')+'&q=%25')).json()).toMatchObject({data:{total:0}});
  });
  it('店払いの保存済み選択を表示し、店の現在設定から昔の入金を作らない',async()=>{
    booking('onsite');booking('legacy');payment('failed','failed');
    f.raw.exec(`INSERT INTO booking_payment_choices VALUES('onsite','a','onsite','onsite',10)`);
    expect(await (await request(path('payments')+'&method=onsite')).json())
      .toMatchObject({data:{total:1,items:[{id:'onsite:onsite',status:'onsite',amount:1000}]}});
    expect(await (await request(path('payments'))).json()).toMatchObject({data:{total:1,summary:{paidAmount:0,pendingCount:0}}});
  });
  it('今月の入金と返金を分け、先月の入金・支払いだけ期限切れの確定予約を数えない',async()=>{
    payment('p');payment('refund','refunded');payment('old-refund','refunded','a','2026-09-02T00:00:00Z','2026-09-02T00:00:00Z');
    payment('lost','expired');payment('kept','expired');payment('wait','pending');payment('foreign','paid','b');
    f.raw.exec("UPDATE bookings SET status='expired' WHERE id='lostb'; UPDATE bookings SET status='confirmed' WHERE id='keptb'");
    expect(await paymentSummary(f.db,'a',now)).toMatchObject({paidAmount:2000,paidCount:2,refundedAmount:2000,refundedCount:2,expiredCount:1,pendingCount:1});
    expect(await (await request(path('payments')+'&q=見つからない&period=7d&limit=1')).json())
      .toMatchObject({data:{total:0,summary:{paidAmount:2000,refundedAmount:2000}}});
  });
  it('月初の境界は店のタイムゾーンで計算し夏時間も扱う',async()=>{
    expect(await paymentPeriod(f.db,'a','month',now)).toEqual({from:'2026-09-30T15:00:00.000Z',to:'2026-10-31T15:00:00.000Z'});
    f.raw.exec("INSERT INTO booking_settings(line_account_id,timezone) VALUES('a','America/New_York')");
    expect(await paymentPeriod(f.db,'a','month',new Date('2026-11-15T00:00:00Z')))
      .toEqual({from:'2026-11-01T04:00:00.000Z',to:'2026-12-01T05:00:00.000Z'});
    const {from,to}=await paymentPeriod(f.db,'a','7d',now);expect(Date.parse(to)-Date.parse(from)).toBe(7*86400000);
  });
  it('CSVは同じ検索の全件を出し、数式と引用符を安全にする。内部メモや秘密値は出さない',async()=>{
    payment('p');payment('q');f.raw.exec(`UPDATE friends SET display_name=' =SUM(1,2)' WHERE id='f'; UPDATE menus SET name='相談"改行' WHERE id='m'; UPDATE bookings SET internal_note='内密'`);
    const r=await request(path('payments/export')+'&limit=1&offset=1');expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/csv');expect(r.headers.get('content-disposition')).toContain('attachment');
    const csv=await r.text();expect(csv).toContain("' =SUM(1,2)");expect(csv).toContain('相談""改行');expect(csv).not.toContain('内密');
    expect(csv).toContain('"p"');expect(csv).toContain('"q"');expect(csv).not.toContain('provider_payment');
  });
  it('1万件を超えるCSVを途中までの成功として渡さない',async()=>{
    booking('large');
    f.raw.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10001)
      INSERT INTO booking_payments(id,line_account_id,booking_id,amount,status,provider,idempotency_key,created_at,updated_at)
      SELECT 'p'||x,'a','large',0,'paid','stripe','key'||x,'2026-10-10T00:00:00Z','2026-10-10T00:00:00Z' FROM n`);
    const r=await request(path('payments/export'));expect(r.status).toBe(413);
    expect(await r.json()).toMatchObject({code:'export_too_large',maxRows:10000});
  });
  it('入金日時が店の月初ぴったりなら今月、直前と翌月初は含めない',async()=>{
    payment('before','paid','a','2026-09-30T14:59:59Z','2026-09-30T14:59:59Z');
    payment('boundary','paid','a','2026-09-30T15:00:00Z','2026-09-30T15:00:00Z');
    payment('next','paid','a','2026-10-31T15:00:00Z','2026-10-31T15:00:00Z');
    expect(await paymentSummary(f.db,'a',now)).toMatchObject({paidAmount:1000,paidCount:1});
  });
  it.each(['limit=0','limit=101','limit=1.5','limit=-1','offset=NaN','offset=100001','period=year','status=failed','method=cash','q='+ 'a'.repeat(201)])('不正な条件を400で拒否する: %s',async query=>{
    expect((await request(path('payments')+'&'+query)).status).toBe(400);
  });
  it('担当者ごとに今日の予定・確定・完了を数え、取消・翌日・別店を除く。0件の人も返す',async()=>{
    booking('a1');booking('a2','a','confirmed');booking('a3','a','completed');booking('cancel','a','cancelled');
    booking('next','a','requested','2026-10-15T15:00:00Z');booking('other','b');
    expect(await (await request(path('staff/today-counts'))).json()).toMatchObject({data:{date:'2026-10-15',timezone:'Asia/Tokyo',items:[{staffId:'s1',todayCount:3},{staffId:'s2',todayCount:0}]}});
  });
});

describe('範囲・未準備・模擬リンク',()=>{
  it('接続情報の実データから末尾だけを返し、切断済みを接続中と表示しない',async()=>{
    f.raw.exec(`INSERT INTO booking_payment_connections(line_account_id,provider,provider_account_id,test_mode,connected_at)
      VALUES('a','stripe','acct_test123456',1,'2026-10-01T00:00:00Z')`);
    const data=await (await request(path('payment-connection'))).json();
    expect(data).toMatchObject({data:{connected:true,testMode:true,accountIdTail:'3456',connectedAt:'2026-10-01T00:00:00Z'}});
    expect(JSON.stringify(data)).not.toContain('acct_test123456');
    f.raw.exec("UPDATE booking_payment_connections SET disconnected_at='2026-10-02T00:00:00Z'");
    expect(await (await request(path('payment-connection'))).json()).toMatchObject({data:{connected:false,accountIdTail:null,connectedAt:null}});
  });
  it('クラスの単価と支払い方法を独立に保存し、古い版と不正な金額を拒否する',async()=>{
    const p='/api/events/admin/events/ev/';
    expect(await (await request(p+'price?account_id=a')).json()).toMatchObject({data:{unitPrice:0,version:0}});
    expect(await (await request(p+'payment?account_id=a','PUT',{mode:'online',expectedVersion:0})).json()).toMatchObject({data:{mode:'online',version:1}});
    expect((await request(p+'price?account_id=a','PUT',{unitPrice:1500,expectedVersion:0})).status).toBe(409);
    expect(await (await request(p+'price?account_id=a','PUT',{unitPrice:1500,expectedVersion:1})).json()).toMatchObject({data:{unitPrice:1500,version:2}});
    expect(await (await request(p+'payment?account_id=a')).json()).toMatchObject({data:{mode:'online',version:2}});
    expect((await request(p+'payment?account_id=a','PUT',{mode:null,expectedVersion:2})).status).toBe(200);
    expect(await (await request(p+'price?account_id=a')).json()).toMatchObject({data:{unitPrice:1500,version:3}});
    for(const unitPrice of [-1,1.5,'100',null,Number.MAX_SAFE_INTEGER+1])
      expect((await request(p+'price?account_id=a','PUT',{unitPrice})).status).toBe(400);
    expect((await request(p+'payment?account_id=a','PUT',{mode:'cash'})).status).toBe(400);
    expect((await request(p+'price?account_id=a','PUT',{})).status).toBe(400);
    role='staff';expect((await request(p+'price?account_id=a','PUT',{unitPrice:0})).status).toBe(403);
  });
  it('コースの解除はnullを保存し、同じ版の同時更新は片方だけが成功する',async()=>{
    const p='/api/restaurant-test/menus/course/payment?account_id=a';
    const results=await Promise.all(['online','onsite'].map(mode=>request(p,'PUT',{mode,expectedVersion:0})));
    expect(results.map(r=>r.status).sort()).toEqual([200,409]);
    expect((await request(p,'PUT',{mode:null,expectedVersion:1})).status).toBe(200);
    expect(await (await request(p)).json()).toMatchObject({data:{mode:null,version:2}});
    expect((await request(p,'PUT',{mode:'bad'})).status).toBe(400);
    f.raw.exec('DROP TABLE restaurant_course_payment_settings');
    expect(await (await request(p)).json()).toMatchObject({code:'course_payment_storage_not_ready'});
  });
  it('上書きの一覧にコースとクラスも含め、解除済み・別店を混ぜない',async()=>{
    await request('/api/restaurant-test/menus/course/payment?account_id=a','PUT',{mode:'onsite'});
    await request('/api/events/admin/events/ev/payment?account_id=a','PUT',{mode:'customer_choice'});
    expect(await (await request(path('menu-payments'))).json()).toMatchObject({data:{menus:[{menuId:'course',mode:'onsite'},{menuId:'ev',mode:'customer_choice'}]}});
    await request('/api/events/admin/events/ev/payment?account_id=a','PUT',{mode:null});
    expect(await (await request(path('menu-payments'))).json()).toMatchObject({data:{menus:[{menuId:'course',mode:'onsite'}]}});
    f.raw.exec("UPDATE rt_menu_items SET status='archived' WHERE id='course'");
    expect(await (await request(path('menu-payments'))).json()).toMatchObject({data:{menus:[]}});
  });
  it('返金日時を後の更新から独立させ、保存した領収書URLを返す',async()=>{
    payment('refund','refunded','a','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z','2026-10-10T00:00:00Z');
    f.raw.exec("UPDATE booking_payments SET refunded_at='2026-09-30T14:59:59Z',receipt_url='https://pay.stripe.com/receipts/test'");
    expect(await paymentSummary(f.db,'a',now)).toMatchObject({refundedAmount:0,refundedCount:0});
    expect(await (await request(path('payments')+'&period=90d')).json()).toMatchObject({data:{items:[{receiptUrl:'https://pay.stripe.com/receipts/test'}]}});
    f.raw.exec("UPDATE booking_payments SET refunded_at='2026-09-30T15:00:00Z'");
    expect(await paymentSummary(f.db,'a',now)).toMatchObject({refundedAmount:1000,refundedCount:1});
  });
  it.each(['payment-connection','menu-payments','payments','payments/export','staff/today-counts','payment-events'])('所属外・存在しないアカウントを拒否する: %s',async endpoint=>{
    access.allow=false;expect((await request(path(endpoint))).status).toBe(404);access.allow=true;
    expect((await request(`/api/booking/admin/${endpoint}`)).status).toBe(400);
    expect((await request(path(endpoint).replace('account_id=a','account_id=missing'))).status).toBe(404);
  });
  it('未移行を503で返し、壊れた表を未移行や空の成功にすり替えない',async()=>{
    f.raw.exec('ALTER TABLE booking_payment_menu_settings RENAME COLUMN mode TO broken');
    const broken=await request(path('menu-payments'));expect(broken.status).toBe(503);
    expect(await broken.json()).toMatchObject({code:'payment_admin_unavailable'});
    f.raw.exec('DROP TABLE booking_payment_choices');
    const missing=await request(path('payments'));expect(missing.status).toBe(503);
    expect(await missing.json()).toMatchObject({code:'payment_storage_not_ready'});
  });
  it('通知原本の保存先がなければ一覧・再読込は503。閲覧のみとstaffの再読込は403',async()=>{
    f.raw.exec('DROP TABLE booking_payment_event_replays; DROP TABLE booking_payment_events');
    expect((await request(path('payment-events'))).status).toBe(503);
    expect((await request(path('payment-events/evt/replay'),'POST',{})).status).toBe(503);
    readOnly=true;expect((await request(path('payment-events/evt/replay'),'POST',{})).status).toBe(403);
    readOnly=false;role='staff';expect((await request(path('payment-events/evt/replay'),'POST',{})).status).toBe(403);
  });
  it.each(['payment','price'])('クラスの%sは所属確認後に保存、別店は404、閲覧のみ保存は403',async suffix=>{
    const p=`/api/events/admin/events/ev/${suffix}?account_id=a`;
    expect((await request(p)).status).toBe(200);expect((await request(p,'PUT',{mode:'online',unitPrice:1000})).status).toBe(200);
    expect((await request(p.replace('/ev/','/evb/'))).status).toBe(404);
    readOnly=true;expect((await request(p,'PUT',{})).status).toBe(403);
  });
  it('コースの支払いは飲食の機能・店・所属を守って保存する',async()=>{
    const p='/api/restaurant-test/menus/course/payment?account_id=a';
    expect((await request(p)).status).toBe(200);expect((await request(p,'PUT',{mode:'onsite'})).status).toBe(200);
    expect((await request(p.replace('/course/','/other-course/'))).status).toBe(404);
    expect((await request(p,'GET',undefined,{RESTAURANT_TEST_ENABLED:'false'})).status).toBe(404);
    readOnly=true;expect((await request(p,'PUT',{mode:null})).status).toBe(403);
  });
  it('リンクは既存の模擬支払いを再利用し、送信しない。実送信要求は拒否する',async()=>{
    payment('link','unpaid');f.raw.exec(`INSERT INTO booking_payment_configs VALUES('a','online','stripe',30,'2026-10-01','2026-10-01')`);
    const p=path('payments/link/send-link');
    expect((await request(p,'POST',{})).status).toBe(400);
    const r=await request(p,'POST',{dryRun:true});expect(r.status).toBe(200);
    const result=await r.json();expect(result).toMatchObject({data:{paymentId:'link',checkoutUrl:'https://checkout.stripe.com/test/pay/linkb',sent:false,simulation:true}});
    expect(await (await request(p,'POST',{dryRun:true})).json()).toEqual(result);
    expect(f.raw.prepare('SELECT COUNT(*) n FROM booking_payments').get()).toEqual({n:1});expect(fetch).not.toHaveBeenCalled();
    readOnly=true;expect((await request(p,'POST',{dryRun:true})).status).toBe(403);
  });
  it('別店・期限切れ・支払い済みのリンクは作れない',async()=>{
    payment('other','pending','b');payment('old','pending');payment('paid');
    f.raw.exec("UPDATE booking_payments SET hold_until='2026-10-01T00:00:00Z' WHERE id='old'");
    for(const id of ['other','old','paid'])expect((await request(path(`payments/${id}/send-link`),'POST',{dryRun:true})).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['unpaid','pending'])('SQLの時計がずれていても%sのリンク期限を開始処理と同じ時計で守る',async status=>{
    f.raw.exec(`INSERT INTO booking_payment_configs VALUES('a','online','stripe',30,'2026-10-01','2026-10-01')`);
    let databaseNow=new Date(now.getTime()+86400000);
    useSqliteClock(f.raw,()=>databaseNow);
    for (const [id,offset,expected] of [['future',1,200],['boundary',0,404],['past',-1,404],['unlimited',null,200]] as const) {
      payment(id,status);
      // SQLが進んでいても期限内なら利用可能。SQLが遅れていても期限と同時から拒否する。
      databaseNow=new Date(now.getTime()+(expected===200?86400000:-86400000));
      f.raw.prepare('UPDATE booking_payments SET hold_until=? WHERE id=?')
        .run(offset===null?null:new Date(now.getTime()+offset).toISOString(),id);
      const response=await request(path(`payments/${id}/send-link`),'POST',{dryRun:true});
      expect(response.status).toBe(expected);
      if(expected===200)expect(await response.json()).toMatchObject({data:{paymentId:id,sent:false,simulation:true}});
      else expect(await response.json()).toMatchObject({error:'payment_not_available'});
    }
    expect(f.raw.prepare('SELECT COUNT(*) n FROM booking_payments').get()).toEqual({n:4});
    expect(fetch).not.toHaveBeenCalled();
  });
});
