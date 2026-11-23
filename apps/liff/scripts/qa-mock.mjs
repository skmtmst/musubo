/**
 * LIFF 撮影モード専用の偽 API。node で :8790 に立つ。
 *
 * 使い方: `node apps/liff/scripts/qa-mock.mjs`
 * 形は Worker の実装 (apps/worker/src/routes/booking.ts・events.ts・
 * webinars.ts・forms.ts・affiliate-self.ts) と LIFF 側の読み方
 * (apps/liff/src/lib/api.ts・pages/Affiliate.tsx) に合わせる。
 * 実在の個人情報は入れない。
 *
 * フォーム (GET /api/forms/:id・/my-latest) は本物の Worker と同じく
 * {success:true,data} の包みで返す。LIFF の api.getForm・getMyLatestFormAnswer が
 * その境界で中身を取り出す (lib/form-api-contract.test.ts が両方を同じ契約で見張る)。
 *
 * 撮影の操作口:
 *   POST /__qa/state { delayMs, fail }  delayMs=応答を遅らせるms(読み込み中を撮る)
 *                                       fail="all" かパスの接頭辞の配列(500を返す)
 *   POST /__qa/reset                   上を元に戻す
 *   GET  /__qa/state                   今の設定を見る
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.QA_MOCK_PORT ?? 8790);

/* features：③-2 第2弾の画面（waitlist・waitlist-expired・party・recurring・lesson・routed など）を出すときだけ撮影が足す。既定は空＝今までの見本のまま。 */
const state = { delayMs: 0, fail: null, features: [], lookTheme: 'default' };
let qaAvailableMiles = 1250;
let qaBankProfile = null;
const qaRedemptions = new Map();
const qaPrefs = [
  { purpose: 'booking_reminders', label: '予約のお知らせ', state: 'granted', enabled: true, recorded: true, version: 1, updatedAt: null },
  { purpose: 'marketing', label: 'キャンペーン・宣伝', state: 'granted', enabled: true, recorded: true, version: 1, updatedAt: null },
];
const qaBankSaves = new Map();

// 見本の言葉・日付は ★V8 の絵 (・・ など) に合わせる。
const QA_EVENT = {
  id: 'qa-event-1',
  name: '秋のわんこ撮影会',
  venue_name: '然 渋谷店 2F',
  venue_url: null,
  image_url: null,
  description: 'プロのカメラマンが撮影します。おやつ付き。',
  description_centered: 0,
  max_bookings_per_friend: 3,
  requires_approval: 0,
  cancel_deadline_hours_before: 16,
  waitlist_enabled: 1,
};

const QA_SLOTS = [
  {
    id: 'qa-slot-1',
    event_id: 'qa-event-1',
    starts_at: '2026-10-11T10:00:00+09:00',
    ends_at: '2026-10-11T11:00:00+09:00',
    capacity: 5,
    is_active: 1,
    active_count: 3,
    remaining: 2,
  },
  {
    id: 'qa-slot-2',
    event_id: 'qa-event-1',
    starts_at: '2026-10-11T11:00:00+09:00',
    ends_at: '2026-10-11T12:00:00+09:00',
    capacity: 5,
    is_active: 1,
    active_count: 5,
    remaining: 0,
  },
];

const QA_EVENT_BOOKING = {
  id: 'qa-event-booking-1',
  event_id: 'qa-event-1',
  status: 'confirmed',
  customer_note: null,
  event_name: '秋のわんこ撮影会',
  event_image_url: null,
  venue_name: '然 渋谷店 2F',
  venue_url: 'https://example.com/qa-hall',
  cancel_deadline_hours_before: 16,
  slot_starts_at: '2026-10-11T10:00:00+09:00',
  slot_ends_at: '2026-10-11T11:00:00+09:00',
};

/** キャンセル待ちの2番目 ( の2行目)。 */
const QA_EVENT_WAITLIST = {
  ...QA_EVENT_BOOKING,
  id: 'qa-event-booking-2',
  status: 'waitlisted',
  waitlist_position: 2,
  slot_starts_at: '2026-10-11T11:00:00+09:00',
  slot_ends_at: '2026-10-11T12:00:00+09:00',
};

/** 自分のキャンセル待ちの行 (GET /api/liff/events/me/waitlist・EventWaitlistMine の形)。qa-slot-2 の 2 番目。 */
const QA_EVENT_WAITLIST_MINE = {
  source: 'waitlist',
  id: 'qa-event-waitlist-1',
  event_id: 'qa-event-1',
  slot_id: 'qa-slot-2',
  status: 'waiting',
  customer_note: null,
  event_name: '秋のわんこ撮影会',
  event_image_url: null,
  venue_name: '然 渋谷店 2F',
  venue_address: null,
  venue_url: null,
  cancel_deadline_hours_before: null,
  slot_starts_at: '2026-10-11T11:00:00+09:00',
  slot_ends_at: '2026-10-11T12:00:00+09:00',
  party_size: 1,
  created_at: '2026-10-02T09:00:00+09:00',
  offer_expires_at: null,
  queue_position: 2,
};

// 紹介のリンク・案件は ★V8  の言葉に合わせる (秋の定期便キャンペーン・鹿肉ふりかけ)。
const QA_LINK = {
  refCode: 'QA1234',
  label: 'ブログ用',
  url: 'https://lin.ee/ref-QA1234',
  clickCount: 12,
  friendAdds: 4,
  conversions: 2,
  conversionsPending: 0,
  conversionsApproved: 2,
  offerId: 'qa-offer-1',
  offerName: '秋の定期便キャンペーン',
};

// ---- 飲食店の席の予約の見本 ----
const SEAT_QA_NOW = Date.parse('2026-10-07T00:00:00Z');
const SEAT_STORE = { id: 'qa-store', name: '然 - NEN - 本店', timezone: 'Asia/Tokyo' };
const seatBookings = new Map();
/** 1日の席：17:00〜21:00 を 30 分ごと。19:00 は残り1席、19:30・21:00 は満席。10/12 は臨時休業で全部満席。 */
function seatSlots(date, durationMinutes = 120) {
  if (date < '2026-10-07') return null;
  const closed = date === '2026-10-12';
  return ['17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00'].map((hm) => {
    const startsAt = new Date(`${date}T${hm}:00+09:00`).toISOString();
    const full = closed || hm === '19:30' || hm === '21:00';
    return {
      startsAt,
      endsAt: new Date(Date.parse(startsAt) + durationMinutes * 60000).toISOString(),
      available: !full,
      remainingTables: full ? 0 : hm === '19:00' ? 1 : 4,
      // API-11：空いている候補卓の種類と、空いていない理由（10/12 は臨時休業）。
      seatTypes: full ? [] : ['table'],
      ...(full ? { unavailableReason: closed ? 'temporary_closed' : 'full' } : {}),
    };
  });
}
/** 店の遅れたときの決まり（API-11 の lateArrivalPolicy）。 */
const SEAT_LATE = { cancelAfterMinutes: 15, message: '15分を過ぎてご連絡がない場合は、取り消しになることがあります' };
function seatMock(method, pathname, url, body) {
  if (method==='GET' && pathname==='/api/liff/restaurant/courses') return [200,{success:true,timezone:'Asia/Tokyo',data:[{id:'qa-course',name:'秋の鹿肉コース',durationMinutes:90,price:5000,allergens:[],photoUrl:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#e7d8bf"/><circle cx="60" cy="60" r="45" fill="#fff8ed"/><ellipse cx="60" cy="60" rx="28" ry="18" fill="#9d5942"/><circle cx="43" cy="47" r="7" fill="#718a52"/></svg>')}]}];
  if (method==='GET' && pathname==='/api/liff/restaurant/referrals') return [200,{success:true,data:[{storeId:'qa-other-store',storeName:'然 恵比寿店',distanceKm:1.2,startsAt:new Date(`${url.searchParams.get('date')}T19:30:00+09:00`).toISOString(),endsAt:new Date(`${url.searchParams.get('date')}T21:30:00+09:00`).toISOString(),bookingUrl:'https://liff.line.me/qa?page=restaurant&token=qa-other'}]}];
  if (method === 'GET' && pathname.startsWith('/api/liff/restaurant/link/')) {
    return pathname.endsWith('/qa-seat') ? [200, { success: true, data: SEAT_STORE }] : [404, { success: false, error: 'not_found' }];
  }
  if (method === 'GET' && pathname === '/api/liff/restaurant/availability') {
    const date = url.searchParams.get('date') ?? '';
    const slots = seatSlots(date, url.searchParams.get('courseId') ? 90 : 120);
    if (!slots) return [400, { success: false, error: 'invalid_date_or_unconfigured_hours' }];
    const closed = date === '2026-10-12';
    return [200, { success: true, data: { storeId: SEAT_STORE.id, date, guestCount: Number(url.searchParams.get('guestCount')), slots, ...(closed ? { unavailableReason: 'temporary_closed' } : {}), lateArrivalPolicy: SEAT_LATE, cancelDeadlineMinutesBefore: 120, cutoffMinutesBefore: 60 } }];
  }
  if (method === 'POST' && pathname === '/api/liff/restaurant/holds') {
    const b = {
      id: `qa-seat-${seatBookings.size + 1}`,
      storeId: SEAT_STORE.id,
      startsAt: body.startsAt,
      endsAt: new Date(Date.parse(body.startsAt) + (body.courseId ? 90 : 120) * 60000).toISOString(),
      guestCount: body.guestCount,
      courseId: body.courseId??null,courseName:body.courseId?'秋の鹿肉コース':null,
      status: 'pending',
      version: 1,
      holdExpiresAt: new Date(SEAT_QA_NOW + 10 * 60000).toISOString(),
      note: body.note ?? null,
      customerPhone: body.customerPhone ?? null,
      seatType: 'table',
    };
    seatBookings.set(b.id, b);
    return [201, { success: true, data: b }];
  }
  if (method === 'GET' && pathname === '/api/liff/restaurant/reservations') {
    return [200, { success: true, data: [...seatBookings.values()] }];
  }
  const m = pathname.match(/^\/api\/liff\/restaurant\/reservations\/([^/]+)\/(confirm|cancel|reschedule)$/);
  if (method === 'POST' && m) {
    const old = seatBookings.get(decodeURIComponent(m[1]));
    if (!old) return [404, { success: false, error: 'not_found' }];
    const next = { ...old, version: old.version + 1, holdExpiresAt: null, status: m[2] === 'cancel' ? 'cancelled' : 'confirmed' };
    if (m[2] === 'confirm') {
      if (body && 'note' in body) next.note = body.note ?? null;
      if (body && 'customerPhone' in body) next.customerPhone = body.customerPhone ?? null;
    }
    if (m[2] === 'reschedule') {
      next.startsAt = body.startsAt;
      next.endsAt = new Date(Date.parse(body.startsAt) + 120 * 60000).toISOString();
      next.guestCount = body.guestCount;
    }
    seatBookings.set(next.id, next);
    return [200, { success: true, data: next }];
  }
  return null;
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

function shouldFail(pathname) {
  if (state.fail === 'all') return true;
  if (Array.isArray(state.fail)) return state.fail.some((p) => pathname.startsWith(p));
  return false;
}

function webinarLive() {
  const now = Math.floor(Date.now() / 1000);
  return {
    live: true,
    title: 'はじめての子犬のしつけ講座',
    durationSeconds: 3600,
    sessionStartAt: now - 120,
    offsetSeconds: 120,
    playlistUrl: 'https://example.com/qa/master.m3u8',
    cta: { label: '個別相談を申し込む', url: 'https://example.com/qa', showAtSeconds: 60 },
    comments: [
      { atSeconds: 5, authorName: 'QA はなこ', body: '楽しみにしていました！' },
      { atSeconds: 8, authorName: 'まる', body: 'トイレの話が知りたいです' },
    ],
  };
}

/** 表紙の画像 ( の「画像」：地 #e9e2d4・店名)。外へ取りに行かないよう data URL で持つ。 */
const QA_FORM_COVER = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="343" height="96" viewBox="0 0 343 96"><rect width="343" height="96" fill="#e9e2d4"/><text x="171.5" y="54" text-anchor="middle" font-family="Noto Sans JP, sans-serif" font-size="16" font-weight="700" fill="#6b5b3e">然 - NEN -</text></svg>',
)}`;

/** 来店アンケート (★V8 の ・・)。2ページ目に予約の欄。 */
function qaForm() {
  const routed = state.features.includes('routed') || state.features.includes('routed-empty');
  return {
    id: 'qa-form-1',
    name: '来店アンケート',
    description: 'ご来店ありがとうございました。1分で終わります。',
    layout: {
      version: 2,
      header: [],
      sections: [
        {
          id: 'qa-section-1',
          name: '今日のご来店',
          blocks: [
            // ページ先頭の画像は題の上の表紙になる ( の「画像」)。
            {
              id: 'qa-b0',
              kind: 'image',
              size: 'full',
              mediaUrl: QA_FORM_COVER,
            },
            {
              id: 'qa-b1',
              kind: 'input',
              type: 'radio',
              name: '目的',
              label: '今日のご来店の目的は？',
              required: true,
              choices: [
                { label: 'トリミング', value: 'trimming', defaultSelected: true },
                { label: 'シャンプーのみ', value: 'shampoo' },
                { label: 'ご相談', value: 'consult' },
              ],
            },
            {
              id: 'qa-b2',
              kind: 'input',
              type: 'checkbox',
              name: '気になったところ',
              label: '気になったところ（いくつでも）',
              choices: [
                { label: '待ち時間', value: 'wait', defaultSelected: true },
                { label: '駐車場', value: 'parking', defaultSelected: true },
                { label: '料金', value: 'price' },
              ],
            },
          ],
        },
        {
          id: 'qa-section-2',
          name: '次回について',
          blocks: [
            {
              id: 'qa-b3',
              kind: 'input',
              type: 'booking',
              name: '次回の予約',
              label: '次回のご希望の日時を選んでください',
              required: true,
              //  は 10/14(水)〜18(日) の5日。16日は満席。
              booking: { menuId: 'qa-menu-1', staffId: 'qa-staff-form', daysAhead: 5, ...(routed ? { routing: { enabled: true, rules: [], fallback: { menuId: 'qa-menu-4' } } } : {}) },
            },
            {
              id: 'qa-b4',
              kind: 'input',
              type: 'textarea',
              name: 'ご要望',
              label: 'ご要望があればお書きください',
              placeholder: '自由にお書きください',
            },
          ],
        },
      ],
      options: {
        thanksUrl: null,
        thanksText: 'ご回答ありがとうございました',
        restorePrevious: false,
        pageTitle: '来店アンケート',
        submitLabel: '答えを送る',
        prevLabel: '前のページへ',
        nextLabel: '次へ',
        sectionHeader: 'pageNumber',
        confirmDialog: { enabled: false },
        deadline: { enabled: false },
        oncePerFriend: { enabled: false },
        totalLimit: { enabled: false },
        afterActions: [],
      },
    },
    isActive: true,
  };
}

function qaDocumentForm() {
  return {
    id: 'qa-document', name: '書類確認', description: '試験用の書類入力です。実際の書類は使わないでください。', isActive: true,
    layout: {
      version: 2, header: [],
      sections: [{ id: 'qa-document-section', name: '書類', blocks: [{
        id: 'qa-document-file', kind: 'input', type: 'file', name: 'identity', label: '本人確認書類',
        required: true, fileKind: 'identity', fileBothSides: true, fileMaxCount: 2,
      }] }],
      options: { confirmDialog: { enabled: false } },
    },
  };
}

function qaAttachmentForm() {
  const form = qaDocumentForm();
  form.id = 'qa-attachments';
  form.name = '写真・PDFの添付';
  form.layout.sections[0].blocks = [{
    id: 'qa-attachment-file', kind: 'input', type: 'file', name: 'attachment', label: '写真・PDF',
    required: true, fileKinds: ['image', 'pdf'], fileMaxCount: 2,
  }];
  return form;
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Idempotency-Key',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    });
    res.end();
    return;
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/__qa/state' && req.method === 'GET') {
    json(res, 200, state);
    return;
  }
  if (pathname === '/__qa/state' && req.method === 'POST') {
    const body = await readBody(req);
    if (typeof body.delayMs === 'number') state.delayMs = body.delayMs;
    if (body.fail === undefined || body.fail === null || body.fail === 'all' || Array.isArray(body.fail)) {
      state.fail = body.fail ?? null;
    }
    if (['default','line','natural','modern','gentle','night'].includes(body.lookTheme)) state.lookTheme = body.lookTheme;
    if (Array.isArray(body.features)) state.features = body.features.filter((f) => typeof f === 'string');
    json(res, 200, state);
    return;
  }
  if (pathname === '/__qa/reset' && req.method === 'POST') {
    state.delayMs = 0;
    state.fail = null;
    state.features = [];
    state.lookTheme = 'default';
    qaAvailableMiles = 1250;
    qaBankProfile = null;
    qaRedemptions.clear();
    qaBankSaves.clear();
    json(res, 200, state);
    return;
  }

  if (state.delayMs > 0) {
    await new Promise((r) => setTimeout(r, state.delayMs));
  }
  if (shouldFail(pathname)) {
    json(res, 500, { error: 'qa_mock_failure' });
    return;
  }

  const method = req.method ?? 'GET';

  if (method === 'GET' && pathname === '/api/liff/customer-look') { json(res, 200, { success: true, data: { settings: state.lookTheme === 'default' ? {} : { liff_theme: state.lookTheme }, version: 1 } }); return; }

  // ---- 上の帯 (店名) ----
  if (method === 'GET' && pathname === '/api/liff/config') {
    json(res, 200, {
      success: true,
      data: { botBasicId: '@qa', accountName: '然 - NEN -', accountId: 'qa-account', style: 'salon' },
    });
    return;
  }

  // ---- 来店スタンプ (★V8 ・・・・) ----
  // カード1枚・6個たまった本人。特典を見せる→店員の暗証番号で使用済み→残り 1個（サーバは特典の個数だけ減らす）。
  {
    const card = {
      id: 'vs-card-1', name: '然 来店スタンプカード', accountIds: ['qa-account'], active: true, version: 1, expectedVersion: 1,
      settings: {
        mode: 'visit', amountUnit: 1000, maxPerVisit: 3, firstVisitBonus: 0, expiryMonths: 6, timezone: 'Asia/Tokyo',
        multipliers: [], rankMultipliers: [],
        rewards: [{ id: 'reward-drink', name: 'ドリンク 1杯', stamps: 5 }, { id: 'reward-dessert', name: 'デザート 1品', stamps: 10 }],
      },
    };
    const wallet = { cardId: 'vs-card-1', friendId: 'qa-friend', balance: 6, earnedTotal: 6, expiresAt: '2026-07-13T03:00:00.000Z' };
    if (method === 'GET' && pathname === '/api/liff/visit-stamps/cards') {
      json(res, 200, { success: true, data: [{ card, wallet }] });
      return;
    }
    if (method === 'GET' && pathname === '/api/liff/visit-stamps/cards/vs-card-1') {
      json(res, 200, { success: true, data: { card, wallet, entries: [] } });
      return;
    }
    if (method === 'POST' && pathname === '/api/liff/visit-stamps/cards/vs-card-1/rewards') {
      json(res, 201, { success: true, data: { id: 'vs-redeem-1', cardId: 'vs-card-1', rewardId: 'reward-drink', rewardName: 'ドリンク 1杯', stamps: 5, status: 'offered' } });
      return;
    }
    if (method === 'POST' && pathname === '/api/liff/visit-stamps/redemptions/vs-redeem-1/use') {
      // 暗証番号だけで店員を当てる（API-10）。使った店員の名前を返す（ の「担当」）。
      json(res, 200, { success: true, data: { id: 'vs-redeem-1', status: 'used', staffId: 'staff-tamura', staffName: '田村' } });
      return;
    }
    // 自分の紙のカードの申請（確認待ち  は map の api で確認待ちを1件返す）。ふだんは無し。
    if (method === 'GET' && pathname === '/api/liff/visit-stamps/cards/vs-card-1/paper-requests') {
      json(res, 200, { success: true, data: [] });
      return;
    }
    // 紙のカードの写真を預ける（multipart）。中身は読み捨て、本人だけが読める URL を返す。
    if (method === 'POST' && pathname === '/api/liff/visit-stamps/cards/vs-card-1/paper-photos') {
      for await (const _chunk of req) { /* 読み捨て */ }
      json(res, 201, { success: true, data: { id: 'vs-photo-1', photoUrl: 'https://qa.example/api/liff/visit-stamps/paper-photos/vs-photo-1', contentType: 'image/jpeg', size: 1024 } });
      return;
    }
    if (method === 'POST' && pathname === '/api/liff/visit-stamps/cards/vs-card-1/paper-requests') {
      json(res, 201, { success: true, data: { id: 'vs-paper-1', status: 'pending' } });
      return;
    }
  }

  // ---- 答えで予約の行き先を分ける（③-2 第2弾 B6：Z76uuv・R02q7）。features に routed があるときだけフォームを書き換える ----
  if (method === 'POST' && /^\/api\/liff\/forms\/[^/]+\/routing\/resolve$/.test(pathname)) {
    json(res, 200, { success: true, data: { matchedIndex: 1, routingToken: 'qa-routing-token', expiresAt: '2026-10-16T05:00:00.000Z', target: { menuId: 'qa-menu-online', staffId: state.features.includes('routed-empty') ? 'qa-staff-empty' : 'qa-staff-1', meetingMode: 'online' } } });
    return;
  }
  // ---- 繰り返しの確かめ（B4・口はまだ無い。見本：3 回目だけ取れない）----
  if (method === 'POST' && pathname === '/api/liff/booking/series/preview') {
    const body = await readBody(req);
    const start = Date.parse(body.starts_at);
    const count = Math.min(Math.max(Number(body.count) || 4, 2), 12);
    json(res, 200, { occurrences: Array.from({ length: count }, (_, i) => {
      const at = start + i * 7 * 86_400_000;
      const blocked = i === 2;
      return { index: i, starts_at: new Date(at).toISOString(), available: !blocked, ...(blocked ? { reason: 'お休み' } : {}), alternatives: blocked ? [1, 2, 3].map((h) => new Date(at + h * 3_600_000).toISOString()) : [] };
    }) });
    return;
  }
  // ---- 追加メニュー（③-2 第2弾 B5：hhUtj）。features に party があるときだけ。形は API-CONTRACT-GAP2 のとおり ----
  if (method === 'GET' && /^\/api\/liff\/booking\/menus\/[^/]+\/addons$/.test(pathname)) {
    json(res, 200, { success: true, data: state.features.includes('party') && pathname.includes('qa-menu-1') ? [{ id: 'qa-addon-1', name: '歯みがき', duration_minutes: 15, base_price: 800, version: 1 }, { id: 'qa-addon-2', name: '爪切り', duration_minutes: 10, base_price: 500, version: 1 }] : [] });
    return;
  }
  // ---- キャンセル待ち（③-2 第2弾：Zm2Vh・xANkO）。features に waitlist / waitlist-expired があるときだけ行を返す ----
  if (method === 'GET' && pathname === '/api/liff/booking/waitlist') {
    const base = { staff_id: 'qa-staff-1', menu_id: 'qa-menu-1', hold_minutes: 30, created_at: '2026-10-15T01:00:00.000Z', menu_name: 'トリミング（小型犬）', staff_name: '佐々木' };
    const rows = [];
    if (state.features.includes('waitlist')) {
      rows.push({ ...base, id: 'qa-wl-1', starts_at: '2026-11-20T05:00:00.000Z', status: 'invited', hold_expires_at: new Date(Date.now() + 18 * 60_000 - 1000).toISOString(), position: 1 });
    }
    if (state.features.includes('waitlist-expired')) {
      rows.push({ ...base, id: 'qa-wl-3', starts_at: '2026-11-20T05:00:00.000Z', status: 'finished', hold_expires_at: '2026-10-16T02:00:00.000Z', position: 1, hold_minutes: 18 });
    }
    if (state.features.includes('waitlist') || state.features.includes('waitlist-expired')) {
      rows.push({ ...base, id: 'qa-wl-2', menu_id: 'qa-menu-3', menu_name: 'シャンプーのみ', starts_at: '2026-11-22T01:00:00.000Z', status: 'waiting', hold_expires_at: null, position: 3 });
    }
    json(res, 200, { waitlist: rows });
    return;
  }
  if (method === 'DELETE' && /^\/api\/liff\/booking\/waitlist\/[^/]+$/.test(pathname)) { json(res, 200, { status: 'cancelled' }); return; }
  if (method === 'POST' && pathname === '/api/liff/booking/waitlist') { json(res, 200, { id: 'qa-wl-new' }); return; }

  // ---- 予約 ----
  if (method === 'GET' && pathname === '/api/liff/booking/menus') {
    const menusBody = {
      menus: [
        {
          id: 'qa-menu-1',
          name: 'トリミング（小型犬）',
          category_label: 'トリミング',
          description: 'シャンプー・カット・爪切り',
          duration_minutes: 105,
          buffer_after_minutes: 15,
          base_price: 8400,
          cancel_deadline_hours_before: 24,
          sort_order: 1,
        },
        {
          id: 'qa-menu-2',
          name: 'トリミング（中型犬）',
          category_label: 'トリミング',
          description: 'シャンプー・カット・爪切り',
          duration_minutes: 150,
          buffer_after_minutes: 15,
          base_price: 12600,
          sort_order: 2,
        },
        {
          id: 'qa-menu-3',
          name: 'シャンプーのみ',
          category_label: 'お手入れ',
          description: null,
          duration_minutes: 60,
          buffer_after_minutes: 10,
          base_price: 4200,
          // 予約の履歴の「お店で払う」の札（nWby5）。
          payment_mode: 'onsite',
          sort_order: 3,
        },
        {
          id: 'qa-menu-4',
          name: '初回相談',
          category_label: '相談',
          description: 'はじめての方向け',
          duration_minutes: 30,
          buffer_after_minutes: 0,
          base_price: 0,
          sort_order: 4,
        },
      ],
    };
    /* ③-2 第2弾 B5・B4：人数の上限・繰り返し（hhUtj・qOUmy）。features があるときだけ。 */
    if (state.features.includes('party')) for (const m of menusBody.menus) if (m.id !== 'qa-menu-4') m.max_party_size = 3;
    if (state.features.includes('recurring')) { const m = menusBody.menus.find((x) => x.id === 'qa-menu-1'); if (m) m.recurring = { enabled: true, max_count: 12 }; }
    /* ③-2 第2弾 B6：答えの行き先のメニュー（Z76uuv）。features に routed があるときだけ足す。 */
    if (state.features.includes('routed') || state.features.includes('routed-empty')) menusBody.menus.push({ id: 'qa-menu-online', name: 'オンライン相談 60 分', category_label: '相談', description: null, duration_minutes: 60, buffer_after_minutes: 0, base_price: 3300, sort_order: 9 });
    json(res, 200, menusBody);
    return;
  }
  {
    const m = pathname.match(/^\/api\/liff\/booking\/menus\/([^/]+)\/staff$/);
    if (method === 'GET' && m) {
      const menuId = m[1];
      const basePrice =
        menuId === 'qa-menu-2' ? 12600 : menuId === 'qa-menu-3' ? 4200 : menuId === 'qa-menu-4' ? 0 : 8400;
      const duration =
        menuId === 'qa-menu-2' ? 150 : menuId === 'qa-menu-3' ? 60 : menuId === 'qa-menu-4' ? 30 : 105;
      json(res, 200, {
        staff: [
          {
            id: 'qa-staff-any',
            display_name: '指名なし',
            role: null,
            profile_image_url: null,
            bio: null,
            is_designation_optional: 1,
            price: basePrice,
            duration_minutes: duration,
          },
          {
            id: 'qa-staff-1',
            display_name: '佐々木',
            role: 'トリマー',
            profile_image_url: null,
            bio: null,
            is_designation_optional: 0,
            price: basePrice + 500, // 指名料 +¥500（B9・C6NcOH）
            duration_minutes: duration,
          },
          {
            id: 'qa-staff-2',
            display_name: '高田',
            role: 'トリマー',
            profile_image_url: null,
            bio: null,
            is_designation_optional: 0,
            price: basePrice,
            duration_minutes: duration,
          },
        ],
      });
      return;
    }
  }
  // 現行の確認画面は、費用見積もりの正常応答が読めるまで送信しない。
  if (method === 'GET' && pathname === '/api/liff/booking/cost-estimate') {
    const menuId = url.searchParams.get('menu_id');
    const base = menuId === 'qa-menu-2' ? 12600 : menuId === 'qa-menu-3' ? 4200 : menuId === 'qa-menu-4' ? 0 : 8400;
    const price = base + (url.searchParams.get('staff_id') === 'qa-staff-1' ? 500 : 0);
    const enabled = state.features.includes('cancellation');
    const startsAt = Date.parse(url.searchParams.get('starts_at') ?? '');
    if (!Number.isFinite(startsAt)) { json(res, 400, { error: 'invalid_starts_at' }); return; }
    json(res, 200, { success: true, data: {
      cancellation: { enabled, version: 1, price, cardRequired: true,
        tiers: [{ beforeHours: 24, percent: 0 }, { beforeHours: 0, percent: 50 }], noShowPercent: 100,
        freeUntil: enabled ? new Date(startsAt - 86400000).toISOString() : null,
        feeNow: enabled ? Math.floor(price / 2) : 0, feeNoShow: enabled ? price : 0, policyAcceptedRequired: enabled },
      deposit: { amount: 0, testMode: true, paymentCollectionAvailable: false },
    } });
    return;
  }
  if (method === 'GET' && pathname === '/api/liff/booking/settings') {
    json(res, 200, { liff_date_view: 'list', booking_window_days: 60 });
    return;
  }
  if (method === 'GET' && pathname === '/api/liff/booking/availability') {
    const staffId = url.searchParams.get('staff_id') ?? 'qa-staff-1';
    if (staffId === 'qa-staff-empty') { json(res, 200, { by_staff: [{ staff_id: staffId, display_name: 'QA スタッフ', slots: [] }], closed_dates: [] }); return; }
    // ★V8 の絵 (・) に合わせた日付で決める。月曜はお休み、
    // 4・10・15・20・25・30 日は満席 (枠はあって残り0)。時刻は 9:00〜16:00 の6つで、
    // 10:00 と 16:00 は埋まっている。
    const from = url.searchParams.get('from') ?? '2026-10-01';
    const to = url.searchParams.get('to') ?? '2026-10-01';
    // フォームの「予約を入れる」(担当 qa-staff-form・) は、絵どおり
    // 16日だけ満席・時刻は 10:00 (埋まり)・13:00・15:00 の3つ。
    const formBlock = staffId === 'qa-staff-form';
    const FULL_DAYS = formBlock ? [16] : [4, 10, 15, 20, 25, 30];
    const TIMES = formBlock
      ? [
          ['10:00', 0],
          ['13:00', 3],
          ['15:00', 3],
        ]
      : [
          ['09:00', 3],
          ['10:00', 0],
          ['13:00', 3],
          ['14:00', 3],
          ['15:00', 3],
          ['16:00', 0],
        ];
    const slots = [];
    const closed = [];
    const end = new Date(`${to}T00:00:00Z`);
    for (let d = new Date(`${from}T00:00:00Z`); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const date = d.toISOString().slice(0, 10);
      if (d.getUTCDay() === 1) {
        closed.push(date);
        continue;
      }
      const full = FULL_DAYS.includes(d.getUTCDate());
      for (const [start, left] of TIMES) {
        const [h, m] = start.split(':').map(Number);
        const remaining = full ? 0 : left;
        slots.push({
          date,
          start,
          end: `${String(h + 1).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
          remaining,
          state: remaining > 0 ? 'available' : 'full',
        });
      }
    }
    json(res, 200, {
      by_staff: [{ staff_id: staffId, display_name: 'QA スタッフ', slots }],
      closed_dates: closed,
    });
    return;
  }
  if (method === 'POST' && pathname === '/api/liff/booking/requests') {
    json(res, 200, { booking_id: 'qa-booking-1', status: 'requested' });
    return;
  }
  // F-6 本人の取消・日時変更（送ったことにする。版の確かめはしない）。
  if (method === 'POST' && /^\/api\/liff\/booking\/[^/]+\/(cancel|reschedule)$/.test(pathname)) {
    json(res, 200, { lock_version: 2, status: pathname.endsWith('/cancel') ? 'cancelled' : 'confirmed' });
    return;
  }
  // 予約の履歴・マイページ（★V8 nWby5・L5g75）。支払いの状態は by-booking で返す。
  if (method === 'GET' && pathname === '/api/liff/booking/me') {
    json(res, 200, {
      upcoming: [
        {
          id: 'qa-history-1',
          starts_at: '2026-10-18T14:00:00+09:00',
          status: 'confirmed',
          customer_note: null,
          menu_name: 'カット＋カラー',
          staff_name: '佐々木',
          profile_image_url: null,
          // F-6 本人の変更・取消に要る値。
          lock_version: 1,
          menu_id: 'qa-menu-1',
          staff_id: 'qa-staff-1',
        },
        {
          id: 'qa-history-2',
          starts_at: '2026-10-20T10:00:00+09:00',
          status: 'confirmed',
          customer_note: null,
          menu_name: 'シャンプーのみ',
          staff_name: 'QA スタッフ',
          profile_image_url: null,
          lock_version: 3,
          menu_id: 'qa-menu-3',
          staff_id: 'qa-staff-1',
        },
        {
          id: 'qa-history-3',
          starts_at: '2026-10-24T11:00:00+09:00',
          status: 'requested',
          customer_note: null,
          menu_name: 'トリミング（中型犬）',
          staff_name: 'QA スタッフ',
          profile_image_url: null,
          lock_version: 1,
          menu_id: 'qa-menu-2',
          staff_id: 'qa-staff-1',
        },
      ],
      past: [
        {
          id: 'qa-history-past-1',
          starts_at: '2026-10-02T11:00:00+09:00',
          status: 'cancelled',
          customer_note: null,
          menu_name: 'カット',
          staff_name: '佐々木',
          profile_image_url: null,
          lock_version: 2,
          menu_id: 'qa-menu-1',
          staff_id: 'qa-staff-1',
        },
        {
          id: 'qa-history-past-2',
          starts_at: '2026-09-12T15:00:00+09:00',
          status: 'expired',
          customer_note: null,
          menu_name: 'トリミング（中型犬）',
          staff_name: 'QA スタッフ',
          profile_image_url: null,
          lock_version: 1,
          menu_id: 'qa-menu-2',
          staff_id: 'qa-staff-1',
        },
      ],
    });
    return;
  }
  if (method === 'GET' && pathname === '/api/liff/booking/payments/by-booking') {
    const id = url.searchParams.get('bookingId');
    const receipt = 'https://pay.stripe.com/receipts/qa-test-receipt';
    const payments = {
      'qa-history-1': { id: 'qa-pay-1', status: 'paid', amount: 8800, currency: 'jpy', hold_until: null, receipt_url: receipt },
      'qa-history-3': { id: 'qa-pay-3', status: 'unpaid', amount: 12600, currency: 'jpy', hold_until: '2026-10-16T10:00:00+09:00' },
      'qa-history-past-1': { id: 'qa-pay-p1', status: 'refunded', amount: 4400, currency: 'jpy', hold_until: null, receipt_url: receipt },
      'qa-history-past-2': { id: 'qa-pay-p2', status: 'expired', amount: 12600, currency: 'jpy', hold_until: null },
    };
    json(res, 200, { payment: payments[id] ?? null });
    return;
  }
  if (method === 'POST' && pathname === '/api/liff/booking/payments/start') {
    // 試験用の決済の見本。本番の鍵・本物の支払いページは使わない。
    json(res, 200, { payment: { id: 'qa-pay-3', status: 'pending', amount: 12600 }, checkoutUrl: 'https://checkout.stripe.com/c/pay/qa-test-session' });
    return;
  }
  // 自分のキャンセル待ち（マイページの「キャンセル待ち 1 件」）。id 指定の読み（空きの知らせ）はここでは返さない。
  if (method === 'GET' && pathname === '/api/liff/booking/waitlist' && !url.searchParams.get('id')) {
    json(res, 200, { waitlist: [{ id: 'qa-wl-1', staff_id: 'qa-staff-1', menu_id: 'qa-menu-1', starts_at: '2026-10-25T13:00:00+09:00', status: 'waiting', hold_minutes: 30, hold_expires_at: null, created_at: '2026-10-14T09:00:00+09:00' }] });
    return;
  }
  // 組3：本人の回数券・月謝（API-CONTRACT-3 の LIFF の返り値の形）。
  if (method === 'GET' && pathname === '/api/liff/booking/entitlements') {
    json(res, 200, { success: true, data: [
      { id: 'qa-ent-1', name: '10回券', kind: 'ticket', menuId: null, remaining: 9, monthlyLimit: null, monthAllowance: null, monthUsed: null, monthRemaining: null,
        validFrom: '2026-04-01T00:00:00Z', expiresAt: '2027-03-31T15:00:00Z', periodStart: null, periodEnd: null, usable: true },
      { id: 'qa-ent-2', name: '月謝（月4回）', kind: 'monthly', menuId: null, remaining: null, monthlyLimit: 4, monthAllowance: 4, monthUsed: 2, monthRemaining: 2,
        validFrom: '2026-04-01T00:00:00Z', expiresAt: null, periodStart: '2026-09-30T15:00:00Z', periodEnd: '2026-10-31T15:00:00Z', usable: true },
    ] });
    return;
  }
  // 組1 の 16：お知らせの受け取り（637 を共用）。見本では目的ごとに止められる形で返す。
  if (pathname === '/api/liff/notification-preferences' || pathname.startsWith('/api/liff/notification-preferences/')) {
    if (method === 'PUT') {
      const purpose = pathname.split('/').pop();
      const body = await readBody(req);
      const item = qaPrefs.find((p) => p.purpose === purpose);
      if (item) { item.enabled = Boolean(body?.enabled); item.state = item.enabled ? 'granted' : 'revoked'; item.version += 1; item.recorded = true; }
    }
    json(res, 200, { success: true, data: { items: qaPrefs, purposeSpecificEnforcement: true, deliveryEnforcement: 'purpose_specific' } });
    return;
  }

  // ---- イベント ----
  if (method === 'GET' && pathname === '/api/liff/events/me') {
    if (state.features.includes('lesson')) {
      /* ③-2 第2弾 B3：振替を使う教室（rx3FL・kzE16）。 */
      const lesson = (id, starts) => ({ ...QA_EVENT_BOOKING, id, event_name: '朝ヨガ（初級）', venue_name: 'スタジオ A', status: 'confirmed', cancel_deadline_hours_before: null, slot_starts_at: starts, slot_ends_at: new Date(Date.parse(starts) + 3_600_000).toISOString(), makeup: { enabled: true, cutoff_at: new Date(Date.parse(starts) - 3 * 3_600_000).toISOString(), plan_label: '月謝', valid_until: '2026-12-14T14:59:59.000Z' } });
      json(res, 200, { items: [lesson('qa-lesson-1', '2026-11-14T00:00:00.000Z'), lesson('qa-lesson-2', '2026-11-21T00:00:00.000Z')] });
      return;
    }
    json(res, 200, { items: [QA_EVENT_BOOKING, QA_EVENT_WAITLIST] });
    return;
  }
  // ---- 欠席の振替（③-2 第2弾 B3）----
  if (method === 'GET' && pathname === '/api/liff/events/makeup-credits') {
    json(res, 200, { success: true, data: state.features.includes('makeup') ? [{ id: 'qa-credit-1', status: 'open', expires_at: '2026-12-14T14:59:59.000Z', source_event_booking_id: 'qa-lesson-1', source_event_id: 'qa-event-1', used_event_booking_id: null, version: 1 }] : [] });
    return;
  }
  if (method === 'GET' && /^\/api\/liff\/events\/makeup-credits\/[^/]+\/options$/.test(pathname)) {
    const at = (day, hm) => `2026-11-${day}T${hm}:00.000Z`;
    json(res, 200, { success: true, data: [
      { id: 'qa-ms-1', event_id: 'qa-event-1', starts_at: at('18', '01:00'), ends_at: at('18', '02:00'), capacity: 5, name: 'ヨガ（初級）', occupied: 2 },
      { id: 'qa-ms-2', event_id: 'qa-event-1', starts_at: at('18', '10:00'), ends_at: at('18', '11:00'), capacity: 6, name: '朝ヨガ（オンライン）', occupied: 1 },
      { id: 'qa-ms-3', event_id: 'qa-event-1', starts_at: at('18', '11:30'), ends_at: at('18', '12:30'), capacity: 4, name: 'ヨガ（中級）', occupied: 4 },
      { id: 'qa-ms-4', event_id: 'qa-event-1', starts_at: at('19', '01:00'), ends_at: at('19', '02:00'), capacity: 4, name: 'ヨガ（初級）', occupied: 2 },
    ] });
    return;
  }
  if (method === 'POST' && /^\/api\/liff\/events\/makeup-credits\/[^/]+\/use$/.test(pathname)) { json(res, 200, { success: true, data: { bookingId: 'qa-event-booking-new', replayed: false } }); return; }
  if (method === 'POST' && /^\/api\/liff\/events\/bookings\/[^/]+\/absence$/.test(pathname)) { json(res, 200, { success: true, data: { eventBooking: { id: 'qa-lesson-1', status: 'absent' }, makeupCredit: { id: 'qa-credit-1', status: 'open', expires_at: '2026-12-14T14:59:59.000Z', source_event_booking_id: 'qa-lesson-1', source_event_id: 'qa-event-1', used_event_booking_id: null, version: 1 }, reasonIfNone: null } }); return; }
  // 自分のキャンセル待ち ( の「順番 2 番目」「キャンセル待ちをやめる」)。
  if (method === 'GET' && pathname === '/api/liff/events/me/waitlist') {
    json(res, 200, { items: [QA_EVENT_WAITLIST_MINE] });
    return;
  }
  if (method === 'POST' && /^\/api\/liff\/events\/me\/waitlist\/[^/]+\/cancel$/.test(pathname)) {
    json(res, 200, { ok: true });
    return;
  }
  if (method === 'GET' && pathname.startsWith('/api/liff/events/me/')) {
    json(res, 200, QA_EVENT_BOOKING);
    return;
  }
  {
    const m = pathname.match(/^\/api\/liff\/events\/me\/([^/]+)\/cancel$/);
    if (method === 'POST' && m) {
      json(res, 200, { ok: true });
      return;
    }
  }
  // 空きが出た案内の中身 (「10月11日（日）11:00〜 に 1 席」「あと 23時間 41分」)。
  {
    const m = pathname.match(/^\/api\/liff\/events\/waitlist\/([^/]+)$/);
    if (method === 'GET' && m) {
      json(res, 200, {
        success: true,
        data: {
          waitlistId: 'qa-event-waitlist-1', eventId: 'qa-event-1', slotId: 'qa-slot-2', eventName: '秋のわんこ撮影会',
          startsAt: '2026-10-11T11:00:00+09:00', endsAt: '2026-10-11T12:00:00+09:00', venueName: '然 渋谷店 2F',
          partySize: 1, status: 'offered', expiresAt: '2026-10-03T08:41:30+09:00', remainingSeconds: 23 * 3600 + 41 * 60 + 30, canAccept: true,
        },
      });
      return;
    }
  }
  {
    const m = pathname.match(/^\/api\/liff\/events\/waitlist\/([^/]+)\/accept$/);
    if (method === 'POST' && m) {
      json(res, 200, {
        success: true,
        data: { bookingId: 'qa-booking-wl', status: 'confirmed', alreadyConfirmed: false },
      });
      return;
    }
  }
  {
    const m = pathname.match(/^\/api\/liff\/events\/([^/]+)\/slots$/);
    if (method === 'GET' && m) {
      json(res, 200, { items: QA_SLOTS });
      return;
    }
  }
  {
    const m = pathname.match(/^\/api\/liff\/events\/([^/]+)\/bookings$/);
    if (method === 'POST' && m) {
      json(res, 200, { id: 'qa-event-booking-new', status: 'confirmed' });
      return;
    }
  }
  {
    const m = pathname.match(/^\/api\/liff\/events\/([^/]+)$/);
    if (method === 'GET' && m) {
      json(res, 200, QA_EVENT);
      return;
    }
  }

  // ---- フォーム ----
  {
    const m = pathname.match(/^\/api\/forms\/([^/]+)\/my-latest$/);
    if (method === 'GET' && m) {
      // 本物と同じ包み。「前回の回答を出す」設定が無いフォームは data:null。
      json(res, 200, { success: true, data: null });
      return;
    }
  }
  {
    const m = pathname.match(/^\/api\/forms\/([^/]+)\/files$/);
    if (method === 'POST' && m) {
      if (m[1] === 'qa-document') {
        json(res, 400, { success: false, code: 'IDENTITY_DOCUMENT_DISABLED', error: '本人確認書類は受け取れません。画像・PDFの質問を使ってください' });
        return;
      }
      if (m[1] === 'qa-attachments') {
        const mimeType = (req.headers['content-type'] || '').split(';')[0];
        const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
        if (url.searchParams.get('block_id') !== 'qa-attachment-file' || url.searchParams.get('side') !== 'single' || !allowed.includes(mimeType)) {
          json(res, 400, { success: false, error: '添付の質問と受け取れる形式を確認してください' });
          return;
        }
        let size = 0;
        for await (const chunk of req) size += chunk.length;
        if (!size || size > 10485760) {
          json(res, 400, { success: false, error: '1ファイル10MBまでです' });
          return;
        }
        json(res, 201, { success: true, data: { file: {
          fileId: randomUUID(), kind: mimeType === 'application/pdf' ? 'pdf' : 'image', side: 'single',
          filename: url.searchParams.get('filename') || 'qa.png', mimeType, state: 'ready',
        }, scanStatus: 'clean' } });
        return;
      }
      json(res, 200, {
        success: true,
        data: { key: 'qa-key', url: 'https://example.com/qa.png', mimeType: 'image/png', size: 123 },
      });
      return;
    }
  }
  {
    const m = pathname.match(/^\/api\/forms\/([^/]+)\/submit$/);
    if (method === 'POST' && m) {
      json(res, 200, { success: true, data: { complete: true } });
      return;
    }
  }
  {
    const m = pathname.match(/^\/api\/forms\/([^/]+)$/);
    if (method === 'GET' && m) {
      // 本物と同じ包み。試し合言葉付きは本物と同じく isTest:true を足す。
      const testToken = url.searchParams.get('test_token');
      const form = m[1] === 'qa-document' ? qaDocumentForm() : m[1] === 'qa-attachments' ? qaAttachmentForm() : qaForm();
      json(res, 200, { success: true, data: testToken ? { ...form, isTest: true } : form });
      return;
    }
  }

  // ---- ウェビナー ----
  {
    const m = pathname.match(/^\/api\/liff\/webinars\/([^/]+)\/(heartbeat|comments|cta-click)$/);
    if (method === 'POST' && m) {
      json(res, 200, { ok: true });
      return;
    }
  }
  {
    const m = pathname.match(/^\/api\/liff\/webinars\/([^/]+)$/);
    if (method === 'GET' && m) {
      const slug = decodeURIComponent(m[1]);
      if (slug === 'qa-webinar-private') {
        json(res, 403, { error: 'forbidden' });
        return;
      }
      if (slug === 'qa-webinar-waiting' || slug === 'qa-webinar-long-wait') {
        json(res, 200, {
          live: false,
          title: 'QA ウェビナー',
          nextSessionAt: Math.floor(Date.now() / 1000) + (slug === 'qa-webinar-long-wait' ? 19 * 86400 + 17 * 3600 : 3600),
        });
        return;
      }
      json(res, 200, webinarLive());
      return;
    }
  }

  // ---- 飲食店の席の予約 (E-11・glL3g・km8EG・sAnyy) ----
  // 撮影は時計を 2026-10-07 09:00 (JST) に合わせる。仮押さえはそこから 10 分。
  if (pathname.startsWith('/api/liff/restaurant/')) {
    const seat = seatMock(method, pathname, url, method === 'POST' ? await readBody(req) : null);
    if (seat) {
      json(res, seat[0], seat[1]);
      return;
    }
  }

  if (method === 'GET' && pathname === '/api/liff/mileage/rewards') {
    json(res, 200, { success: true, availableMiles: qaAvailableMiles, rewards: [{
      id: 'qa-reward-1', name: 'QA 割引券', description: '試験用の交換先', imageUrl: null,
      currentVersion: { requiredMiles: 100 }, canRedeem: qaAvailableMiles >= 100,
      unavailableReason: qaAvailableMiles >= 100 ? null : '必要なマイルが足りません',
    }] });
    return;
  }
  if (method === 'POST' && pathname === '/api/liff/mileage/rewards/qa-reward-1/redeem') {
    await readBody(req);
    const key = req.headers['idempotency-key'];
    if (!key) { json(res, 400, { error: '再実行キーを確認してください' }); return; }
    if (!qaRedemptions.has(key)) {
      if (qaAvailableMiles < 100) { json(res, 409, { error: '必要なマイルが足りません' }); return; }
      qaAvailableMiles -= 100;
      qaRedemptions.set(key, { status: 'succeeded', rewardName: 'QA 割引券', customerMessage: '試験用です', rewardCode: 'QA-ONLY', message: null });
    }
    json(res, 200, qaRedemptions.get(key));
    return;
  }
  if (method === 'GET' && pathname === '/api/liff/affiliate/bank') {
    json(res, 200, { success: true, data: qaBankProfile });
    return;
  }
  if (method === 'PUT' && pathname === '/api/liff/affiliate/bank') {
    const body = await readBody(req);
    const key = req.headers['idempotency-key'];
    const fingerprint = JSON.stringify(body);
    const prior = qaBankSaves.get(key);
    if (prior) {
      json(res, prior.fingerprint === fingerprint ? 200 : 409, prior.fingerprint === fingerprint
        ? { success: true, data: prior.profile } : { success: false, error: '同じ再実行キーが別の入力に使われています' });
      return;
    }
    if (body.expectedVersion !== (qaBankProfile?.version ?? 0)) {
      json(res, 409, { success: false, error: '振込先が更新されています' }); return;
    }
    if (!req.headers['idempotency-key'] || !/^\d{1,8}$/.test(body.accountNumber ?? '')) {
      json(res, 400, { success: false, error: '振込先を確認してください' }); return;
    }
    const { bankCode, bankName, branchCode, branchName, accountType, accountHolderName } = body;
    qaBankProfile = { bankCode, bankName, branchCode, branchName, accountType, accountHolderName,
      accountLast4: body.accountNumber.slice(-4), version: (qaBankProfile?.version ?? 0) + 1 };
    qaBankSaves.set(key, { fingerprint, profile: qaBankProfile });
    json(res, 200, { success: true, data: qaBankProfile });
    return;
  }
  if (method === 'GET' && pathname === '/api/liff/affiliate/statements') {
    json(res, 200, { success: true, data: [{ id: 'qa-statement-1', totalAmount: 1000, createdAt: '2026-10-01T00:00:00Z', expiresAt: null }] });
    return;
  }
  if (method === 'GET' && pathname === '/api/liff/affiliate/statements/qa-statement-1/download') {
    if (url.searchParams.get('issue') === '1') {
      const issued = new URL(pathname, `http://${req.headers.host}`);
      issued.searchParams.set('expires', String(Math.floor(Date.now() / 1000) + 900));
      issued.searchParams.set('signature', 'qa-fixture-only');
      json(res, 200, { success: true, data: { url: issued.href, expiresAt: new Date(Date.now() + 900000).toISOString() } });
      return;
    }
    const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
    let pdf = '%PDF-1.4\n'; const offsets = [0];
    for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    res.writeHead(200, { 'Content-Type': 'application/pdf', 'Access-Control-Allow-Origin': '*', 'Content-Disposition': 'attachment; filename="qa-statement.pdf"' });
    res.end(pdf);
    return;
  }

  // ---- アフィリエイト・ mileage ----
  if (method === 'GET' && pathname === '/api/liff/affiliate/me') {
    json(res, 200, {
      affiliate: {
        id: 'qa-aff',
        name: 'QA たろう',
        code: 'QA1234',
        commissionRate: 10,
        isActive: true,
        friendId: 'Fqa0001',
      },
      links: [QA_LINK],
    });
    return;
  }
  if (method === 'POST' && pathname === '/api/liff/affiliate/register') {
    await readBody(req);
    json(res, 200, {
      affiliate: {
        id: 'qa-aff',
        name: 'QA たろう',
        code: 'QA1234',
        commissionRate: 10,
        isActive: true,
        friendId: 'Fqa0001',
      },
      links: [QA_LINK],
    });
    return;
  }
  if (method === 'POST' && pathname === '/api/liff/affiliate/links') {
    json(res, 200, { link: QA_LINK });
    return;
  }
  if (method === 'GET' && pathname === '/api/liff/affiliate/offers') {
    json(res, 200, {
      offers: [
        {
          id: 'qa-offer-1',
          name: '秋の定期便キャンペーン',
          description: '紹介した人が予約すると、あなたに 500マイル。',
          rewardAmount: 0,
          rewardMiles: 500,
          windowDays: null,
          receptionFrom: null,
          receptionTo: null,
          halted: false,
          totalRemaining: null,
          monthlyRemaining: null,
          enrolled: true,
          refCode: 'QA1234',
          url: 'https://lin.ee/ref-QA1234',
        },
        {
          id: 'qa-offer-2',
          name: '鹿肉ふりかけ',
          description: '鹿肉ふりかけを紹介すると、1件 100マイル。',
          rewardAmount: 0,
          rewardMiles: 100,
          windowDays: null,
          receptionFrom: null,
          receptionTo: null,
          halted: false,
          totalRemaining: null,
          monthlyRemaining: null,
          enrolled: false,
          refCode: null,
          url: null,
        },
      ],
    });
    return;
  }
  {
    const m = pathname.match(/^\/api\/liff\/affiliate\/offers\/([^/]+)\/enroll$/);
    if (method === 'POST' && m) {
      json(res, 200, { link: QA_LINK });
      return;
    }
  }
  if (method === 'GET' && pathname === '/api/liff/member-card') {
    json(res, 200, { success: true, data: { name: 'シルバー', since: '2026-09-01T00:00:00.000Z', downgradeDueAt: '2026-12-31T00:00:00.000Z', next: { name: 'ゴールド', remaining: 2, metric: 'visits', progress: 0.65 }, memberNumber: '0012-3456', benefits: ['マイル 1.2 倍', '誕生月 10% OFF'], benefitDetails: { couponCode: null, mileMultiplier: 1.2 } } });
    return;
  }
  if (method === 'GET' && pathname === '/api/liff/mileage/me') {
    json(res, 200, {
      mileage: {
        programId: 'qa-program',
        programName: 'QA マイル',
        available: qaAvailableMiles,
        pending: 500,
        lifetimeEarned: 2000,
        spent: 2000 - qaAvailableMiles,
      },
      history: [],
      insights: {
        accountCount: 1,
        rewardedActions: 2,
        referralMiles: 50,
        qualityReferralCount: 1,
        lastEarnedAt: null,
      },
      opportunities: [],
    });
    return;
  }

  json(res, 404, { error: 'qa_mock_not_found', path: pathname });
});

server.listen(PORT, () => {
  console.log(`[qa-mock] listening on :${PORT}`);
});
