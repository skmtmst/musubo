/*
 * 業種ダッシュボード（。絵 XBkC2）の撮影の見本。
 * 口は API 組4（/api/dashboard/style、apps/web/src/lib/api-styles.ts の styleApi・API-CONTRACT-4）。
 * 下の TODAY は絵の中身の控え。ここから口の生の形（summary・schedule・analytics・cards）を組み立てて返す。
 * 使い方のスタイルは PUT /api/dashboard/style { style } で変えられる（撮影で 4 業種を順に撮るため）。
 */

import { STYLE_SETUP_STATE, STYLE_QUESTION_KEYS } from './style-setup-fixtures.mjs'

let accountStyle = 'standard'

const b = (label, tone) => ({ label, tone })
const PAY = { store: b('店舗払い', 'neutral'), paid: b('支払い済み', 'success'), unpaid: b('未払い', 'danger'), refunded: b('返金済み', 'neutral'), expired: b('期限切れ', 'warning'), free: b('無料', 'neutral'), pre: b('先払い', 'success') }
const kpi = (id, title, value, unit, delta, detail, link, help, valueText) => ({ id, title, value, unit, delta, detail, link, help, ...(valueText ? { valueText } : {}) })
const up = (text) => ({ text, tone: 'up' })
const down = (text) => ({ text, tone: 'down' })
const side = (id, title, rows, extra = {}) => ({ id, title, rows: rows.map(([label, value, tone]) => ({ label, value, ...(tone ? { tone } : {}) })), ...extra })
const link = (label, href) => ({ label, href })

const NEW_HELP = '予約が入った日で数えます。来店日で数えるほかの数とは別です。'
const PAY_HELP = '今日の入金はオンライン（Stripe）で受け取った額です。売上（料金×確定数）とは別の数です。'

const RESTAURANT = {
  style: 'restaurant', asOf: '2026-10-15T09:42:00.000Z', hoursLabel: '17:00〜22:00',
  staff: [{ id: 't1', name: 'T1' }, { id: 't2', name: 'T2' }, { id: 't3', name: 'T3' }, { id: 'c1', name: 'C1' }, { id: 'c2', name: 'C2' }, { id: 'tr1', name: 'TR1' }, { id: 'pa', name: '個室A' }],
  kpis: [
    kpi('today', '今日の予約', 7, '組・23人', up('+2組'), 'LINE 4・電話 2・他 1', link('一覧', '/restaurant-test/reservations'), '取消・無断・押さえを除く今日の予約です。来店日で数えます。'),
    kpi('waiting', '対応待ち', 3, '件', null, '承認 1・未配席 1 ほか', link('内訳', '/restaurant-test/reservations'), '承認待ち・卓が決まっていない予約など、お店が何かする必要がある数です。'),
    kpi('free', '空席（いま）', 5, '卓', null, '全 9 卓', link('座席表', '/restaurant-test/tables'), '動いている卓のうち、いま予約が重なっていない卓の数です。'),
    kpi('noshow', '無断キャンセル率', 1.2, '%', up('−0.6pt'), '過去30日', link('人・LINE', '/friends'), '無断キャンセル ÷（予約 − 取消 − 押さえ）。過去30日に始まった予約で数えます。'),
    kpi('new', '新着予約', 4, '件', up('+1'), '今日入った予約', link('一覧', '/restaurant-test/reservations'), NEW_HELP),
  ],
  alert: { id: 'close-tasks', title: '他の予約サイトの枠を閉じてください（未対応 2件）', detail: '10/15（木）19:00 の枠が残り 2席 → ホットペッパー・食べログの枠を閉じてください', actions: [{ id: 'open-admin', label: '媒体の管理画面を開く', icon: 'external', href: 'https://example.com/hotpepper' }, { id: 'close', label: '閉じた', icon: 'check', taskId: 'close-task-1' }] },
  rows: [
    { id: 'r1', reservationId: 'r1', time: '17:30', name: '見本 115', sub: '常連・LINE', people: 2, seat: 'T3', course: '席のみ', courseNote: '—', pay: PAY.store, state: b('着席中', 'success'), action: 'undo' },
    { id: 'r2', reservationId: 'r2', time: '18:00', name: '見本 183', sub: '2回目・LINE', people: 4, seat: 'T5', course: '季節のおまかせ', courseNote: '1人 ¥8,800', pay: PAY.paid, state: b('予約中', 'info'), action: 'visit' },
    { id: 'r3', reservationId: 'r3', time: '18:30', name: '見本 187', sub: '初めて・電話', people: 2, seat: 'C1-2', course: '記念日コース', courseNote: '1人 ¥6,000', pay: PAY.unpaid, state: b('予約中', 'info'), action: 'visit', highlight: true },
    { id: 'r4', reservationId: 'r4', time: '19:00', name: '見本 166', sub: '常連・予約サイト', people: 4, seat: 'T7', course: '席のみ', courseNote: '—', pay: PAY.store, state: b('予約中', 'info'), action: 'visit' },
    { id: 'r5', reservationId: 'r5', time: '19:00', name: '見本 108', sub: '初めて・LINE', people: 6, seat: '個室A', course: '宴会コース', courseNote: '1人 ¥6,500', pay: PAY.paid, state: b('承認待ち', 'warning'), action: 'visit' },
    { id: 'r6', reservationId: 'r6', time: '19:30', name: '見本 160', sub: '3回目・LINE', people: 3, seat: 'T2', course: '季節のおまかせ', courseNote: '1人 ¥8,800', pay: PAY.refunded, state: b('取消', 'neutral'), action: null },
    { id: 'r7', reservationId: 'r7', time: '20:00', name: '見本 140', sub: '2回目・電話', people: 2, seat: 'C3-4', course: '記念日コース', courseNote: '1人 ¥6,000', pay: PAY.expired, state: b('予約中', 'info'), action: 'visit' },
  ],
  rowsNote: '7件中 1〜7件',
  board: {
    from: '17:00', to: '22:00', now: '18:42', next: '19:30 T1',
    columns: [
      { id: 't1', name: 'T1', initial: 'T1', tone: 'green', count: 1, next: '次の空き 19:30' },
      { id: 't3', name: 'T3', initial: 'T3', tone: 'purple', count: 2, next: '次の空き 20:30' },
      { id: 'c1', name: 'C1-2', initial: 'C', tone: 'blue', count: 1, next: '次の空き 20:30' },
      { id: 'pa', name: '個室A', initial: '個', tone: 'amber', count: 1, next: '19:00〜 貸切' },
    ],
    entries: [
      { id: 'b1', columnId: 't3', start: '17:30', end: '19:00', name: '見本 115', menu: '席のみ', state: 'active', stateLabel: '着席中' },
      { id: 'b2', columnId: 'c1', start: '18:30', end: '20:30', name: '見本 187', menu: '記念日コース', state: 'booked', stateLabel: '予約中', unpaid: true },
      { id: 'b3', columnId: 'pa', start: '19:00', end: '21:30', name: '見本 108', menu: '宴会コース', state: 'pending', stateLabel: '承認待ち' },
      { id: 'b4', columnId: 't1', start: '17:00', end: '18:30', name: '見本 104', menu: '席のみ', state: 'done', stateLabel: '来店済み' },
    ],
    free: [{ columnId: 't1', start: '19:30' }],
  },
  week: null,
  month: {
    title: '2026年10月',
    days: (() => {
      const out = []
      const data = { 1: [null, '予約なし'], 2: [9, 25], 3: [14, 40, 'few'], 4: [16, 46, 'few'], 6: [7, 19], 7: [10, 28], 8: [null, '予約なし'], 9: [12, 34], 10: [15, 43, 'few'], 11: [18, 52, 'full'], 13: [9, 25], 14: [null, '予約なし'], 15: [15, 43], 16: [13, 37], 17: [17, 49, 'full'], 18: [18, 52, 'full'], 20: [6, 16], 21: [null, '予約なし'], 22: [9, 25], 23: [12, 34], 24: [16, 46, 'few'], 25: [15, 43, 'few'], 27: [8, 22], 28: [null, '予約なし'], 29: [12, 34], 30: [13, 37], 31: [18, 52, 'full'] }
      out.push({ date: '2026-09-28', day: '28', inMonth: false, closed: true }, { date: '2026-09-29', day: '29', inMonth: false }, { date: '2026-09-30', day: '30', inMonth: false })
      for (let d = 1; d <= 31; d += 1) {
        const date = `2026-10-${String(d).padStart(2, '0')}`
        const monday = [5, 12, 19, 26].includes(d)
        const v = data[d]
        const mark = v?.[2] === 'few' ? b('残りわずか', 'warning') : v?.[2] === 'full' ? b('満席', 'danger') : null
        out.push({ date, day: d === 1 ? '10/1' : String(d), inMonth: true, ...(monday ? { closed: true } : v && v[0] === null ? { empty: true } : v ? { groups: v[0], people: v[1] } : {}), mark, ...(d === 15 ? { today: true } : {}) })
      }
      out.push({ date: '2026-11-01', day: '11/1', inMonth: false })
      return out
    })(),
    selected: { title: '10月15日（木）の予約', total: '15組・43人', moreLabel: 'この日の一覧を開く（15組）', rows: [
      { time: '17:00', name: '見本 29', sub: '3名', state: b('来店', 'success') },
      { time: '17:30', name: '見本 33', sub: '2名', state: b('予約', 'info') },
      { time: '18:00', name: '見本 114', sub: '4名・個室', state: b('予約', 'info') },
      { time: '18:30', name: '見本 143', sub: '2名', state: b('前日の返事まだ', 'warning') },
      { time: '19:00', name: '見本 176', sub: '6名・コース', state: b('予約', 'info') },
      { time: '19:30', name: '見本 102', sub: '2名', state: b('予約', 'info') },
    ] },
  },
  side: [
    side('new', '新着予約（今日入った）', [['10/18（日）19:00', '佐々木さま 2名'], ['10/24（土）18:30', '中村さま 4名'], ['11/02（月）19:30', '小林さま 2名']], { help: NEW_HELP, link: link('一覧', '/restaurant-test/reservations') }),
    side('pay', 'お支払い（今日）', [['今日の入金（オンライン）', '¥42,600'], ['未払い（先払いで未払い）', '2件 ¥24,000', 'danger'], ['返金', '1件 ¥26,400']], { help: PAY_HELP, link: link('一覧', '/restaurant-test/reservations') }),
    side('care', '今日気をつけること', [['アレルギー', '2組（えび・そば）'], ['記念日', '1組（18:30）'], ['無断歴あり', '1人（20:00）']]),
    side('waitlist', '席のキャンセル待ち', [['19:00〜 2名', '佐々木さま'], ['19:30〜 4名', '中村さま']], { action: { label: '空きを知らせる', icon: 'send' } }),
  ],
}

const SALON_BOARD = {
  from: '10:00', to: '20:00', now: '14:05', next: '15:00 高田',
  columns: [
    { id: 's1', name: '見本 18', initial: '高', tone: 'green', count: 3, next: '次の空き 15:00' },
    { id: 's2', name: '見本 30', initial: '中', tone: 'purple', count: 3, next: '次の空き 15:30' },
    { id: 's3', name: '見本 157', initial: '森', tone: 'blue', count: 4, next: '次の空き 16:00' },
    { id: 's4', name: '見本 31', initial: '佐', tone: 'amber', count: 2, next: '16:00〜 休み', off: true },
  ],
  entries: [
    { id: 'e1', columnId: 's1', start: '10:00', end: '11:30', name: '見本 186', menu: 'カット＋カラー', state: 'done', stateLabel: '来店済み', nominated: true },
    { id: 'e2', columnId: 's1', start: '13:00', end: '15:00', name: '見本 124', menu: '縮毛矯正', state: 'active', stateLabel: '施術中', nominated: true },
    { id: 'e3', columnId: 's1', start: '17:00', end: '18:00', name: '見本 136', menu: 'カット', state: 'booked', stateLabel: '予約中' },
    { id: 'e4', columnId: 's2', start: '11:30', end: '12:30', name: '見本 106', menu: 'ネイル', state: 'done', stateLabel: '来店済み' },
    { id: 'e5', columnId: 's2', start: '14:00', end: '15:30', name: '見本 174', menu: 'ジェルネイル', state: 'active', stateLabel: '施術中' },
    { id: 'e6', columnId: 's2', start: '18:00', end: '19:00', name: '見本 144', menu: 'カット', state: 'booked', stateLabel: '予約中', nominated: true },
    { id: 'e7', columnId: 's3', start: '11:00', end: '12:00', name: '見本 126', menu: 'カット', state: 'done', stateLabel: '来店済み' },
    { id: 'e8', columnId: 's3', start: '12:30', end: '14:30', name: '見本 119', menu: 'パーマ', state: 'active', stateLabel: '施術中', nominated: true },
    { id: 'e9', columnId: 's3', start: '15:00', end: '16:00', name: '見本 129', menu: 'ヘッドスパ', state: 'pending', stateLabel: '承認待ち' },
    { id: 'e10', columnId: 's3', start: '18:00', end: '19:30', name: '見本 172', menu: 'カット＋ケア', state: 'booked', stateLabel: '予約中', nominated: true, unpaid: true },
    { id: 'e11', columnId: 's4', start: '11:00', end: '12:00', name: '見本 127', menu: 'カット', state: 'done', stateLabel: '来店済み' },
    { id: 'e12', columnId: 's4', start: '14:30', end: '15:30', name: '見本 150', menu: 'カット', state: 'booked', stateLabel: '予約中', unpaid: true, selected: true },
    { id: 'e13', columnId: 's4', start: '16:00', end: '20:00', name: '休み（急な休み）', menu: '予約は止めています', state: 'off', stateLabel: '' },
  ],
  free: [{ columnId: 's1', start: '15:00' }, { columnId: 's2', start: '15:30' }, { columnId: 's3', start: '16:00' }, { columnId: 's4', start: '15:30' }],
}

const SALON = {
  style: 'salon', asOf: '2026-10-15T05:05:00.000Z', hoursLabel: '10:00〜20:00',
  staff: [{ id: 's1', name: '見本 18' }, { id: 's2', name: '見本 30' }, { id: 's3', name: '見本 157' }, { id: 's4', name: '見本 31' }],
  kpis: [
    kpi('today', '今日の予約', 12, '件', up('+3件'), '見込み ¥96,800', link('一覧', '/booking/bookings'), '取消を除く今日の予約です。来店日で数えます。見込みは料金×確定数です。'),
    kpi('waiting', '対応待ち', 2, '件', null, '承認 1・印なし 1', link('内訳', '/booking/bookings'), '承認待ち・来店の印が付いていない予約など、お店が何かする必要がある数です。'),
    kpi('rebook', '次回予約率', 38, '%', up('+5pt'), '過去30日', link('人・LINE', '/friends'), '施術のあと24時間以内に次の予約を入れた人の割合です。'),
    kpi('income', '今日の入金', null, '', up('+¥6,200'), '未払い 1件 ¥5,500', link('一覧', '/booking/bookings'), PAY_HELP, '¥32,400'),
    kpi('new', '新着予約', 6, '件', up('+2'), '今日入った予約', link('一覧', '/booking/bookings'), NEW_HELP),
  ],
  alert: { id: 'gcal', title: 'Google カレンダーの同期が止まっています（佐野さん）', detail: '13:10 から読めていません。佐野さんの外の予定が空きとして出ています', actions: [{ id: 'reconnect', label: 'つなぎ直す', icon: 'refresh', href: '/settings' }] },
  rows: [
    { id: 'e1', time: '10:00', name: '見本 186', sub: '指名・LINE', course: 'カット＋カラー', courseNote: '¥12,000', staff: '高田', pay: PAY.store, state: b('来店済み', 'neutral'), action: 'done' },
    { id: 'e2', time: '13:00', name: '見本 124', sub: '指名・LINE', course: '縮毛矯正', courseNote: '¥18,000', staff: '高田', pay: PAY.paid, state: b('施術中', 'success'), action: null },
    { id: 'e12', time: '14:30', name: '見本 150', sub: '初めて・電話', course: 'カット', courseNote: '¥5,500', staff: '佐野', pay: PAY.unpaid, state: b('予約中', 'info'), action: 'visit', highlight: true },
    { id: 'e9', time: '15:00', name: '見本 129', sub: '2回目・LINE', course: 'ヘッドスパ', courseNote: '¥6,600', staff: '森', pay: PAY.store, state: b('承認待ち', 'warning'), action: 'visit' },
  ],
  rowsNote: '12件中 1〜4件',
  board: SALON_BOARD,
  week: {
    title: '10月12日（月）〜 10月18日（日）', from: '2026-10-12', to: '2026-10-18',
    days: [
      { date: '2026-10-12', label: '10/12（月）', sub: '空き 3' }, { date: '2026-10-13', label: '10/13（火）', sub: '定休日', closed: true },
      { date: '2026-10-14', label: '10/14（水）', sub: '空き 1' }, { date: '2026-10-15', label: '10/15（木）', sub: '空き 4', today: true },
      { date: '2026-10-16', label: '10/16（金）', sub: '満' }, { date: '2026-10-17', label: '10/17（土）', sub: '満' }, { date: '2026-10-18', label: '10/18（日）', sub: '空き 5' },
    ],
    entries: [
      { id: 'w1', day: '2026-10-12', start: '10:00', end: '11:30', title: 'カット', name: '見本 143' },
      { id: 'w2', day: '2026-10-12', start: '13:00', end: '15:00', title: 'カラー', name: '見本 29' },
      { id: 'w3', day: '2026-10-14', start: '11:00', end: '12:00', title: 'カット', name: '見本 33' },
      { id: 'w4', day: '2026-10-14', start: '14:30', end: '17:00', title: 'カット＋カラー', name: '見本 114' },
      { id: 'w5', day: '2026-10-15', start: '10:00', end: '11:00', title: 'ヘッドスパ', name: '見本 176' },
      { id: 'w6', day: '2026-10-15', start: '15:00', end: '16:30', title: 'カット', name: '見本 164' },
      { id: 'w7', day: '2026-10-16', start: '10:00', end: '12:00', title: '縮毛矯正', name: '見本 102' },
      { id: 'w8', day: '2026-10-16', start: '12:00', end: '13:00', title: 'カット', name: '見本 133' },
      { id: 'w9', day: '2026-10-16', start: '13:00', end: '16:00', title: 'カラー', name: '見本 149' },
      { id: 'w10', day: '2026-10-16', start: '16:00', end: '19:00', title: 'パーマ', name: '見本 153' },
      { id: 'w11', day: '2026-10-17', start: '10:00', end: '11:30', title: 'カット', name: '見本 137' },
      { id: 'w12', day: '2026-10-17', start: '11:30', end: '13:30', title: 'カラー', name: '見本 151' },
      { id: 'w13', day: '2026-10-17', start: '14:00', end: '16:00', title: 'パーマ', name: '見本 107' },
      { id: 'w14', day: '2026-10-17', start: '16:00', end: '18:00', title: 'カット', name: '見本 158' },
      { id: 'w15', day: '2026-10-18', start: '13:00', end: '14:30', title: 'カット', name: '見本 156' },
    ],
    free: [{ day: '2026-10-12', start: '16:00', end: '17:00' }, { day: '2026-10-14', start: '12:00', end: '13:00' }, { day: '2026-10-15', start: '12:00', end: '13:00' }, { day: '2026-10-18', start: '11:00', end: '12:00' }],
  },
  month: null,
  side: [
    side('new', '新着予約（今日入った）', [['10/18（土）11:00', '大野さま カット'], ['10/19（日）14:00', '石井さま カラー'], ['10/22（水）10:30', '森田さま ネイル']], { help: NEW_HELP, link: link('一覧', '/booking/bookings') }),
    side('pay', 'お支払い（今日）', [['今日の入金（オンライン）', '¥32,400'], ['未払い（先払いで未払い）', '1件 ¥5,500', 'danger'], ['返金', '0件']], { help: PAY_HELP, link: link('一覧', '/booking/bookings') }),
    side('rebook', '次回予約がまだ', [['見本 186さま', 'カット＋カラー'], ['見本 106さま', 'ネイル'], ['見本 126さま', 'カット']], { help: '今日来た人のうち、次の予約がまだの人です。', link: link('人・LINE', '/friends'), action: { label: 'LINE で次回を案内する', icon: 'line' } }),
  ],
}

const CONSULT = {
  style: 'consult', asOf: '2026-10-15T02:20:00.000Z', hoursLabel: null,
  staff: [{ id: 'yamaguchi', name: '山口' }, { id: 'ishii', name: '石井' }],
  kpis: [
    kpi('meetings', '今日の面談', 6, '件', up('+1件'), 'オンライン 4・対面 2', link('一覧', '/booking/bookings'), '取消を除く今日の面談です。面談日で数えます。'),
    kpi('results', '結果待ち', 3, '件', null, 'いちばん古い 2日前', link('付ける', '/booking/bookings'), '面談が終わって、結果（検討中・成約・見送り）をまだ付けていない数です。'),
    kpi('week', '今週の面談', 18, '件', up('+4件'), '面談日 10/12〜18', link('一覧', '/booking/bookings'), '今週（月〜日）の面談です。面談日で数えます。'),
    kpi('noshow', '無断欠席率', 4.2, '%', up('−1.1pt'), '過去30日', link('人・LINE', '/friends'), '無断欠席 ÷（予約 − 取消）。過去30日の面談で数えます。'),
    kpi('new', '新着予約', 5, '件', down('−2'), '今日入った予約', link('一覧', '/booking/bookings'), NEW_HELP),
  ],
  alert: { id: 'meet-url', title: 'Meet の URL が無い面談があります（1件）', detail: '15:00 小野さま：オンラインなのに Meet の URL が入っていません', actions: [{ id: 'url', label: 'URL を入れる', icon: 'link', href: '/booking/bookings' }] },
  rows: [
    { id: 'm1', time: '10:00', endTime: '〜11:00', name: '見本 125', sub: '転職の初回面談', meet: b('オンライン', 'info'), staff: '山口', pay: PAY.free, state: b('実施', 'success'), action: 'done' },
    { id: 'm2', time: '11:30', endTime: '〜12:30', name: '見本 173', sub: 'キャリア相談 60分', meet: b('オンライン', 'info'), staff: '山口', pay: PAY.paid, state: b('確定', 'info'), action: 'meet', actionHref: 'https://meet.google.com/' },
    { id: 'm3', time: '13:00', endTime: '〜13:30', name: '見本 128', sub: '保険の見直し', meet: b('対面', 'neutral'), staff: '石井', pay: PAY.free, state: b('確定', 'info'), action: 'place', actionHref: 'https://maps.google.com/' },
    { id: 'm4', time: '14:00', endTime: '〜15:00', name: '見本 132', sub: '有料相談 60分 ¥5,500', meet: b('オンライン', 'info'), staff: '石井', pay: PAY.unpaid, state: b('確定', 'info'), action: 'meet', actionHref: 'https://meet.google.com/', highlight: true },
    { id: 'm5', time: '15:00', endTime: '〜16:00', name: '見本 134', sub: 'キャリア相談 60分', meet: b('オンライン', 'info'), staff: '山口', pay: PAY.expired, state: b('確定', 'info'), action: 'meet' },
    { id: 'm6', time: '16:30', endTime: '〜17:00', name: '見本 152', sub: '内見の相談', meet: b('対面', 'neutral'), staff: '石井', pay: PAY.refunded, state: b('取消', 'neutral'), action: null },
  ],
  rowsNote: '6件中 1〜6件・前日と1時間前の LINE のリマインドは自動で送ります',
  board: { from: '10:00', to: '18:00', now: '11:20', next: '13:30 山口', columns: [{ id: 'yamaguchi', name: '山口', initial: '山', tone: 'green', count: 3, next: '次の空き 13:30' }, { id: 'ishii', name: '石井', initial: '石', tone: 'blue', count: 3, next: '次の空き 15:00' }], entries: [
    { id: 'm1', columnId: 'yamaguchi', start: '10:00', end: '11:00', name: '見本 125', menu: '転職の初回面談', state: 'done', stateLabel: '実施' },
    { id: 'm2', columnId: 'yamaguchi', start: '11:30', end: '12:30', name: '見本 173', menu: 'キャリア相談', state: 'booked', stateLabel: '確定' },
    { id: 'm5', columnId: 'yamaguchi', start: '15:00', end: '16:00', name: '見本 134', menu: 'キャリア相談', state: 'booked', stateLabel: '確定' },
    { id: 'm3', columnId: 'ishii', start: '13:00', end: '13:30', name: '見本 128', menu: '保険の見直し', state: 'booked', stateLabel: '確定' },
    { id: 'm4', columnId: 'ishii', start: '14:00', end: '15:00', name: '見本 132', menu: '有料相談', state: 'booked', stateLabel: '確定', unpaid: true },
  ], free: [{ columnId: 'yamaguchi', start: '13:30' }, { columnId: 'ishii', start: '15:00' }] },
  week: null, month: null,
  side: [
    side('prep', '次の面談の準備（11:30 西村さま）', [['過去の面談', '1回（9/28 初回）'], ['回答フォーム', '転職の時期：3か月以内'], ['流入', 'Instagram の広告']], { more: link('詳細を開く', '/booking/bookings') }),
    side('pay', 'お支払い（今日）', [['今日の入金（オンライン）', '¥11,000'], ['未払い（先払いで未払い）', '2件 ¥11,000', 'danger'], ['返金', '1件 ¥5,500']], { help: PAY_HELP, link: link('一覧', '/booking/bookings') }),
    side('free', '今日の空き', [['山口', '16:00〜18:00'], ['石井', '15:00〜16:30']]),
  ],
}

const LESSON = {
  style: 'lesson', asOf: '2026-10-15T08:40:00.000Z', hoursLabel: null,
  staff: [{ id: 'sato', name: '佐藤' }, { id: 'tamura', name: '田村' }, { id: 'inoue', name: '井上' }],
  kpis: [
    kpi('classes', '今日のクラス', 6, '回', up('+1回'), '予約 48・定員 64', link('一覧', '/events'), '今日のクラスの回数です。予約と定員は今日の回の合計です。'),
    kpi('attendance', '出欠待ち', 2, '回', null, '直近7日', link('名簿', '/events'), '終わった回のうち、出席の印をまだ付けていない回の数です。'),
    kpi('fill', '今週の埋まり', 72, '%', up('+6pt'), 'オンラインは 61%', link('一覧', '/events'), '今週の回の予約 ÷ 定員です。教室とオンラインの定員は別に数えます。'),
    kpi('income', '今日の入金', null, '', up('+¥4,400'), '未払い 2人 ¥6,600', link('一覧', '/events'), PAY_HELP, '¥38,500'),
    kpi('new', '新着予約', 9, '件', up('+3'), '今日入った予約', link('一覧', '/events'), NEW_HELP),
  ],
  alert: { id: 'remind', title: '前日のリマインドが届かなかった人がいます（2人）', detail: 'LINE をブロックしているため届きません。電話かメールで連絡してください', actions: [{ id: 'people', label: '人を見る', icon: 'people', href: '/friends' }] },
  rows: [
    { id: 'c1', time: '10:00', endTime: '〜11:00', name: '朝ヨガ（初級）', sub: '教室A・佐藤・教室', booked: 12, capacity: 12, waiting: 3, vacancy: '×', pay: PAY.pre },
    { id: 'c2', time: '12:00', endTime: '〜12:45', name: 'ピラティス', sub: '教室B・田村・オンライン', booked: 6, capacity: 20, waiting: 0, vacancy: '○', pay: PAY.pre },
    { id: 'c3', time: '15:00', endTime: '〜16:00', name: 'キッズダンス', sub: '教室A・井上・教室', booked: 9, capacity: 10, waiting: 1, vacancy: '△', pay: PAY.store },
    { id: 'c4', time: '18:00', endTime: '〜19:00', name: 'リフレッシュヨガ', sub: '教室A・佐藤・教室', booked: 10, capacity: 12, waiting: 0, vacancy: '△', pay: PAY.pre },
    { id: 'c5', time: '19:30', endTime: '〜20:30', name: 'ボディメイク', sub: '教室B・田村・教室＋オンライン', booked: 18, capacity: 30, waiting: 5, vacancy: '△', pay: PAY.pre },
    { id: 'c6', time: '20:45', endTime: '〜21:30', name: '体験ヨガ', sub: '教室A・佐藤・教室', booked: 3, capacity: 6, waiting: 0, vacancy: '○', pay: PAY.store },
  ],
  rowsNote: '6回中 1〜6回・払い方はクラスごとに決めます（先払い＝予約の時に Stripe で支払い／店舗払い＝当日お店で）',
  board: { from: '10:00', to: '22:00', now: '17:40', next: '18:00 佐藤', columns: [{ id: 'sato', name: '佐藤', initial: '佐', tone: 'green', count: 3, next: '次 18:00' }, { id: 'tamura', name: '田村', initial: '田', tone: 'purple', count: 2, next: '次 19:30' }, { id: 'inoue', name: '井上', initial: '井', tone: 'blue', count: 1, next: '今日は終わり' }], entries: [
    { id: 'c1', columnId: 'sato', start: '10:00', end: '11:00', name: '朝ヨガ（初級）', menu: '12／12', state: 'done', stateLabel: '済み' },
    { id: 'c4', columnId: 'sato', start: '18:00', end: '19:00', name: 'リフレッシュヨガ', menu: '10／12', state: 'booked', stateLabel: '予約中' },
    { id: 'c6', columnId: 'sato', start: '20:45', end: '21:30', name: '体験ヨガ', menu: '3／6', state: 'booked', stateLabel: '予約中' },
    { id: 'c2', columnId: 'tamura', start: '12:00', end: '12:45', name: 'ピラティス', menu: '6／20', state: 'done', stateLabel: '済み' },
    { id: 'c5', columnId: 'tamura', start: '19:30', end: '20:30', name: 'ボディメイク', menu: '18／30', state: 'booked', stateLabel: '予約中' },
    { id: 'c3', columnId: 'inoue', start: '15:00', end: '16:00', name: 'キッズダンス', menu: '9／10', state: 'done', stateLabel: '済み' },
  ], free: [] },
  week: null, month: null,
  roster: {
    rowId: 'c4', head: '18:00〜19:00・教室A・講師 佐藤', title: 'リフレッシュヨガ', pay: PAY.pre, meta: '予約 10／定員 12・待ち 0', payLinkCount: 2, more: 'ほか 3人',
    members: [
      { name: '見本 143', sub: '会員・32回目', pay: PAY.paid, attend: 'done' },
      { name: '見本 180', sub: '会員・8回目', pay: PAY.paid, attend: 'done' },
      { name: '見本 188', sub: '体験・初めて', pay: PAY.unpaid, attend: 'button' },
      { name: '見本 109', sub: '会員・15回目', pay: PAY.paid, attend: 'button' },
      { name: '見本 159', sub: '回数券 残り3', pay: PAY.paid, attend: 'button' },
      { name: '見本 105', sub: '会員・取消', pay: PAY.refunded, attend: 'cancel' },
      { name: '見本 130', sub: '会員・4回目', pay: PAY.expired, attend: 'button' },
    ],
  },
  side: [
    side('new', '新着予約（今日入った）', [['10/18（日）10:00', '朝ヨガ 大野さま'], ['10/19（月）19:30', 'ボディメイク 石井さま'], ['10/22（木）18:00', 'リフレッシュヨガ 森田さま']], { help: NEW_HELP, link: link('一覧', '/events') }),
    side('pay', 'お支払い（今日）', [['今日の入金（オンライン）', '¥38,500'], ['未払い（先払いで未払い）', '2人 ¥6,600', 'danger'], ['返金', '1件 ¥2,200']], { help: PAY_HELP, link: link('一覧', '/events') }),
  ],
}

const TODAY = { restaurant: RESTAURANT, salon: SALON, consult: CONSULT, lesson: LESSON }


/* ── 口の生の形へ ── */
const TZ = 'Asia/Tokyo'
const iso = (date, hm) => `${date}T${hm}:00+09:00`
const metric = (value, unit = '件', formula = '見本') => ({ value, status: 'available', formula, unit })
const rate = (value, numerator, denominator, formula = '見本') => ({ value, numerator, denominator, status: 'available', formula, unit: '' })
const STATUS = { 来店済み: 'visited', 着席中: 'seated', 予約中: 'confirmed', 承認待ち: 'requested', 取消: 'cancelled', 施術中: 'seated', 確定: 'confirmed', 実施: 'completed', 済み: 'completed', '': 'confirmed' }
const booking = (o) => ({ id: o.id, version: 1, updatedAt: '2026-10-15T00:00:00.000Z', kind: o.kind ?? 'booking', friendId: null, personKey: o.id, name: o.name, startsAt: o.startsAt, endsAt: o.endsAt, requestedAt: o.startsAt, status: o.status, staffId: o.staffId ?? null, menuId: null, storeId: null, slotId: null, partySize: o.partySize ?? 1, price: o.price ?? 0, visited: Boolean(o.visited), attendance: o.attendance ?? null, held: false, meetingMode: o.meetingMode ?? null, meetingUrl: o.meetingUrl ?? null, location: o.location ?? null, outcome: null, source: o.source ?? 'line', entryPoint: null, refCode: null, designation: o.designated ? 'designated' : null, cancelledAt: null, confirmedResponse: null, participationMode: null })
const yenOf = (t) => Number(String(t ?? '').replace(/[^0-9]/g, '')) || 0

function scheduleFor(style, query) {
  const date = query.get('date') || '2026-10-15'
  const range = query.get('range') || 'today'
  const t = TODAY[style]
  const board = t.board
  const columns = board.columns.map((c) => ({ id: c.id, kind: style === 'restaurant' ? 'table' : 'staff', name: c.name }))
  let entries = []
  if (style === 'lesson') {
    entries = t.rows.map((r) => ({ id: `class:${r.id}`, kind: 'class', columnIds: [board.entries.find((e) => e.id === r.id)?.columnId ?? columns[0].id], startsAt: iso(date, r.time), endsAt: iso(date, r.endTime.replace('〜', '')), title: r.name, booking: null, classId: `cls-${r.id}` }))
  } else if (style === 'restaurant') {
    entries = t.rows.map((r) => ({ id: `restaurant:${r.id}`, kind: 'restaurant', columnIds: [columns.find((c) => r.seat?.startsWith(c.name.slice(0, 2)))?.id ?? columns[0].id], startsAt: iso(date, r.time), endsAt: iso(date, `${String(Number(r.time.slice(0, 2)) + 2).padStart(2, '0')}${r.time.slice(2)}`), title: r.course, booking: booking({ id: r.id, kind: 'restaurant', name: r.name, startsAt: iso(date, r.time), endsAt: iso(date, r.time), status: STATUS[r.state.label] ?? 'confirmed', visited: r.action === 'undo', partySize: r.people, price: yenOf(r.courseNote), source: r.sub.includes('電話') ? 'phone' : r.sub.includes('予約サイト') ? 'hotpepper' : 'line' }) }))
  } else {
    entries = board.entries.filter((e) => e.state !== 'off').map((e) => {
      const row = t.rows.find((r) => r.id === e.id)
      return { id: `booking:${e.id}`, kind: 'booking', columnIds: [e.columnId], startsAt: iso(date, e.start), endsAt: iso(date, e.end), title: style === 'consult' ? row?.sub ?? e.menu : e.menu, booking: booking({ id: e.id, name: e.name, startsAt: iso(date, e.start), endsAt: iso(date, e.end), status: STATUS[e.stateLabel] ?? 'confirmed', visited: e.state === 'done', staffId: e.columnId, designated: e.nominated, meetingMode: row?.meet ? (row.meet.label === '対面' ? 'in_person' : 'online') : null, meetingUrl: row?.action === 'meet' ? row.actionHref ?? null : null, location: row?.action === 'place' ? '本社 3階 面談室' : null, attendance: e.state === 'active' ? 'visited' : null }) }
    })
  }
  const slots = [
    ...board.free.map((f) => ({ columnId: f.columnId, menuId: null, date, startsAt: iso(date, f.start), endsAt: iso(date, `${String(Number(f.start.slice(0, 2)) + 1).padStart(2, '0')}${f.start.slice(2)}`), remaining: 1 })),
    ...(style === 'lesson' ? t.rows.map((r) => ({ columnId: columns[0].id, menuId: null, date, startsAt: iso(date, r.time), endsAt: iso(date, r.endTime.replace('〜', '')), remaining: r.capacity - r.booked, entryId: `class:${r.id}` })) : []),
  ]
  const closures = style === 'salon' ? [{ id: 'cl-1', target: 'staff', targetIds: ['s4'], dateFrom: date, dateTo: date, kind: 'closed', hours: [{ start: '16:00', end: '20:00' }], reason: '急な休み' }] : []
  const days = [{ date, entryIds: entries.map((e) => e.id), bookings: entries.length, people: entries.reduce((n, e) => n + (e.booking?.partySize ?? 1), 0) }]
  let closedDates = []
  if (range === 'week' && t.week) {
    entries = t.week.entries.map((e) => ({ id: `booking:${e.id}`, kind: 'booking', columnIds: ['s1'], startsAt: iso(e.day, e.start), endsAt: iso(e.day, e.end), title: e.title, booking: booking({ id: e.id, name: e.name, startsAt: iso(e.day, e.start), endsAt: iso(e.day, e.end), status: 'confirmed' }) }))
    days.length = 0
    for (const d of t.week.days) days.push({ date: d.date, entryIds: entries.filter((e) => e.startsAt.startsWith(d.date)).map((e) => e.id), bookings: entries.filter((e) => e.startsAt.startsWith(d.date)).length, people: 0 })
    closedDates = t.week.days.filter((d) => d.closed).map((d) => d.date)
    slots.length = 0
    for (const f of t.week.free) slots.push({ columnId: 's1', menuId: null, date: f.day, startsAt: iso(f.day, f.start), endsAt: iso(f.day, f.end), remaining: 1 })
    return { style, asOf: new Date().toISOString(), timeZone: TZ, range, display: 'calendar', calendarView: 'week', from: iso(t.week.from, '00:00'), to: iso(t.week.to, '23:59'), columns, entries, days, closures: [], availability: { status: 'available', reason: null, resources: [], slots, closedDates } }
  }
  if (range === 'month' && t.month) {
    days.length = 0
    for (const d of t.month.days.filter((x) => x.inMonth)) days.push({ date: d.date, entryIds: d.date === date ? entries.map((e) => e.id) : [], bookings: d.groups ?? 0, people: d.people ?? 0 })
    closedDates = t.month.days.filter((x) => x.inMonth && x.closed).map((x) => x.date)
    return { style, asOf: new Date().toISOString(), timeZone: TZ, range, display: 'calendar', calendarView: 'month', from: '2026-10-01T00:00:00+09:00', to: '2026-11-01T00:00:00+09:00', columns, entries, days, closures: [], availability: { status: 'available', reason: null, resources: [], slots: [], closedDates } }
  }
  return { style, asOf: new Date().toISOString(), timeZone: TZ, range, display: query.get('display') || 'list', calendarView: 'day', from: iso(date, '00:00'), to: iso(date, '23:59'), columns, entries, days, closures, availability: { status: 'available', reason: null, resources: [], slots, closedDates } }
}

const METRICS = {
  restaurant: { now: { bookings: metric(7, '組'), guests: metric(23, '人'), firstTime: metric(2), regular: metric(3), attention: metric(3), unseated: metric(1), mediaCloseTasks: metric(2), freeTables: metric(5, '卓'), noShowRate: rate(0.012, 3, 246), visits: metric(18, '人'), nextBookingRate: rate(0.31, 40, 129), returnRate: rate(0.44, 57, 129) }, prev: { bookings: metric(5, '組'), noShowRate: rate(0.018, 4, 222), nextBookingRate: rate(0.28, 35, 125), returnRate: rate(0.41, 50, 122), visits: metric(15, '人') } },
  salon: { now: { recall: metric(8, '人'), bookings: metric(12), estimatedRevenue: metric(96800, '円'), attention: metric(2), nextBookingRate: rate(0.38, 46, 121), visits: metric(284, '人'), returnRate: rate(0.66, 80, 121), noShowRate: rate(0.019, 6, 312), guests: metric(12, '人') }, prev: { bookings: metric(9), nextBookingRate: rate(0.33, 40, 121), estimatedRevenue: metric(2314000, '円'), visits: metric(271, '人'), noShowRate: rate(0.016, 5, 300), returnRate: rate(0.62, 75, 121) } },
  consult: { now: { bookings: metric(6), visits: metric(2, '人'), resultPending: metric(3), weekBookings: metric(18), noShowRate: rate(0.042, 4, 96), conversionRate: rate(0.18, 15, 81), cancelRate: rate(0.06, 6, 100), returnRate: rate(0.21, 17, 81) }, prev: { bookings: metric(5), weekBookings: metric(14), noShowRate: rate(0.053, 5, 94), conversionRate: rate(0.16, 12, 75), visits: metric(1, '人') } },
  lesson: { now: { classes: metric(6, '回'), capacity: metric(64, '人'), unlimitedClasses: metric(0, '回'), attendancePending: metric(2, '回'), classroomOccupancy: rate(0.72, 48, 66), onlineOccupancy: rate(0.61, 22, 36), trialConversion: rate(0.37, 7, 19), visits: metric(42, '人'), noShowRate: rate(0.03, 2, 66) }, prev: { classes: metric(5, '回'), classroomOccupancy: rate(0.66, 44, 66), visits: metric(38, '人'), trialConversion: rate(0.3, 6, 20) } },
}

function snapshotFor(style, query) {
  const date = query.get('date') || '2026-10-15'
  const m = METRICS[style]
  const fresh = TODAY[style].side.find((c) => c.id === 'new')?.rows ?? []
  const newBookings = fresh.map((r, i) => {
    const [md, hm] = r.label.split(' ')
    const day = `2026-${md.slice(0, 2)}-${md.slice(3, 5)}`
    const [name, extra] = r.value.split('さま')
    return booking({ id: `new-${i}`, name: name.trim(), startsAt: iso(day, hm ?? '10:00'), endsAt: iso(day, hm ?? '10:00'), status: 'confirmed', partySize: Number((extra ?? '').replace(/[^0-9]/g, '')) || 1 })
  })
  return { style, asOf: new Date().toISOString(), timeZone: TZ, from: iso(date, '00:00'), to: iso(date, '23:59'), dateBasis: 'visit', range: query.get('range') || 'today', metrics: m.now, previous: m.prev, items: [], newBookings, resultId: 'qa-result' }
}

function analyticsFor(style, query) {
  const snap = snapshotFor(style, query)
  const daily = Array.from({ length: 30 }, (_, i) => { const d = new Date(Date.UTC(2026, 8, 16 + i)); const v = Math.round((Math.sin(i * 1.7) + 1.2) * (style === 'consult' ? 3 : 10)); return { date: d.toISOString().slice(0, 10), bookings: v + 2, visits: v, noShowRate: rate(0.02, 1, 50), cancellations: 1, estimatedRevenue: style === 'salon' ? v * 8000 : null } })
  const staffNames = TODAY[style].board.columns
  const analytics = {
    periodMetrics: snap.metrics, daily,
    menus: style === 'restaurant' ? [['季節のおまかせ', 62, 58], ['記念日コース', 18, 16], ['宴会コース', 40, 38], ['席のみ', 124, 120], ['貸切プラン', 2, 2]].map(([menuId, b, v]) => ({ menuId, bookings: b, visits: v, cancellations: 2, noShowRate: b < 5 ? { value: null, status: 'insufficient_sample', formula: '見本', unit: '' } : rate(0.016, 1, b), estimatedRevenue: null })) : [],
    staff: staffNames.map((c, i) => ({ staffId: c.id, bookings: 98 - i * 12, utilization: rate(0.84 - i * 0.07, 1, 1), designationRate: rate(0.62 - i * 0.15, 1, 1), nextBookingRate: rate(0.45 - i * 0.05, 1, 1), returnRate: i === 3 ? { value: null, status: 'insufficient_sample', formula: '見本', unit: '' } : rate(0.71 - i * 0.05, 1, 1) })),
    funnel: [['Instagram の広告', 412, 38, 33, 7], ['LINE の友だち紹介', 126, 24, 22, 5], ['Google 検索', 88, 21, 17, 2], ['士業の先生から', 14, 6, 6, 1]].map(([route, friends, b, p, w]) => ({ route, friends, bookings: b, performed: p, won: w })),
  }
  return { ...snap, analytics }
}

const CARDS = {
  restaurant: ['connection-alert', 'channel-close-alert', 'today-seats', 'reservations', 'customers', 'analytics'],
  salon: ['connection-alert', 'ledger', 'reservations', 'customers', 'analytics'],
  consult: ['connection-alert', 'consultations', 'results-pending', 'customers', 'staff', 'analytics'],
  lesson: ['connection-alert', 'classes', 'members', 'trials', 'analytics'],
}
let styleVersion = 1
let qaEmpty = false

/** 業種ダッシュボードの口の見本。当たらなければ null。 */
export function styleDashboardMock(method, pathname, query, body) {
  const root = '/api/dashboard/style'
  if (pathname === root) {
    if (method === 'PUT') { if (body?.style) accountStyle = body.style; qaEmpty = Boolean(body?.qaEmpty); styleVersion += 1 }
    const selection = { style: accountStyle, styleSelected: accountStyle !== 'standard', version: styleVersion, styleMode: STYLE_SETUP_STATE.styleMode }
    if (method === 'PUT') return { success: true, data: { ...selection, changedAnswers: {}, bookingSettingsChanges: [], inserted: [] } }
    const cards = (CARDS[accountStyle] ?? []).map((id) => ({ id, visible: true }))
    return { success: true, data: {
      ...selection, answers: {}, settings: {}, cards, metricIds: [], visibleTabs: [],
      questions: STYLE_QUESTION_KEYS.map((key) => ({ key, canChangeLater: true, recommended: key !== 'payment', modes: ['configured', 'later', 'manual'] })),
    } }
  }
  if (!pathname.startsWith(root + '/')) return null
  const style = query.get('style') || accountStyle
  if (method === 'GET' && pathname === root + '/summary') { if (!TODAY[style]) return null; const d = snapshotFor(style, query); return { success: true, data: qaEmpty ? { ...d, newBookings: [], metrics: Object.fromEntries(Object.entries(d.metrics).map(([k, m]) => [k, m.denominator !== undefined ? m : { ...m, value: 0 }])) } : d } }
  if (method === 'GET' && pathname === root + '/schedule') { if (!TODAY[style]) return null; const d = scheduleFor(style, query); return { success: true, data: qaEmpty ? { ...d, entries: [], days: d.days.map((x) => ({ ...x, entryIds: [], bookings: 0, people: 0 })), closures: [] } : d } }
  if (method === 'GET' && pathname === root + '/analytics') return TODAY[style] ? { success: true, data: analyticsFor(style, query) } : null
  if (pathname === root + '/cards' && (method === 'PUT' || method === 'DELETE')) {
    styleVersion += 1
    const cards = method === 'PUT' && Array.isArray(body?.cards) ? body.cards : (CARDS[accountStyle] ?? []).map((id) => ({ id, visible: true }))
    return { success: true, data: { cards, version: styleVersion } }
  }
  if (method === 'POST' && pathname === root + '/closures') return { success: true, data: { id: 'closure-qa', existingReservationsCancelled: false } }
  return null
}
