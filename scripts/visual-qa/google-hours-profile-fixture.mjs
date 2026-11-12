import { emptyHoursWorkspace } from '../../packages/shared/dist/google-hours-workspace.js'
export const GOOGLE_STORE = { id: 'store-sby', name: '然 渋谷店', lineAccountId: 'visual-qa-account' }
export const GOOGLE_CONNECTION = {
  status: 'connected', googleAccountEmail: 'shop@example.com', locationName: 'locations/nen-shibuya', locationTitle: '然 渋谷店',
  locationMapsUrl: 'https://maps.google.com/?cid=nen-shibuya', connectedAt: '2026-09-12T10:20:00+09:00', disconnectedAt: null,
  lastSyncedAt: '2026-10-02T08:00:00+09:00', lastSyncError: null, averageRating: 4.2, totalReviewCount: 24,
}
const googleReview = (id, name, rating, comment, at, replyStatus, extra = {}) => ({
  id, reviewName: `accounts/1/locations/1/reviews/${id}`, reviewerDisplayName: name, starRating: rating, comment,
  createTime: at, updateTime: null, needsAttention: rating <= 2, replyStatus, replyDraft: null, replyDraftAiGenerated: false,
  replyDraftGeneratedAt: null, replyComment: null, replyUpdateTime: null, firstSeenAt: at, updatedAt: at, ...extra,
})
export const GOOGLE_REVIEWS = [
  googleReview('rv-1', '佐藤 S.', 5, '鹿肉のローストが本当においしかったです。また来ます。', '2026-09-30T21:40:00+09:00', 'unreplied'),
  googleReview('rv-2', 'Kenji', 2, '予約していたのに20分待ちました。料理はよかったです。', '2026-09-30T20:12:00+09:00', 'unreplied', {
    replyDraft: 'Kenji 様、ご来店ありがとうございました。お待たせしてしまい申し訳ございません。ご予約の時間にご案内できるよう、席の準備を見直しました。またのお越しをお待ちしております。',
  }),
  googleReview('rv-3', 'Yuki T.', 4, '個室が落ち着けて、記念日に使えました。', '2026-09-29T22:05:00+09:00', 'draft', { replyDraft: 'Yuki T. 様、記念日にお選びいただきありがとうございました。', replyDraftAiGenerated: true }),
  googleReview('rv-4', 'M. Tanaka', 5, 'コースの説明が丁寧でした。', '2026-09-28T19:30:00+09:00', 'published', { replyComment: 'ありがとうございます。またお待ちしております。', replyUpdateTime: '2026-09-29T10:00:00+09:00' }),
  googleReview('rv-5', 'あや', 3, '少し量が少なめに感じました。', '2026-09-27T13:10:00+09:00', 'pending_confirm', { replyDraft: 'ご意見ありがとうございます。量の見直しを検討いたします。' }),
]
export const GOOGLE_CONNECTION_DATA = {
  success: true, store: GOOGLE_STORE, connection: GOOGLE_CONNECTION, candidates: [],
  summary: { unrepliedCount: 2, draftCount: 1, attentionCount: 1, newCount: 0, storedCount: 24, postsAttentionCount: 0, syncStale: false },
  writeEnabled: false, oauthConfigured: true, aiAvailable: true,
  permissions: { canManageConnection: true, canPublishReply: true },
}
const googlePost = (id, kind, summary, title, publishedAt, status) => ({
  id, kind, origin: 'admin', summary, title, schedule: null, cta: null, offer: null, media: [], publishMode: 'now', status,
  googleState: status === 'published' ? 'LIVE' : null, searchUrl: null, staffName: '見本 30', error: null,
  createdAt: publishedAt, sentAt: publishedAt, publishedAt, updatedAt: publishedAt,
})
export const GOOGLE_POSTS = [
  googlePost('gp-1', 'offer', '秋の鹿肉コース、10/31 まで乾杯ドリンク1杯サービス', '秋の鹿肉コース、10/31 まで乾杯ドリンク1杯サービス', '2026-10-01T11:00:00+09:00', 'published'),
  googlePost('gp-2', 'event', '10/12（月）ジビエの夕べ（予約制・12名）', '10/12（月）ジビエの夕べ（予約制・12名）', '2026-09-28T18:00:00+09:00', 'published'),
  { ...googlePost('gp-3', 'standard', 'ランチの営業時間が 11:30〜14:00 になりました', null, '2026-09-20T09:00:00+09:00', 'published'), googleState: 'EXPIRED' },
]
export const GOOGLE_POST_LIST = {
  success: true, posts: GOOGLE_POSTS, page: 1, perPage: 20, total: GOOGLE_POSTS.length,
  counts: { all: 3, draft: 0, published: 3, attention: 0, scheduled: 0 }, writeEnabled: false, permissions: { canPublish: true },
}
export const GOOGLE_PERFORMANCE = {
  success: true, days: 28, range: { startDate: '2026-09-05', endDate: '2026-10-02' }, previousRange: { startDate: '2026-08-08', endDate: '2026-09-04' },
  totals: { impressions: 1820, directionRequests: 214, callClicks: 38, websiteClicks: 156 },
  previousTotals: { impressions: 1625, directionRequests: 204, callClicks: 39, websiteClicks: 143 },
  daily: Array.from({ length: 28 }, (_, i) => ({ date: `2026-${i < 26 ? '09' : '10'}-${String(i < 26 ? 5 + i : i - 25).padStart(2, '0')}`, impressions: 50 + ((i * 17) % 30) })),
  food: { menuClicks: 310, bookings: 42, foodOrders: null }, lastMetricsSyncedAt: '2026-10-02T04:00:00+09:00',
}

const GOOGLE_WEEKLY = Object.fromEntries(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'].map((d) => [d, d === 'TUESDAY' ? [] : [{ open: '17:00', close: '23:00' }]]))
export const createGoogleHoursProfile = (GOOGLE_STORE) => ({
  success: true, store: GOOGLE_STORE,
  profile: {
    name: 'locations/nen-shibuya', title: '然 渋谷店', address: { postalCode: null, administrativeArea: '東京都', locality: '渋谷区', addressLines: ['神南1-2-3'] },
    phone: '03-****-5678', websiteUri: 'https://nen-shop.jp', description: '信州のジビエを炭火で。', openStatus: 'OPEN',
    regularHours: GOOGLE_WEEKLY, specialHours: [], mapsUri: 'https://maps.google.com/?cid=nen-shibuya',
  },
  today: { date: '2026-10-02', weekday: 'FRIDAY', holidayName: null, periods: [{ open: '17:00', close: '23:00' }], closed: false, special: false },
  holidays: [{ date: '2026-10-12', name: 'スポーツの日', weekday: 'MONDAY', special: null }],
  timeZone: 'Asia/Tokyo', closed: false, photoCount: 12,
  googleUpdates: { fields: [{ mask: 'phoneNumbers', label: '電話番号' }], updated: { phone: '03-****-9999' } },
  fetchedAt: '2026-10-02T08:00:00+09:00', stale: false, refreshError: null, pendingChangeCount: 0, writeEnabled: false, aiAvailable: true,
  permissions: { canManageConnection: true, canPublishReply: true, canSendChange: true },
})

export const createGoogleHoursWorkspace = () => ({success:true,version:0,data:emptyHoursWorkspace(),history:[],holidays:[],serviceTypes:[]})
