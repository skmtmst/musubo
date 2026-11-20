/**
 * 画像で見張るルートの一覧。
 *
 * 全103ルートをいきなり入れない。**5つの画面型の代表**から始めて、
 * 落ち着いたら増やす。増やすときは、そのルートが本当に描けることを
 * 手で1回確かめてから足す（描けないものを入れると、毎回赤いままになり、
 * 誰も見なくなる）。
 *
 * `name` は画像のファイル名になる。変えると前回と比較できなくなるので、
 * 一度決めたら変えない。
 */
export const ROUTES = [
  // L 一覧
  { name: 'tags', path: '/tags', type: 'L' },
  { name: 'friends', path: '/friends', type: 'L' },
  { name: 'scenarios', path: '/scenarios', type: 'L' },
  { name: 'templates', path: '/templates', type: 'L' },
  // D 受信箱（3カラム全画面）
  { name: 'chats', path: '/chats', type: 'D' },
  // 設定系
  { name: 'settings-features', path: '/settings', type: 'L' },
  { name: 'staff', path: '/staff', type: 'L' },
  // S ダッシュボード（カードを並べる画面）
  /*
    ダッシュボードは「6日前」のような**今日から数える表示**を持つ。
    時計を止めないと、日をまたぐたびに絵が変わって毎朝赤くなる。
    実際に一度そうなった（6日前→7日前）。
  */
  { name: 'dashboard', path: '/', type: 'S', clock: '2026-08-19T12:00:00.000Z' },
  // A 分析
  { name: 'analytics', path: '/analytics', type: 'A' },
  // 残りの一覧
  { name: 'broadcasts', path: '/broadcasts', type: 'L' },
  { name: 'rich-menus', path: '/rich-menus', type: 'L' },
  { name: 'initial-rich-menu', path: '/getting-started/rich-menu', type: 'C', widths: [1152, 1440, 1920] },
  { name: 'automations', path: '/automations', type: 'L' },
]

/**
 * まだ入れられないルート。**モックの形が足りず、画面が落ちる。**
 *
 * 落ちるものを一覧へ入れると毎回赤くなり、誰も見なくなる。
 * 直したら `ROUTES` へ移す。直し方は、**推測しないこと**。
 * ブラウザに出る `◯◯.filter is not a function` や
 * `undefined の ◯◯ を読めない` を見て、その口の形だけを
 * `mock-api.mjs` の `SHAPES` に足す。配列で返る口は `api.ts` から
 * 自動で読んでいる（`api-shapes.mjs`）ので、手で足さない。
 */
export const NOT_READY = []

/**
 * 4-1 の「中身が出せないとき」。
 *
 * 実ルート `/tags` を開いたまま、**ブラウザ側で口の返事だけ差し替える**。
 * 画面のコードは本物のまま通る（`fixture` を渡して素通りさせない）。
 * モックは触らない（触ると他の画面の画像まで変わる）。
 *
 * `loading` はここに入れない。返事を止めたまま撮るので、
 * 待ち方が違う（`capture.spec.mjs` に別で書いてある）。
 */
export const TAG_STATES = [
  {
    name: 'tags-empty',
    label: 'まだ1件も無い',
    status: 200,
    body: { success: true, data: [] },
    // 1件も無いときは、上の数も0。101件のまま残すと、消えたように見える。
    statsBody: {
      success: true,
      data: {
        tags: { total: 0, unused: 0, taggedFriends: 0, assignedThisMonth: 0 },
        marks: { total: 0, inUse: 0, unanswered: 0, inProgress: 0, resolved: 0, changedLast7: 0 },
        searches: { total: 0, limit: 5 },
        templates: { total: 0, inUse: 0, sentThisMonth: 0, unused90d: 0, clickRate: null },
        scenarios: { total: 0, active: 0, subscribers: 0, completed: 0, sentThisWeek: 0 },
        reminders: { total: 0, active: 0, waiting: 0, sentThisMonth: 0 },
      },
    },
  },
  {
    name: 'tags-error',
    label: '読み込めなかった',
    status: 500,
    body: { success: false, error: 'internal error' },
  },
  {
    name: 'tags-forbidden',
    label: '見る権限が無い',
    status: 403,
    body: { success: false, error: 'forbidden' },
  },
]

/** 画像を撮る幅。PCのどの幅でも横スクロールが出てはいけない。 */
export const WIDTHS = [1440, 1920]
