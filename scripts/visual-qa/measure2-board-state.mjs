/** 固定した絵の板IDで、撮影時に開く画面を選ぶ。製品の保存・権限は変えない。 */
import { RICH_MENU_GROUPS, RICH_MENU_GROUP_DETAILS, RICH_MENU_FOLDERS, TAGS, TAG_GROUPS, TEMPLATES, TEMPLATE_FOLDERS, FORMS, FORM_FOLDERS, AUTO_REPLIES, NEN_PHOTO_PUBLICATIONS, BROADCASTS, BROADCAST_FOLDERS, BOOKING_REQUESTS, BOOKING_STAFF, EC_NOTIFICATION_SETTINGS, LINE_NOTIFICATION_DEFINITIONS, LINE_NOTIFICATION_SEND_COUNTS, FORM_VISIT_DETAIL, FORM_VISIT_SUBMISSIONS, OUTGOING_WEBHOOKS, LINE_ACCOUNTS, BROADCAST_NOTIFICATION_SETTINGS, NEN_DELIVERIES } from './fixtures.mjs'

import { TAG_EDIT_GROUPS, FRIEND_ATTRIBUTE_SAVED_SEARCH_DETAIL } from './fixtures.mjs'
export const REFERENCE_REVISION = '2026-10-11 16:11 JST'

const createTemplate = (kind) => ({
  url: '/hq/templates',
  click: [kind, 'テンプレートを作る'],
})

// 普通の一覧の撮影だけを4行にする。削除確認で使う未使用の下書きは共通見本に残す。
const richMenuItems = RICH_MENU_GROUPS.filter(group => group.id !== 'rich-menu-safe').map(group => ({
  ...group,
  ...(group.id === 'rmg-gold' ? { audienceCount: 182 } : {}),
  // 10/5の予約が撮影日を過ぎても、予約状態の絵を再現する。
  ...(group.id === 'rmg-autumn' ? { publishingAt: `${new Date().getUTCFullYear() + 1}-10-05T00:00:00.000+09:00` } : {}),
})).sort((a, b) => a.targetingPriority - b.targetingPriority)
const richMenuApi = [
  { match: 'GET /api/rich-menu-groups$', body: { success: true, data: {
    items: richMenuItems, total: richMenuItems.length, limit: 20,
    sort: [{ field: 'targetingPriority', direction: 'asc' }, { field: 'createdAt', direction: 'asc' }, { field: 'id', direction: 'asc' }],
    facets: { total: richMenuItems.length, published: richMenuItems.filter(group => group.status === 'published').length, targeting: richMenuItems.filter(group => group.targetingEnabled).length, folderCounts: Object.fromEntries(richMenuItems.reduce((counts, group) => {
      const id = group.folderId ?? '__unfiled__'; counts.set(id, (counts.get(id) ?? 0) + 1); return counts
    }, new Map())) },
  } } },
  { match: 'GET /api/tags$', body: { success: true, data: TAGS.map(tag => tag.id === 'tag-0' ? { ...tag, name: 'ゴールド会員' } : tag) } },
]

// 統括の普通の一覧も、店と同じ既存の見本を配った状態で撮る。
// GET の撮影だけ。共通APIの作成・編集・詳細の見本は上書きしない。
const distribution = (count) => ({
  distributed_account_count: count,
  distributed_account_names: ['本店', '渋谷店', 'イベント'].slice(0, count),
  distributed_account_more: 0, outdated_account_count: 0, current_version: 1,
})
const hqRow = (row, type, count) => ({
  id: `measure2-hq-${type}-${row.id}`, name: row.name, description: row.description ?? null,
  template_type: type, folder_id: row.folderId ?? row.groupId ?? null,
  revision: 1, updated_at: row.updatedAt ?? row.createdAt,
  ...distribution(count),
})
const hqTemplates = TEMPLATES.slice(0, 6).map((row, index) => ({
  ...hqRow(row, 'template', [3, 2, 3, 0, 0, 1][index]), kind: 'message',
  this_month_sent_count: row.monthlySendCount, content_summary: row.messageType,
  outdated_account_count: row.hasDraft && row.publishedAt ? 1 : 0,
}))
const assignmentWords = { ec: 'EC 連携', line_login: 'LINE ログイン', form: '回答フォーム', ec_purchase: 'EC 購入', manual: '手動', birthday: '誕生日のきまり' }
const hqTags = TAGS.slice(0, 6).map((row, index) => ({
  ...hqRow(row, 'tag', index === 5 ? 0 : 3), friend_count: row.friendCount,
  manual_assignment_allowed: row.assignSource === 'manual', assignment_method: assignmentWords[row.assignSource],
}))
const hqForms = FORMS.slice(0, 5).map((row, index) => ({
  ...hqRow(row, 'form', [3, 2, 0, 3, 0][index]),
}))
const hqMenus = richMenuItems.map((row) => ({
  ...hqRow(row, 'rich_menu', row.status === 'published' ? 3 : 0),
  display_order: row.targetingPriority, display_audience: row.targetingEnabled ? 'タグ「ゴールド会員」' : row.isDefaultForAll ? 'すべての友だち' : 'まだ決めていない',
  tap_count: row.monthlyStats?.taps ?? 0,
}))
const hqListProfile = (url, rows, folders) => ({ url, api: [
  { match: 'GET /api/hq/templates$', body: { success: true, data: rows, stats: {
    thisMonthSentCount: rows.every(row => row.this_month_sent_count != null) ? rows.reduce((sum, row) => sum + row.this_month_sent_count, 0) : null,
    outdatedTemplateCount: rows.filter(row => row.outdated_account_count > 0).length,
  } } },
  { match: 'GET /api/hq/templates/folders$', body: { success: true, data: folders.map(folder => ({ id: folder.id, name: folder.name, color: folder.color, revision: 1 })) } },
] })

// 統括にも店と同じ普通の配信を1アカウントへ送った見本を置く。
// 承認待ち・送信枠など口の無い機能はこの見本で作らない。
const hqBroadcasts = BROADCASTS.map(row => {
  const state = row.status === 'draft' ? 'prepared' : row.status === 'failed' ? 'failed' : row.status === 'sent' ? 'sent' : 'scheduled'
  return {
    id: `measure2-hq-${row.id}`, title: row.title, status: state, version: 1, scheduledAt: row.scheduledAt,
    input: { requestId: `measure2-hq-${row.id}`, title: row.title, messageType: 'text', messageContent: `${row.title}の本文です。`,
      accountIds: ['visual-qa-account'], accountTagIds: [], excludedAccountIds: [], audience: { kind: 'all' }, scheduledAt: row.scheduledAt, folderId: row.folderId },
    targets: [{ accountId: 'visual-qa-account', accountName: '本店', audienceCount: row.totalCount, remaining: 20000,
      connected: true, paused: false, blockedReasons: [], excluded: false, broadcastId: state === 'sent' || state === 'failed' ? row.id : null,
      status: state, totalCount: row.totalCount, successCount: row.successCount, version: 1, retryableCount: 0, stopped: false }],
  }
})
const cancellationEvent = event => event === 'ec.subscription.payment_failed' ? 'ec.subscription.cancelled' : event

const captureJst = new Date(Date.now() + 9 * 60 * 60 * 1000)
const csvSample = ['LINEユーザーID,LINE表示名,本名,システム表示名,登録日', ...[1, 2, 3].map(i => `U${String(i).repeat(32)},撮影の見本${i},,,2026-09-01`)].join('\n')
const monthDeliveryApi = [0, -1].map(offset => {
  const from = new Date(Date.UTC(captureJst.getUTCFullYear(), captureJst.getUTCMonth() + offset, 1) - 9 * 60 * 60 * 1000).toISOString()
  const to = new Date(Date.UTC(captureJst.getUTCFullYear(), captureJst.getUTCMonth() + offset + 1, 1) - 9 * 60 * 60 * 1000).toISOString()
  const sent = NEN_DELIVERIES.summary.sent - (offset === -1 ? 240 : 0)
  const summary = { ...NEN_DELIVERIES.summary, sent }
  const total = ['pending', 'processing', 'sent', 'skipped', 'failed', 'cancelled'].reduce((count, key) => count + summary[key], 0)
  return { match: `GET /api/nen-campaigns/deliveries?lineAccountId=visual-qa-account&limit=1&from=${encodeURIComponent(from)}`,
    body: { success: true, data: { ...NEN_DELIVERIES, range: { ...NEN_DELIVERIES.range, from, to }, summary,
      deliveries: NEN_DELIVERIES.deliveries.slice(0, 1).map(row => ({ ...row, scheduledAt: from, sentAt: row.sentAt ? from : null, updatedAt: from })), pagination: { ...NEN_DELIVERIES.pagination, total, limit: 1, cursor: '0', nextCursor: '1' },
    } },
  }
})

const searchEditExample = structuredClone(FRIEND_ATTRIBUTE_SAVED_SEARCH_DETAIL)
// 「VIPかつ未契約」：2つ目は付いていないタグを選ぶ。共通の一覧見本は変えない。
searchEditExample.conditions.all[1].op = 'excludes'

export const BOARD_STATE_PROFILES = {
  apLqS: { url: '/reminders', joinControlText: 'button[title="失敗があるリマインダだけに絞り込みます"]' },
  T9gblG: { url: '/friends/migrations', click: [
    `file:${JSON.stringify({ name: 'friends.csv', text: csvSample })}`, 'まず確認だけする',
  ], api: [{ match: 'POST /api/friends/imports$', body: { success: true, data: {
    id: 'measure2-preview', status: 'previewed', duplicate: false,
    result: { summary: { add: 3, update: 0, unchanged: 0, conflict: 0, error: 0 }, rows: [] },
  } } }] },
  qwIZr: { url: '/restaurant-test/dashboard', transformApi: (rules) => rules.map(rule => {
    if (rule.match !== 'GET /api/restaurant-test/reservations/day') return rule
    const samples = [
      { customer_name: '見本 169', source: 'restaurant_board', status: 'visited', table_label: 'T3' },
      { customer_name: '見本 114', source: 'line', status: 'confirmed', table_label: 'C1' },
      { customer_name: '見本 141', source: 'tabelog', status: 'pending', table_label: 'T1' },
      { customer_name: '見本 182', source: 'hotpepper', status: 'confirmed', table_label: 'T4' },
      { customer_name: '押さえ', source: 'phone', status: 'pending', table_label: 'TR1', hold_expires_at: '@TODAY@T22:00:00+09:00' },
    ]
    return { ...rule, body: { ...rule.body, data: { ...rule.body.data,
      reservations: rule.body.data.reservations.slice(0, samples.length).map((row, index) => ({ ...row, hold_expires_at: null, ...samples[index] })),
    } } }
  }) },
  MuhWR: { url: '/nen-campaigns', api: monthDeliveryApi },
  JKjsE: { url: '/hq', api: [
    // 接続を確かめるTESTのアカウントも、普通の一覧では小さい利用数で撮る。
    { match: 'GET /api/line-accounts$', body: { success: true, data: LINE_ACCOUNTS.map(account => account.id === 'visual-qa-account'
      ? { ...account, stats: { ...account.stats, friendCount: 14, messagesThisMonth: 12 } } : account) } },
  ] },
  cdZBf: { url: '/broadcasts/reserved?id=broadcast-0', api: [
    { match: 'GET /api/broadcasts/notification-settings$', body: { success: true, data: {
      ...BROADCAST_NOTIFICATION_SETTINGS, displayText: '配信の開始・完了・エラーは、Slack の同じスレッドへ知らせます。',
    } } },
  ] },
  v0SbYR: { url: '/form-submissions/responses?id=form-visit', api: [
    // fields・入力の札・評価のまとめは、同じ質問の見出しを使う。
    { match: 'GET /api/forms/form-visit$', body: { success: true, data: {
      ...FORM_VISIT_DETAIL,
      fields: FORM_VISIT_DETAIL.fields.map(field => field.name === 'staff' ? { ...field, label: '担当の対応はいかがでしたか？' } : field),
      layout: { ...FORM_VISIT_DETAIL.layout, sections: FORM_VISIT_DETAIL.layout.sections.map(section => ({ ...section,
        blocks: section.blocks.map(block => block.name === 'staff' ? { ...block, label: '担当の対応はいかがでしたか？' } : block),
      })) },
    } } },
    { match: 'GET /api/forms/form-visit/submissions$', body: { success: true, data: {
      ...FORM_VISIT_SUBMISSIONS, summary: { ...FORM_VISIT_SUBMISSIONS.summary,
        ratingFields: FORM_VISIT_SUBMISSIONS.summary.ratingFields.map(field => field.key === 'staff' ? { ...field, label: '担当の対応はいかがでしたか？' } : field),
      },
    } } },
  ] },
  ZSbFY: { url: '/webhooks', api: [
    // 名前と実装済みの受信/予約の出来事だけを撮影へ合わせる。先月比較や金額だけの送信を作らない。
    { match: 'GET /api/webhooks/outgoing$', body: { success: true, data: OUTGOING_WEBHOOKS.map((row, index) => ({
      ...row,
      ...(index === 0 ? { name: '顧客台帳（CRM）', eventTypes: ['message_received'] } : {}),
      ...(index === 1 ? { name: 'Slack への通知', eventTypes: ['friend_add'] } : {}),
      ...(index === 2 ? { name: '予約台帳', eventTypes: ['booking_created'] } : {}),
      ...(index === 4 ? { name: '旧ポイント連携' } : {}),
    })) } },
  ] },
  wxIQ7: { url: '/rich-menus/connections?id=rmg-1', api: [
    // 編集中の下書きとは別に、公開した3ページのつながりを撮る。
    { match: 'GET /api/rich-menu-groups/rmg-1$', body: { success: true, data: {
      ...RICH_MENU_GROUP_DETAILS['rmg-1'], status: 'published',
      pages: RICH_MENU_GROUP_DETAILS['rmg-1'].pages.map(page => ({ ...page, lineRichmenuId: page.lineRichmenuId ?? `measure2-line-${page.id}` })),
    } } },
  ] },
  g3iDs: { url: '/line-notifications', api: [
    // 「定期便を止めた」は決済失敗ではなく解約。設定・定義・集計の鍵をそろえる。
    { match: 'GET /api/ec-commerce/settings$', body: { success: true, data: EC_NOTIFICATION_SETTINGS.map(row => ({ ...row, eventType: cancellationEvent(row.eventType) })) } },
    { match: 'GET /api/line-notifications/customer-definitions$', body: { success: true, data: LINE_NOTIFICATION_DEFINITIONS.map(row => ({ ...row, key: cancellationEvent(row.key), sourceEventType: cancellationEvent(row.sourceEventType) })) } },
    { match: 'GET /api/line-notifications/send-counts$', body: { success: true, data: { ...LINE_NOTIFICATION_SEND_COUNTS,
      byEventType: LINE_NOTIFICATION_SEND_COUNTS.byEventType.map(row => ({ ...row, eventType: cancellationEvent(row.eventType) })),
    } } },
  ] },
  GcyTr: { url: '/booking/bookings?view=day&date=2026-09-03&status=all', api: [
    { match: 'GET /api/booking/admin/staff$', body: { staff: BOOKING_STAFF.map((staff, index) => index === 0 ? { ...staff, display_name: 'Masato' } : staff) } },
    { match: 'GET /api/booking/admin/requests$', body: {
      requests: BOOKING_REQUESTS.filter(row => row.starts_at.startsWith('2026-09-03')).map(row => ({
        ...row, staff_id: BOOKING_STAFF.find(staff => staff.display_name === row.staff_name)?.id ?? null,
        ...(row.staff_name === BOOKING_STAFF[0].display_name ? { staff_name: 'Masato' } : {}),
      })), total: 5, limit: 100, offset: 0,
    } },
  ] },
  SyQA1: { url: '/nen-members?tab=publications', api: [
    { match: 'GET /api/nen-members/photos/publications$', body: { success: true, data: {
      ...NEN_PHOTO_PUBLICATIONS,
      // 撮る一覧も同じ8枚。掲載順と写真ごとの名前の同意だけを再現する。
      // 累計を30日の回数へ置き換えない。
      items: ['pub-3', 'pub-2', 'pub-1', 'pub-4', 'pub-5', 'pub-6', 'pub-7', 'pub-8'].map(id => {
        const photo = NEN_PHOTO_PUBLICATIONS.items.find(item => item.id === id)
        return { ...photo, hide_owner_name: id === 'pub-2' ? 0 : 1 }
      }),
    } } },
  ] },
  uE9gf: { url: '/auto-replies', api: [
    { match: 'GET /api/auto-replies$', body: { success: true, data: AUTO_REPLIES.map(rule => rule.id === 'ar-2'
      ? { ...rule, actions: [...rule.actions, { actionType: 'notify_staff' }] } : rule) } },
  ] },
  U4Eep0: { url: '/hq/broadcasts', api: [
    { match: 'GET /api/hq/broadcasts$', body: { success: true, data: hqBroadcasts } },
    { match: 'GET /api/hq/broadcasts/folders$', body: { success: true, data: BROADCAST_FOLDERS.map(folder => ({
      id: folder.id, name: folder.name, color: folder.color, revision: 1, item_count: hqBroadcasts.filter(run => run.input.folderId === folder.id).length,
    })) } },
  ] },
  i0Ao0R: hqListProfile('/hq/templates', hqTemplates, TEMPLATE_FOLDERS),
  DzdC3: hqListProfile('/hq/friend-attributes', hqTags, TAG_GROUPS),
  wZPua: hqListProfile('/hq/form-submissions', hqForms, FORM_FOLDERS),
  noVq4: hqListProfile('/hq/rich-menus', hqMenus, RICH_MENU_FOLDERS),
  rZEGN: { url: '/rich-menus', api: richMenuApi },

  AqDWN: { url: '/tags/searches/edit?id=ss-1', api: { match: 'GET /api/saved-searches/ss-1$', body: { success: true, data: searchEditExample } } },
  l87p1J: { url: '/templates/questions/new', click: ['fill:テンプレート名=定期便 継続のご確認', 'fill:前文（空なら送らない）=いつもありがとうございます。', 'fill:質問文（160文字まで）=来月も定期便を続けますか？', '押されたときにあわせて行うことを足す', 'fill:選択肢1の足すスコア=10', '名前とフォルダ'] },
  K7HWG: { url: '/auto-replies/edit?id=ar-new', click: ['fill:ルール名='] },
  d4adD4: { url: '/events/new', click: ['fill:イベント名=秋のしつけ教室（第1回）', '1人あたりの予約回数', '1 回まで', '申し込みの上限', '開始の 1 日前まで', '承認', '承認してから確定（期限 24 時間）', '満席になったとき', 'キャンセル待ちを受ける（空いたら順番に案内）', '＋ 質問を足す', 'fill:聞くこと=ペットの名前と年齢', '足す'] },
  Qat9s: { url: '/tags/edit?id=tag-ec-customer', api: { match: 'GET /api/tag-groups$', body: { success: true, data: TAG_EDIT_GROUPS } } },
  iN6np: { url: '/broadcasts/new?step=message&draft=visual-compose' },
  pIHp3: { url: '/hq/broadcasts/new?step=message&id=hq-visual-compose' },
  M2tJM: { url: '/hq/broadcasts/detail?id=hq-visual-sent' },
  HfK0O: createTemplate('メッセージ'),
  SDSsr: createTemplate('カルーセル'),
  IY3nx: createTemplate('質問'),
  C3qMCz: createTemplate('クーポン'),
  Fkv3w: createTemplate('リサーチ'),
  g8d6ai: createTemplate('リッチメッセージ'),
  Ni0V8: createTemplate('リッチビデオ'),
  pQ4fH: { url: '/hq/templates?item=visual-hq-tpl-thanks&mode=detail' },
}

export function applyBoardStateProfiles(map) {
  const result = structuredClone(map)
  if (!result.boards || typeof result.boards !== 'object') throw new Error('boards を持つ対応表を指定してください')
  for (const [id, profile] of Object.entries(BOARD_STATE_PROFILES)) {
    const entry = result.boards[id]
    if (!entry) continue
    // 閲覧のみ・失敗・手動の再現条件がある板を、作成画面の見本で上書きしない。
    if (entry.state?.manual || entry.state?.role === 'viewer' || entry.kind === '閲覧のみ') {
      throw new Error(`${id}: 既存の状態指定と撮影の指定が重なっています`)
    }
    // 地図に具体的な開き方がある板は、その操作・API見本を正とし、補助の既定で上書きしない。
    if (entry.state?.click) continue
    entry.url = profile.url
    if (profile.joinControlText) entry.state = { ...entry.state, joinControlText: profile.joinControlText }
    if (profile.transformApi) {
      entry.state = { ...entry.state, api: profile.transformApi(Array.isArray(entry.state?.api) ? entry.state.api : entry.state?.api ? [entry.state.api] : []) }
    }
    if (profile.click) entry.state = { ...entry.state, click: [...profile.click] }
    if (profile.api) entry.state = { ...entry.state, api: [...(Array.isArray(profile.api) ? profile.api : [profile.api]), ...(Array.isArray(entry.state?.api) ? entry.state.api : entry.state?.api ? [entry.state.api] : [])] }
  }
  return result
}

export const FORM_STATE_PROFILES = {
  u5MM7: { url: '/hq/form-submissions?item=visual-hq-tpl-form&mode=edit' },
  scJcP: { url: '/hq/form-submissions?item=visual-hq-tpl-form&mode=edit&tab=after' },
  xRPdo: { url: '/hq/form-submissions?item=visual-hq-tpl-form&mode=edit&tab=appearance' },
  N4T9mO: { url: '/hq/form-submissions?item=visual-hq-tpl-form&mode=edit&page=2' },
}
