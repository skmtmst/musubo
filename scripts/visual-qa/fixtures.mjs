import { storeAt } from './qa-clock.mjs'

/**
 * 画面確認のための、固定の中身。
 *
 * **画面の通常・空・失敗を再現する合成データ。実在の顧客情報は使わない。**
 * これが無いと、実装は空の表しか描けず、設計と画像で比べられない。
 * 「空の状態」だけを見て「一致した」と言えてしまうのが、いちばん危ない。
 *
 * 守ること
 * - **実在の顧客・秘密値を使わない。** 名前も数字も設計の絵の値そのもの
 * - **乱数と時刻を使わない。** 毎回まったく同じ絵になる
 * - **設計を変えたらここも変える。** 合わなくなったら、どちらが正かを決める
 *
 * 対象: 友だち属性・タグの一覧と編集。
 */

/**
 * 設計の左パネル（`DgeL8`）の並びと件数。
 * `count` は絵に書いてある数。タグはこの数だけ作る。
 */
export const FOLDER_COUNTS = [
  ['g-vip', 'VIP', 14],
  ['g-pet', 'ペット', 12],
  ['g-member', '会員', 18],
  ['g-health', '健康', 16],
  ['g-purchase', '購入', 21],
  ['', '未分類', 20],
]

/**
 * フォルダ。全部で6つ（CSV取込の判定・埋め草の行先に使う）。
 * 画面の `/api/tag-groups` が返すのは下の `TAG_GROUPS`（★V8 の絵の3つ）。
 */
const TAG_GROUPS_ALL = [
  { id: 'g-vip', name: 'VIP', sortOrder: 0, color: '#2563EB', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'g-pet', name: 'ペット', sortOrder: 1, color: '#16A34A', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'g-member', name: '会員', sortOrder: 2, color: '#D97706', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'g-health', name: '健康', sortOrder: 3, color: '#0EA5E9', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'g-purchase', name: '購入', sortOrder: 4, color: '#3B82F6', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  { id: 'g-inquiry-follow', name: 'お問い合わせフォロー', sortOrder: 5, color: '#7C3AED', createdAt: '2026-08-25T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z' },
]

/**
 * `/api/tag-groups` の返事。★V8 友だち属性の絵（I1E7Bt・aPeD8・fkGUR）の
 * フォルダの列は VIP・ペット・会員・未分類の3つ＋未分類。
 * 健康・購入・お問い合わせフォローは返さない（その中のタグは一覧では「未分類」の
 * フォルダ名で出るが、件数の「未分類 20」は groupId が空のタグだけを数えるので変わらない）。
 */
export const TAG_GROUPS = TAG_GROUPS_ALL.slice(0, 3)
/** 編集の下書きが持つ購入フォルダも、編集板の撮影時だけ返す。 */
export const TAG_EDIT_GROUPS = TAG_GROUPS_ALL
  .filter((group) => TAG_GROUPS.some((listed) => listed.id === group.id) || group.id === 'g-purchase')
  .map((group) => ({ ...group, accountId: 'visual-qa-account' }))

/** 機能4のCSV取込。DBを変えず、同じ入力には同じ判定を返す。 */
export const TAG_IMPORT_SAMPLE_ROWS = [
  { line: 12, name: '定期便リマインド', folderName: '購入' },
  { line: 13, name: 'VIP', folderName: 'VIP' },
  { line: 14, name: '誕生日クーポン 2026', folderName: '誕生日' },
  { line: 15, name: '', folderName: '会員' },
  { line: 16, name: '会員\nランク', folderName: '会員' },
  { line: 88, name: '長期未購入フォロー用の判定タグ（2026年版・暫定）'.repeat(2), folderName: '' },
  { line: 204, name: '店舗共通ラベル', folderName: 'お問い合わせフォロー' },
  { line: 331, name: '休眠', folderName: '' },
]

const EXISTING_TAG_NAMES = new Set(['VIP', 'EC顧客連携済み', 'NEN会員'])

export function tagImportPreview(rows = TAG_IMPORT_SAMPLE_ROWS) {
  const knownFolders = new Set(TAG_GROUPS_ALL.map((folder) => folder.name))
  const seen = new Set()
  const planned = rows.map((input, index) => {
    const line = Number.isInteger(input?.line) && input.line > 0 ? input.line : index + 2
    const name = typeof input?.name === 'string' ? input.name.trim() : ''
    const folderName = typeof input?.folderName === 'string' ? input.folderName.trim() : ''
    const base = { line, name, folderName }
    if (!name) return { ...base, status: 'invalid', code: 'name_required', message: 'タグ名が入っていません' }
    if (name.length > 60) return { ...base, status: 'invalid', code: 'name_too_long', message: 'タグ名が長すぎます（60文字まで）' }
    if (/[\u0000-\u001F\u007F]/u.test(name)) return { ...base, status: 'invalid', code: 'invalid_character', message: '使えない文字が入っています' }
    if (EXISTING_TAG_NAMES.has(name)) return { ...base, status: 'skipped', code: 'already_exists', message: '同じ名前のタグがあります' }
    const normalized = name.normalize('NFKC').toLowerCase()
    if (seen.has(normalized)) return { ...base, status: 'skipped', code: 'duplicate_in_file', message: '同じCSVの前の行と重複しています' }
    seen.add(normalized)
    if (folderName && !knownFolders.has(folderName)) {
      return { ...base, status: 'ready', code: 'folder_not_found', message: 'フォルダがありません。未分類として登録します' }
    }
    return { ...base, status: 'ready', message: '登録できます' }
  })
  return {
    summary: {
      total: planned.length,
      ready: planned.filter((row) => row.status === 'ready').length,
      created: 0,
      skipped: planned.filter((row) => row.status === 'skipped').length,
      invalid: planned.filter((row) => row.status === 'invalid').length,
      failed: 0,
    },
    rows: planned,
  }
}

export function tagImportResult(rows = TAG_IMPORT_SAMPLE_ROWS) {
  const preview = tagImportPreview(rows)
  const resultRows = preview.rows.map((row, index) => {
    if (row.status !== 'ready') return row
    if (row.name === '店舗共通ラベル') {
      return { ...row, status: 'failed', code: 'folder_changed', message: '担当しているアカウントの外なので、作れません' }
    }
    if (row.name === '休眠') {
      return { ...row, status: 'failed', code: 'create_failed', message: '保存できませんでした。もう一度お試しください' }
    }
    return { ...row, status: 'created', tagId: `visual-tag-${index + 1}` }
  })
  const summary = {
    total: resultRows.length,
    ready: 0,
    created: resultRows.filter((row) => row.status === 'created').length,
    skipped: resultRows.filter((row) => row.status === 'skipped').length,
    invalid: resultRows.filter((row) => row.status === 'invalid').length,
    failed: resultRows.filter((row) => row.status === 'failed').length,
  }
  const rejected = summary.invalid + summary.failed
  return {
    summary,
    rows: resultRows,
    outcome: summary.created > 0 && rejected > 0 ? 'partial' : rejected > 0 ? 'failed' : 'success',
  }
}

/**
 * タグ6件。設計の表（`HrwyW`）の6行そのまま。
 * フォルダと登録日は ★V8 の絵（I1E7Bt）に合わせた：1行目・4行目は VIP、1行目の登録日は 1月13日。
 *
 * `mileageMultiplierBps` は 10000 で 1.0倍。設計の「1.2倍」は 12000。
 */
const DESIGN_ROWS = [
  // 名前, フォルダ, 付与人数, 本人マイル, 紹介マイル, 倍率, ★, 登録日, 付与元, 使用先, 他N
  ['EC顧客連携済み', 'g-vip', 64, 10, 0, 12000, true, '2026-01-13T00:00:00.000Z', 'ec', { broadcasts: 3, forms: 1 }, 1],
  ['LINEログイン連携済み', 'g-member', 198, 0, 0, null, true, '2026-01-13T00:00:00.000Z', 'line_login', { scenarios: 2 }, 0],
  ['NEN会員', 'g-member', 128, 10, 5, null, false, '2026-01-13T00:00:00.000Z', 'form', { broadcasts: 4 }, 3],
  ['商品到着確認対象', 'g-vip', 41, 3, 0, null, false, '2026-01-13T00:00:00.000Z', 'ec_purchase', { autoReplies: 1 }, 1],
  ['未契約', '', 37, 0, 0, null, true, '2026-01-13T00:00:00.000Z', 'manual', { savedSearches: 2 }, 0],
  ['誕生日クーポン対象', 'g-vip', 0, 20, 0, null, false, '2026-01-13T00:00:00.000Z', 'birthday', { broadcasts: 1 }, 2],
].map(([name, groupId, friendCount, mileageReward, referralMileageReward, mileageMultiplierBps, isStarred, createdAt, assignSource, usedIn, otherActionCount], index) => ({
  // `tag-0` は編集画面の既存設定に使うため、一覧先頭の行とは分ける。
  id: index === 0 ? 'tag-ec-customer' : `tag-${index}`,
  name: String(name),
  color: '#8b938d',
  groupId: String(groupId),
  friendCount: Number(friendCount),
  mileageReward: Number(mileageReward),
  referralMileageReward: Number(referralMileageReward),
  mileageMultiplierBps: mileageMultiplierBps == null ? null : Number(mileageMultiplierBps),
  mileageMultiplierPriority: 0,
  isStarred: Boolean(isStarred),
  displayOrder: index,
  createdAt: String(createdAt),
  /*
    サーバーは **0件・断定できないものを省く**。ここでも省く。
    省かずに 0 を入れると、画面が「未使用」と「取れていない」を
    言い分けられているかを確かめられなくなる。
  */
  assignSource: String(assignSource),
  ...(Object.keys(usedIn).length ? { usedIn } : {}),
  ...(otherActionCount ? { otherActionCount: Number(otherActionCount) } : {}),
}))

/** 設計 `ee0sk` / `VjXGX` の、保存済み「NEN会員（定期）」設定。 */
export const TAG_EDITOR_NEN_SUBSCRIPTION = {
  id: 'tag-0',
  name: 'NEN会員（定期）',
  color: '#8b938d',
  groupId: 'g-purchase',
  friendCount: 128,
  mileageReward: 10,
  referralMileageReward: 5,
  mileageMultiplierBps: 15000,
  mileageMultiplierPriority: 3,
  isStarred: false,
  assignSource: 'manual',
  usedIn: { broadcasts: 4 },
  otherActionCount: 3,
  linkedActions: [
    { id: 'tag-action-message', type: 'メッセージ', label: '「ご登録ありがとうございます。定期便の特典は…」を送信', timing: 'すぐに' },
    { id: 'tag-action-add', type: 'タグ', label: '「定期便・稼働中」を追加', timing: 'すぐに' },
    { id: 'tag-action-scenario', type: 'シナリオ', label: '「定期便オンボーディング」を開始', timing: '24時間後' },
  ],
  createdAt: '2026-01-13T00:00:00.000Z',
}

/** 統合96の GET /api/tags/:id?withActions=1 と同じ、タグ定義の器。 */
const TAG_DEFINITION_ACTIONS = [
  { id: 'tag-action-message', type: 'send_message', params: { content: 'ご登録ありがとうございます。定期便の特典をご案内します。' }, onFailure: 'stop' },
  { id: 'tag-action-add', type: 'add_tag', params: { tagId: 'tag-subscription-active' }, onFailure: 'stop' },
  { id: 'tag-action-scenario', type: 'start_scenario', params: { scenarioId: 'scenario-subscription-onboarding' }, onFailure: 'continue' },
]

const TAG_DEFINITION_TAG = {
  ...TAG_EDITOR_NEN_SUBSCRIPTION,
  lineAccountId: 'visual-qa-account',
  description: '定期便を利用しているNEN会員',
  manualAssignmentAllowed: true,
  reapplyPolicy: 'every_time',
  linkedEnabled: true,
  status: 'active',
  version: 3,
  updatedAt: '2026-08-20T19:20:00+09:00',
}

export const TAG_DEFINITION_NEN_SUBSCRIPTION = {
  ...TAG_DEFINITION_TAG,
  tag: TAG_DEFINITION_TAG,
  automation: {
    id: 'common-action-tag-0',
    name: 'NEN会員（定期）が付いたとき',
    status: 'published',
    publishedVersion: {
      id: 'common-action-tag-0-v4', versionNumber: 4, state: 'published', actions: TAG_DEFINITION_ACTIONS,
    },
    draftVersion: {
      id: 'common-action-tag-0-v5', versionNumber: 5, state: 'draft', actions: TAG_DEFINITION_ACTIONS,
    },
    actions: TAG_DEFINITION_ACTIONS,
  },
}

/** 統合96の GET /api/tags/:id/dependencies と同じ、保管前の影響確認。 */
const TAG_REFERENCE_COUNTS = {
  broadcasts: 3,
  forms: 1,
  scenarios: 2,
  autoReplies: 1,
  savedSearches: 1,
  automations: 0,
  commonActions: 0,
  richMenus: 0,
  templates: 0,
  webinars: 0,
  reminders: 0,
  entryRoutes: 0,
  trackedLinks: 0,
  bookingMenus: 0,
  affiliateOffers: 1,
  events: 0,
  analyticsFunnels: 0,
  friendAddSettings: 0,
}

export const TAG_DEPENDENCIES_NEN_SUBSCRIPTION = {
  tag: { id: 'tag-0', name: 'NEN会員（定期）', version: 3, status: 'active' },
  friendCount: 128,
  referenceCounts: TAG_REFERENCE_COUNTS,
  references: [
    { kind: 'broadcast', name: '一斉配信', href: '/broadcasts', count: 3, state: 'active', definitionVersion: null },
    { kind: 'form', name: '回答フォーム', href: '/form-submissions', count: 1, state: 'active', definitionVersion: null },
    { kind: 'scenario', name: 'シナリオ', href: '/scenarios', count: 2, state: 'active', definitionVersion: 4 },
    { kind: 'auto_reply', name: '自動応答', href: '/auto-replies', count: 1, state: 'active', definitionVersion: 4 },
    { kind: 'saved_search', name: '保存した検索', href: '/tags?tab=searches', count: 1, state: 'active', definitionVersion: 3 },
  ],
  // `dKlkz` は公開・下書き版を持たない資産の完全削除確認（設計どおり5行）。
  // 参照は残すので、アーカイブ優先の安全動作は変えない。
  linkedActions: [],
  pendingRunCount: 0,
  mileageImpact: {
    configured: true,
    self: 10,
    referrer: 5,
    multiplier: 15000,
    priority: 3,
    reapplyPolicy: 'every_time',
    historyPreserved: true,
  },
  blockingReferenceCount: 8,
  canArchive: true,
  canDelete: false,
  checkedAt: '2026-09-07T04:48:00+09:00',
  revision: 'tag:tag-0:v3:2026-08-20T19:20:00+09:00',
}

/** 機能4。画面確認では保存せず、保管APIの成功時の器だけを固定する。 */
export const TAG_ARCHIVE_RESULT = { archived: true, replacedFriendCount: 0 }

/**
 * タグ101件。設計の「1〜20 / 101件」に合わせる。
 *
 * 先頭6件は絵に描いてある行そのまま。残り95件は、フォルダごとの件数が
 * 絵の数（VIP 14／ペット 12／会員 18／健康 16／購入 21／未分類 20）に
 * ちょうど収まるように足した埋め草。
 *
 * **6件だけで比べない。** 桁あふれも折り返しもページ送りも出ないので、
 * 「一致した」と言えてしまう。設計は101件あるときの絵として描いてある。
 */
export const TAGS = (() => {
  const rows = [...DESIGN_ROWS]
  const used = new Map()
  for (const row of rows) used.set(row.groupId, (used.get(row.groupId) ?? 0) + 1)

  let n = rows.length
  for (const [groupId, label, count] of FOLDER_COUNTS) {
    const rest = count - (used.get(groupId) ?? 0)
    for (let i = 0; i < rest; i += 1) {
      rows.push({
        id: `tag-${n}`,
        name: `${label}タグ ${i + 1}`,
        color: '#8b938d',
        groupId,
        // 埋め草にも人数を入れる。0 にすると「整理候補」が跳ね上がる。
        friendCount: 3 + ((n * 7) % 40),
        /*
          埋め草は `assignSource` も `usedIn` も持たない。
          設計の6行が「EC連携」「配信3・フォーム1」を出すのに対し、
          埋め草は「—」「未使用」になる。**両方の見え方を1枚で確かめる。**
        */
        mileageReward: 0,
        referralMileageReward: 0,
        mileageMultiplierBps: null,
        mileageMultiplierPriority: 0,
        isStarred: false,
        displayOrder: n,
        createdAt: '2026-01-13T00:00:00.000Z',
      })
      n += 1
    }
  }

  /*
    編集用の `tag-0` は購入フォルダの埋め草1件と差し替える。
    101件・フォルダ件数・先頭6行を変えず、`/tags/edit?id=tag-0` も
    設計どおり保存済みの状態で開ける。
  */
  const editorRow = rows.find((row, index) => index >= DESIGN_ROWS.length && row.groupId === 'g-purchase')
  if (editorRow) {
    Object.assign(editorRow, TAG_EDITOR_NEN_SUBSCRIPTION, { displayOrder: editorRow.displayOrder })
    /*
      削除確認は検索で一覧を1件にせず、設計どおり20件表示の背面で開く。
      先頭6行はPencilの固定行なので、その直後へ編集用タグを移す。
    */
    rows.splice(rows.indexOf(editorRow), 1)
    rows.splice(DESIGN_ROWS.length, 0, editorRow)
  }
  const vipRow = rows.find((row, index) => index >= DESIGN_ROWS.length && row.groupId === 'g-vip')
  if (vipRow) Object.assign(vipRow, { id: 'tag-vip', name: 'VIP' })
  const purchaseRow = rows.find((row, index) => index >= DESIGN_ROWS.length && row.groupId === 'g-purchase' && row.id !== 'tag-0')
  if (purchaseRow) Object.assign(purchaseRow, { id: 'tag-purchase', name: '購入者' })
  // 機能5の配信対象・送信後アクション。埋め草2件を差し替え、総数とフォルダ件数は保つ。
  const scenarioTargetRow = rows.find((row, index) => index >= DESIGN_ROWS.length && row.groupId === 'g-member' && row.id !== 'tag-vip')
  if (scenarioTargetRow) Object.assign(scenarioTargetRow, { id: 'tag-first-guide', name: '初回案内' })
  const scenarioCompleteRow = rows.find((row, index) => index >= DESIGN_ROWS.length && row.groupId === 'g-member' && row.id !== 'tag-first-guide')
  if (scenarioCompleteRow) Object.assign(scenarioCompleteRow, { id: 'tag-first-guide-complete', name: '初回案内済み' })
  /*
    整理候補の理由を付ける。**設計の絵に合わせて 未使用24・整理候補26。**

    サーバーは `withCounts=1` のとき、理由が無くても `[]` を必ず返す約束
    （`docs/v8-design-rules.md` §5）。省略＝未取得なので、ここでも全件に付ける。
    1件でも欠けると画面は「未取得」と判断し、KPIが `—` になる。

    - 未使用 … 友だち0人**かつ**全参照0件。**後ろの24件**に寄せてある
      （1ページ目の見た目を変えず、KPIの数だけ設計に合わせるため）
    - 重複名 … 正規化して同じになる2件。**前後の空白違い**にしてあるので、
      `NFKC → 前後空白除去 → 連続空白を1つ → 小文字化` が効いていないと数が合わない
  */
  const UNUSED_COUNT = 24
  for (const row of rows) row.cleanupReasons = []

  for (const row of rows.slice(-UNUSED_COUNT)) {
    row.friendCount = 0
    delete row.usedIn
    row.cleanupReasons = ['unused']
  }

  // 重複名の2件。未使用と重ならない位置に置く（重なると26にならない）。
  const dup = rows.filter((row) => row.cleanupReasons.length === 0).slice(40, 42)
  dup[0].name = '長期未購入フォロー'
  dup[1].name = '長期未購入フォロー　'
  for (const row of dup) row.cleanupReasons = ['duplicate_name']

  return rows
})()

/**
 * 一覧の数。設計の4枚（`mfmn3`）に書いてある値そのまま。
 *
 * **タグ一覧から計算しない。** 「付与済み友だち」は人の数で、
 * タグごとの人数を足した数ではない（2つタグが付いた人を2人と数えてしまう）。
 * サーバーが数えて返すもの（`/api/list-stats`）。
 */
export const LIST_STATS = {
  tags: { total: 101, unused: 24, taggedFriends: 186, assignedThisMonth: 214 },
  marks: { total: 4, inUse: 4, unanswered: 23, inProgress: 19, resolved: 186, changedLast7: 74 },
  searches: { total: 5, limit: 50 },
  templates: { total: 0, inUse: 0, sentThisMonth: 0, unused90d: 0, clickRate: null },
  // 板 `axFrW` の帯: シナリオ5件（稼働中3・停止中2）/ 購読中1,028人 / 読了済728人 / 今週342通
  scenarios: { total: 5, active: 3, subscribers: 1028, completed: 728, sentThisWeek: 342 },
  // 板 `I3L41O` の帯: 公開中5件（下書き2）/ 今月712件（先月640）/ 完了74% / 後処理の未完2件
  forms: { published: 5, draft: 2, monthlySubmits: 712, prevMonthSubmits: 640, monthlyCompletionRate: 74, pendingPostActions: 2 },
  // 設計 `M1EXwB` の帯: リマインダ9件（有効7）/ 送信予定124通 / 今月386通 / 失敗2通
  reminders: { total: 9, active: 7, waiting: 124, sentThisMonth: 386, failed: 2 },
}

/** 友だち一覧の件数と状態。実在の顧客データは使わない。 */
export const FRIEND_STATS = {
  active: 214,
  total: 231,
  blockedByThem: 12,
  hiddenByUs: 5,
  unanswered: 23,
  resolved: 186,
  addedThisMonth: 38,
  addedLastMonth: 26,
}

export const OPERATORS = [
  { id: 'operator-masato', name: 'Masato' },
  { id: 'operator-kenta', name: 'Kenta' },
]

/**
 * シナリオ配信の一覧。状態の異なる5行を用意する。
 *
 * 1件だけで返していたころは、**配信方式も終了後の動きも1通りしか出ず**、
 * 設計の5行（時刻／経過時間、一時停止／別シナリオへ／1つ前を再開、
 * 稼働中／停止中／下書き）をどれも確かめられなかった。
 */
/* V8 板 `axFrW`（シナリオ配信一覧）の5行を上から順に並べた。
 * 行の補足は「送り方・通数・フォルダ名」で、実装が `deliveryMode`・
 * `stepCount`・フォルダ名から組み立てる。説明文は一覧には出ないが、
 * 行を開いた板（詳細パネル）に出るため絵の文言で持つ。 */
export const FRIEND_SCENARIOS = [
  // 名前, 説明, 配信方式, 購読中, 読了, 登録日, 終了後, 稼働
  ['新規登録7日間フォロー', '登録直後から7日間の初回案内', 'absolute_time', 428, 312, '2026-08-16', 'pause', true],
  ['商品購入後サポート', '購入1日後から使い方を案内', 'elapsed', 316, 201, '2026-08-18', 'move', true],
  ['予約前日・当日案内', '予約日の前日・当日に案内', 'absolute_time', 284, 215, '2026-08-20', 'pause', true],
  ['休眠ユーザー復帰', '60日やりとりが無い人へ', 'relative', 0, 0, '2026-08-22', 'resume_previous', false],
  ['会員更新リマインド', '更新日の7日前と前日', 'absolute_time', 0, 0, '2026-08-23', 'pause', false],
].map(([name, description, deliveryMode, subscriberCount, completedCount, day, onCompleteMode, isActive], index) => ({
  id: `scenario-${index}`,
  name: String(name),
  description: String(description),
  triggerType: 'manual',
  triggerTagId: null,
  lineAccountId: 'visual-qa-account',
  isActive: Boolean(isActive),
  deliveryMode: String(deliveryMode),
  allowConcurrent: true,
  displayOrder: index,
  // 絵のフォルダ分け：初回案内2・購入後1・予約フォロー1・未分類1。
  folderId: [
    'scenario-folder-onboarding',
    'scenario-folder-purchase',
    'scenario-folder-booking',
    'scenario-folder-onboarding',
    null,
  ][index] ?? null,
  audienceCondition: null,
  onCompleteMode: String(onCompleteMode),
  onCompleteScenarioId: null,
  subscriberCount: Number(subscriberCount),
  completedCount: Number(completedCount),
  // 絵の通数：4・3・3・4・2（上から順）。
  stepCount: [4, 3, 3, 4, 2][index] ?? 3,
  createdAt: `${day}T00:00:00.000Z`,
  /* 板 `PMLkX` ほか編集の①の箱「保存済み 10月1日 14:02」（日本時間）。一覧は更新日時を出さない。 */
  updatedAt: index === 0 ? '2026-10-01T05:02:00.000Z' : `${day}T00:00:00.000Z`,
}))

/** シナリオ一覧 `axFrW` の3分類。件数は絵のとおり（初回案内2・購入後1・予約フォロー1）。未分類1件は mock-api が `unfiledCount` で返す。 */
export const SCENARIO_FOLDERS = [
  ['scenario-folder-onboarding', '初回案内', '#2563EB', 2],
  ['scenario-folder-purchase', '購入後', '#10B981', 1],
  ['scenario-folder-booking', '予約フォロー', '#F59E0B', 1],
].map(([id, name, color, itemCount], index) => ({
  id: String(id),
  kind: 'scenario',
  name: String(name),
  parentId: null,
  displayOrder: index,
  itemCount: Number(itemCount),
  color: String(color),
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}))

/**
 * 友だち追加時配信の実行結果 `P2J0Te`。4行は直近の例、summary は直近28日。
 * 実在する友だち・秘密値は含めず、設計に置かれた固定名だけを使う。
 */
export const FRIEND_ADD_EVENTS = {
  items: [
    {
      id: 'friend-add-event-1', friendId: 'visual-friend-add-1',
      displayName: 'Demo Person', pictureUrl: null,
      kind: 'first_time', isUnblockedHint: false,
      attributionStatus: 'captured', refCode: 'store-qr',
      entryRouteId: 'entry-route-store', entryRouteName: '店頭QR',
      routingStatus: 'completed', occurredAt: '2026-09-07T01:32:00.000Z',
      processedAt: '2026-09-07T01:32:01.000Z',
    },
    {
      id: 'friend-add-event-2', friendId: 'visual-friend-add-2',
      displayName: 'Masato S.', pictureUrl: null,
      kind: 'returning', isUnblockedHint: true,
      attributionStatus: 'unavailable', refCode: null,
      entryRouteId: null, entryRouteName: null,
      routingStatus: 'completed', occurredAt: '2026-09-07T01:28:00.000Z',
      processedAt: '2026-09-07T01:28:01.000Z',
    },
    {
      id: 'friend-add-event-3', friendId: 'visual-friend-add-3',
      displayName: '見本 15', pictureUrl: null,
      kind: 'first_time', isUnblockedHint: false,
      attributionStatus: 'captured', refCode: 'referral-campaign',
      entryRouteId: 'entry-route-referral', entryRouteName: '紹介キャンペーン',
      routingStatus: 'pending', occurredAt: '2026-09-07T01:21:00.000Z',
      processedAt: null,
    },
    {
      id: 'friend-add-event-4', friendId: 'visual-friend-add-4',
      displayName: '見本 141', pictureUrl: null,
      kind: 'first_time', isUnblockedHint: null,
      attributionStatus: 'unavailable', refCode: null,
      entryRouteId: null, entryRouteName: null,
      routingStatus: 'failed', occurredAt: '2026-09-07T01:14:00.000Z',
      processedAt: '2026-09-07T01:14:02.000Z',
    },
  ],
  summary: {
    total: 214,
    firstTime: 176,
    returning: 38,
    captured: 198,
    unavailable: 16,
    pending: 8,
    failed: 3,
  },
  nextCursor: null,
}

/**
 * 友だち追加時配信の新しい実行結果契約（PR #1111）。
 * 一覧4行と集計値は設計 `P2J0Te` に置かれた固定値を使う。
 */
export const FRIEND_ADD_RUNS = {
  items: [
    {
      id: 'friend-add-run-1', receivedAt: '2026-09-07T01:32:00.000Z', processedAt: '2026-09-07T01:32:00.800Z',
      friend: { id: 'visual-friend-add-1', displayName: 'Demo Person' }, friendKind: 'first_time',
      attribution: { status: 'captured', routeId: 'route-shop', routeName: '店頭QR', reason: 'store-qr' },
      rule: { id: 'rule-shop', name: '店頭QRの初回案内', versionId: 'rule-shop-v1', versionNumber: 1 },
      scenario: { id: 'scenario-welcome', name: '新規登録7日間フォロー', enrollmentId: 'enrollment-1', started: true },
      actions: { total: 2, failed: 0 }, deliveryCount: 1, status: 'completed', errorCode: null,
    },
    {
      id: 'friend-add-run-2', receivedAt: '2026-09-07T01:28:00.000Z', processedAt: '2026-09-07T01:28:00.700Z',
      friend: { id: 'visual-friend-add-2', displayName: 'Masato S.' }, friendKind: 'returning',
      attribution: { status: 'unavailable', routeId: null, routeName: null, reason: '経路不明のテスト' },
      rule: { id: 'rule-fallback', name: '経路が分からなかった人', versionId: 'rule-fallback-v1', versionNumber: 1 },
      scenario: { id: 'scenario-common', name: '共通のあいさつ', enrollmentId: 'enrollment-2', started: true },
      actions: { total: 1, failed: 0 }, deliveryCount: 1, status: 'completed', errorCode: null,
    },
    {
      id: 'friend-add-run-3', receivedAt: '2026-09-07T01:21:00.000Z', processedAt: null,
      friend: { id: 'visual-friend-add-3', displayName: '見本 15' }, friendKind: 'first_time',
      attribution: { status: 'captured', routeId: 'route-referral', routeName: '紹介キャンペーン', reason: 'referral-campaign' },
      rule: { id: 'rule-referral', name: '紹介キャンペーンの初回案内', versionId: 'rule-referral-v1', versionNumber: 1 },
      scenario: { id: 'scenario-welcome', name: '新規登録7日間フォロー', enrollmentId: null, started: false },
      actions: { total: 2, failed: 0 }, deliveryCount: 0, status: 'pending', errorCode: null,
    },
    {
      id: 'friend-add-run-4', receivedAt: '2026-09-07T01:14:00.000Z', processedAt: '2026-09-07T01:14:02.000Z',
      friend: { id: 'visual-friend-add-4', displayName: '見本 141' }, friendKind: 'first_time',
      attribution: { status: 'unavailable', routeId: null, routeName: null, reason: null },
      rule: { id: 'rule-fallback', name: '経路が分からなかった人', versionId: 'rule-fallback-v1', versionNumber: 1 },
      /* 絵 REIxB の4行目・N43uVX：案内は届いたが、シナリオを始めるところで止まった。 */
      scenario: { id: 'scenario-common', name: '共通のあいさつ', enrollmentId: null, started: false },
      actions: { total: 2, failed: 1 }, deliveryCount: 1, status: 'failed', errorCode: 'action_failed',
    },
    /* 絵 REIxB の5行目：以前からの友だち（再追加）→ 案内なし・タグだけ。 */
    {
      id: 'friend-add-run-5', receivedAt: '2026-09-07T01:02:00.000Z', processedAt: null,
      friend: { id: 'visual-friend-add-5', displayName: '見本 25' }, friendKind: 'returning',
      attribution: { status: 'captured', routeId: 'route-instagram', routeName: 'Instagram プロフィール', reason: 'instagram-profile' },
      rule: { id: 'rule-shop', name: '店頭QRの初回案内', versionId: 'rule-shop-v1', versionNumber: 1 },
      scenario: null,
      actions: { total: 1, failed: 0 }, deliveryCount: 0, status: 'suppressed', errorCode: null,
    },
  ],
  total: 214,
  nextCursor: 'friend-add-run-cursor-2',
  summary: {
    /* 絵 REIxB の数の帯（直近28日 214人・送った案内 1,842通）。 */
    recentFriends: 214,
    recentEvents: 226,
    lastDeliveryAt: '2026-09-07T01:32:00.800Z',
    totalRuns: 214,
    cumulativeDeliveries: 1842,
    scenarioStarts: 198,
    averageSendTimeMs: 800,
    failed: 3,
    staffHandoffs: {
      value: null,
      state: 'unavailable',
      reason: '担当者引き継ぎと実行イベントを結ぶ記録がありません',
    },
  },
}

/**
 * 友だち追加時配信を公開する2画面（`ec9vg` / `quhg6`）の固定データ。
 *
 * 正本は `FriendAddRoutingVersion` / `FriendAddRoutingValidation` /
 * `FriendAddRoutingDraftTestResult` / `FriendAddRoutingPublishResult`。
 * **画面の都合で別名の項目を作らない。** 本物の契約と同じ形で、
 * 通常・空・失敗を分けて撮れるようにする。
 */
export const FRIEND_ADD_LIFECYCLE_ROUTING = {
  firstTime: {
    scenarioId: 'scenario-paused',
    timing: 'immediate',
    actions: [{ kind: 'tag', tagId: 'tag-0' }],
  },
  returning: {
    scenarioId: null,
    mode: 'same',
    startPosition: 'beginning',
    actions: [],
  },
  criteria: { firstTime: 'unfollow_count_zero' },
}

export const FRIEND_ADD_LIFECYCLE_DRAFT = {
  accountId: 'visual-qa-account',
  versionId: 'friend-add-version-2',
  versionNumber: 2,
  status: 'draft',
  routing: FRIEND_ADD_LIFECYCLE_ROUTING,
  lastTestStatus: 'succeeded',
  lastTestedAt: '2026-08-30T10:00:00.000Z',
  publishedAt: null,
}

export const FRIEND_ADD_LIFECYCLE_VALIDATION = {
  canPublish: true,
  estimatedAudienceCount: 128,
  checks: [
    {
      key: 'first_time',
      label: 'はじめて友だち追加した人への配信',
      status: 'passed',
      detail: '配信するシナリオを確認できました。',
    },
    {
      key: 'returning',
      label: '以前からの友だち・ブロック解除後の配信',
      status: 'passed',
      detail: '配信方法を確認できました。',
    },
    {
      key: 'actions',
      label: '配信と一緒に行うこと',
      status: 'passed',
      detail: '1件の操作を、並べた順に実行します。',
    },
    {
      key: 'duplicate_prevention',
      label: '同じ友だち追加通知の二重実行防止',
      status: 'passed',
      detail: 'LINEアカウントとWebhookイベントの組み合わせで、同じ通知を1回だけ処理します。',
    },
  ],
  conflicts: [],
  lastTestStatus: 'succeeded',
}

export const FRIEND_ADD_LIFECYCLE_TEST_RESULT = {
  versionId: 'friend-add-version-2',
  displayName: '見本 143',
  kind: 'first_time',
  scenarioId: 'scenario-paused',
  scenarioName: '停止中',
  suppressed: false,
  actionCount: 1,
  stateChanged: false,
}

export const FRIEND_ADD_LIFECYCLE_PUBLISHED = {
  accountId: 'visual-qa-account',
  versionId: 'friend-add-version-2',
  versionNumber: 2,
  publishedAt: '2026-08-30T10:30:00.000Z',
  estimatedAudienceCount: 128,
  duplicatePrevention: 'webhook_event',
  monitoringPath: null,
  monitoringUnavailableReason: '実行結果の画面はまだ接続されていません。',
}

/** 取得できて下書きが無い状態。失敗とは別に404で返す。 */
export const FRIEND_ADD_LIFECYCLE_EMPTY = {
  status: 404,
  body: { success: false, error: '確認する下書きがありません' },
}

/** 読み口が失敗した状態。0件や「まだありません」に変換しない。 */
export const FRIEND_ADD_LIFECYCLE_ERROR = {
  status: 500,
  body: { success: false, error: '下書きを読み込めませんでした' },
}

const FRIEND_TAGS = {
  subscription: { id: 'friend-tag-subscription', name: '定期便提案対象', color: '#8B938D', createdAt: '2026-01-01T00:00:00.000Z' },
  uncontracted: { id: 'friend-tag-uncontracted', name: '未契約', color: '#8B938D', createdAt: '2026-01-01T00:00:00.000Z' },
  staff: { id: 'friend-tag-staff', name: 'スタッフ', color: '#8B938D', createdAt: '2026-01-01T00:00:00.000Z' },
  nen: { id: 'friend-tag-nen', name: 'NEN会員', color: '#8B938D', createdAt: '2026-01-01T00:00:00.000Z' },
  delivery: { id: 'friend-tag-delivery', name: '商品到着確認対象', color: '#8B938D', createdAt: '2026-01-01T00:00:00.000Z' },
  login: { id: 'friend-tag-login', name: 'LINEログイン連携済み', color: '#8B938D', createdAt: '2026-01-01T00:00:00.000Z' },
  ec: { id: 'friend-tag-ec', name: 'EC顧客連携済み', color: '#8B938D', createdAt: '2026-01-01T00:00:00.000Z' },
}

function friend(overrides) {
  return {
    id: '',
    lineUserId: '',
    displayName: '',
    pictureUrl: null,
    statusMessage: null,
    isFollowing: true,
    metadata: {},
    refCode: null,
    lineAccountId: 'visual-qa-account',
    userId: null,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    latestIncomingMessage: null,
    latestOutgoingAt: null,
    activeScenario: { name: '停止中', status: 'paused' },
    handled: true,
    operator: null,
    supportMark: null,
    tags: [],
    ...overrides,
  }
}

/* 板 `x6QsVz` の6行。タグは行だけの見せ方（`+2` の数えと先頭の名前が絵と
 * 合うようにする）。一覧の絞り込みの選択肢（`/api/tags`）は変えない。 */
const FRIEND_ROW_TAG_TEIKI_PROPOSAL = { id: 'friend-tag-teiki-proposal', name: '定期便の提案', color: '#8B938D', createdAt: '2026-01-01T00:00:00.000Z' }
const FRIEND_ROW_TAG_VIP = { id: 'friend-tag-vip', name: 'VIP', color: '#8B938D', createdAt: '2026-01-01T00:00:00.000Z' }
const FRIEND_ROW_TAG_TEIKI = { id: 'friend-tag-teiki', name: '定期便', color: '#8B938D', createdAt: '2026-01-01T00:00:00.000Z' }

export const FRIENDS = [
  friend({
    id: 'friend-kyohei', lineUserId: 'U-visual-1', displayName: 'Kyohei Yamamoto',
    metadata: { __attention: '1' }, createdAt: '2026-08-14T00:00:00.000Z',
    chatStatus: 'unread', handled: false,
    latestIncomingMessage: { content: '🚚💐', messageType: 'text', createdAt: '2026-08-14T07:58:00.000Z' },
    supportMark: { id: 'mark-unread', name: '未対応', color: '#D34851' },
    tags: [FRIEND_ROW_TAG_TEIKI_PROPOSAL, FRIEND_TAGS.uncontracted, FRIEND_TAGS.delivery],
  }),
  friend({
    id: 'friend-masato', lineUserId: 'U-visual-2', displayName: 'Masato.S',
    chatStatus: 'resolved', operator: OPERATORS[0],
    supportMark: { id: 'mark-progress', name: '対応中', color: '#A66A00' },
    tags: [FRIEND_TAGS.staff], createdAt: '2026-08-13T00:00:00.000Z',
  }),
  friend({
    id: 'friend-kanno', lineUserId: 'U-visual-3', displayName: '見本 15',
    metadata: { __attention: '1' }, chatStatus: 'resolved', operator: OPERATORS[1],
    latestIncomingMessage: { content: '', messageType: 'sticker', createdAt: '2026-08-13T20:52:00.000Z' },
    latestOutgoingAt: '2026-08-14T09:00:00.000Z',
    firstTrackedLinkName: '広告',
    supportMark: { id: 'mark-progress', name: '担当中', color: '#A66A00' },
    tags: [FRIEND_TAGS.nen, FRIEND_TAGS.delivery, FRIEND_TAGS.uncontracted], createdAt: '2026-08-13T00:00:00.000Z',
  }),
  friend({
    id: 'friend-kenta', lineUserId: 'U-visual-4', displayName: 'Demo Person',
    chatStatus: 'in_progress', operator: OPERATORS[1],
    latestIncomingMessage: { content: '登録しました！', messageType: 'text', createdAt: '2026-08-13T16:16:00.000Z' },
    latestOutgoingAt: '2026-08-14T10:00:00.000Z',
    firstTrackedLinkName: 'QR',
    supportMark: { id: 'mark-progress', name: '対応中', color: '#A66A00' },
    tags: [FRIEND_TAGS.login], createdAt: '2026-08-13T00:00:00.000Z',
  }),
  friend({
    id: 'friend-hanako', lineUserId: 'U-visual-5', displayName: '見本 143',
    chatStatus: 'resolved', operator: OPERATORS[1],
    activeScenario: { name: '稼働中', status: 'active' },
    latestIncomingMessage: { content: 'ありがとうございます', messageType: 'text', createdAt: '2026-08-12T11:03:00.000Z' },
    firstTrackedLinkName: '紹介',
    tags: [FRIEND_ROW_TAG_VIP, FRIEND_ROW_TAG_TEIKI, FRIEND_TAGS.uncontracted], createdAt: '2026-08-12T00:00:00.000Z',
  }),
  friend({
    id: 'friend-sakamoto', lineUserId: 'U-visual-6', displayName: '見本 25',
    chatStatus: 'resolved', operator: OPERATORS[0],
    activeScenario: { name: '稼働中', status: 'active' },
    latestIncomingMessage: { content: '発送について', messageType: 'text', createdAt: '2026-08-16T09:12:00.000Z' },
    tags: [FRIEND_ROW_TAG_TEIKI], createdAt: '2026-08-10T00:00:00.000Z',
  }),
]

/**
 * 統合ユーザー一覧と重複集計。
 *
 * どちらも既定の EMPTY_PAGE では描けない1件返しの口。`rows` や
 * `perAccount` を欠くと画面が落ちるため、Workerの返却契約と同じ形で持つ。
 * 連絡先は平文の個人情報を置かず、画面と同じマスク済みの値にする。
 */
export const USERS_GROUPED = {
  total: 2,
  page: 1,
  pageSize: 50,
  computedAt: '2026-08-31T01:00:00.000Z',
  rows: [
    {
      identityKey: 'uid:merged-person-1',
      identityKeyKind: 'uid',
      displayName: '見本 161',
      pictureUrl: null,
      accounts: [
        {
          accountId: 'visual-qa-account',
          accountName: '画面確認アカウント',
          lineUserId: 'U-visual-merged-1',
          isFollowing: true,
          joinedAt: '2026-08-01T01:00:00.000Z',
          friendId: 'friend-merged-1',
        },
        {
          accountId: 'visual-qa-branch',
          accountName: '画面確認・支店',
          lineUserId: 'U-visual-merged-2',
          isFollowing: true,
          joinedAt: '2026-08-03T01:00:00.000Z',
          friendId: 'friend-merged-2',
        },
      ],
      xUsername: null,
      emails: ['ta***@example.com'],
      phones: ['090-****-0001'],
      lastActivityAt: '2026-08-30T01:00:00.000Z',
      isDuplicate: true,
    },
    {
      identityKey: 'solo:friend-solo-1',
      identityKeyKind: 'solo',
      displayName: '見本 113',
      pictureUrl: null,
      accounts: [
        {
          accountId: 'visual-qa-account',
          accountName: '画面確認アカウント',
          lineUserId: 'U-visual-solo-1',
          isFollowing: true,
          joinedAt: '2026-08-10T01:00:00.000Z',
          friendId: 'friend-solo-1',
        },
      ],
      xUsername: null,
      emails: [],
      phones: [],
      lastActivityAt: '2026-08-29T01:00:00.000Z',
      isDuplicate: false,
    },
  ],
}

export const DUPLICATE_STATS = {
  totalFollowing: 231,
  uniquePeople: 228,
  friendDups: 3,
  duplicateGroups: 3,
  wastedPerBroadcastYen: 9,
  msgUnitYen: 3,
  perAccount: [
    {
      accountId: 'visual-qa-account',
      accountName: '然-NEN-TEST',
      friends: 2140,
      dups: 318,
      dupRate: 318 / 2140,
    },
    {
      accountId: 'visual-qa-branch',
      accountName: 'ECサポート',
      friends: 1486,
      dups: 286,
      dupRate: 286 / 1486,
    },
    {
      accountId: 'visual-qa-booking',
      accountName: '公式A（予約）',
      friends: 902,
      dups: 124,
      dupRate: 124 / 902,
    },
    {
      accountId: 'visual-qa-mail',
      accountName: 'MAIL 配信',
      friends: 640,
      dups: 57,
      dupRate: 57 / 640,
    },
  ],
  pairwiseOverlap: [
    { fromAccountId: 'visual-qa-account', toAccountId: 'visual-qa-branch', overlap: 186 },
    { fromAccountId: 'visual-qa-account', toAccountId: 'visual-qa-booking', overlap: 54 },
    { fromAccountId: 'visual-qa-account', toAccountId: 'visual-qa-mail', overlap: 78 },
    { fromAccountId: 'visual-qa-branch', toAccountId: 'visual-qa-account', overlap: 186 },
    { fromAccountId: 'visual-qa-branch', toAccountId: 'visual-qa-booking', overlap: 31 },
    { fromAccountId: 'visual-qa-branch', toAccountId: 'visual-qa-mail', overlap: 69 },
    { fromAccountId: 'visual-qa-booking', toAccountId: 'visual-qa-account', overlap: 54 },
    { fromAccountId: 'visual-qa-booking', toAccountId: 'visual-qa-branch', overlap: 31 },
    { fromAccountId: 'visual-qa-booking', toAccountId: 'visual-qa-mail', overlap: 12 },
    { fromAccountId: 'visual-qa-mail', toAccountId: 'visual-qa-account', overlap: 78 },
    { fromAccountId: 'visual-qa-mail', toAccountId: 'visual-qa-branch', overlap: 69 },
    { fromAccountId: 'visual-qa-mail', toAccountId: 'visual-qa-booking', overlap: 12 },
  ],
  computedAt: '2026-08-31T01:00:00.000Z',
}

/**
 * 回答フォーム削除確認（`gBp2J`）の読み口。
 *
 * - `archive`: 回答と利用先があるので、物理削除ではなく保管する
 * - `delete`: 取得できた実値0。未取得を0件へ丸めた状態ではない
 * - `failure`: ブラウザ側の route.fulfill で使い、0件の絵を作らない
 */
export const FORM_DELETE_IMPACT_FIXTURES = {
  archive: {
    form: { id: 'form-visit', name: '来店アンケート', isActive: true, status: 'active' },
    submissionCount: 1284,
    openCount: 214,
    references: [
      { kind: 'webinar', name: '使い方講座', href: '/webinars/edit?id=webinar-guide', state: 'available' },
      { kind: 'rich_menu', name: '通常メニュー・予約', href: '/rich-menus/edit?id=rich-menu-main', state: 'available' },
      { kind: 'scenario', name: '来店後フォロー', href: '/scenarios?id=scenario-followup', state: 'available' },
    ],
    referenceCount: 3,
    answerUrl: 'https://liff.line.me/visual-qa/?page=form&id=form-visit',
    revision: 7,
    checkedAt: '2026-08-31T11:00:00.000',
    canDelete: false,
    canArchive: true,
    recommendedAction: 'archive',
    blockers: ['published', 'has_submissions', 'has_opens', 'in_use'],
  },
  /* 板 `GVizd`：一覧の3行目「休止の理由」を開いたとき（回答96件・リッチメニューとシナリオが開く）。 */
  archiveSurvey: {
    form: { id: 'form-3', name: '休止の理由', isActive: true, status: 'active' },
    submissionCount: 96,
    openCount: 20,
    references: [
      { kind: 'rich_menu', name: '通常メニュー', href: '/rich-menus/edit?id=rich-menu-main', state: 'available' },
      { kind: 'scenario', name: '休止フォロー', href: '/scenarios?id=scenario-pause', state: 'available' },
    ],
    referenceCount: 2,
    answerUrl: 'https://liff.line.me/visual-qa/?page=form&id=form-3',
    revision: 3,
    checkedAt: '2026-08-31T11:00:00.000',
    canDelete: false,
    canArchive: true,
    recommendedAction: 'archive',
    blockers: ['published', 'has_submissions', 'has_opens', 'in_use'],
  },
  delete: {
    form: { id: 'form-empty', name: '下書きフォーム', isActive: false, status: 'active' },
    submissionCount: 0,
    openCount: 0,
    references: [],
    referenceCount: 0,
    answerUrl: 'https://liff.line.me/visual-qa/?page=form&id=form-empty',
    revision: 2,
    checkedAt: '2026-08-31T11:00:00.000',
    canDelete: true,
    canArchive: true,
    recommendedAction: 'delete',
    blockers: [],
  },
  failure: {
    status: 503,
    body: { success: false, error: 'form_delete_impact_unavailable', message: '削除の影響を確認できませんでした。' },
  },
}

/* 回答フォームのフォルダ。板 `I3L41O` の総数18件と内訳（来店・予約6・
 * 資料請求4・アンケート5・未分類3）。一覧は `itemCount` を見て数を出す。 */
export const FORM_FOLDERS = [
  { id: 'form-folder-visit', kind: 'form', name: '来店・予約', parentId: null, displayOrder: 0, color: '#2f6fde', formCount: 6, itemCount: 6, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
  { id: 'form-folder-request', kind: 'form', name: '資料請求', parentId: null, displayOrder: 1, color: '#1f9d55', formCount: 4, itemCount: 4, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
  { id: 'form-folder-survey', kind: 'form', name: 'アンケート', parentId: null, displayOrder: 2, color: '#e07b24', formCount: 5, itemCount: 5, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
]

const FORM_BASE_LAYOUT = {
  version: 2,
  header: [],
  sections: [{ id: 'form-section-1', name: 'セクション1', blocks: [] }],
  options: {
    thanksUrl: null, thanksText: 'ご回答ありがとうございました。', restorePrevious: false,
    pageTitle: null, submitLabel: '送信', prevLabel: '前へ', nextLabel: '次へ',
    sectionHeader: 'pageNumber', confirmDialog: { enabled: false },
    deadline: { enabled: false }, oncePerFriend: { enabled: false },
    totalLimit: { enabled: false }, afterActions: [],
  },
}

const formRow = (id, name, description, folderId, isActive, submitCount, monthly, lastSubmittedAt, updatedAt, destinationSummary, pendingPostActionCount = 0) => ({
  id, lineAccountId: 'visual-qa-account', name, description, folderId,
  fields: [], layout: FORM_BASE_LAYOUT, onSubmitTagId: null, onSubmitScenarioId: null,
  onSubmitMessageType: null, onSubmitMessageContent: null, onSubmitWebhookUrl: null,
  onSubmitWebhookHeaders: null, onSubmitWebhookFailMessage: null,
  saveToMetadata: destinationSummary.friendFieldCount > 0, isActive, status: 'active', archivedAt: null,
  pendingPostActionCount,
  revision: 1, submitCount,
  monthlySubmitCount: monthly.submitCount,
  monthlyOpenCount: monthly.openCount,
  monthlyCompletionRate: monthly.rate,
  createdAt: updatedAt, updatedAt, lastSubmittedAt,
  usedByAccounts: [], accountScopeReviewRequired: false,
  destinationCount: destinationSummary.friendFieldCount + destinationSummary.tagCount,
  destinationSummary,
})

/* 板 `I3L41O` の5行を上から順に並べた。保存先は絵のとおり「友だち情報 N」
 * だけ（タグの内訳は付けない）。来店アンケートには後処理の未完2の札が
 * 付く。帯の数（公開中5・下書き2・今月712・先月640・完了74%・未完2）は
 * `LIST_STATS.forms` が返す。 */
export const FORMS = [
  formRow('form-1', '来店アンケート', '来店後に感想と次回の希望を聞く・9ブロック', 'form-folder-survey', true, 1284, { submitCount: 186, openCount: 248, rate: 75 }, '2026-08-21T03:00:00.000Z', '2026-08-21T03:00:00.000Z', { friendFieldCount: 3, tagCount: 0 }, 2),
  formRow('form-2', '資料請求', '名前と連絡先・5ブロック', 'form-folder-request', true, 3410, { submitCount: 402, openCount: 536, rate: 75 }, '2026-08-22T03:00:00.000Z', '2026-08-12T03:00:00.000Z', { friendFieldCount: 5, tagCount: 0 }),
  formRow('form-3', '休止の理由', '定期便を止める人に理由を聞く・3ブロック', 'form-folder-survey', true, 96, { submitCount: 12, openCount: 20, rate: 60 }, '2026-08-20T03:00:00.000Z', '2026-08-18T03:00:00.000Z', { friendFieldCount: 1, tagCount: 0 }),
  formRow('form-4', 'イベント申込（10月）', '日時の希望と人数・7ブロック', null, true, 220, { submitCount: 88, openCount: 110, rate: 80 }, '2026-08-25T03:00:00.000Z', '2026-08-22T03:00:00.000Z', { friendFieldCount: 4, tagCount: 0 }),
  formRow('form-5', '会員登録', '住所と生年月日・12ブロック', 'form-folder-visit', false, 0, { submitCount: 0, openCount: 0, rate: null }, null, '2026-08-15T03:00:00.000Z', { friendFieldCount: 7, tagCount: 0 }),
  { ...formRow('form-6', '旧アンケート（2025春）', '3ブロック', null, false, 1860, { submitCount: 0, openCount: 5, rate: 0 }, '2025-05-30T03:00:00.000Z', '2025-05-30T03:00:00.000Z', { friendFieldCount: 2, tagCount: 0 }), status: 'archived', archivedAt: '2025-05-30T03:00:00.000Z' },
  /* NEN-07: NEN配信「口コミのお願い」がつなぐフォーム。編集画面の選択肢と
   * 「つながる先」へ出る公開中フォームとして見本へ置く。 */
  formRow('form-review', '口コミ', '星の評価とひとこと・2ブロック', null, true, 210, { submitCount: 24, openCount: 30, rate: 80 }, '2026-08-24T03:00:00.000Z', '2026-08-24T03:00:00.000Z', { friendFieldCount: 1, tagCount: 1 }),
]

/**
 * 機能13 `EMBIK`。一覧の1ページ目と、画面全体18件の集計を同じ応答で返す。
 * 2026-10-11の指定に合わせ、18件の範囲を実際に返す。最初の5行は固定絵の見本を保つ。
 * 編集画面の選択肢など、ほかの口は `FORMS` の全部のまま。
 */
export const FORM_LIST = {
  items: [...FORMS.slice(0, 5), ...Array.from({ length: 13 }, (_, index) => ({
    ...FORMS[index % 5], id: `form-list-example-${index + 1}`, name: `回答フォーム ${index + 6}`, pendingPostActionCount: 0,
  }))],
  total: 18,
  page: 1,
  limit: 20,
}

/** 来店アンケートの9ブロックと公開設定。設計 `vCqUj` / `cSqvP`。 */
export const FORM_DETAIL = {
  ...FORMS[0],
  fields: [
    { name: 'real_name', label: 'お名前（漢字）', type: 'text', required: true },
    { name: 'satisfaction', label: '満足度', type: 'radio', required: true, options: ['大変満足', '満足', 'ふつう', '不満'] },
    { name: 'good_points', label: 'よかった点', type: 'checkbox', options: ['接客', '仕上がり', '店内', '説明'] },
    { name: 'opinion', label: 'ご意見', type: 'textarea' },
    { name: 'next_visit', label: '次回来店の希望日', type: 'date' },
  ],
  /* 編集画面（m1cWEy・ijxur・XXFT4・tpRRT・J1pdB・Z9wXm・ITBAB）の絵の中身。
   * 1ページ目：店のロゴ・見出し・本文・ラジオ・5段階・本人確認書類。2ページ目：見出し・予約を入れる・自由に書く。 */
  contentRevision: 4,
  publishedVersionId: 'form-1-version-3',
  publishedContentRevision: 3,
  layout: {
    version: 2,
    header: [],
    sections: [{
      id: 'form-section-visit', name: '来店について', blocks: [
        { id: 'form-logo', kind: 'image', mediaUrl: 'https://example.co.jp/nen-logo.png', size: 'full' },
        { id: 'form-heading', kind: 'heading', text: '来店アンケート', level: 1 },
        { id: 'form-intro', kind: 'text', text: 'ご来店ありがとうございました。1分で終わります。' },
        { id: 'form-purpose', kind: 'input', type: 'radio', name: 'visit_purpose', label: '今日のご来店の目的は？', required: true, choiceMode: 'friendField', choiceFriendFieldId: null, destinations: { friendFieldIds: ['field-plan'] }, choices: [
          { id: 'purpose-1', label: 'トリミング' },
          { id: 'purpose-2', label: 'シャンプーのみ' },
          { id: 'purpose-3', label: 'ご相談' },
        ] },
        { id: 'form-staff-rating', kind: 'input', type: 'rating', name: 'staff_rating', label: '担当の対応はいかがでしたか？' },
        { id: 'form-identity', kind: 'input', type: 'file', name: 'identity_documents', label: '本人確認書類（免許証など）を送ってください', fileKinds: ['image', 'pdf', 'identity'], fileBothSides: true, fileMaxCount: 2 },
      ],
    }, {
      id: 'form-section-next', name: '次回について', blocks: [
        { id: 'form-next-heading', kind: 'heading', text: '次回について', level: 1 },
        { id: 'form-next-booking', kind: 'input', type: 'booking', name: 'next_booking', label: '次回のご希望の日時を選んでください', required: true, booking: { menuId: 'bm-1', staffId: null, daysAhead: 14 } },
        { id: 'form-next-request', kind: 'input', type: 'textarea', name: 'request', label: 'ご要望があればお書きください' },
      ],
    }],
    options: {
      thanksUrl: null,
      thanksText: 'ご回答ありがとうございました！次回のご来店をお待ちしています。',
      restorePrevious: true, pageTitle: '来店アンケート｜然', submitLabel: '答えを送る',
      prevLabel: '戻る', nextLabel: '次へ', sectionHeader: 'name',
      confirmDialog: { enabled: true, text: 'この内容で送信しますか？', okLabel: '送信する', cancelLabel: '戻る' },
      deadline: { enabled: false, endsAt: null, message: '受付は終了しました。またのご来店をお待ちしています' },
      oncePerFriend: { enabled: true, message: 'このフォームには回答済みです。' },
      totalLimit: { enabled: false, max: 300 },
      afterActions: [
        { kind: 'send_text', text: 'ご回答ありがとうございます' },
        { kind: 'tag', op: 'add', tagIds: ['tag-visit-survey-answered'] },
        { kind: 'friend_field', fieldId: 'field-plan', value: '{{answer}}' },
      ],
    },
  },
  referenceData: {
    tags: [{ id: 'tag-visit-survey-answered', name: '来店アンケート回答済み' }],
    mileage: [{ id: 'mileage-visit-survey', label: '回答で50マイル', amount: 50 }],
    reminders: [{ id: 'reminder-next-visit', name: '次回来店の希望日をお知らせ' }],
  },
}

/**
 * 公開中の版（Z9wXm「変わること」の比べ元）。編集画面は `?view=published` で読む。
 * 下書きとの違いは絵の3行に合わせる：目的の質問を足した・きっかけの質問を消した・答え終わったあとの言葉を変えた。
 */
export const FORM_DETAIL_PUBLISHED = {
  id: FORM_DETAIL.id,
  name: FORM_DETAIL.name,
  description: FORM_DETAIL.description,
  fields: FORM_DETAIL.fields,
  isActive: true,
  layout: {
    ...FORM_DETAIL.layout,
    sections: FORM_DETAIL.layout.sections.map((section) => section.id !== 'form-section-visit' ? section : {
      ...section,
      blocks: section.blocks.map((block) => block.id !== 'form-purpose' ? block : {
        id: 'form-trigger', kind: 'input', type: 'radio', name: 'visit_trigger', label: 'ご来店のきっかけ', required: false,
        choices: [{ id: 'trigger-1', label: '紹介' }, { id: 'trigger-2', label: 'SNS' }],
      }),
    }),
    options: { ...FORM_DETAIL.layout.options, thanksText: 'ご回答ありがとうございました！' },
  },
}

/**
 * 機能13 v9tYhl。回答一覧と集計を設計比較できる固定ページ。
 * 後処理（postActions）は V8 `MKQyJ`・`v0SbYR` の「未完」「済み」と帯が撮れるよう、2件目だけタグ付けで止める（絵は2行目が未完）。
 */
export const FORM_SUBMISSIONS = {
  items: [
    { id: 'submission-1', formId: 'form-1', friendId: 'friend-1', friendName: '見本 16', data: { real_name: '見本 16', satisfaction: '大変満足', good_points: ['接客', '仕上がり'], opinion: '説明が分かりやすかったです', next_visit: '2026-09-12' }, destinationWrite: { status: 'succeeded', attempted: 3, succeeded: 3, failed: 0 }, postActions: { state: 'completed', pending: [] }, createdAt: '2026-08-25T10:20:00+09:00' },
    { id: 'submission-2', formId: 'form-1', friendId: 'friend-2', friendName: '見本 17', data: { real_name: '見本 17', satisfaction: '満足', good_points: ['店内'], opinion: 'また利用します', next_visit: '2026-09-18' }, destinationWrite: { status: 'partial', attempted: 3, succeeded: 2, failed: 1 }, postActions: { state: 'failed', pending: ['tag'] }, createdAt: '2026-08-24T15:04:00+09:00' },
    { id: 'submission-3', formId: 'form-1', friendId: 'friend-3', friendName: '見本 26', data: { real_name: '見本 26', satisfaction: 'ふつう', good_points: ['説明'], opinion: '', next_visit: '2026-09-18' }, destinationWrite: { status: 'failed', attempted: 3, succeeded: 0, failed: 3 }, postActions: { state: 'completed', pending: [] }, createdAt: '2026-08-23T09:12:00+09:00' },
    { id: 'submission-4', formId: 'form-1', friendId: 'friend-4', friendName: '見本 27', data: { real_name: '見本 27', satisfaction: '大変満足', good_points: ['接客'], opinion: '満足です', next_visit: '2026-09-20' }, destinationWrite: { status: 'succeeded', attempted: 3, succeeded: 3, failed: 0 }, postActions: { state: 'completed', pending: [] }, createdAt: '2026-08-22T18:30:00+09:00' },
    { id: 'submission-5', formId: 'form-1', friendId: null, friendName: null, data: { real_name: 'ゲスト回答', satisfaction: '満足', good_points: [], opinion: 'ありがとうございました', next_visit: null }, destinationWrite: { status: 'not_requested', attempted: 0, succeeded: 0, failed: 0 }, postActions: { state: 'completed', pending: [] }, createdAt: '2026-08-21T07:40:00+09:00' },
    { id: 'submission-6', formId: 'form-1', friendId: 'friend-5', friendName: '見本 28', data: { real_name: '見本 28', satisfaction: '不満', good_points: ['仕上がり'], opinion: '確認したいことがあります', next_visit: null }, destinationWrite: { status: 'pending', attempted: 3, succeeded: 0, failed: 0 }, postActions: { state: 'completed', pending: [] }, createdAt: '2026-08-20T12:16:00+09:00' },
  ],
  total: 6, page: 1, limit: 20,
  summary: {
    startedUnique: 8, submitted: 6, completionRate: 75,
    destinationWrites: { pending: 1, succeeded: 3, partial: 1, failed: 1, not_requested: 1, unknown: 0 },
    dateAnsweredUniqueFriends: 4,
    dateFields: [{ key: 'next_visit', label: '次回来店の希望日', answered: 4, uniqueFriends: 3, minDate: '2026-09-12', maxDate: '2026-09-20' }],
  },
}

/*
  V8「集まった回答」（`v0SbYR` まとめて見る・`MKQyJ` 1件ずつ見る）の絵のフォーム。
  form-1（ほかの板が使う）とは質問が違うので、別の ID で持つ（撮影は ?id=form-visit）。
  絵は「186件中 1〜20件」の下に3行だけ描いているので、3件だけ返す（件数は 1,284）。
*/
export const FORM_VISIT_DETAIL = {
  ...FORMS[0],
  id: 'form-visit',
  name: '来店アンケート',
  submitCount: 1284,
  fields: [
    { name: 'purpose', label: '今日のご来店の目的は？', type: 'radio', required: true, options: ['トリミング', 'シャンプーのみ', 'ご相談'] },
    { name: 'staff', label: '担当の対応は？', type: 'rating' },
    { name: 'comment', label: 'ご意見', type: 'textarea' },
  ],
  layout: {
    version: 2,
    header: [],
    sections: [{
      id: 'form-visit-section', name: '来店について', blocks: [
        { id: 'fv-purpose', kind: 'input', type: 'radio', name: 'purpose', label: '今日のご来店の目的は？', required: true, choices: [
          { id: 'fv-p1', label: 'トリミング' }, { id: 'fv-p2', label: 'シャンプーのみ' }, { id: 'fv-p3', label: 'ご相談' },
        ] },
        { id: 'fv-staff', kind: 'input', type: 'rating', name: 'staff', label: '担当の対応は？' },
        { id: 'fv-comment', kind: 'input', type: 'textarea', name: 'comment', label: 'ご意見' },
      ],
    }],
    options: {},
  },
}
const visitSubmission = (id, name, createdAt, data, postActions) => ({
  id, formId: 'form-visit', friendId: `friend-${id}`, friendName: name, data,
  destinationWrite: { status: 'not_requested', attempted: 0, succeeded: 0, failed: 0 }, postActions, createdAt,
})
export const FORM_VISIT_SUBMISSIONS = {
  items: [
    visitSubmission('fv-1', '見本 28', '2026-09-30T18:12:00+09:00', { purpose: 'トリミング', staff: 5, comment: '待ち時間が短くて助かりました' }, { state: 'completed', pending: [] }),
    visitSubmission('fv-2', 'ココ', '2026-09-30T17:40:00+09:00', { purpose: 'シャンプーのみ', staff: 4, comment: '駐車場が分かりにくかったです' }, { state: 'failed', pending: ['tag'] }),
    visitSubmission('fv-3', 'マロン', '2026-09-30T12:05:00+09:00', { purpose: 'ご相談', staff: 5, comment: '' }, { state: 'completed', pending: [] }),
  ],
  total: 1284, page: 1, limit: 20,
  summary: {
    startedUnique: 1712, submitted: 1284, completionRate: 75,
    destinationWrites: { pending: 0, succeeded: 0, partial: 0, failed: 0, not_requested: 1284, unknown: 0 },
    dateAnsweredUniqueFriends: 0, dateFields: [],
    ratingFields: [{ key: 'staff', label: '担当の対応は？', answered: 186, average: 4.3 }],
  },
}

/**
 * NENコラム下書き作成。Workerの公開契約と同じ6項目だけを持つ。
 * 画面側は通常・入力エラー・重複・保存失敗を、このstatus/bodyで描き分ける。
 */
export const NEN_COLUMN_CREATE = {
  request: {
    title: '鹿肉の選び方',
    category: '食事',
    excerpt: '原材料表示の基本をご紹介します。',
    articleUrl: 'https://example.com/columns/venison-guide',
    imageUrl: 'https://cdn.example.com/columns/venison-guide.jpg',
    publishedAt: null,
    targetMode: 'tag',
    targetTagId: 'tag-2',
    scheduledAt: '2026-09-08T10:00:00+09:00',
    completionEventName: '鹿肉の選び方を読了',
    completionTagId: 'tag-3',
  },
  success: {
    status: 201,
    // 本番口は `data: { id, queued }` を返す(点検 #512 の中8)。数は固定値。
    body: { success: true, data: { id: 'nen-column-draft-1', queued: 0 } },
  },
  inputError: {
    status: 400,
    body: { success: false, error: 'article_url_invalid' },
  },
  duplicate: {
    status: 409,
    body: { success: false, error: 'column_already_exists' },
  },
  failure: {
    status: 500,
    body: { success: false, error: 'column_create_failed' },
  },
}

/** 機能21の書き込み口。撮影では保存・配信せず、本番契約と同じ結果だけを返す。 */
export const NEN_COLUMN_OPERATIONS = {
  audience: { count: 486, targetMode: 'tag', targetTagId: 'tag-2' },
  duplicate: { id: 'nen-column-copy-1', sourceColumnId: 'nen-column-tooth' },
  pendingNow: { queued: 148 },
  readEvent: { recorded: true, tagged: true },
}

/**
 * NEN配信の一覧・詳細・編集に使う通常データ。
 * 一覧の件数・状態を画面コードへ埋め込まず、この固定結果だけで再現する。
 */
const nenCampaignSetting = (campaignKey, label, category, triggerEvent, delayDays, deliveryTime, isEnabled, title, bodyText, buttonLabel = null) => ({
  campaignKey,
  label,
  category,
  triggerEvent,
  delayDays,
  deliveryTime,
  isEnabled,
  title,
  bodyText,
  buttonLabel,
  buttonUrl: buttonLabel ? 'https://example.com/nen' : null,
  imageUrl: null,
  // 実口・型と揃える(#728)。値は未設定時の実口の決めごとと同じ。
  dedupWindowDays: 30,
  excludeFormRespondents: false,
  afterActions: campaignKey === 'review_request' ? [
    { kind: 'open_form', formId: 'form-review', formName: '口コミ', buttonLabel: '感想を書く（30秒）' },
    { kind: 'award_mileage', amount: 200, trigger: 'form_submitted' },
  ] : [],
  // 実口・型と揃える(NEN-07)。つなぐフォームが使えないときだけ理由コードが入る。
  formIssue: null,
  updatedAt: '2026-08-25T10:00:00+09:00',
})

export const NEN_CAMPAIGN_SETTINGS = [
  nenCampaignSetting('order_thanks', '注文ありがとうございます', 'transactional', 'ec.order.confirmed', 0, '09:00', true, 'ご注文ありがとうございます', 'ご注文の内容を確認しました。'),
  nenCampaignSetting('shipping_notice', 'お荷物を送りました', 'transactional', 'ec.shipping.shipped', 0, '09:00', true, 'お荷物を発送しました', '追跡番号から配送状況をご確認いただけます。', '配送状況を見る'),
  nenCampaignSetting('arrival_check', '使い方のご案内', 'follow_up', 'ec.order.arrived', 1, '10:00', true, '商品は無事に届きましたか？', '使い方のポイントを3つにまとめました。', '使い方を見る'),
  nenCampaignSetting('care_check', '困っていませんか', 'follow_up', 'ec.order.arrived', 3, '19:00', false, 'お困りのことはありませんか？', '気になることを、2つの選択肢から教えてください。', '回答する'),
  nenCampaignSetting('review_request', '口コミのお願い', 'follow_up', 'ec.order.arrived', 10, '10:00', true, '口コミのお願い', '{{ペットの名前}}ちゃん、{{商品名}}はいかがでしたか。よろしければ、ひとことだけ感想を聞かせてください。星をえらぶだけでも大丈夫です。', '感想を書く（30秒）'),
  nenCampaignSetting('cross_sell', 'そろそろ無くなるころ', 'follow_up', 'ec.order.arrived', 30, '10:00', true, 'そろそろ無くなるころです', '次回のお買い物に使えるご案内をお送りします。', '商品を見る'),
  nenCampaignSetting('birthday_coupon', 'お誕生日クーポン', 'birthday', 'pet.birthday', 0, '10:00', true, '{{pet_name}}、お誕生日おめでとうございます', '{{coupon_code}} を {{coupon_expiry}} までお使いいただけます。', 'クーポンを受け取る'),
  nenCampaignSetting('column', 'NENコラム', 'column', 'column.scheduled', 0, '10:00', false, '今週のNENコラム', '愛犬・愛猫との暮らしに役立つ読みものをお届けします。', 'コラムを読む'),
]

const nenColumn = (id, title, category, excerpt, deliveryStatus, publishedAt, deliveryAt = null) => ({
  id,
  externalId: `external-${id}`,
  slug: id,
  title,
  category,
  excerpt,
  introText: `${title}をご紹介します。`,
  articleUrl: `https://example.com/columns/${id}`,
  imageUrl: null,
  publishedAt,
  deliveryStatus,
  deliveryAt,
  targetMode: id === 'nen-column-autumn' ? 'tag' : 'all',
  targetTagId: id === 'nen-column-autumn' ? 'tag-2' : null,
  completionEventName: `${title}を読了`,
  completionTagId: 'tag-3',
  sourceColumnId: null,
  lineAccountId: 'visual-qa-account',
  updatedAt: '2026-08-25T10:00:00+09:00',
})

/*
 * ★V8-B `Jxmqh` の表の上から6行（題・分類・公開日・LINE 配信の状態）。並びは一覧の口の並び（新しい順）。
 * 1行目は予約中の下書き（公開日は「10/10 予定」）、5行目は公開したが LINE では送っていないコラム。
 */
const NEN_COLUMN_DESIGN_ROWS = [
  nenColumn('nen-column-autumn', '秋の食事、量はどれくらい？', '季節のこと', '写真1枚・900字', 'scheduled', null, '2026-10-10T10:00:00+09:00'),
  nenColumn('nen-column-toilet', 'トイレの回数、気にしていますか', 'からだのこと', '写真1枚・1,100字', 'sent', '2026-09-26T10:00:00+09:00'),
  nenColumn('nen-column-water', '夏の水分補給、どれくらい？', '季節のこと', '写真1枚・900字', 'sent', '2026-08-08T10:00:00+09:00'),
  nenColumn('nen-column-tooth', '歯みがきのコツ、3つだけ', 'お手入れ', '写真2枚・1,200字', 'sent', '2026-07-22T10:00:00+09:00'),
  nenColumn('nen-column-nail', '爪切りが苦手な子へ', 'お手入れ', '動画1本・700字', 'draft', '2026-07-01T10:00:00+09:00'),
  nenColumn('nen-column-food', 'フードの切り替えかた', 'ごはん', '写真3枚・1,600字', 'sent', '2026-06-14T10:00:00+09:00'),
]

export const NEN_COLUMNS = [
  ...NEN_COLUMN_DESIGN_ROWS,
  // 全部で24本（公開中20・下書き4）。★V8-B の数の帯とタブの件数。
  ...Array.from({ length: 15 }, (_, index) => nenColumn(
    `nen-column-sent-${index + 1}`,
    `暮らしのコラム ${index + 1}`,
    '暮らし',
    '写真1枚・800字',
    'sent',
    `2026-${String(5 - Math.floor(index / 9)).padStart(2, '0')}-${String(28 - (index % 9)).padStart(2, '0')}T10:00:00+09:00`,
  )),
  ...Array.from({ length: 3 }, (_, index) => nenColumn(
    `nen-column-draft-${index + 1}`,
    `下書きのコラム ${index + 1}`,
    '下書き',
    '公開前の下書きです',
    'draft',
    null,
  )),
]

export const NEN_PETS = [
  { id: 'nen-pet-momo', friendId: 'friend-1', customerId: 'customer-1', name: 'ももちゃん', animalType: 'dog', gender: 'female', birthday: '2022-09-02', ownerName: '見本 16', lineUserId: 'Uvisualfriend000001', updatedAt: '2026-09-10T10:00:00.000+09:00' },
  { id: 'nen-pet-sora', friendId: 'friend-2', customerId: 'customer-2', name: 'そらくん', animalType: 'cat', gender: 'male', birthday: '2024-08-28', ownerName: '見本 17', lineUserId: 'Uvisualfriend000002', updatedAt: '2026-09-10T10:00:00.000+09:00' },
  { id: 'nen-pet-komugi', friendId: 'friend-3', customerId: 'customer-3', name: 'こむぎちゃん', animalType: 'dog', gender: 'female', birthday: '2018-11-14', ownerName: '見本 26', lineUserId: 'Uvisualfriend000003', updatedAt: '2026-09-10T10:00:00.000+09:00' },
  { id: 'nen-pet-leo', friendId: 'friend-4', customerId: 'customer-4', name: 'レオくん', animalType: 'dog', gender: 'male', birthday: null, ownerName: '見本 19', lineUserId: 'Uvisualfriend000004', updatedAt: '2026-09-10T10:00:00.000+09:00' },
  { id: 'nen-pet-purin', friendId: 'friend-5', customerId: 'customer-5', name: 'ぷりんちゃん', animalType: 'other', gender: 'female', birthday: '2022-10-05', ownerName: '見本 27', lineUserId: 'Uvisualfriend000005', updatedAt: '2026-09-10T10:00:00.000+09:00' },
]

const nenJob = (id, campaignKey, label, friendName, scheduledAt, status, attempts, sentAt, triggerLabel, reactionLabel, lineAccountName = 'LINE 本店') => ({
  id,
  campaignKey,
  label,
  friendName,
  scheduledAt,
  status,
  attempts,
  lastError: status === 'failed' ? 'LINEへの送信が拒否されました' : null,
  sentAt,
  triggerLabel,
  reactionLabel,
  lineAccountName,
})

// ★V8-B `Tj7n4` の送った履歴は1ページ目に6行（表のすぐ下にページ送り）。
export const NEN_JOBS = [
  nenJob('nen-job-1', 'care_check', '困っていませんか', '見本 17', '2026-08-25T19:00:00+09:00', 'pending', 0, null, '8/22 の注文が到着', '—'),
  nenJob('nen-job-2', 'birthday_coupon', 'ももちゃんのお誕生日', '見本 16', '2026-08-25T10:00:00+09:00', 'sent', 1, '2026-08-25T10:00:02+09:00', 'ペットの誕生日 9/02', '開きました'),
  nenJob('nen-job-3', 'order_thanks', '注文ありがとうございます', '見本 28', '2026-08-25T09:12:00+09:00', 'sent', 1, '2026-08-25T09:12:03+09:00', '注文が確定', '開きました', 'LINE 二号店'),
  nenJob('nen-job-4', 'shipping_notice', 'お荷物を送りました', '見本 26', '2026-08-24T18:00:00+09:00', 'sent', 1, '2026-08-24T18:00:03+09:00', '発送を登録', '押しました', 'LINE 二号店'),
  nenJob('nen-job-5', 'arrival_check', '使い方のご案内', '見本 155', '2026-08-24T10:00:00+09:00', 'failed', 3, null, '8/22 の注文が到着', '—'),
  nenJob('nen-job-6', 'review_request', '口コミのお願い', '見本 19', '2026-08-23T20:00:00+09:00', 'sent', 1, '2026-08-23T20:00:04+09:00', '8/16 の注文が到着', '開きました'),
]

/*
  機能21の新しい集計・履歴契約（PR #1117）。既存の設定・コラム・ペット・
  配信jobと同じIDだけを使い、画面ごとに別の作り物が生まれないようにする。
*/
const NEN_METRICS_RANGE = {
  days: 30,
  from: '2026-07-26T15:00:00.000Z',
  to: '2026-08-25T15:00:00.000Z',
}

const nenUnavailable = (reason) => ({ value: null, state: 'unavailable', reason })

const NEN_FLOW_COUNTS = {
  order_thanks: { planned: 486, sent: 486, failed: 0, skipped: 0, associatedConversions: 28, associatedConversionAmount: 156800 },
  shipping_notice: { planned: 462, sent: 462, failed: 0, skipped: 0, associatedConversions: 22, associatedConversionAmount: 118400 },
  arrival_check: { planned: 424, sent: 418, failed: 6, skipped: 0, associatedConversions: 18, associatedConversionAmount: 86400 },
  care_check: { planned: 0, sent: 0, failed: 0, skipped: 0, associatedConversions: 0, associatedConversionAmount: 0 },
  review_request: { planned: 386, sent: 386, failed: 0, skipped: 0, associatedConversions: 28, associatedConversionAmount: 96400 },
  cross_sell: { planned: 550, sent: 402, failed: 0, skipped: 148, associatedConversions: 20, associatedConversionAmount: 72000 },
  birthday_coupon: { planned: 148, sent: 148, failed: 0, skipped: 0, associatedConversions: 12, associatedConversionAmount: 32400 },
  column: { planned: 184, sent: 184, failed: 0, skipped: 0, associatedConversions: 14, associatedConversionAmount: 50000 },
}

export const NEN_FLOW_METRICS = {
  range: NEN_METRICS_RANGE,
  summary: { active: 6, paused: 2, planned: 2_640, sent: 2_486, associatedConversions: 142, associatedConversionAmount: 612400 },
  flows: NEN_CAMPAIGN_SETTINGS.map((setting) => ({
    campaignKey: setting.campaignKey,
    label: setting.label,
    category: setting.category,
    isEnabled: setting.isEnabled,
    ...NEN_FLOW_COUNTS[setting.campaignKey],
    openRate: nenUnavailable('LINEはNEN配信の個人開封を提供していません'),
    attribution: '送信後7日以内の関連成果であり、配信が原因とは断定しません',
  })),
}

const NEN_COLUMN_RESULTS = {
  'nen-column-autumn': { targeted: 1_284, sent: 0, pending: 1_284, opened: null, completed: 0, rate: null, conversions: 0, conversionAmount: 0 },
  'nen-column-toilet': { targeted: 1_102, sent: 1_102, opened: 612, completed: 488, rate: 0.555, conversions: 9, conversionAmount: 36000 },
  'nen-column-water': { targeted: 1_040, sent: 1_040, opened: 580, completed: 462, rate: 0.558, conversions: 7, conversionAmount: 28000 },
  'nen-column-tooth': { targeted: 998, sent: 998, opened: 451, completed: 380, rate: 0.452, conversions: 12, conversionAmount: 48000 },
  'nen-column-nail': { targeted: 0, sent: 0, opened: 88, completed: 41, rate: null, conversions: 0, conversionAmount: 0 },
  'nen-column-food': { targeted: 960, sent: 960, opened: 530, completed: 431, rate: 0.552, conversions: 14, conversionAmount: 56000 },
}

export const NEN_COLUMN_METRICS = {
  range: NEN_METRICS_RANGE,
  summary: { total: 24, sent: 19, drafts: 4, scheduled: 1, unread: 1_927, associatedConversions: 38, associatedConversionAmount: 142000 },
  columns: NEN_COLUMNS.map((column) => {
    const result = NEN_COLUMN_RESULTS[column.id] ?? {
      targeted: 0,
      sent: 0,
      opened: null,
      rate: null,
      conversions: 0,
      completed: 0,
      conversionAmount: 0,
    }
    const trackingAvailable = result.opened !== null
    return {
      id: column.id,
      title: column.title,
      category: column.category,
      deliveryStatus: column.deliveryStatus,
      publishedAt: column.publishedAt,
      deliveryAt: column.deliveryAt,
      period: { from: column.publishedAt ?? column.deliveryAt, to: column.publishedAt ?? column.deliveryAt },
      targeted: result.targeted,
      sent: result.sent,
      pending: result.pending ?? 0,
      failed: 0,
      articleOpened: trackingAvailable
        ? { value: result.opened, rate: result.rate, state: 'available', reason: null }
        : { value: null, rate: null, state: 'unavailable', reason: 'この記事URLの計測台帳がありません' },
      unread: trackingAvailable ? Math.max(result.sent - result.opened, 0) : null,
      completionRate: {
        value: result.completed,
        rate: result.opened ? result.completed / result.opened : 0,
        state: 'available',
        reason: null,
      },
      associatedConversions: result.conversions,
      associatedConversionAmount: result.conversionAmount,
      attribution: '送信後7日以内の関連成果',
    }
  }),
}

const NEN_PET_DETAILS = {
  'nen-pet-momo': { breed: 'トイプードル', deliveryCount: 6, lastSentAt: '2026-08-25T10:00:02+09:00', coupons: { issued: 2, used: 1 } },
  'nen-pet-sora': { breed: '雑種', deliveryCount: 3, lastSentAt: '2026-08-25T10:00:02+09:00', coupons: { issued: 1, used: 1 } },
  'nen-pet-komugi': { breed: '柴', deliveryCount: 9, lastSentAt: '2026-08-14T10:00:02+09:00', coupons: { issued: 3, used: 1 } },
  'nen-pet-leo': { breed: 'ラブラドール', deliveryCount: 0, lastSentAt: null, coupons: { issued: 0, used: 0 } },
  'nen-pet-purin': { breed: null, deliveryCount: 4, lastSentAt: '2026-08-05T10:00:02+09:00', coupons: { issued: 1, used: 0 } },
}

export const NEN_PET_METRICS = {
  range: NEN_METRICS_RANGE,
  summary: {
    pets: 864,
    birthdayRegistered: 822,
    birthdayMissing: 42,
    birthdayThisMonth: 72,
    friends: 1_284,
    friendsWithoutPet: 420,
    birthdayOpenRate: nenUnavailable('LINEは誕生日配信の個人開封を提供していません'),
    birthdayReachRate: 94.6 / 100,
    birthdayClickRate: 38.2 / 100,
    coupons: { issued: 73, used: 28, usageRate: 28 / 73 },
  },
  breeds: [
    { name: 'トイプードル', count: 286 },
    { name: '柴', count: 194 },
    { name: '雑種', count: 172 },
    { name: 'ラブラドール', count: 86 },
    { name: '未登録', count: 126 },
  ],
  pets: NEN_PETS.map((pet) => {
    const detail = NEN_PET_DETAILS[pet.id]
    return {
      id: pet.id,
      name: pet.name,
      animalType: pet.animalType,
      breed: detail.breed,
      birthday: pet.birthday,
      friendId: pet.friendId,
      ownerName: pet.ownerName,
      ownerDeliveryHistory: { count: detail.deliveryCount, lastSentAt: detail.lastSentAt },
      coupons: detail.coupons,
    }
  }),
}

const NEN_FRIEND_IDS = ['friend-2', 'friend-1', 'friend-6', 'friend-3', 'friend-7', 'friend-4', 'friend-5']
const nenDeliveryReaction = () => nenUnavailable('この配信記録に対応する個人の反応は取得できません')

export const NEN_DELIVERIES = {
  range: NEN_METRICS_RANGE,
  summary: {
    pending: 148, processing: 0, sent: 2_486, skipped: 0, failed: 6, cancelled: 0, retryRequired: 0,
    unmetReasons: { blocked: 4, unfollowed: 2, other: 0 },
  },
  deliveries: NEN_JOBS.map((job, index) => ({
    id: job.id,
    campaignKey: job.campaignKey,
    label: job.label,
    friendId: NEN_FRIEND_IDS[index],
    friendName: job.friendName,
    lineAccountName: job.lineAccountName,
    scheduledAt: job.scheduledAt,
    sentAt: job.sentAt,
    status: job.status,
    attempts: job.attempts,
    unmetReason: job.status === 'failed' ? '送信処理でエラーが起きました' : null,
    reaction: nenDeliveryReaction(),
    version: 1,
    updatedAt: job.sentAt ?? job.scheduledAt,
  })),
  pagination: { total: 2_640, limit: 20, cursor: '0', nextCursor: '20' },
}

export const NEN_DELIVERY_DETAILS = Object.fromEntries(NEN_JOBS.map((job, index) => {
  const setting = NEN_CAMPAIGN_SETTINGS.find((item) => item.campaignKey === job.campaignKey)
  return [job.id, {
    id: job.id,
    campaignKey: job.campaignKey,
    label: job.label,
    friendId: NEN_FRIEND_IDS[index],
    friendName: job.friendName,
    lineAccountName: job.lineAccountName,
    scheduledAt: job.scheduledAt,
    sentAt: job.sentAt,
    status: job.status,
    attempts: job.attempts,
    unmetReason: job.status === 'failed' ? '送信処理でエラーが起きました' : null,
    trigger: job.triggerLabel,
    content: setting ? {
      title: setting.title,
      bodyText: setting.bodyText,
      buttonLabel: setting.buttonLabel,
      buttonUrl: setting.buttonUrl,
      imageUrl: setting.imageUrl,
      state: 'available',
      reason: null,
    } : {
      title: null, bodyText: null, buttonLabel: null, buttonUrl: null, imageUrl: null,
      state: 'unavailable', reason: '予約時の配信内容が保存されていません',
    },
    version: 1,
    updatedAt: job.sentAt ?? job.scheduledAt,
  }]
}))

export const NEN_BIRTHDAY_COUPON = {
  isEnabled: true,
  codePrefix: 'NENBDAY',
  benefitLabel: 'お誕生日月限定クーポン',
  discountAmount: 500,
  validityDays: 31,
  updatedAt: '2026-08-25T10:00:00+09:00',
}
/* V8 板 `FM94M`（共通情報一覧）の7件に合わせた分け方。お店の情報4・
 * 案内文の型1・キャンペーン2・未分類0。件数は絵のとおり。 */
export const COMMON_VAR_FOLDERS = [
  { id: 'cvf-store', kind: 'common_var', name: 'お店の情報', parentId: null, displayOrder: 0, color: '#2563EB', itemCount: 4, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
  { id: 'cvf-guides', kind: 'common_var', name: '案内文の型', parentId: null, displayOrder: 1, color: '#10B981', itemCount: 1, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
  { id: 'cvf-campaign', kind: 'common_var', name: 'キャンペーン', parentId: null, displayOrder: 2, color: '#F59E0B', itemCount: 2, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
]

/* 板 `FM94M` の7行を上から順に並べた。帯の数（7件・下書き1・差し込み
 * 43か所・空のまま1件・期限が近い1件）はこの7件から計算される。`state`
 * が無い行は使用中、期限つきの使用中は「M/dまで」の札になる。 */
export const COMMON_VARS = [
  {
    id: 'common-var-delete-target', lineAccountId: 'visual-qa-account', folderId: 'cvf-store',
    name: '会社名', varKey: 'company_name', type: 'text', value: '株式会社NEN',
    createdAt: '2025-11-20T16:40:00.000+09:00', updatedAt: '2026-08-01T10:12:00.000+09:00',
    nextSchedule: null, pendingScheduleCount: 0, usageCount: 15,
  },
  {
    id: 'common-var-hours', lineAccountId: 'visual-qa-account', folderId: 'cvf-store',
    name: '営業時間', varKey: 'shop_hours', type: 'text', value: '平日 10:00〜19:00',
    createdAt: '2026-07-01T10:00:00.000+09:00', updatedAt: '2026-08-12T10:00:00.000+09:00',
    nextSchedule: null, pendingScheduleCount: 0, usageCount: 8,
  },
  {
    /* 期限つき。札は「10/7まで」、期限が近い帯に1件数えられる。 */
    id: 'common-var-campaign', lineAccountId: 'visual-qa-account', folderId: 'cvf-campaign',
    name: '今月のキャンペーン', varKey: 'monthly_campaign', type: 'text', value: '夏の20%オフ',
    validUntil: '2026-10-07T23:59:59+09:00',
    createdAt: '2026-08-01T10:00:00.000+09:00', updatedAt: '2026-08-22T10:00:00.000+09:00',
    /* 板 Hhl9M（止める窓）は決めた日の切り替えの注意を出さない絵なので、予約は持たない。 */
    nextSchedule: null, pendingScheduleCount: 0, usageCount: 7,
  },
  {
    id: 'common-var-phone', lineAccountId: 'visual-qa-account', folderId: 'cvf-store',
    name: '電話番号', varKey: 'phone', type: 'text', value: '03-0000-5678',
    createdAt: '2026-06-01T10:00:00.000+09:00', updatedAt: '2026-07-20T10:00:00.000+09:00',
    nextSchedule: null, pendingScheduleCount: 0, usageCount: 7,
  },
  {
    /* 空のまま使われている1件（空欄のまま送られます → 直す）。 */
    id: 'common-var-contact', lineAccountId: 'visual-qa-account', folderId: 'cvf-guides',
    name: '問い合わせ先', varKey: 'contact', type: 'text', value: '',
    createdAt: '2026-06-10T10:00:00.000+09:00', updatedAt: '2026-06-10T10:00:00.000+09:00',
    nextSchedule: null, pendingScheduleCount: 0, usageCount: 2,
  },
  {
    /* 下書き。使っている所は「なし」。 */
    id: 'common-var-delete-safe', lineAccountId: 'visual-qa-account', folderId: 'cvf-campaign',
    name: '臨時のお知らせ', varKey: 'temp_notice', type: 'text', value: '本日は17時まで',
    state: 'draft',
    createdAt: '2026-09-01T10:00:00.000+09:00', updatedAt: '2026-09-01T10:00:00.000+09:00',
    nextSchedule: null, pendingScheduleCount: 0, usageCount: 0,
  },
  {
    id: 'common-var-address', lineAccountId: 'visual-qa-account', folderId: 'cvf-store',
    name: '住所', varKey: 'address', type: 'text', value: '東京都渋谷区〇〇 1-2-3',
    createdAt: '2026-06-01T10:00:00.000+09:00', updatedAt: '2026-07-20T10:00:00.000+09:00',
    /* 板 FM94M の7件目（絵の6行の下に隠れている）。使っている所を「未取得」にして
     * 並び（使われている数が多い順）の最後へ回す。4か所にすると5行目に割り込む。 */
    nextSchedule: null, pendingScheduleCount: 0,
  },
]

export const COMMON_VAR_DELETE_IMPACT = {
  variable: { id: 'common-var-delete-target', name: '会社名', varKey: 'company_name' },
  total: 15,
  blockingTotal: 15,
  historicalTotal: 0,
  unscopedFormTotal: 0,
  canDelete: false,
  byKind: { template: 12, broadcast: 0, scenario: 0, reminder: 0, auto_reply: 0, form: 3, automation: 0, friend_add: 0, common_action: 0 },
  items: [
    {
      kind: 'template', kindLabel: 'テンプレート', name: '定期便 初回のご案内',
      status: '予約中 8/26 10:00', href: '/templates/edit?id=template-first-delivery',
      blocksDeletion: true, currentPreview: 'ご不明な点は 株式会社NEN までお気軽にどうぞ。',
    },
    {
      kind: 'template', kindLabel: 'テンプレート', name: '夏の定番5点（パネル2）',
      status: '予約中 8/27 12:00', href: '/templates/edit?id=template-summer-panel',
      blocksDeletion: true, currentPreview: '株式会社NEN からのおすすめです。8月末まで送料無料。',
    },
    {
      kind: 'form', kindLabel: '回答フォーム', name: '来店アンケート',
      status: '公開中', href: '/forms/edit?id=form-store-survey',
      blocksDeletion: true, currentPreview: 'このフォームは 株式会社NEN が作成しています',
    },
    {
      kind: 'template', kindLabel: 'テンプレート', name: '商品到着のお知らせ',
      status: '下書き', href: '/templates/edit?id=template-delivered',
      blocksDeletion: true, currentPreview: '株式会社NEN です。お届けが完了しました。',
    },
    {
      kind: 'form', kindLabel: '回答フォーム', name: '資料請求',
      status: '公開中', href: '/forms/edit?id=form-document-request',
      blocksDeletion: true, currentPreview: '株式会社NEN の資料をお送りします',
    },
    {
      kind: 'template', kindLabel: 'テンプレート', name: '再開のごあいさつ',
      status: '下書き', href: '/templates/edit?id=template-restart',
      blocksDeletion: true, currentPreview: '株式会社NEN より、ひさしぶりのご案内です。',
    },
  ],
  unavailableReferences: [],
  checkedAt: '2026-09-07T10:00:00.000+09:00',
  recommendedAction: 'review_references',
}

export const COMMON_VAR_DELETE_IMPACT_EMPTY = {
  variable: { id: 'common-var-delete-safe', name: '臨時のお知らせ', varKey: 'temp_notice' },
  total: 0,
  blockingTotal: 0,
  historicalTotal: 0,
  unscopedFormTotal: 0,
  canDelete: true,
  byKind: { template: 0, broadcast: 0, scenario: 0, reminder: 0, auto_reply: 0, form: 0, automation: 0, friend_add: 0, common_action: 0 },
  items: [],
  unavailableReferences: [],
  checkedAt: '2026-08-31T10:00:00.000+09:00',
  recommendedAction: 'delete',
}

export const COMMON_VAR_DELETE_IMPACT_ERROR = {
  success: false,
  error: '使用先を確認できないため削除できません',
}

/** PR #1131 の詳細・差し替え契約。既存の会社名と使用先を共通で使う。 */
const COMMON_VAR_SOURCE = COMMON_VARS.find((variable) => variable.id === COMMON_VAR_DELETE_IMPACT.variable.id)
const COMMON_VAR_REPLACEMENT = COMMON_VARS.find((variable) => variable.id === 'common-var-hours')

export const COMMON_VAR_DETAIL = {
  ...COMMON_VAR_SOURCE,
  memo: '契約書・請求書・お客さま案内で使う正式な会社名',
  version: 3,
  archivedAt: null,
  usageByKind: COMMON_VAR_DELETE_IMPACT.byKind,
  usages: COMMON_VAR_DELETE_IMPACT.items,
  usagePage: {
    total: COMMON_VAR_DELETE_IMPACT.total,
    shown: COMMON_VAR_DELETE_IMPACT.items.length,
    hasMore: COMMON_VAR_DELETE_IMPACT.total > COMMON_VAR_DELETE_IMPACT.items.length,
    unavailableCount: COMMON_VAR_DELETE_IMPACT.unscopedFormTotal,
  },
  history: [
    {
      id: 'common-var-version-3', version: 3, name: '会社名', value: '株式会社NEN',
      memo: '契約書・請求書・お客さま案内で使う正式な会社名',
      changeReason: '登記上の表記に統一', actorId: 'staff-1', actorName: '見本 145', createdAt: '2026-08-01T10:12:00.000+09:00',
    },
    {
      id: 'common-var-version-2', version: 2, name: '会社名', value: 'NEN', memo: '',
      changeReason: '初回登録', actorId: 'staff-1', actorName: '見本 145', createdAt: '2025-11-20T16:40:00.000+09:00',
    },
  ],
}

/*
 * 共通情報の切り替え予約。編集画面の予約表を撮影・検証するために置く。
 * 口の形は GET /api/common-vars/:id/schedules の serializeSchedule と同じ。
 */
export const COMMON_VAR_SCHEDULES = [
  {
    id: 'common-var-schedule-1',
    varId: COMMON_VAR_DETAIL.id,
    effectiveFrom: '2026-10-01T10:00',
    value: '株式会社NEN（10月〜）',
    appliedAt: null,
  },
]

export const COMMON_VAR_REPLACEMENT_CANDIDATES = {
  source: {
    id: COMMON_VAR_SOURCE.id,
    name: COMMON_VAR_SOURCE.name,
    type: COMMON_VAR_SOURCE.type,
    version: COMMON_VAR_DETAIL.version,
  },
  candidates: COMMON_VARS
    .filter((variable) => variable.id !== COMMON_VAR_SOURCE.id && variable.type === COMMON_VAR_SOURCE.type)
    .map((variable) => ({
      id: variable.id,
      name: variable.name,
      varKey: variable.varKey,
      type: variable.type,
      value: variable.value,
      version: 1,
    })),
}

export const COMMON_VAR_REPLACEMENT_PREVIEW = {
  source: COMMON_VAR_REPLACEMENT_CANDIDATES.source,
  replacement: {
    id: COMMON_VAR_REPLACEMENT.id,
    name: COMMON_VAR_REPLACEMENT.name,
    type: COMMON_VAR_REPLACEMENT.type,
    version: 1,
  },
  usageTotal: COMMON_VAR_DELETE_IMPACT.total,
  replaceableTotal: COMMON_VAR_DELETE_IMPACT.blockingTotal,
  blockedTotal: 0,
  historicalTotal: COMMON_VAR_DELETE_IMPACT.historicalTotal,
  unscopedFormTotal: COMMON_VAR_DELETE_IMPACT.unscopedFormTotal,
  byKind: COMMON_VAR_DELETE_IMPACT.byKind,
  canReplace: true,
  revision: '8d8c3f91f498b423cd7c37562f0fd5b2e1676959e040bc6b126de36a537a6926',
  checkedAt: '2026-09-07T10:00:00.000+09:00',
}

export const COMMON_VAR_REPLACEMENT_RESULT = {
  runId: 'common-var-replace-run-1',
  archivedVersion: COMMON_VAR_DETAIL.version + 1,
  sourceId: COMMON_VAR_SOURCE.id,
  replacementId: COMMON_VAR_REPLACEMENT.id,
  replacedUsageCount: COMMON_VAR_REPLACEMENT_PREVIEW.replaceableTotal,
  remainingUsageCount: 0,
  verification: 'verified',
  completedAt: '2026-09-07T10:01:00.000+09:00',
}

/*
 * V8 板 `xxKtW`（共通情報の削除の窓）：「電話番号」は7か所で使われていて、まだ消せない。
 * 使っている所の上2つ・ほか5か所、差し替え先の候補は「問い合わせ先」が先頭。
 */
const COMMON_VAR_PHONE = COMMON_VARS.find((variable) => variable.id === 'common-var-phone')
const COMMON_VAR_CONTACT = COMMON_VARS.find((variable) => variable.id === 'common-var-contact')
export const COMMON_VAR_DELETE_IMPACT_PHONE = {
  variable: { id: COMMON_VAR_PHONE.id, name: COMMON_VAR_PHONE.name, varKey: COMMON_VAR_PHONE.varKey },
  total: 7,
  blockingTotal: 7,
  historicalTotal: 0,
  unscopedFormTotal: 0,
  canDelete: false,
  byKind: { template: 5, broadcast: 0, scenario: 0, reminder: 0, auto_reply: 2, form: 0, automation: 0, friend_add: 0, common_action: 0 },
  items: [
    { kind: 'template', kindLabel: 'テンプレート', name: '店舗のご案内', status: '公開中', href: '/templates/edit?id=template-store-guide', blocksDeletion: true, currentPreview: 'お電話は 03-0000-5678 まで。' },
    { kind: 'auto_reply', kindLabel: '自動応答', name: '営業時間外の自動返信', status: '動いている', href: '/auto-replies/edit?id=auto-reply-after-hours', blocksDeletion: true, currentPreview: '急ぎの方は 03-0000-5678 へ。' },
    { kind: 'template', kindLabel: 'テンプレート', name: 'ご予約の確認', status: '公開中', href: '/templates/edit?id=template-booking-confirm', blocksDeletion: true, currentPreview: '変更は 03-0000-5678 まで。' },
    { kind: 'template', kindLabel: 'テンプレート', name: '定期便 初回のご案内', status: '公開中', href: '/templates/edit?id=template-first-delivery', blocksDeletion: true, currentPreview: 'ご不明な点は 03-0000-5678 まで。' },
    { kind: 'template', kindLabel: 'テンプレート', name: '商品到着のお知らせ', status: '下書き', href: '/templates/edit?id=template-delivered', blocksDeletion: true, currentPreview: 'お問い合わせは 03-0000-5678 まで。' },
    { kind: 'auto_reply', kindLabel: '自動応答', name: '電話番号を聞かれたとき', status: '動いている', href: '/auto-replies/edit?id=auto-reply-phone', blocksDeletion: true, currentPreview: '03-0000-5678 です。' },
    { kind: 'template', kindLabel: 'テンプレート', name: '再開のごあいさつ', status: '下書き', href: '/templates/edit?id=template-restart', blocksDeletion: true, currentPreview: '03-0000-5678 までお気軽に。' },
  ],
  unavailableReferences: [],
  checkedAt: '2026-09-07T10:00:00.000+09:00',
  recommendedAction: 'review_references',
}

export const COMMON_VAR_REPLACEMENT_CANDIDATES_PHONE = {
  source: { id: COMMON_VAR_PHONE.id, name: COMMON_VAR_PHONE.name, type: COMMON_VAR_PHONE.type, version: 1 },
  candidates: [COMMON_VAR_CONTACT, ...COMMON_VARS.filter((variable) => variable.id !== COMMON_VAR_PHONE.id && variable.id !== COMMON_VAR_CONTACT.id)]
    .map((variable) => ({ id: variable.id, name: variable.name, varKey: variable.varKey, type: variable.type, value: variable.value, version: 1 })),
}

export const COMMON_VAR_REPLACEMENT_PREVIEW_PHONE = {
  source: COMMON_VAR_REPLACEMENT_CANDIDATES_PHONE.source,
  replacement: { id: COMMON_VAR_CONTACT.id, name: COMMON_VAR_CONTACT.name, type: COMMON_VAR_CONTACT.type, version: 1 },
  usageTotal: 7,
  replaceableTotal: 7,
  blockedTotal: 0,
  historicalTotal: 0,
  unscopedFormTotal: 0,
  byKind: COMMON_VAR_DELETE_IMPACT_PHONE.byKind,
  canReplace: true,
  revision: 'b7d0c6a1e2f34c5d8e9fa0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1',
  checkedAt: '2026-09-07T10:00:00.000+09:00',
}

/*
 * V8 板 `Hhl9M`（共通情報の止める窓）：「今月のキャンペーン」は予約中の一斉配信に差し込まれている。
 * 止めると送られなくなる、の帯を出すための使用先。
 */
export const COMMON_VAR_DELETE_IMPACT_CAMPAIGN = {
  variable: { id: 'common-var-campaign', name: '今月のキャンペーン', varKey: 'monthly_campaign' },
  total: 7,
  blockingTotal: 7,
  historicalTotal: 0,
  unscopedFormTotal: 0,
  canDelete: false,
  byKind: { template: 6, broadcast: 1, scenario: 0, reminder: 0, auto_reply: 0, form: 0, automation: 0, friend_add: 0, common_action: 0 },
  items: [
    { kind: 'broadcast', kindLabel: '一斉配信', name: '10月のお知らせ', status: '配信予約中', href: '/broadcasts/edit?id=broadcast-october', blocksDeletion: true, currentPreview: '夏の20%オフは今月末まで。' },
  ],
  unavailableReferences: [],
  checkedAt: '2026-09-07T10:00:00.000+09:00',
  recommendedAction: 'review_references',
}

/**
 * 機能15 `YfTfJ` の登録メディアと削除影響。
 *
 * 使用先の名前はすべて作り物。内部IDは画面に出さず、hrefの中だけで使う。
 * 通常・0件・失敗を同じ契約から撮れるよう、形を分けて固定してある。
 */
export const MEDIA_FOLDERS = [
  { id: 'media-product', name: '01_商品写真', kind: 'media', sortOrder: 0, color: '#2563EB', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
  { id: 'media-banner', name: '02_バナー', kind: 'media', sortOrder: 1, color: '#1f9d55', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
  { id: 'media-video', name: '03_動画', kind: 'media', sortOrder: 2, color: '#e07b24', createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
]

export const MEDIA_QUOTA = {
  usageBytes: 3435973837,
  reservedBytes: 0,
  limitBytes: 10737418240,
  remainingBytes: 7301444403,
  usageRate: 0.32,
  state: 'normal',
}

const mediaPreview = (color) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="560"><rect width="1040" height="560" fill="${color}"/><svg x="440" y="200" width="160" height="160" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4-4L7 21"/></svg></svg>`)}`

export const MEDIA_ITEMS = [
  {
    id: 'media-autumn-new', lineAccountId: 'visual-qa-account', folderId: 'media-product',
    kind: 'image', filename: '秋の新商品.jpg', mimeType: 'image/jpeg',
    sizeBytes: 1258291, width: 1024, height: 678, durationMs: null,
    url: mediaPreview('#c8a27a'), uploadedBy: '見本 145', uploadedByName: '見本 145', createdAt: '2026-08-19T09:00:00.000Z', usageCount: 3,
  },
  {
    id: 'media-banner', lineAccountId: 'visual-qa-account', folderId: 'media-banner',
    kind: 'image', filename: '会員証バナー.png', mimeType: 'image/png',
    sizeBytes: 430080, width: 2500, height: 1686, durationMs: null,
    url: mediaPreview('#9fb3c8'), uploadedBy: '見本 145', uploadedByName: '見本 145', createdAt: '2026-08-18T09:00:00.000Z', usageCount: 1,
  },
  {
    id: 'media-guide-video', lineAccountId: 'visual-qa-account', folderId: 'media-video',
    kind: 'video', filename: '使い方ガイド.mp4', mimeType: 'video/mp4',
    sizeBytes: 39845888, width: null, height: null, durationMs: 215000,
    url: mediaPreview('#e8ebef'), uploadedBy: '見本 145', uploadedByName: '見本 145', createdAt: '2026-08-17T09:00:00.000Z', usageCount: 1,
  },
  {
    id: 'media-delete-safe', lineAccountId: 'visual-qa-account', folderId: null,
    kind: 'file', filename: 'メニュー表.pdf', mimeType: 'application/pdf',
    sizeBytes: 2202009, width: null, height: null, durationMs: null,
    url: 'data:application/pdf;base64,JVBERi0xLjQ=', uploadedBy: '田中', uploadedByName: '田中', createdAt: '2026-08-16T09:00:00.000Z', usageCount: 0,
  },
  {
    id: 'media-staff', lineAccountId: 'visual-qa-account', folderId: 'media-product',
    kind: 'image', filename: 'スタッフ紹介.jpg', mimeType: 'image/jpeg',
    sizeBytes: 880640, width: 1024, height: 678, durationMs: null,
    url: mediaPreview('#d9b8a6'), uploadedBy: '佐々木', uploadedByName: '佐々木', createdAt: '2026-08-15T09:00:00.000Z', usageCount: 1,
  },
  {
    id: 'media-replacement', lineAccountId: 'visual-qa-account', folderId: 'media-banner',
    kind: 'image', filename: '休業のお知らせ.png', mimeType: 'image/png',
    sizeBytes: 317440, width: 1024, height: 678, durationMs: null,
    url: mediaPreview('#b9c7a5'), uploadedBy: '田中', uploadedByName: '田中', createdAt: '2026-08-14T09:00:00.000Z', usageCount: 0,
  },
  {
    id: 'media-delete-target', lineAccountId: 'visual-qa-account', folderId: 'media-product',
    kind: 'image', filename: '夏の定番セット.jpg', mimeType: 'image/jpeg',
    sizeBytes: 1468006, width: 1024, height: 678, durationMs: null,
    url: mediaPreview('#e2c18f'), uploadedBy: '見本 145', uploadedByName: '見本 145', createdAt: '2026-08-13T09:00:00.000Z', usageCount: 3,
  },
  {
    id: 'media-price-list', lineAccountId: 'visual-qa-account', folderId: null,
    kind: 'file', filename: '価格表_2026.pdf', mimeType: 'application/pdf',
    sizeBytes: 901120, width: null, height: null, durationMs: null,
    url: 'data:application/pdf;base64,JVBERi0xLjQ=', uploadedBy: '見本 145', uploadedByName: '見本 145', createdAt: '2026-08-12T09:00:00.000Z', usageCount: 1,
  },
  {
    id: 'media-coupon', lineAccountId: 'visual-qa-account', folderId: 'media-banner',
    kind: 'image', filename: '誕生月クーポン.png', mimeType: 'image/png',
    sizeBytes: 215040, width: 1029, height: 1029, durationMs: null,
    url: mediaPreview('#f3ece1'), uploadedBy: '田中', uploadedByName: '田中', createdAt: '2026-08-11T09:00:00.000Z', usageCount: 1,
  },
  {
    id: 'media-pamphlet', lineAccountId: 'visual-qa-account', folderId: 'media-product',
    kind: 'image', filename: '定期便パンフ.jpg', mimeType: 'image/jpeg',
    sizeBytes: 491520, width: 1024, height: 678, durationMs: null,
    url: mediaPreview('#e4eee8'), uploadedBy: '佐々木', uploadedByName: '佐々木', createdAt: '2026-08-10T09:00:00.000Z', usageCount: 5,
  },
  {
    id: 'media-store-video', lineAccountId: 'visual-qa-account', folderId: 'media-video',
    kind: 'video', filename: '店内のようす.mp4', mimeType: 'video/mp4',
    sizeBytes: 88080384, width: null, height: null, durationMs: 164000,
    url: mediaPreview('#eef0f2'), uploadedBy: '佐々木', uploadedByName: '佐々木', createdAt: '2026-08-09T09:00:00.000Z', usageCount: 1,
  },
  ...Array.from({ length: 175 }, (_, index) => {
    const folderId = index < 60 ? 'media-product' : index < 95 ? 'media-banner' : index < 105 ? 'media-video' : null
    const kind = index < 95 ? 'image' : index < 105 ? 'video' : index < 135 ? 'file' : 'image'
    const ext = kind === 'image' ? 'jpg' : kind === 'video' ? 'mp4' : 'pdf'
    return {
      id: `media-filler-${index + 1}`,
      lineAccountId: 'visual-qa-account',
      folderId,
      kind,
      filename: `保管_${kind === 'image' ? '画像' : kind === 'video' ? '動画' : '資料'}_${String(index + 1).padStart(3, '0')}.${ext}`,
      mimeType: kind === 'image' ? 'image/jpeg' : kind === 'video' ? 'video/mp4' : 'application/pdf',
      sizeBytes: kind === 'image' ? 204800 : kind === 'video' ? 22020096 : 1048576,
      width: kind === 'image' ? 1024 : null,
      height: kind === 'image' ? 678 : null,
      durationMs: kind === 'video' ? 120000 : null,
      url: kind === 'file' ? 'data:application/pdf;base64,JVBERi0xLjQ=' : mediaPreview('#eef0f2'),
      uploadedBy: '見本 145', uploadedByName: '見本 145',
      createdAt: '2026-01-01T00:00:00.000Z',
      usageCount: index < 22 ? 0 : ((index % 3) + 1),
    }
  }),
  ...Array.from({ length: 11 }, (_, index) => ({
    id: `media-archived-${index + 1}`,
    lineAccountId: 'visual-qa-account',
    folderId: null,
    kind: 'image',
    filename: `退避画像_${String(index + 1).padStart(2, '0')}.jpg`,
    mimeType: 'image/jpeg',
    sizeBytes: 204800,
    width: 1024,
    height: 678,
    durationMs: null,
    url: mediaPreview('#eef0f2'),
    uploadedBy: '見本 145', uploadedByName: '見本 145',
    createdAt: '2026-01-01T00:00:00.000Z',
    usageCount: 0,
    archivedAt: '2026-08-20T00:00:00.000Z',
    archiveReason: '使わなくなったため退避',
  })),
]

export const FILE_SCAN_ITEMS = [
  {
    id: 'scan-quarantine-1', lineAccountId: 'visual-qa-account',
    subjectKind: 'media', subjectId: 'media-delete-target', mediaId: 'media-delete-target',
    filename: '請求書.pdf', mimeType: 'application/pdf', sizeBytes: 225280,
    status: 'quarantined', reasonCode: 'pdf_active_content',
    reasonLabel: '危険な仕掛けが見つかりました', uploaderLabel: '見本',
    attempts: 0, nextRetryAt: null,
    scannedAt: '2026-09-25T10:00:00+09:00', quarantinedAt: '2026-09-25T10:00:00+09:00',
    releasedAt: null, releaseReason: null,
    createdAt: '2026-09-25T10:00:00+09:00', updatedAt: '2026-09-25T10:00:00+09:00',
  },
  {
    id: 'scan-quarantine-2', lineAccountId: 'visual-qa-account',
    subjectKind: 'photo', subjectId: 'photo-3', mediaId: null,
    filename: 'photo_03.jpg', mimeType: 'image/jpeg', sizeBytes: 655360,
    status: 'quarantined', reasonCode: 'trailing_data',
    reasonLabel: '画像の後ろに別のデータがあります', uploaderLabel: 'お客さん',
    attempts: 0, nextRetryAt: null,
    scannedAt: '2026-09-25T09:30:00+09:00', quarantinedAt: '2026-09-25T09:30:00+09:00',
    releasedAt: null, releaseReason: null,
    createdAt: '2026-09-25T09:30:00+09:00', updatedAt: '2026-09-25T09:30:00+09:00',
  },
  {
    id: 'scan-pending-1', lineAccountId: 'visual-qa-account',
    subjectKind: 'media', subjectId: 'media-banner', mediaId: 'media-banner',
    filename: '会員証バナー.png', mimeType: 'image/png', sizeBytes: 839680,
    status: 'pending', reasonCode: null, reasonLabel: null, uploaderLabel: '見本',
    attempts: 1, nextRetryAt: '2026-09-25T11:00:00+09:00',
    scannedAt: null, quarantinedAt: null,
    releasedAt: null, releaseReason: null,
    createdAt: '2026-09-25T10:55:00+09:00', updatedAt: '2026-09-25T10:55:00+09:00',
  },
]

export const FILE_SCAN_CONFIG = {
  externalProvider: null,
  externalEndpointUrl: null,
  externalSecretRef: null,
  externalTimeoutMs: 10000,
  maxBytesOverride: null,
  maxPixelsOverride: null,
  updatedAt: '2026-09-25T10:00:00+09:00',
}

export const MEDIA_DELETE_IMPACT = {
  media: { id: 'media-delete-target', filename: '夏の定番セット.jpg', kind: 'image' },
  usageCount: 3,
  references: [
    {
      kind: 'template', name: '夏の定番5点',
      href: '/templates', state: 'available',
      scannedAt: '2026-08-31T10:00:00.000Z',
    },
    {
      kind: 'broadcast', name: '夏のご案内',
      href: '/broadcasts/detail?id=broadcast-visual', state: 'available',
      scannedAt: '2026-08-31T10:00:00.000Z',
    },
    {
      kind: 'rich_menu', name: '夏キャンペーン',
      href: '/rich-menus', state: 'available',
      scannedAt: '2026-08-31T10:00:00.000Z',
    },
  ],
  checkedAt: '2026-08-31T10:00:00.000Z',
  lastScannedAt: '2026-08-31T10:00:00.000Z',
  verified: true,
  canDelete: false,
  recommendedAction: 'review_references',
}

export const MEDIA_DELETE_IMPACT_EMPTY = {
  media: { id: 'media-delete-safe', filename: 'メニュー表.pdf', kind: 'file' },
  usageCount: 0,
  references: [],
  checkedAt: '2026-08-31T10:00:00.000Z',
  lastScannedAt: null,
  verified: true,
  canDelete: true,
  recommendedAction: 'delete',
}

export const MEDIA_DELETE_IMPACT_ERROR = {
  success: false,
  error: '削除したときの影響を確認できませんでした',
}

export const MEDIA_REPLACEMENT_IMPACT = {
  source: { id: 'media-delete-target', filename: '夏の定番セット.jpg', kind: 'image' },
  replacement: { id: 'media-replacement', filename: '休業のお知らせ.png', kind: 'image' },
  usageCount: 3,
  replaceableCount: 3,
  references: MEDIA_DELETE_IMPACT.references.map((reference) => ({
    ...reference, replaceable: true, blocker: null, reason: null,
  })),
  blockers: [],
  canReplace: true,
  checkedAt: '2026-08-31T10:00:00.000Z',
  revision: 'visual-qa-media-replacement-v1',
}

export const MEDIA_REPLACEMENT_IMPACT_EMPTY = {
  ...MEDIA_REPLACEMENT_IMPACT,
  source: { id: 'media-delete-safe', filename: 'メニュー表.pdf', kind: 'file' },
  usageCount: 0,
  replaceableCount: 0,
  references: [],
  revision: 'visual-qa-media-replacement-empty-v1',
}

export const MEDIA_REPLACEMENT_IMPACT_BLOCKED = {
  ...MEDIA_REPLACEMENT_IMPACT,
  replaceableCount: 1,
  blockers: ['shared_reference'],
  canReplace: false,
  references: [
    MEDIA_REPLACEMENT_IMPACT.references[0],
    {
      ...MEDIA_REPLACEMENT_IMPACT.references[1],
      replaceable: false,
      blocker: 'shared_reference',
      reason: '複数のLINEアカウントで共有しているため、この画面からは差し替えません。',
    },
  ],
  revision: 'visual-qa-media-replacement-blocked-v1',
}

/**
 * `GET /api/rich-menu-groups/:id/delete-impact` の正本形。
 *
 * Claude は szXsT の通常・0件・失敗を撮るとき、この3つをそのまま使う。
 * 表示中人数は記録する台帳が無いので、設計の人数を固定値で作らない。
 */
export const RICH_MENU_DELETE_IMPACT = {
  group: {
    id: 'rich-menu-target',
    accountId: 'visual-qa-account',
    name: '来店後フォローメニュー',
    status: 'published',
  },
  // #430/#1206: 削除影響でも一覧と同じ固定の割当人数を返す。
  currentAudience: { value: 8140, state: 'available', reason: null },
  // 全員の既定を消すので、出し分けに当たらない友だちに出るメニューは無い（板 `yOyCg`）。
  nextDisplay: {
    guaranteedGroupId: null,
    reason: 'friend_specific_rules',
    candidates: [],
  },
  incomingSwitches: [
    {
      sourceGroupId: 'rich-menu-source',
      sourceGroupName: '会員向けメニュー',
      sourcePageId: 'rich-menu-source-page',
      sourcePageName: '特典',
      areaId: 'rich-menu-source-area',
      areaLabel: '来店後のご案内',
      targetPageId: 'rich-menu-target-page',
      targetPageName: 'フォロー',
    },
  ],
  // 絵 `yOyCg` の消せない理由は3行（既定・LINE登録・切替先）。オートメーション等から使われている行は出さない。
  operationalReferences: [],
  // 一覧の「通常メニュー（会員向け）」は全員の既定（isDefaultForAll）なので、既定も消せない理由に入る（板 `yOyCg`）。
  lineResources: {
    pageCount: 2,
    pagesWithLineRichMenuId: 2,
    isDefaultForAll: true,
    publishing: false,
  },
  blockers: ['default_for_all', 'published', 'line_resources', 'incoming_switches'],
  canDelete: false,
  recommendedAction: 'unpublish',
}

export const RICH_MENU_DELETE_IMPACT_EMPTY = {
  group: {
    id: 'rich-menu-safe',
    accountId: 'visual-qa-account',
    name: '未使用の下書き',
    status: 'draft',
  },
  currentAudience: { value: null, reason: 'assignment_ledger_unavailable' },
  nextDisplay: {
    guaranteedGroupId: null,
    reason: 'friend_specific_rules',
    candidates: [],
  },
  incomingSwitches: [],
  operationalReferences: [],
  lineResources: {
    pageCount: 1,
    pagesWithLineRichMenuId: 0,
    isDefaultForAll: false,
    publishing: false,
  },
  blockers: [],
  canDelete: true,
  recommendedAction: 'delete',
}

export const RICH_MENU_DELETE_IMPACT_ERROR = {
  success: false,
  error: '削除したときの影響を確認できませんでした',
}

/**
 * 機能12の5画面を実APIと同じ器で確認する固定データ。
 *
 * `rmg-1` は3枚を行き来できるが、「予約する」だけ入口へ戻れない。
 * `rmg-2` は切替ボタンを持たない。設計 `DIUbO` / `NXdDk` の通常状態を
 * 同じ取得口で描き分けられるようにしている。
 */
const richMenuArea = (id, label, targetPageId, boundsX) => ({
  id,
  boundsX,
  boundsY: 0,
  boundsWidth: 833,
  boundsHeight: 260,
  actionType: 'richmenuswitch',
  actionData: { targetPageId },
  intent: 'switch',
  label,
  tagIds: [],
  scoreChange: null,
  templateId: null,
  formId: null,
  trackedLinkId: null,
})

/* URL を開く面（2500×1686 の 3×2）。url が空なら未設定の面になる。 */
const richMenuUrlArea = (id, label, boundsX, boundsY, uri) => ({
  id,
  boundsX,
  boundsY,
  boundsWidth: 834,
  boundsHeight: 843,
  actionType: 'uri',
  actionData: uri ? { uri } : {},
  intent: 'url',
  label,
  tagIds: [],
  scoreChange: null,
  templateId: null,
  formId: null,
  trackedLinkId: null,
})

const richMenuPage = (id, orderIndex, name, areas = [], imageR2Key = null) => ({
  id,
  orderIndex,
  name,
  aliasId: `visual-${id}`,
  lineRichmenuId: `line-${id}`,
  imageR2Key,
  imageContentType: imageR2Key ? 'image/png' : null,
  areas,
})

const RICH_MENU_BASE = {
  accountId: 'visual-qa-account',
  chatBarText: 'メニューを開く',
  size: 'large',
  isDefaultForAll: false,
  status: 'published',
  publishingAt: null,
  targetingPriority: 1,
  targetingEnabled: true,
  folderId: 'rich-menu-folder-members',
  displayOrder: 1,
  version: 1,
  thumbnailR2Key: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
}

/* 板 `rZEGN` のフォルダの列（通常・会員向け・キャンペーン＋未分類、各1件）。 */
export const RICH_MENU_FOLDERS = [
  { id: 'rich-menu-folder-normal', kind: 'rich_menu', name: '通常', parentId: null, displayOrder: 1, color: '#2563eb' },
  { id: 'rich-menu-folder-members', kind: 'rich_menu', name: '会員向け', parentId: null, displayOrder: 2, color: '#16a34a' },
  { id: 'rich-menu-folder-store', kind: 'rich_menu', name: 'キャンペーン', parentId: null, displayOrder: 3, color: '#d97706' },
]

/* 並びは板 `rZEGN` の上から（出し分けの「会員ランク上位」→ 既定の「通常メニュー」）。 */
export const RICH_MENU_GROUPS = [
  {
    ...RICH_MENU_BASE,
    id: 'rich-menu-target',
    thumbnailR2Key: 'qa-thumb-normal',
    name: '通常メニュー（会員向け）',
    isDefaultForAll: true,
    targetingPriority: 1,
    targetingEnabled: false,
    targetingCondition: null,
    folderId: 'rich-menu-folder-normal',
    displayOrder: 1,
  },
  {
    ...RICH_MENU_BASE,
    /* 編集の見本（RICH_MENU_GROUP_DETAILS の rmg-1 ＝通常メニュー（会員向け）の下書き）と ID を分ける。
     * 同じ ID だと、作る③の「出す順番」が自分と取り違えて、この行を消していた。 */
    id: 'rmg-gold',
    thumbnailR2Key: 'qa-thumb-gold',
    name: '会員ランク上位',
    /* 板 `rZEGN` の丸：通常・通常・キャンペーン・未分類（上から）。 */
    folderId: 'rich-menu-folder-normal',
    targetingPriority: 0,
    displayOrder: 0,
    monthlyStats: {
      from: '2026-08-01', to: '2026-08-31', taps: 3210,
      uniqueAudience: { value: 8140, state: 'available', reason: null },
    },
    targetingCondition: JSON.stringify({
      operator: 'AND',
      rules: [{ type: 'tag_exists', value: 'tag-0' }],
    }),
  },
  {
    ...RICH_MENU_BASE,
    id: 'rmg-autumn',
    thumbnailR2Key: 'qa-thumb-autumn',
    name: '秋のキャンペーン',
    size: 'compact',
    status: 'draft',
    publishingAt: '2026-10-05T00:00:00.000+09:00',
    isDefaultForAll: true,
    targetingPriority: 2,
    targetingEnabled: false,
    targetingCondition: null,
    folderId: 'rich-menu-folder-store',
    displayOrder: 2,
    pageCount: 1,
    defaultPageAreaCount: 2,
  },
  {
    ...RICH_MENU_BASE,
    id: 'rmg-2',
    thumbnailR2Key: 'qa-thumb-guide',
    name: '初回来店ガイド',
    status: 'draft',
    targetingPriority: 3,
    targetingEnabled: false,
    targetingCondition: null,
    folderId: null,
    displayOrder: 3,
  },
  {
    ...RICH_MENU_BASE,
    id: 'rich-menu-safe',
    name: '未使用の下書き',
    status: 'draft',
    targetingPriority: 4,
    targetingEnabled: false,
    targetingCondition: null,
    folderId: null,
    displayOrder: 4,
  },
]

export const RICH_MENU_GROUP_DETAILS = {
  'rmg-1': {
    ...RICH_MENU_GROUPS.find((group) => group.id === 'rmg-gold'),
    id: 'rmg-1',
    /* 板 `kmTab`・`Z0uO6`（作る②）の頭は `名前：通常メニュー（会員向け）・
     * いまは下書きです`。一覧の `rmg-1`（会員ランク上位）は変えない。 */
    name: '通常メニュー（会員向け）',
    status: 'draft',
    /* 板 `OxEMM`・`F4gELj`（作る③④）は「すべての友だち」（既定）で出す下書き。 */
    isDefaultForAll: true,
    targetingEnabled: false,
    targetingCondition: null,
    defaultPageId: 'rmg-1-top',
    pages: [
      richMenuPage('rmg-1-top', 0, 'トップ', [
        richMenuArea('rmg-1-top-product', '商品を見る', 'rmg-1-product', 0),
        richMenuArea('rmg-1-top-booking', '予約する', 'rmg-1-booking', 833),
      ], 'visual-qa/rich-menus/rmg-1-top.png'),
      richMenuPage('rmg-1-product', 1, '商品を見る', [
        richMenuArea('rmg-1-product-top', 'トップ', 'rmg-1-top', 0),
        richMenuArea('rmg-1-product-booking', '予約する', 'rmg-1-booking', 1666),
      ], 'visual-qa/rich-menus/rmg-1-product.png'),
      richMenuPage('rmg-1-booking', 2, '予約する', [
        richMenuArea('rmg-1-booking-product', '商品を見る', 'rmg-1-product', 833),
      ], null),
    ],
  },
  /* 板 `Z0uO6`・`kmTab`（作る② ボタンの動き）：作りかけの下書き。一覧には出さない ID。
   * 切替タブ3枚（トップ・タブA・タブB）、トップは6面。A〜C は URL を開く、D〜F は未設定。 */
  'rmg-draft': {
    ...RICH_MENU_BASE,
    id: 'rmg-draft',
    name: '通常メニュー（会員向け）',
    status: 'draft',
    isDefaultForAll: true,
    targetingEnabled: false,
    targetingCondition: null,
    defaultPageId: 'rmg-draft-top',
    pages: [
      richMenuPage('rmg-draft-top', 0, 'トップ', [
        richMenuUrlArea('rmg-draft-a', '予約する', 0, 0, 'https://nen.example/booking'),
        richMenuUrlArea('rmg-draft-b', 'お知らせ', 833, 0, 'https://nen.example/news'),
        richMenuUrlArea('rmg-draft-c', 'クーポン', 1666, 0, 'https://nen.example/coupon'),
        richMenuUrlArea('rmg-draft-d', '会員証', 0, 843, ''),
        richMenuUrlArea('rmg-draft-e', 'よくある質問', 833, 843, ''),
        richMenuUrlArea('rmg-draft-f', 'お問い合わせ', 1666, 843, ''),
      ], 'visual-qa/rich-menus/rmg-1-top.png'),
      richMenuPage('rmg-draft-tab-a', 1, 'タブA：予約', []),
      richMenuPage('rmg-draft-tab-b', 2, 'タブB：会員', []),
    ],
  },
  /* 板 `hKr8f`（公開した・公開の進み）：公開中で「すべての友だち」の既定。 */
  'rich-menu-target': {
    ...RICH_MENU_GROUPS.find((group) => group.id === 'rich-menu-target'),
    status: 'published',
    defaultPageId: 'rmt-top',
    pages: [
      richMenuPage('rmt-top', 0, 'トップ', [
        richMenuArea('rmt-top-product', '商品を見る', 'rmt-top', 0),
      ], 'visual-qa/rich-menus/rmg-1-top.png'),
    ],
  },
  'rmg-2': {
    ...RICH_MENU_GROUPS.find((group) => group.id === 'rmg-2'),
    defaultPageId: 'rmg-2-top',
    pages: [richMenuPage('rmg-2-top', 0, 'トップ')],
  },
}

export const RICH_MENU_EXTERNAL = {
  currentDefault: 'line-rich-menu-external',
  lineMenus: [
    {
      richMenuId: 'line-rich-menu-external',
      name: 'LINE公式マネージャーで作成',
      chatBarText: 'メニュー',
      size: { width: 2500, height: 1686 },
      areasCount: 6,
      areas: [
        { bounds: { x: 0, y: 0, width: 833, height: 843 }, action: { type: 'uri', label: '商品を見る', url: 'https://example.com/products', text: null, displayText: null, richMenuAliasId: null, supported: true, unsupportedReason: null } },
        { bounds: { x: 833, y: 0, width: 834, height: 843 }, action: { type: 'message', label: '予約する', url: null, text: '予約', displayText: null, richMenuAliasId: null, supported: true, unsupportedReason: null } },
        { bounds: { x: 1667, y: 0, width: 833, height: 843 }, action: { type: 'postback', label: 'クーポン', url: null, text: null, displayText: 'クーポンを確認', richMenuAliasId: null, supported: true, unsupportedReason: null } },
        { bounds: { x: 0, y: 843, width: 833, height: 843 }, action: { type: 'uri', label: 'お知らせ', url: 'https://example.com/news', text: null, displayText: null, richMenuAliasId: null, supported: true, unsupportedReason: null } },
        { bounds: { x: 833, y: 843, width: 834, height: 843 }, action: { type: 'richmenuswitch', label: '会員メニュー', url: null, text: null, displayText: null, richMenuAliasId: 'visual-rmg-1-top', supported: true, unsupportedReason: null } },
        { bounds: { x: 1667, y: 843, width: 833, height: 843 }, action: { type: 'message', label: 'お問い合わせ', url: null, text: '問い合わせ', displayText: null, richMenuAliasId: null, supported: true, unsupportedReason: null } },
      ],
      isCurrentDefault: true,
      adminManaged: false,
      adminInfo: null,
    },
  ],
}

export const RICH_MENU_TAP_STATS = {
  from: '2026-08-01',
  to: '2026-08-31',
  byArea: [{ areaId: 'qa-area-booking', groupId: 'rich-menu-target', label: '予約する', taps: 4210 }],
  byGroup: [
    { groupId: 'rich-menu-target', taps: 12480 },
    { groupId: 'rmg-gold', taps: 3210 },
  ],
  total: 15690,
}

/**
 * 受信箱のLINEの会話。LINE側の一覧には5件を返す。
 * `/api/support/inbox?channel=email` のメール2件と混ぜ、一覧は合計7件になる。
 *
 * **メールはここに入れない。** 画面は `/api/chats`（LINE）と
 * `/api/support/inbox?channel=email`（メール）を別々に読んで混ぜる。
 * メールをここへ入れると、MAILの札が付かずLINE扱いで描かれる。
 *
 * 空で返していたあいだ、受信箱は「チャットを選択してください」しか描けず、
 * **一覧も吹き出しも顧客情報も出ないまま**だった。空の絵を設計と並べても
 * 「差が無い」とは言えない。
 *
 * 画面が読むのは `Chat` に画面用の項目を足した形（`friendName`
 * `lastMessageContent` `isUnread` など）。**型に無いからと省くと、
 * 名前も本文も出ない行になる。**
 */
export const CHATS = [
  // 名前, 状態, 担当, 本文, 最終受信, 未読
  ['Kyohei Yamamoto', 'unread', 'operator-kenta', '本日8月19日のお知らせです。内容をご確認ください。', '2026-08-19T09:48:00.000Z', true],
  ['Demo Person (Obama)', 'in_progress', 'operator-kenta', 'テスト', '2026-08-18T10:20:00.000Z', false],
  ['見本 15', 'resolved', 'operator-masato', '最新のやり取りを確認できます。', '2026-08-13T05:16:00.000Z', false],
  ['見本 143', 'resolved', 'operator-kenta', '予約内容を確認しました。', '2026-08-12T08:20:00.000Z', false],
  ['見本 121', 'resolved', 'operator-masato', 'ありがとうございました。', '2026-08-11T04:15:00.000Z', false],
].map(([friendName, status, operatorId, lastMessageContent, lastMessageAt, isUnread], index) => ({
  id: `chat-${index}`,
  friendId: `friend-${index}`,
  friendName: String(friendName),
  friendPictureUrl: null,
  operatorId,
  status: String(status),
  notes: null,
  revision: 1,
  isUnread: Boolean(isUnread),
  lastMessageAt: String(lastMessageAt),
  lastMessageContent: String(lastMessageContent),
  lastMessageDirection: 'incoming',
  lastMessageType: 'text',
  sendMode: 'line',
  createdAt: '2026-08-13T00:00:00.000Z',
  updatedAt: String(lastMessageAt),
}))

/**
 * 受信箱の上に出る数。設計 `xGLVe` の帯そのまま。
 * 「要返信 1件・最長 1時間12分待ち」。
 */
export const INBOX_STATS = {
  waiting: 1,
  oldestWaitingMinutes: 72,
  averageFirstReplyMinutes: null,
  waitingOverAnHour: 1,
  mine: 0,
  todayInbound: 0,
  todayByChannel: { line: 0, email: 0 },
  /*
    担当者ごとの未読数（設計 `YZaDK`）。**0件の担当者はここに載らない**
    契約なので、`Masato` はわざと入れない——画面が実値0として描くところを
    確かめるため。担当がまだ決まっていない会話は `operatorId` が `null`。
  */
  assigneeUnread: [
    { operatorId: null, operatorName: null, unread: 2 },
    { operatorId: 'operator-kenta', operatorName: 'Kenta', unread: 3 },
  ],
}

/**
 * 選んだ会話の吹き出し。設計 `xGLVe` のトーク欄そのまま。
 *
 * 空で返すとトーク欄が真っ白になり、**日付の区切り・シナリオの記録・
 * 送った人の名前**という設計の3要素をどれも確かめられない。
 *
 * 向きは `incoming` / `outgoing`。**`inbound` / `outbound` ではない。**
 * 違う言葉で書くと、画面はどれも受信側の吹き出しとして描く。
 *
 * 吹き出しは `/api/chats/:id` の `messages` から出る。
 * `/api/friends/:id/messages` は別の口で、こちらには出ない。
 */
export const FRIEND_MESSAGES = {
  /*
    会話の中を探す（V8.pen M0393 段13・枠 v7GV2）の見本。絵と同じ4つの吹き出しで、
    「定期便」が2つに当たる（いま見ている当たり＝太い枠・ほか＝薄い枠）。
  */
  'friend-0': [
    {
      id: 'msg-k1', friendId: 'friend-0', direction: 'incoming', messageType: 'text',
      content: '秋の新商品はいつ届きますか？定期便に追加できますか？', createdAt: '2026-08-19T01:12:00.000Z',
      broadcastId: null, scenarioStepId: null, source: 'line', scenarioName: null, sentByStaffName: null,
    },
    {
      id: 'msg-k2', friendId: 'friend-0', direction: 'outgoing', messageType: 'text',
      content: 'お問い合わせありがとうございます。秋の新商品は\n10月4日から発送します。定期便への追加は、このトークで『追加』と送っていただくだけで大丈夫です。', createdAt: '2026-08-19T01:20:00.000Z',
      broadcastId: null, scenarioStepId: null, source: 'manual', scenarioName: null, sentByStaffName: 'Kenta',
    },
    {
      id: 'msg-k3', friendId: 'friend-0', direction: 'incoming', messageType: 'text',
      content: 'ありがとうございます！では追加でお願いします🙏', createdAt: '2026-08-19T01:24:00.000Z',
      broadcastId: null, scenarioStepId: null, source: 'line', scenarioName: null, sentByStaffName: null,
    },
    {
      id: 'msg-k4', friendId: 'friend-0', direction: 'outgoing', messageType: 'text',
      content: 'ご注文の追加を受け付けました。10月4日の発送分に入ります。（このメッセージは自動で送っています）', createdAt: '2026-08-19T01:24:30.000Z',
      broadcastId: null, scenarioStepId: null, source: 'auto_reply', scenarioName: null, sentByStaffName: null,
    },
  ],
  'friend-1': [
    {
      id: 'msg-1', friendId: 'friend-1', direction: 'incoming', messageType: 'text',
      content: '登録しました！', createdAt: '2026-08-13T05:16:00.000Z',
      broadcastId: null, scenarioStepId: null,
      source: 'line', scenarioName: null, sentByStaffName: null,
    },
    {
      id: 'msg-2', friendId: 'friend-1', direction: 'outgoing', messageType: 'text',
      content: 'シナリオ「友だち挨拶」を開始', createdAt: '2026-08-13T05:18:00.000Z',
      broadcastId: null, scenarioStepId: 'step-1',
      source: 'scenario', scenarioName: '友だち挨拶', sentByStaffName: null,
    },
    {
      id: 'msg-3', friendId: 'friend-1', direction: 'outgoing', messageType: 'text',
      content: 'テスト', createdAt: '2026-08-13T10:20:00.000Z',
      broadcastId: null, scenarioStepId: null,
      source: 'manual', scenarioName: null, sentByStaffName: '見本',
    },
  ],
}

/**
 * 友だちのマイル。設計 `xGLVe` の右パネル「利用可能 2,450 mile」。
 *
 * **`summary` を返さないと画面ごと落ちる**（`summary.programName` を読む）。
 * 空の一覧で返していたあいだ、会話を開くたびに「もう一度試す」だけの
 * 画面になっていた。
 */
export const FRIEND_MILEAGE = {
  summary: {
    programId: 'mile-default',
    programName: 'NENマイル',
    available: 2450,
    pending: 0,
    lifetimeEarned: 2450,
    spent: 0,
  },
  history: [],
  /*
    **`insights` と `connections` を欠かさない。**

    口の契約は `{ summary, history, insights, connections }` の4つ。
    `insights` が無いと `mileage/friends/detail/page.tsx` が
    `insights.rewardedActions` で投げ、**画面ごと「画面を表示できませんでした」
    になって `HIU5O` と `vz0Ji` が1枚も撮れない。**
    型に無い名前で書いても握りつぶされるだけなので、`MileageSelfInsights` と
    `MileageConnectedAccount` の名前をそのまま使う。
  */
  insights: {
    accountCount: 1,
    rewardedActions: 3,
    referralMiles: 0,
    qualityReferralCount: 0,
    lastEarnedAt: '2026-08-24T20:53:00+09:00',
  },
  connections: [
    {
      accountId: 'visual-qa-account',
      accountName: '画面確認アカウント',
      friendId: 'friend-1',
      available: 5,
      lastEarnedAt: '2026-08-24T20:53:00+09:00',
    },
  ],
}

/**
 * 会話を開いたときの右パネル。設計 `xGLVe` の「顧客情報」そのまま。
 *
 * **`tags` と `formSubmissions` は必ず配列で返す。** 一覧の口が返す
 * `{items,total,page,limit}` のままだと `friend.tags.length` で落ち、
 * 会話を開くたびに「もう一度試す」だけの画面になっていた。
 */
export const FRIEND_DETAILS = {
  /*
   * 受信箱で最初に開く会話（Kyohei Yamamoto・chat-0）の右の欄（★V8 M0393 XqSvX「その人の要点」）。
   * 無いと右の欄が「名前なし・友だち追加日は未登録・ブロック済」になり、絵と並べられない。
   */
  'friend-0': {
    id: 'friend-0',
    // 実口 GET /api/friends/:id と同じく所属アカウントを返す。無いと受信箱が「別アカウントの相手」と判断して会話を開かない(#673)。
    lineAccountId: 'visual-qa-account',
    displayName: 'Kyohei Yamamoto',
    systemDisplayName: 'Kyohei Yamamoto',
    realName: '山本 恭平',
    pictureUrl: null,
    isFollowing: true,
    createdAt: '2025-08-13T15:00:00.000Z',
    metadata: {},
    tags: [
      { id: 'friend-tag-teiki-proposal', name: '定期便の提案', color: '#8B938D', createdAt: '2025-08-14T00:00:00.000Z' },
      { id: 'friend-tag-uncontracted', name: '未契約', color: '#8B938D', createdAt: '2025-08-14T00:00:00.000Z' },
    ],
    formSubmissions: [],
    formSubmissionTotal: 0,
  },
  'friend-1': {
    id: 'friend-1',
    // 実口 GET /api/friends/:id と同じく所属アカウントを返す。無いと受信箱が「別アカウントの相手」と判断して会話を開かない(#673)。
    lineAccountId: 'visual-qa-account',
    displayName: 'Demo Person (Obama)',
    systemDisplayName: 'Demo Person (Obama)',
    realName: '見本 太郎',
    pictureUrl: null,
    isFollowing: true,
    createdAt: '2026-08-13T00:00:00.000Z',
    metadata: {},
    tags: [
      // 友だち詳細（★V8 JCDRm）のタグ欄は短い札3つで1行。長い名前だと2行に折れて下が全部ずれる。
      { id: 'friend-tag-vip', name: 'VIP', color: '#8B938D', createdAt: '2026-08-13T00:00:00.000Z' },
      { id: 'friend-tag-teiki', name: '定期便', color: '#8B938D', createdAt: '2026-08-13T00:00:00.000Z' },
      { id: 'friend-tag-member', name: 'NEN会員', color: '#8B938D', createdAt: '2026-08-13T00:00:00.000Z' },
    ],
    formSubmissions: [],
    formSubmissionTotal: 2,
    // 友だち詳細の札・担当・メモ（JCDRm）。無いと「やり取りなし」になり、メモ欄が1行になる。
    support: { status: 'resolved', operatorName: 'Kenta', notes: '定期便を月2回。秋の新商品に興味あり（9/20 の問い合わせより）。' },
  },
}

/**
 * テンプレートの置き場。設計 `v19Ivv`（一覧）の件数そのまま。
 * 未分類7・お問い合わせ8・予約6・EC5で計26件。
 */
export const TEMPLATE_FOLDERS = [
  ['tf-inquiry', 'お問い合わせ', 8],
  ['tf-booking', '予約', 6],
  ['tf-ec', 'EC', 5],
].map(([id, name, count], index) => ({
  id: String(id),
  kind: 'template',
  name: String(name),
  parentId: null,
  displayOrder: index,
  color: null,
  createdAt: '2026-01-13T00:00:00.000Z',
  updatedAt: '2026-01-13T00:00:00.000Z',
  templateCount: Number(count),
}))

/**
 * テンプレート26件。**件数はフォルダの数に合わせる。**
 * 合わないと、フォルダの脇に出る数と一覧の行数が食い違う。
 *
 * 先頭6件は設計 `v19Ivv` の一覧の6行そのまま（名前・種類・公開・使っている所・今月・更新）。
 * 数の帯は 26件・未公開の変更2件・使っていない5件・今月 8,420通 になるようにしてある
 * （下書きだけの「秋の新商品（画像）」は送れないので送信数0、一覧では「—」。使っている所の合計は 90。絵の 84 は残り20件が1か所ずつでも届かない数なので、桁だけそろえた）。
 */
export const TEMPLATES = (() => {
  const FOLDER_LABEL = { 'tf-inquiry': 'お問い合わせ', 'tf-booking': '予約', 'tf-ec': 'EC' }
  const TOP = [
    { name: '初回お問い合わせへの返信', folderId: 'tf-inquiry', messageType: 'text', messageContent: 'ご連絡ありがとうございます。以下の内容をご確認ください。', usage: 38, sends: [1240, 18300], updatedAt: '2026-08-22T09:20:00.000Z' },
    { name: '予約前日のご案内', folderId: 'tf-booking', messageType: 'text', messageContent: '{{name}}さん、こんにちは。\n明日 {{date}} にご予約をいただいています。\n変更・キャンセルは下のリンクからお願いします。', usage: 11, sends: [1860, 31400], updatedAt: '2026-08-21T09:02:00.000Z', hasDraft: true },
    { name: '発送完了のお知らせ', folderId: 'tf-ec', messageType: 'text', messageContent: 'ご注文の商品を発送しました。お届けまで今しばらくお待ちください。', usage: 10, sends: [480, 9720] },
    { name: '定期便 初回のご案内', folderId: null, messageType: 'flex', messageContent: JSON.stringify({ type: 'bubble', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: '{名前}さん、いつもありがとうございます。初回のお届けについてご案内します。' }] } }), usage: 6, sends: [210, 3040] },
    { name: '秋の新商品（画像）', folderId: null, messageType: 'image', messageContent: JSON.stringify({ originalContentUrl: 'https://example.com/autumn.jpg', previewImageUrl: 'https://example.com/autumn.jpg' }), usage: 0, sends: [0, 0], updatedAt: '2026-09-30T10:00:00.000Z', draftOnly: true },
    { name: '折り返しのご案内', folderId: 'tf-inquiry', messageType: 'text', messageContent: '担当から折り返しご連絡します。少々お待ちください。', usage: 9, sends: [640, 5880] },
  ]
  // 残り20件：お問い合わせ6・予約5・EC4・未分類5。使っている所は1か所ずつ、4件だけ0（使っていない）。
  const restFolders = [
    ...Array(6).fill('tf-inquiry'), ...Array(5).fill('tf-booking'), ...Array(4).fill('tf-ec'), ...Array(5).fill(null),
  ]
  const bookingNames = ['予約確定のお知らせ', '予約変更のご案内', '来店後フォロー']
  // 残りの今月の送信数（合計 3,990。先頭6件の 4,430 と合わせて 8,420）。
  const restSends = [320, 300, 280, 260, 250, 240, 230, 220, 210, 200, 190, 180, 170, 160, 150, 140, 130, 120, 110, 130]
  const rows = TOP.map((t, n) => ({ ...t, n }))
  const counters = {}
  restFolders.forEach((folderId, i) => {
    const key = folderId ?? 'none'
    counters[key] = (counters[key] ?? 0) + 1
    const label = folderId ? FOLDER_LABEL[folderId] : '未分類'
    const name = folderId === 'tf-booking' && counters[key] <= bookingNames.length
      ? bookingNames[counters[key] - 1]
      : `${label}のひな形 ${counters[key]}`
    rows.push({
      n: 6 + i,
      name,
      folderId,
      messageType: 'text',
      messageContent: `${label}のご連絡です。内容をご確認ください。`,
      usage: i >= 16 ? 0 : 1,
      sends: [restSends[i], restSends[i] * 12],
      // 未公開の変更は先頭の「予約前日のご案内」とこの1件の計2件。
      hasDraft: i === 3,
    })
  })
  return rows.map((t) => ({
    id: `template-${t.n}`,
    name: t.name,
    /* 分類は分類名にする。説明文を入れると画面の分類欄が説明文になる。 */
    category: t.folderId ? FOLDER_LABEL[t.folderId] : '未分類',
    messageType: t.messageType,
    messageContent: t.messageContent,
    folderId: t.folderId,
    /* 本物の口は質問・質問状態・置き場を必ず返す。無いと絞り・バッジの確認ができない。 */
    question: null,
    questionStatus: 'published',
    usageCount: t.usage,
    tapCount: 0,
    monthlySendCount: t.sends[0],
    totalSendCount: t.sends[1],
    createdAt: '2026-01-13T00:00:00.000Z',
    updatedAt: t.updatedAt ?? '2026-01-13T00:00:00.000Z',
    /* 公開の札（公開中・未公開の変更・下書きだけ）。本物の口は公開日時と下書きの有無を返す。 */
    publishedAt: t.draftOnly ? null : '2026-01-13T00:00:00.000Z',
    hasDraft: Boolean(t.hasDraft || t.draftOnly),
  }))
})()

/** テスト送信先。設計 `h0kahp` のLINE連携済み2人。 */
export const TEMPLATE_TEST_RECIPIENTS = [
  { id: 'friend-test-kenta', displayName: 'Demo Person', pictureUrl: null },
  { id: 'friend-test-masato', displayName: 'Masato S.', pictureUrl: null },
]

/**
 * 受信箱の保存した検索。設計 `ASsb3`（2-13 保存した検索を開く）の並び。
 *
 * **空で返すと、同じ名前かどうかを確かめられない。** 2-17（重複エラー）は
 * すでにある名前を打ったときの絵なので、既存が0件だと「保存しました」に
 * なってしまう。実際そうなった。
 */
/**
 * 受信箱の保存した検索（設計 `ASsb3`）。
 *
 * **友だち側の `{all,any}` とは別の形。** 受信箱は軸ごとに値を持つ。
 * 前はここに `{ all: [], any: [] }` を入れていたので、
 * 名前の下の要約が全部「絞り込みなし」になっていた。
 *
 * 名前と中身は設計の3件をそのまま置く。
 */
const INBOX_VIEW_CONDITIONS = {
  version: 1,
  query: '',
  channels: [],
  statuses: [],
  assignees: [],
  unread: 'all',
  messageTypes: [],
  receivedFrom: null,
  receivedTo: null,
  sort: 'newest',
}

/*
  **1件だけ古い形のまま残す。**

  保存した検索の仕組みは受信箱より前からあり、古い行は友だち側と同じ
  `{ all: [], any: [] }` の形で入っている。3件とも新しい形にすると、
  **古い行を開くと受信箱ごと落ちる**という起きた不具合を二度と踏めない。
  画面はこれを「絞り込みなし」として開く。
*/
const LEGACY_VIEW_CONDITIONS = { all: [], any: [] }

export const INBOX_SAVED_VIEWS = [
  ['未対応・期限超過', true, { statuses: ['unread'], sort: 'waiting_desc' }, 1],
  ['Kenta 担当の未対応', true, { statuses: ['unread'], assignees: ['operator-kenta'] }, 3],
  ['LINEからの新着', false, null, 5],
].map(([name, isShared, patch, matchCount], index) => ({
  id: `inbox-view-${index}`,
  name: String(name),
  scope: 'chats',
  conditions: patch ? { ...INBOX_VIEW_CONDITIONS, ...patch } : LEGACY_VIEW_CONDITIONS,
  createdBy: 'Kenta',
  lineAccountId: 'visual-qa-account',
  isShared: Boolean(isShared),
  matchCount: Number(matchCount),
  displayOrder: index,
  createdAt: '2026-08-17T03:00:00.000Z',
}))

/**
 * 機能4「保存した検索」。設計 `QKx8Q` の先頭5行と、編集画面 `XBkiQ` の
 * `ss-1` を同じデータで開く。使用先と該当人数を省かず、0件と未取得を混ぜない。
 */
export const FRIEND_ATTRIBUTE_SAVED_SEARCHES = [
  {
    id: 'ss-1', name: 'VIPかつ未契約', scope: 'friends',
    conditions: {
      all: [
        { kind: 'tag', op: 'includes', value: 'tag-vip' },
        { kind: 'tag', op: 'includes', value: 'tag-4' },
      ],
      any: [], visibility: 'visible_only',
      description: 'VIPだが契約していない人への案内用',
      list: { columns: ['名前', 'タグ', '担当者'], sort: 'recent', limit: 20 },
    },
    createdBy: 'Kenta', lineAccountId: 'visual-qa-account', isShared: true,
    displayOrder: 0, createdAt: '2026-08-20T19:20:00+09:00', matchCount: 18,
    usedIn: [
      { kind: 'broadcast', id: 'broadcast-vip', name: 'VIP未契約案内', mode: 'live', lastUsedAt: '2026-08-20T19:20:00+09:00' },
      { kind: 'automation', id: 'automation-follow', name: '3日後フォロー', mode: 'live', lastUsedAt: '2026-08-20T19:20:00+09:00' },
    ],
    canDelete: false, callCountThisMonth: 31,
  },
  {
    id: 'ss-2', name: '誕生日30日前', scope: 'friends',
    conditions: { all: [{ kind: 'field', key: 'birthday', op: 'eq', value: '今日から30日以内' }], any: [], visibility: 'visible_only' },
    createdBy: 'Kenta', lineAccountId: 'visual-qa-account', isShared: false,
    displayOrder: 1, createdAt: '2026-08-20T18:10:00+09:00', matchCount: 12,
    usedIn: [{ kind: 'other', id: 'reminder-birthday', name: '誕生日のお知らせ', mode: 'live', lastUsedAt: '2026-08-20T18:10:00+09:00' }],
    canDelete: false, callCountThisMonth: 18,
  },
  {
    id: 'ss-3', name: '未対応・担当なし', scope: 'friends',
    conditions: { all: [{ kind: 'mark', op: 'eq', value: 'mark-default' }], any: [], visibility: 'visible_only' },
    createdBy: 'Kenta', lineAccountId: 'visual-qa-account', isShared: true,
    displayOrder: 2, createdAt: '2026-08-19T20:05:00+09:00', matchCount: 11,
    usedIn: [{ kind: 'other', id: 'inbox-unassigned', name: '受信箱', mode: 'live', lastUsedAt: '2026-08-19T20:05:00+09:00' }],
    canDelete: false, callCountThisMonth: 14,
  },
  {
    id: 'ss-4', name: '購入者または予約者', scope: 'friends',
    conditions: { all: [], any: [{ kind: 'tag', op: 'includes', value: 'tag-purchase' }], visibility: 'visible_only' },
    createdBy: 'Masato', lineAccountId: 'visual-qa-account', isShared: true,
    displayOrder: 3, createdAt: '2026-08-18T14:30:00+09:00', matchCount: 42,
    usedIn: [
      { kind: 'broadcast', id: 'broadcast-purchase-1', name: '購入者へのご案内', mode: 'fixed', lastUsedAt: '2026-08-18T14:30:00+09:00' },
      { kind: 'broadcast', id: 'broadcast-purchase-2', name: '予約者へのご案内', mode: 'fixed', lastUsedAt: '2026-08-18T14:30:00+09:00' },
      { kind: 'broadcast', id: 'broadcast-purchase-3', name: '来店前のお知らせ', mode: 'fixed', lastUsedAt: '2026-08-18T14:30:00+09:00' },
    ],
    canDelete: false, callCountThisMonth: 12,
  },
  {
    id: 'ss-5', name: '離脱注意', scope: 'friends',
    conditions: {
      all: [
        { kind: 'created_at', op: 'between', value: { to: '2026-06-18' } },
        { kind: 'following', op: 'eq', value: true },
      ],
      any: [], visibility: 'visible_only',
    },
    createdBy: 'Kenta', lineAccountId: 'visual-qa-account', isShared: false,
    displayOrder: 4, createdAt: '2026-08-17T11:22:00+09:00', matchCount: 0,
    usedIn: [], canDelete: true, callCountThisMonth: 9,
  },
].map((search, index) => ({
  ...search,
  conditionFormat: 'search_v1',
  updatedBy: search.createdBy,
  updatedAt: search.createdAt,
  revision: [3, 1, 2, 5, 1][index],
  matchCountError: null,
  usedIn: search.usedIn.map((reference, referenceIndex) => ({
    ...reference,
    revision: [3, 1, 2, 5, 1][index],
    callCountThisMonth: Math.max(1, 3 - referenceIndex),
  })),
}))

/** 一覧・詳細・事前確認を、統合96の保存検索契約と同じ階層で返す。 */
export const FRIEND_ATTRIBUTE_SAVED_SEARCH_RESPONSE = {
  success: true,
  data: FRIEND_ATTRIBUTE_SAVED_SEARCHES,
  items: FRIEND_ATTRIBUTE_SAVED_SEARCHES,
  summary: { total: 12, usedInBroadcasts: 5, zeroMatches: 2, callsThisMonth: 84 },
  pagination: { total: 12, limit: 20, cursor: '0', nextCursor: null },
}

export const FRIEND_ATTRIBUTE_SAVED_SEARCH_DETAIL = {
  ...FRIEND_ATTRIBUTE_SAVED_SEARCHES[0],
  accountScope: { type: 'line_account', id: 'visual-qa-account' },
  owner: { id: 'visual-qa-owner', isCurrentUser: true },
  match: {
    total: 18,
    byChannel: { line: 15, mail: 3 },
    calculatedAt: '2026-09-07T04:48:00+09:00',
    error: null,
  },
}

/*
  対応マーク（設計 `rIhbN` 4-3、`GMvBd` 4-3-A）。

  **「保留」を必ず入れる。** 撮影の手順が「保留」を押して編集画面へ進む。
  行が無いと押しどころが描かれず、4-3-A が1枚も撮れない
  （kentavndng/line-harness-board#105 に挙げていた欠け）。
*/
const SUPPORT_MARK_BASE = [
  {
    id: 'mark-default', name: '未対応', color: '#F59E0B', isDefault: true,
    autoOnInbound: true, displayOrder: 0, createdAt: '2026-01-01T00:00:00.000Z',
    isInherited: false, friendCount: 23, automaticChangeLabel: '受信時・期限超過',
    usedIn: { broadcasts: 1, scenarios: 0, autoReplies: 1, savedSearches: 1, automations: 1 },
  },
  {
    id: 'mark-in-progress', name: '対応中', color: '#3B82F6', isDefault: false,
    autoOnInbound: false, displayOrder: 1, createdAt: '2026-01-02T00:00:00.000Z',
    isInherited: false, friendCount: 19, automaticChangeLabel: '担当者割当時',
    usedIn: { broadcasts: 0, scenarios: 0, autoReplies: 0, savedSearches: 0, automations: 1 },
  },
  {
    id: 'mark-resolved', name: '対応済み', color: '#10B981', isDefault: false,
    autoOnInbound: false, displayOrder: 2, createdAt: '2026-01-03T00:00:00.000Z',
    isInherited: false, friendCount: 186, automaticChangeLabel: '手動・返信完了時',
    usedIn: { broadcasts: 1, scenarios: 0, autoReplies: 0, savedSearches: 0, automations: 0 },
  },
  {
    id: 'mark-hold', name: '保留', color: '#94A3B8', isDefault: false,
    autoOnInbound: false, displayOrder: 3, createdAt: '2026-01-04T00:00:00.000Z',
    isInherited: false, friendCount: 3, automaticChangeLabel: '条件一致時',
    usedIn: { broadcasts: 0, scenarios: 0, autoReplies: 0, savedSearches: 0, automations: 0 },
  },
]

/*
  対応マークの自動変更ルール。

  **止めているルールを1件混ぜる。** 全部動いていると、「動いています／
  止めています」の描き分けと、止めたものが実行順から外れて見えるかを
  一度も確かめられない。優先度も変えて、実行順の並びが出るようにする。
*/
export const SUPPORT_MARK_AUTOMATION_RULES = [
  {
    id: 'support-rule-assigned',
    name: '担当者が決まったら対応中へ',
    markId: 'mark-hold',
    event: 'staff_assigned',
    condition: null,
    priority: 100,
    manualProtectionMinutes: 60,
    isActive: true,
    version: 2,
    updatedAt: '2026-08-31T10:00:00+09:00',
  },
  {
    id: 'support-rule-overdue',
    name: '期限を過ぎたら確認待ちへ',
    markId: 'mark-hold',
    event: 'response_overdue',
    condition: { operator: 'AND', rules: [] },
    priority: 50,
    manualProtectionMinutes: 0,
    isActive: false,
    version: 1,
    updatedAt: '2026-08-30T15:00:00+09:00',
  },
]

export const SUPPORT_MARKS = SUPPORT_MARK_BASE.map((mark) => ({
  ...mark,
  updatedAt: mark.createdAt,
  version: 1,
  automationRules: SUPPORT_MARK_AUTOMATION_RULES.filter((rule) => rule.markId === mark.id),
  displayTargets: ['inbox', 'friend_list', 'friend_detail'],
}))

/** 統合96の GET /api/support-marks/:id/archive-impact と同じ器。 */
export const SUPPORT_MARK_ARCHIVE_IMPACT = {
  mark: {
    ...SUPPORT_MARKS.find((mark) => mark.id === 'mark-hold'),
    updatedAt: '2026-08-31T10:00:00+09:00',
    version: 1,
    automationRules: SUPPORT_MARK_AUTOMATION_RULES,
    displayTargets: ['inbox', 'friend_list', 'friend_detail'],
  },
  friendCount: 3,
  usedIn: { broadcasts: 0, scenarios: 0, autoReplies: 0, savedSearches: 0, automations: 0 },
  automationRules: SUPPORT_MARK_AUTOMATION_RULES,
  displayTargets: ['inbox', 'friend_list', 'friend_detail'],
  replacementOptions: SUPPORT_MARKS
    .filter((mark) => mark.id !== 'mark-hold' && !mark.isInherited)
    .map((mark) => ({ ...mark, updatedAt: mark.createdAt, version: 1, automationRules: [], displayTargets: ['inbox', 'friend_list', 'friend_detail'] })),
  canArchive: true,
  impactRevision: 'mark-hold:1:3:0:0:0:0:0',
  checkedAt: '2026-09-07T04:48:00+09:00',
  expectedVersion: 1,
}

/*
  リマインダの実行結果（設計 `GC4St` 7-1-H、要件 §3-7）。

  **成功だけを並べない。** 送信済み・配信予定・再試行待ち・送信失敗・
  送らなかったもの を1件ずつ入れて、状態の描き分けと「失敗した1通だけ
  再試行できる」を確かめられるようにする。

  **かかった時間が出せない行を混ぜる**（まだ始まっていない予定）。
  `durationMs` を0で埋めると「一瞬で終わった」と読めてしまう。
*/
const RUN_BASE = {
  ownerKind: 'reminder',
  ownerId: 'reminder-1',
  lineAccountId: 'visual-qa-account',
  accountLabel: '然-NEN-TEST',
  triggerLabel: '予約前日のお知らせ',
  reference: null,
  reminderId: 'reminder-1',
  friendReminderId: 'fr-1',
  reminderStepId: 'step-1',
}

export const REMINDER_RUNS = {
  reminder: {
    id: 'reminder-1', name: '予約前日のご案内', isActive: true,
    /** V8詳細（rbAig）はこの3つで「いまの状態」の札と操作を分ける。 */
    lifecycleStatus: 'published', stopConditions: null, hasPublishedVersion: true,
  },
  summary: {
    /* 板 `loVfW` の「いまの状態」：登録者186人・124通・今月386通・失敗2通。 */
    sent: 1126, scheduled: 398, stopped: 28, errors: 2,
    targetCount: 186, nextScheduledAt: '2026-08-24T09:00:00+09:00',
    /* V8詳細の「いまの状態」。`getReminderDeliveryRunSummary` の追加列と同じ意味。 */
    sentThisMonth: 386, scheduledNext7Days: 124,
  },
  /* 板 `rbAig`（概要）の通知2通。送った212通・失敗1通と174通・1通。
   * 届き方の見本は1通目の本文（`renderReminderBodySample` が読む）。 */
  steps: [
    {
      id: 'step-1', stepNumber: 1, offsetMinutes: -1440, messageType: 'text',
      messageContent: '明日10月2日(木)14:00からのご相談の案内です。時間になったら下のURLから参加してください。https://meet.google.com/abc-defg-hij',
      /** LINEは友だち単位の既読を返さない。**0%を作らない。** */
      sent: 212, openRate: null, errors: 1,
    },
    {
      id: 'step-2', stepNumber: 2, offsetMinutes: -60, messageType: 'text',
      messageContent: 'まもなく開始です。参加URLをもう一度お送りします。https://meet.google.com/abc-defg-hij',
      sent: 174, openRate: null, errors: 1,
    },
  ],
  /* 板 `rbAig` の最近の実行3行と、通知ごとの「次に送る」（`planned` の
   * 2件。概要は手順番号ごとの最早を拾う）。 */
  items: [
    {
      ...RUN_BASE, id: 'run-1', friendId: 'friend-hanako', friendName: '見本 122',
      stepNumber: 1, scheduledAt: '2026-09-30T18:00:00+09:00',
      startedAt: '2026-09-30T18:00:02+09:00', completedAt: '2026-09-30T18:00:03+09:00',
      occurredAt: '2026-09-30T18:00:03+09:00', subject: '見本 122',
      status: 'succeeded', domainStatus: 'succeeded', detail: '1通目',
      durationMs: 1200, attemptCount: 1, nextRetryAt: null,
      lastErrorCode: null, lastErrorMessage: null,
      lineRequestId: '0f3c2a8e-1b44-4f0a-9d21-77c0a1b2c3d4', messageLogId: 'log-1',
      canRetry: false,
    },
    {
      ...RUN_BASE, id: 'run-2', friendId: 'friend-ichiro', friendName: '見本 176',
      stepNumber: 1, scheduledAt: '2026-09-30T18:00:00+09:00',
      startedAt: '2026-09-30T18:00:02+09:00', completedAt: '2026-09-30T18:00:03+09:00',
      occurredAt: '2026-09-30T18:00:03+09:00', subject: '見本 176',
      status: 'failed', domainStatus: 'permanent_failed', detail: '1通目',
      durationMs: 900, attemptCount: 1, nextRetryAt: null,
      lastErrorCode: '400', lastErrorMessage: 'LINEが受け付けませんでした',
      lineRequestId: null, messageLogId: null,
      canRetry: true,
    },
    {
      ...RUN_BASE, id: 'run-3', friendId: 'friend-misaki', friendName: '見本 29',
      stepNumber: 2, scheduledAt: '2026-09-30T13:00:00+09:00',
      startedAt: '2026-09-30T13:00:02+09:00', completedAt: '2026-09-30T13:00:03+09:00',
      occurredAt: '2026-09-30T13:00:03+09:00', subject: '見本 29',
      status: 'succeeded', domainStatus: 'succeeded', detail: '2通目',
      durationMs: 900, attemptCount: 1, nextRetryAt: null,
      lastErrorCode: null, lastErrorMessage: null,
      lineRequestId: null, messageLogId: null,
      canRetry: false,
    },
    {
      ...RUN_BASE, id: 'run-4', friendId: 'friend-hanako', friendName: '見本 122',
      stepNumber: 1, scheduledAt: '2026-10-01T18:00:00+09:00',
      startedAt: null, completedAt: null,
      occurredAt: '2026-10-01T18:00:00+09:00', subject: '見本 122',
      status: 'planned', domainStatus: 'planned', detail: '1通目',
      durationMs: null, attemptCount: 0, nextRetryAt: null,
      lastErrorCode: null, lastErrorMessage: null,
      lineRequestId: null, messageLogId: null,
      canRetry: false,
    },
    {
      ...RUN_BASE, id: 'run-5', friendId: 'friend-misaki', friendName: '見本 29',
      stepNumber: 2, scheduledAt: '2026-10-02T13:00:00+09:00',
      startedAt: null, completedAt: null,
      occurredAt: '2026-10-02T13:00:00+09:00', subject: '見本 29',
      status: 'planned', domainStatus: 'planned', detail: '2通目',
      durationMs: null, attemptCount: 0, nextRetryAt: null,
      lastErrorCode: null, lastErrorMessage: null,
      lineRequestId: null, messageLogId: null,
      canRetry: false,
    },
  ],
  pagination: { total: 5, limit: 20, offset: 0 },
}

// 友だち一括操作。画面側はこの応答契約を使う。
// 0件と未取得を混ぜないため、通常・空・失敗は同じ配列の増減ではなく
// API状態として切り替える。ここには「取得できた通常値」だけを置く。
export const FRIEND_BULK_RUN = {
  preview: {
    selectedCount: 4,
    targetCount: 3,
    excludedCount: 1,
    accountBreakdown: [{ lineAccountId: 'visual-qa-account', count: 3 }],
    exclusions: [{ reason: 'LINEの友だちではないため対象外', count: 1 }],
    sample: FRIENDS.slice(0, 3).map((item) => ({
      friendId: item.id,
      displayName: item.displayName,
      pictureUrl: item.pictureUrl,
      lineAccountId: item.lineAccountId,
    })),
    reversible: true,
  },
  detail: {
    id: 'friend-bulk-run-1',
    status: 'partial',
    selection: { kind: 'explicit', friendIds: FRIENDS.slice(0, 4).map((item) => item.id) },
    operation: { kind: 'add_tag', tagId: 'tag-0' },
    targetCount: 3,
    excludedCount: 1,
    successCount: 2,
    skippedCount: 0,
    temporaryFailureCount: 1,
    permanentFailureCount: 0,
    reversible: true,
    scheduledAt: null,
    createdAt: '2026-08-31T01:00:00.000Z',
    startedAt: '2026-08-31T01:00:01.000Z',
    completedAt: '2026-08-31T01:00:03.000Z',
    updatedAt: '2026-08-31T01:00:03.000Z',
    page: 1,
    limit: 50,
    total: 3,
    items: FRIENDS.slice(0, 3).map((item, index) => ({
      id: `friend-bulk-item-${index + 1}`,
      friendId: item.id,
      displayName: item.displayName,
      pictureUrl: item.pictureUrl,
      lineAccountId: item.lineAccountId,
      status: index === 2 ? 'temporary_failure' : 'success',
      attemptCount: 1,
      errorMessage: index === 2 ? '時間をおいて、もう一度お試しください' : null,
      retryAt: null,
      completedAt: '2026-08-31T01:00:03.000Z',
    })),
  },
}

/**
 * `InCDe`（友だち同士）と `ELayY`（EC会員と友だち）が共有する本人照合契約。
 * 値はすべて作り物で、メール・電話は必ずマスクする。
 */
const IDENTITY_CONFIDENCE = { score: 92, label: 'very_high' }
const IDENTITY_FRIEND_LEFT = {
  kind: 'friend', id: 'friend-identity-left', label: '見本 161', detail: '支店',
  lineAccountId: 'visual-qa-account', lineAccountName: '画面確認アカウント', shopKey: null,
  attributes: [
    { label: 'メールアドレス', valuePreview: 'ta***@example.com', verified: true },
    { label: '電話番号', valuePreview: '090-****-0001', verified: true },
  ],
}
const IDENTITY_FRIEND_RIGHT = {
  kind: 'friend', id: 'friend-identity-right', label: '見本 171', detail: '本店',
  lineAccountId: 'visual-qa-account', lineAccountName: '画面確認アカウント', shopKey: null,
  attributes: [
    { label: 'メールアドレス', valuePreview: 'ta***@example.com', verified: true },
    { label: '電話番号', valuePreview: '090-****-0001', verified: true },
  ],
}
const IDENTITY_EVIDENCE = [
  {
    key: 'verified_email', label: '確認済みのメールアドレスが同じ', strength: 'strong',
    verified: true, valuePreview: 'ta***@example.com',
  },
  {
    key: 'similar_name', label: '表示名が似ている', strength: 'weak',
    verified: false, valuePreview: null,
  },
]

export const IDENTITY_CANDIDATE_FRIEND = {
  id: 'identity-friend-1', kind: 'friend_duplicate', status: 'pending', version: 1,
  confidence: IDENTITY_CONFIDENCE, left: IDENTITY_FRIEND_LEFT, right: IDENTITY_FRIEND_RIGHT,
  evidence: IDENTITY_EVIDENCE,
  profileCandidates: [
    {
      fieldKey: 'display_name', fieldLabel: 'LINE表示名',
      options: [
        {
          sourceFriendId: 'friend-identity-left', sourceLabel: '見本 161',
          valuePreview: '見本 161', verified: false,
        },
        {
          sourceFriendId: 'friend-identity-right', sourceLabel: '見本 171',
          valuePreview: '見本 171', verified: false,
        },
      ],
    },
    {
      fieldKey: 'metadata.email', fieldLabel: 'メールアドレス',
      options: [
        {
          sourceFriendId: 'friend-identity-left', sourceLabel: '見本 161',
          valuePreview: 'ta***@example.com', verified: false,
        },
        {
          sourceFriendId: 'friend-identity-right', sourceLabel: '見本 171',
          valuePreview: 'ta***@example.com', verified: false,
        },
      ],
    },
  ],
  tagCandidates: [
    {
      id: 'tag-nen-member', name: 'NEN会員', color: '#2f855a',
      sourceFriendIds: ['friend-identity-left', 'friend-identity-right'],
    },
    {
      id: 'tag-follow-up', name: '要フォロー', color: '#d97706',
      sourceFriendIds: ['friend-identity-left'],
    },
  ],
  impact: [
    { key: 'duplicate_deliveries', label: '重複配信', value: 3, unit: '通', note: null },
    { key: 'orders', label: '注文', value: null, unit: '件', note: '取得元を接続後に表示' },
  ],
  history: [], detectedAt: '2026-08-30T10:00:00.000Z', reviewedAt: null,
  canDecide: true, canUndo: false, undoNote: '判定を取り消すと、根拠を確認する候補へ戻ります。',
}

/** ★V8 比べて決める fcg2D：友だち同士の詳細（/api/friends/duplicates/:id）。判定の履歴を1件持つ。 */
export const FRIEND_DUPLICATE_DETAIL = {
  ...IDENTITY_CANDIDATE_FRIEND,
  left: { ...IDENTITY_CANDIDATE_FRIEND.left, detail: '支店' },
  right: { ...IDENTITY_CANDIDATE_FRIEND.right, detail: '本店' },
  history: [
    {
      id: 'identity-history-1', fromStatus: 'pending', toStatus: 'deferred', actorName: 'Kenta',
      reason: '本人に確認中', decidedAt: '2026-09-30T01:12:00.000Z', reprocessMode: null,
    },
  ],
  detectedAt: '2026-09-28T09:40:00.000Z',
}

export const IDENTITY_CANDIDATE_EC = {
  ...IDENTITY_CANDIDATE_FRIEND,
  id: 'identity-ec-1', kind: 'ec_member',
  left: {
    kind: 'ec_event', id: 'event-identity-1', label: '注文 NEN-1001', detail: '2026/08/30',
    lineAccountId: 'visual-qa-account', lineAccountName: '画面確認アカウント', shopKey: 'shop-a',
    attributes: [
      { label: 'メールアドレス', valuePreview: 'ta***@example.com', verified: true },
      { label: '電話番号', valuePreview: '090-****-0001', verified: true },
    ],
  },
  impact: [
    { key: 'orders', label: '結び付く注文', value: 24, unit: '件', note: null },
    { key: 'past_messages', label: '過去のLINE送信', value: 0, unit: '通', note: '再送しません' },
  ],
}

function identityListItem(candidate) {
  return {
    id: candidate.id, kind: candidate.kind, status: candidate.status, version: candidate.version,
    confidence: candidate.confidence, left: candidate.left, right: candidate.right,
    evidenceSummary: candidate.evidence.map((item) => item.label),
    detectedAt: candidate.detectedAt, reviewedAt: candidate.reviewedAt,
  }
}

export const IDENTITY_CANDIDATE_LISTS = {
  /*
   * ★V8 重複検出 hn6Y8・G9C4Uw：候補3組（最高・高・低）、根拠とアカウントは絵の文。
   * 数の帯は statusCounts（未確認11・保留2・結び付けた5 ＝18組）と lowConfidenceCount（2組）から出す。
   */
  friend_duplicate: {
    items: [
      {
        ...identityListItem(IDENTITY_CANDIDATE_FRIEND),
        left: { ...IDENTITY_CANDIDATE_FRIEND.left, lineAccountName: '支店' },
        right: { ...IDENTITY_CANDIDATE_FRIEND.right, lineAccountName: '本店' },
        evidenceSummary: ['確認済みのメールが同じ'],
      },
      {
        ...identityListItem({
          ...IDENTITY_CANDIDATE_FRIEND,
          id: 'identity-friend-2', status: 'pending',
          confidence: { ...IDENTITY_CANDIDATE_FRIEND.confidence, label: 'high', score: 78 },
          left: { ...IDENTITY_CANDIDATE_FRIEND.left, label: '見本 141', lineAccountName: '公式A' },
          right: { ...IDENTITY_CANDIDATE_FRIEND.right, label: 'Yamada', lineAccountName: '然-NEN-TEST' },
        }),
        evidenceSummary: ['電話番号が同じ'],
      },
      {
        ...identityListItem({
          ...IDENTITY_CANDIDATE_FRIEND,
          id: 'identity-friend-3', status: 'deferred',
          confidence: { ...IDENTITY_CANDIDATE_FRIEND.confidence, label: 'low', score: 42 },
          left: { ...IDENTITY_CANDIDATE_FRIEND.left, label: 'テスト太郎', lineAccountName: 'EC' },
          right: { ...IDENTITY_CANDIDATE_FRIEND.right, label: 'test', lineAccountName: 'MAIL配信' },
        }),
        evidenceSummary: ['表示名が似ている（参考）'],
      },
    ], total: 18, limit: 20, offset: 0,
    statusCounts: { pending: 11, deferred: 2, linked: 5, different: 0 },
    lowConfidenceCount: 2,
  },
  /*
   * ★V8-B w1W8h：会員のつき合わせの3組（高い・中くらい・候補なし）。id は EC運用の集計（EC_IDENTITY_CANDIDATES）と同じにして、
   * 1行目の下の行に「注文 3件 ¥18,600」が出るようにする。
   */
  ec_member: {
    items: [
      {
        ...identityListItem(IDENTITY_CANDIDATE_EC), id: 'ec-identity-1',
        confidence: { score: 94, label: 'high' },
        left: { ...IDENTITY_CANDIDATE_EC.left, label: '見本 16', detail: 'EC-10422' },
        right: { ...IDENTITY_CANDIDATE_EC.right, label: '高橋 なおと', detail: '友だち追加 9/12' },
        evidenceSummary: ['姓', '郵便番号', 'ペット名「もも」'],
      },
      {
        ...identityListItem(IDENTITY_CANDIDATE_EC), id: 'ec-identity-2',
        confidence: { score: 82, label: 'medium' },
        left: { ...IDENTITY_CANDIDATE_EC.left, label: '佐藤 由美', detail: 'EC-10398' },
        right: { ...IDENTITY_CANDIDATE_EC.right, label: 'ゆみ🐶', detail: '友だち追加 8/30' },
        evidenceSummary: ['ペット名「きなこ」', '地域'],
      },
      {
        ...identityListItem(IDENTITY_CANDIDATE_EC), id: 'ec-identity-3',
        confidence: { score: 0, label: 'low' },
        left: { ...IDENTITY_CANDIDATE_EC.left, label: '見本 27', detail: 'EC-10377' },
        right: { ...IDENTITY_CANDIDATE_EC.right, label: '', detail: null },
        evidenceSummary: [],
      },
    ], total: 3, limit: 20, offset: 0,
  },
  empty: { items: [], total: 0, limit: 20, offset: 0 },
}

export const IDENTITY_CANDIDATE_ERROR = {
  success: false, error: '本人照合の候補を読み込めませんでした', code: 'VISUAL_QA_ERROR',
}

/** `w8W4Eh` 統合ユーザー詳細。平文のメール・電話は置かない。 */
export const MERGED_PERSON_DETAIL = {
  id: 'merged-person-1', status: 'active', revision: 4, primaryDisplayName: '見本 171',
  linkedFriends: [
    {
      friendId: 'friend-identity-right', displayName: '見本 171',
      lineAccountId: 'visual-qa-account', lineAccountName: '本店', isFollowing: true,
      linkedAt: '2026-08-28T10:00:00.000Z', linkMethod: 'operator_review', confidence: 92,
      candidateId: 'identity-friend-1', candidateVersion: 2,
    },
    {
      friendId: 'friend-identity-left', displayName: '見本 161',
      lineAccountId: 'visual-qa-account-sub', lineAccountName: '支店', isFollowing: true,
      linkedAt: '2026-08-28T10:00:00.000Z', linkMethod: 'operator_review', confidence: 92,
      candidateId: 'identity-friend-1', candidateVersion: 2,
    },
  ],
  profileValues: [
    {
      fieldKey: 'email', fieldLabel: 'メールアドレス', valuePreview: 'ta***@example.com',
      sourceType: 'form', sourceLabel: '来店アンケート', sourceFriendId: 'friend-identity-right',
      verifiedAt: '2026-08-28T09:00:00.000Z', selectedByName: '画面確認',
      selectedAt: '2026-08-28T10:10:00.000Z', updateMode: 'fixed',
    },
    {
      fieldKey: 'phone', fieldLabel: '電話番号', valuePreview: '090-****-0001',
      sourceType: 'friend_field', sourceLabel: '支店の友だち情報',
      sourceFriendId: 'friend-identity-left', verifiedAt: null, selectedByName: '画面確認',
      selectedAt: '2026-08-28T10:12:00.000Z', updateMode: 'auto',
    },
  ],
  profileCandidates: IDENTITY_CANDIDATE_FRIEND.profileCandidates,
  tagCandidates: IDENTITY_CANDIDATE_FRIEND.tagCandidates,
  deliveryPriorities: [
    {
      purpose: 'broadcast', friendId: 'friend-identity-right',
      lineAccountId: 'visual-qa-account', lineAccountName: '本店', priority: 1,
      isActive: true, reason: '通常の配信は本店から送ります',
    },
    {
      purpose: 'broadcast', friendId: 'friend-identity-left',
      lineAccountId: 'visual-qa-account-sub', lineAccountName: '支店', priority: 2,
      isActive: true, reason: '本店から送れないときの代替です',
    },
  ],
  history: [
    {
      id: 'merged-event-2', eventType: 'profile',
      summary: 'プロフィールの採用値を2件更新しました', actorName: '画面確認',
      occurredAt: '2026-08-28T10:12:00.000Z',
    },
    {
      id: 'merged-event-1', eventType: 'link', summary: '本人照合で友だちを結び付けました',
      actorName: '画面確認', occurredAt: '2026-08-28T10:00:00.000Z',
    },
  ],
  createdAt: '2026-08-28T10:00:00.000Z', updatedAt: '2026-08-28T10:12:00.000Z',
  archivedAt: null,
}

/** 0件を未取得へ変えないため、器は通常時と同じまま空配列を返す。 */
export const MERGED_PERSON_EMPTY = {
  ...MERGED_PERSON_DETAIL,
  revision: 1,
  linkedFriends: [MERGED_PERSON_DETAIL.linkedFriends[0]],
  profileValues: [],
  profileCandidates: [],
  tagCandidates: [],
  deliveryPriorities: [],
  history: [],
}

export const MERGED_PERSON_ERROR = {
  success: false, error: '統合ユーザーを読み込めませんでした', code: 'VISUAL_QA_ERROR',
}

/** 機能3の保存した検索。入力値と一致人数を同じ契約で読み直せる1件。 */
export const FRIEND_SAVED_VIEWS = {
  items: [
    {
      id: 'friend-saved-view-1', name: 'NEN会員・要フォロー',
      conditions: {
        all: [{ kind: 'tag', op: 'includes', value: 'tag-nen-member' }],
        any: [
          { kind: 'memo', op: 'contains', value: '折り返し' },
          { kind: 'reminder', op: 'exists', value: 'reminder-1' },
        ],
        visibility: 'visible_only',
        description: 'NEN会員のうち、次の対応を確認する友だち',
        list: { columns: ['名前', 'タグ', '最終反応日'], sort: 'recent', limit: 20 },
      },
      revision: 1, isShared: true, ownerId: 'staff-visual-qa',
      lineAccountId: 'visual-qa-account', displayOrder: 1,
      match: {
        total: 126, byChannel: { line: 124, mail: 2 },
        calculatedAt: '2026-09-07T00:00:00.000Z', error: null,
      },
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
    },
  ],
  total: 1,
}

export const IDENTITY_CANDIDATE_DETECTION = {
  normal: { processed: 1, hasMore: false, nextCursor: null },
  empty: { processed: 0, hasMore: false, nextCursor: null },
}

/**
 * シナリオの通。設計 `bV5Vs`（5-1-C シナリオ編集）の4通。
 *
 * **`steps` を配列で返さないと画面ごと落ちる**（`scenario.steps` を回す）。
 * 空の一覧の形で返していたあいだ、シナリオを開くたびに「もう一度試す」
 * だけの画面になっていた。
 */
export const SCENARIO_STEPS = [
  {
    id: 'step-0', scenarioId: 'scenario-0', stepOrder: 1, delayMinutes: 0,
    offsetDays: 0, offsetMinutes: null, deliveryTime: '10:00', templateId: null,
    onReachTagId: null, afterSend: 'continue', messageType: 'text',
    /* 板 `PMLkX` の1通目の題。 */
    messageContent: '{{name}}さん、ご登録ありがとうございます。\n7日間でサービスの使い方を順番にご案内します。',
    targetCondition: {
      operator: 'AND',
      rules: [
        { type: 'tag_exists', value: 'tag-first-guide' },
        { type: 'support_mark', value: { markIds: ['mark-default'], exclude: false } },
      ],
      groups: [],
    },
    question: null, isDraft: false,
    createdAt: '2026-08-16T00:00:00.000Z',
  },
  {
    id: 'step-1', scenarioId: 'scenario-0', stepOrder: 2, delayMinutes: 1440,
    offsetDays: 1, offsetMinutes: null, deliveryTime: '20:00', templateId: null,
    onReachTagId: null, afterSend: 'continue', messageType: 'carousel',
    /* 板 `PMLkX` の2通目の札はカルーセル。 */
    messageContent: '最初に確認してほしい3つのポイント',
    targetCondition: {
      operator: 'AND',
      rules: [{ type: 'tag_exists', value: 'tag-first-guide' }],
      groups: [],
    },
    question: null, isDraft: false,
    createdAt: '2026-08-16T00:00:00.000Z',
  },
  {
    id: 'step-2', scenarioId: 'scenario-0', stepOrder: 3, delayMinutes: 4320,
    offsetDays: 3, offsetMinutes: null, deliveryTime: '10:00', templateId: null,
    onReachTagId: null, afterSend: 'pause', messageType: 'text',
    messageContent: '使い方で迷っていることはありますか？',
    targetCondition: {
      operator: 'AND',
      rules: [
        { type: 'tag_exists', value: 'tag-first-guide' },
        { type: 'registered_at', value: { from: '2026-08-01', to: '' } },
      ],
      groups: [],
    },
    question: {
      text: '使い方で迷っていることはありますか？',
      tapMode: 'single',
      choices: [
        { label: 'はい', behavior: 'none' },
        { label: 'いいえ', behavior: 'none' },
      ],
    },
    isDraft: false, createdAt: '2026-08-16T00:00:00.000Z',
  },
  {
    id: 'step-3', scenarioId: 'scenario-0', stepOrder: 4, delayMinutes: 10080,
    offsetDays: 7, offsetMinutes: null, deliveryTime: '10:00', templateId: 'template-0',
    /* 板 `PMLkX` の通ごとの数「到達タグ：初回案内済み」。 */
    onReachTagId: 'tag-first-guide-complete', afterSend: 'pause', messageType: 'text',
    /* 板 `PMLkX` の4通目の題（テンプレート名は実装が別口で付ける）。通ごとの数では「下書き」。 */
    messageContent: '初回限定のご案内',
    targetCondition: null, question: null, isDraft: true,
    createdAt: '2026-08-16T00:00:00.000Z',
  },
]

/** `hz9ti` の設定済み3動作。現行 ScenarioAction の5種だけで完全な値を返す。 */
export const SCENARIO_ACTIONS = [
  {
    id: 'scenario-action-1', scenarioId: 'scenario-0', hook: 'step_sent',
    stepId: 'step-0', choiceIndex: null, sortOrder: 0, actionType: 'tag',
    config: { op: 'add', tagIds: ['tag-first-guide-complete'] },
    condition: null, repeatOnRefire: true, complete: true,
  },
  {
    id: 'scenario-action-2', scenarioId: 'scenario-0', hook: 'step_sent',
    stepId: 'step-0', choiceIndex: null, sortOrder: 1, actionType: 'support_mark',
    config: { markId: 'mark-in-progress' },
    condition: {
      operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-first-guide-complete' }], groups: [],
    },
    repeatOnRefire: true, complete: true,
  },
  {
    id: 'scenario-action-3', scenarioId: 'scenario-0', hook: 'step_sent',
    stepId: 'step-0', choiceIndex: null, sortOrder: 2, actionType: 'scenario',
    config: { op: 'start', scenarioId: 'scenario-1', restart: 'from_start', rememberPrevious: true },
    condition: {
      operator: 'AND', rules: [{ type: 'registered_at', value: { from: '2026-08-01', to: '' } }], groups: [],
    },
    repeatOnRefire: false, complete: true,
  },
]

/* 板 `PMLkX` の開始のきっかけの箱（友だち追加のとき）。無いと箱が
 * 「呼ばれたときだけ」になる。 */
export const SCENARIO_TRIGGERS = [
  { id: 'trigger-1', kind: 'friend_add', tagId: null },
]

/* 板 `PMLkX` の通ごとの届く日時の例（時刻の下の青い行）。取れないと
 * 出ない。実装は `deliveryAtLabel` をそのまま出す。 */
export const SCENARIO_PREVIEW = {
  startAt: '2026-10-01T14:00:00+09:00',
  steps: [
    { stepOrder: 1, deliveryAt: '2026-10-01T14:00:00+09:00', deliveryAtLabel: '10月1日（木）14:00（すぐ）', messageType: 'text', messageContent: '{{name}}さん、ご登録ありがとうございます。' },
    { stepOrder: 2, deliveryAt: '2026-10-02T20:00:00+09:00', deliveryAtLabel: '10月2日（金）20:00', messageType: 'carousel', messageContent: '最初に確認してほしい3つのポイント' },
    { stepOrder: 3, deliveryAt: '2026-10-04T10:00:00+09:00', deliveryAtLabel: '10月4日（日）10:00', messageType: 'text', messageContent: '使い方で迷っていることはありますか？' },
    { stepOrder: 4, deliveryAt: '2026-10-08T10:00:00+09:00', deliveryAtLabel: '10月8日（木）10:00', messageType: 'text', messageContent: '初回限定のご案内' },
  ],
}

/** シナリオ編集を開き直したときに読み返す下書き。 */
export const SCENARIO_DRAFT = {
  scenarioId: 'scenario-0', lineAccountId: 'visual-qa-account', version: 3,
  afterActions: [
    { id: 'scenario-action-1', hook: 'step_sent', stepId: 'step-0', choiceKey: null, type: 'add_tag', params: { tagIds: ['tag-first-guide-complete'] }, condition: null, onFailure: 'stop', sortOrder: 0 },
    { id: 'scenario-action-2', hook: 'step_sent', stepId: 'step-0', choiceKey: null, type: 'set_support_mark', params: { markId: 'mark-in-progress' }, condition: { operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-first-guide-complete' }], groups: [] }, onFailure: 'stop', sortOrder: 10 },
    { id: 'scenario-action-3', hook: 'step_sent', stepId: 'step-0', choiceKey: null, type: 'start_scenario', params: { scenarioId: 'scenario-1' }, condition: { operator: 'AND', rules: [{ type: 'registered_at', value: { from: '2026-08-01', to: '' } }], groups: [] }, onFailure: 'stop', sortOrder: 20 },
  ],
  updatedBy: 'staff-visual-qa', updatedAt: '2026-09-07T00:10:00.000Z',
}

/**
 * シナリオの到達率。設計 `bV5Vs` の通ごとの数。
 *
 * 一覧の形で返していたあいだ、画面は `stats.steps.find(...)` で落ちていた。
 * **配列には `steps` が無い。**
 */
export const SCENARIO_STATS = {
  enrolledTotal: 428,
  activeNow: 116,
  completed: 312,
  paused: 0,
  steps: SCENARIO_STEPS.map((step, index) => ({
    stepOrder: step.stepOrder,
    reachedCount: [428, 412, 386, 351][index] ?? 0,
    reachRate: [0.96, 0.92, 0.86, 0.78][index] ?? 0,
  })),
}

/** シナリオ配信の試算・開始記録。送信は行わず、契約で定めた数だけ返す。 */
export const SCENARIO_SIMULATION = {
  scenarioId: 'scenario-0', lineAccountId: 'visual-qa-account',
  computedAt: '2026-09-07T00:00:00.000Z', sideEffects: false,
  audience: { accountTotal: 428, matched: 124, alreadySubscribed: 8, newStartPlanned: 116, excluded: 304 },
  steps: [428, 410, 382, 351].map((targetCount, index) => ({
    id: `step-${index}`, stepOrder: index + 1,
    scheduledAt: `2026-09-${String(7 + index).padStart(2, '0')}T11:00:00.000Z`, targetCount,
    excludedCount: [0, 18, 46, 77][index],
  })),
}

export const SCENARIO_RUNS = {
  summary: { active: 116, paused: 0, completed: 312, delivering: 18 },
  /* 板 `X4STXS`（配信結果）の参加中の友だちの4行（途中・途中・止まっている・読み終えた）。 */
  subscriptions: [
    { id: 'scenario-sub-1', friendId: 'friend-1', friendName: '見本 16', status: 'active', currentStepOrder: 3, startedAt: '2026-09-27T01:00:00.000Z', nextDeliveryAt: '2026-10-04T01:00:00.000Z', updatedAt: '2026-09-30T01:00:00.000Z' },
    { id: 'scenario-sub-3', friendId: 'friend-3', friendName: '見本 121', status: 'active', currentStepOrder: 2, startedAt: '2026-09-30T01:00:00.000Z', nextDeliveryAt: '2026-10-02T11:00:00.000Z', updatedAt: '2026-10-01T11:00:00.000Z' },
    { id: 'scenario-sub-4', friendId: 'friend-4', friendName: '見本 143', status: 'paused', currentStepOrder: 1, startedAt: '2026-09-29T01:00:00.000Z', nextDeliveryAt: null, updatedAt: '2026-09-30T01:00:00.000Z' },
    { id: 'scenario-sub-2', friendId: 'friend-2', friendName: 'Kyohei Yamamoto', status: 'completed', currentStepOrder: 4, startedAt: '2026-08-28T01:00:00.000Z', nextDeliveryAt: null, updatedAt: '2026-09-04T11:00:00.000Z' },
  ],
  pagination: { total: 428, limit: 20, cursor: '', nextCursor: null },
  testSends: [{ id: 'scenario-test-1', friendId: 'friend-1', friendName: '見本 16', sentAt: '2026-09-07T00:05:00.000Z', messageCount: 4 }],
  quota: { limit: 5000, used: 1842, remaining: 3158, state: 'available', reason: null, asOf: '2026-09-07T00:00:00.000Z' },
  concurrentBroadcasts: [{ id: 'broadcast-0', title: '8月キャンペーンのお知らせ', status: 'scheduled', scheduledAt: '2026-09-08T01:00:00.000Z' }],
  scenarioClickTotal: 86,
  steps: SCENARIO_STEPS.map((step, index) => ({ id: step.id, stepOrder: step.stepOrder, delivered: [428, 412, 386, 351][index], opened: { value: null, state: 'unavailable', reason: '開封計測は現在利用できません' }, clicked: { value: [42, 38, 31, 24][index], state: 'available', reason: null }, failed: { value: [2, 1, 1, 0][index], state: 'available', reason: null } })),
}

/* 一斉配信の一覧。板 `NtCE3` の先頭5行を上から順に並べ、残り19件で
 * 総数24・札の数（予約中4・下書き3・承認待ち1・送信済み15・エラー1）・
 * フォルダの数（予約配信6・キャンペーン8・EC・フォロー5・未分類5）に
 * 合わせる。5行目までが絵に見えている行。 */
export const BROADCASTS = [
  // 題, 種別, 対象, 状態, 予定, 対象数, 成功数, フォルダ
  ['8月キャンペーンのお知らせ', 'image', 'all', 'scheduled', '2026-08-24T01:00:00.000Z', 1248, 0, 'bf-campaign'],
  ['未購入者フォロー', 'text', 'segment', 'draft', null, 18, 0, 'bf-ec'],
  ['新商品発売のお知らせ', 'carousel', 'tag', 'sent', '2026-08-20T03:00:00.000Z', 626, 624, 'bf-campaign'],
  ['予約空き枠のご案内', 'text', 'tag', 'sent', '2026-08-18T09:30:00.000Z', 203, 203, 'bf-ec'],
  ['重要なお知らせ', 'text', 'all', 'draft', '2026-08-17T00:00:00.000Z', 0, 0, null],
  // 以下19件は数の帯・札・フォルダの数を絵に合わせるための分。
  ['9月キャンペーン予告', 'image', 'all', 'scheduled', '2026-09-10T01:00:00.000Z', 0, 0, 'bf-reserved'],
  ['定休日のお知らせ', 'text', 'all', 'scheduled', '2026-09-07T01:00:00.000Z', 0, 0, 'bf-reserved'],
  ['新メニューのご案内', 'text', 'tag', 'scheduled', '2026-09-05T01:00:00.000Z', 0, 0, 'bf-reserved'],
  ['季節のおすすめ', 'image', 'tag', 'scheduled', '2026-09-03T01:00:00.000Z', 0, 0, 'bf-reserved'],
  ['秋の味覚特集', 'carousel', 'all', 'draft', null, 0, 0, 'bf-campaign'],
  ['7月キャンペーン報告', 'image', 'all', 'sent', '2026-08-15T01:00:00.000Z', 512, 510, 'bf-campaign'],
  ['夏休みのお知らせ', 'text', 'all', 'sent', '2026-08-12T01:00:00.000Z', 480, 478, null],
  ['お盆期間の営業案内', 'text', 'segment', 'sent', '2026-08-10T01:00:00.000Z', 350, 348, 'bf-ec'],
  ['新商品モニター募集', 'text', 'tag', 'sent', '2026-08-08T01:00:00.000Z', 290, 289, 'bf-campaign'],
  ['会員限定セール', 'image', 'tag', 'sent', '2026-08-05T01:00:00.000Z', 610, 605, 'bf-campaign'],
  ['ポイント2倍デー', 'text', 'all', 'sent', '2026-08-01T01:00:00.000Z', 540, 538, 'bf-reserved'],
  ['雨の日クーポン', 'text', 'segment', 'sent', '2026-07-28T01:00:00.000Z', 180, 179, 'bf-ec'],
  ['土用の丑の日', 'image', 'all', 'sent', '2026-07-25T01:00:00.000Z', 420, 418, 'bf-campaign'],
  ['七夕のお願い', 'text', 'all', 'sent', '2026-07-07T01:00:00.000Z', 390, 388, null],
  ['父の日の贈り物', 'carousel', 'tag', 'sent', '2026-06-20T01:00:00.000Z', 310, 309, 'bf-campaign'],
  ['梅雨の晴れ間クーポン', 'text', 'all', 'sent', '2026-06-10T01:00:00.000Z', 260, 259, null],
  ['衣替えセール', 'image', 'tag', 'sent', '2026-06-01T01:00:00.000Z', 330, 328, 'bf-ec'],
  ['5周年ありがとう', 'text', 'all', 'sent', '2026-05-20T01:00:00.000Z', 600, 598, null],
  ['ゴールデンウィーク', 'image', 'all', 'failed', '2026-05-01T01:00:00.000Z', 450, 0, 'bf-reserved'],
].map(([title, messageType, targetType, status, scheduledAt, totalCount, successCount, folderId], index) => ({
  id: `broadcast-${index}`,
  title: String(title),
  messageType: String(messageType),
  messageContent: index === 1
    ? 'まだご購入いただいていない方へ。今なら初回20%オフでお試しいただけます。'
    // 送った後の詳細（F3X1Mo）の右のスマホに出すカルーセル。中身は columns の配列（送る形と同じ）。
    : index === 2
      ? JSON.stringify([
        { title: '秋の新商品 3種', text: '定期便なら 10%オフ', actions: [{ type: 'uri', label: '商品を見る', uri: 'https://nen.example/new' }] },
        { title: 'お試しセット', text: '初回限定 1,980円', actions: [{ type: 'uri', label: '詳しく見る', uri: 'https://nen.example/trial' }] },
      ])
      : `${title}の本文です。`,
  targetType: String(targetType),
  targetTagId: targetType === 'tag' ? 'tag-0' : null,
  status: String(status),
  scheduledAt,
  sentAt: status === 'sent' ? scheduledAt : null,
  totalCount: Number(totalCount),
  successCount: Number(successCount),
  lineAccountId: 'visual-qa-account',
  folderId: folderId ?? null,
  measureOpens: true,
  internalMemo: index === 1 ? '購入前に離脱した方へ、商品の選び方を案内する' : null,
  // 板 `cgiGB`・`Q28Gb`：「3 メッセージ」の途中で止まった下書き。
  draftStep: index === 1 ? 'message' : null,
  draftPayload: index === 1
    ? { saveAsDraft: true, draftStep: 'message', targetType: 'segment' }
    : null,
  messageOptions: index === 1 ? { buttons: [] } : null,
  afterActionVersionId: index === 1 ? 'common-action-version-broadcast-tagged' : null,
  version: 1,
  createdAt: '2026-08-16T00:00:00.000Z',
  // 承認の絡み（#816 C）。0行目は依頼中、2行目は承認を通って送信済み。
  // 記録の見本（BROADCAST_ACTIVITY）と合わせる。無い行は 'none'。
  approvalStatus: index === 0 ? 'pending' : index === 2 ? 'approved' : 'none',
  // 10の状態（#816）。承認待ちは承認の軸が先（deriveBroadcastDisplayStatus
  // と同じ）。0行目は status が予約済みでも「承認待ち」で見せる。
  displayStatus: index === 0 ? 'pending_approval' : String(status),
  displayStatusLabel: { draft: '下書き', pending_approval: '承認待ち', scheduled: '予約済み', sent: '送信済み', failed: 'エラー' }[index === 0 ? 'pending_approval' : status] ?? String(status),
  ledger: status === 'sent'
    ? {
      sent: Number(successCount), failed: 0, failedTemporary: 0, failedPermanent: 0,
      unknown: 0, inFlight: 0, retryableCount: 0,
    }
    : { sent: 0, failed: 0, failedTemporary: 0, failedPermanent: 0, unknown: 0, inFlight: 0, retryableCount: 0 },
}))

/**
 * 一斉配信の宛先台帳の見本（#816 / C-2）。
 *
 * 行がある8人（届いた5・一時的1・届けられなかった1・送達不明1）と、
 * まだ送っていない20人（名前の一覧は無い）。
 */
export const BROADCAST_RECIPIENTS = {
  rows: [
    { friendId: 'friend-1', displayName: '山田花子', lineAccountId: 'visual-qa-account', group: 'delivered', label: '届いた', detail: 'LINEが受け付けました', retryable: false, lineRequestId: 'req-9a1', errorCode: null, dispatchedAt: '2026-10-01T10:00:00+09:00', settledAt: '2026-10-01T10:00:05+09:00' },
    { friendId: 'friend-2', displayName: '佐々木健', lineAccountId: 'visual-qa-account', group: 'failed_permanent', label: '失敗：届けられませんでした', detail: 'ブロック・友だち解除などで受け付けられませんでした。送り直しません', retryable: false, lineRequestId: null, errorCode: 'line_http_400', dispatchedAt: '2026-10-01T10:00:00+09:00', settledAt: '2026-10-01T10:00:06+09:00' },
    { friendId: 'friend-3', displayName: '鈴木一郎', lineAccountId: 'visual-qa-account', group: 'failed_temporary', label: '失敗：一時的（あとで再送できます）', detail: '混み合いなどで送れませんでした。時間を置いて送り直せます', retryable: true, lineRequestId: null, errorCode: 'line_http_429', dispatchedAt: '2026-10-01T10:01:00+09:00', settledAt: '2026-10-01T10:01:07+09:00' },
    { friendId: 'friend-4', displayName: '高橋美香', lineAccountId: 'visual-qa-account', group: 'delivered', label: '届いた', detail: 'LINEが受け付けました', retryable: false, lineRequestId: 'req-9a1', errorCode: null, dispatchedAt: '2026-10-01T10:00:00+09:00', settledAt: '2026-10-01T10:00:05+09:00' },
    { friendId: 'friend-5', displayName: '田中太郎', lineAccountId: 'visual-qa-account', group: 'delivered', label: '届いた', detail: 'LINEが受け付けました', retryable: false, lineRequestId: 'req-9a2', errorCode: null, dispatchedAt: '2026-10-01T10:00:30+09:00', settledAt: '2026-10-01T10:00:35+09:00' },
    { friendId: 'friend-6', displayName: '伊藤さくら', lineAccountId: 'visual-qa-account', group: 'delivered', label: '届いた', detail: 'LINEが受け付けました', retryable: false, lineRequestId: 'req-9a2', errorCode: null, dispatchedAt: '2026-10-01T10:00:30+09:00', settledAt: '2026-10-01T10:00:35+09:00' },
    { friendId: 'friend-7', displayName: '渡辺大輔', lineAccountId: 'visual-qa-account', group: 'delivered', label: '届いた', detail: 'LINEが受け付けました', retryable: false, lineRequestId: 'req-9a2', errorCode: null, dispatchedAt: '2026-10-01T10:00:30+09:00', settledAt: '2026-10-01T10:00:35+09:00' },
    { friendId: 'friend-8', displayName: '中村恵子', lineAccountId: 'visual-qa-account', group: 'unknown', label: '送達不明', detail: '外へ出たかもしれません。二重に届くのを避けるため送り直しません', retryable: false, lineRequestId: null, errorCode: 'line_no_response', dispatchedAt: '2026-10-01T10:00:30+09:00', settledAt: '2026-10-01T10:01:35+09:00' },
  ],
  summary: {
    sent: 5, failedTemporary: 1, failedPermanent: 1, unknown: 1, inFlight: 0,
    pending: 20, total: 28, retryableCount: 1,
  },
}

/** 一斉配信の操作の記録の見本（#816 / C-3）。新しい順。消せない。 */
export const BROADCAST_ACTIVITY = [
  { kind: 'lifecycle', action: 'send_started', label: '送信を始めた', actorStaffId: null, actorName: '自動', reason: null, createdAt: '2026-10-01T10:00:00+09:00' },
  { kind: 'approval', action: 'approved', label: '承認した', actorStaffId: 'staff-approver', actorName: '見本 121', reason: null, createdAt: '2026-09-25T21:02:00+09:00' },
  { kind: 'approval', action: 'requested', label: '承認を依頼した', actorStaffId: 'staff-sender', actorName: '見本 145', reason: null, createdAt: '2026-09-25T20:10:00+09:00' },
  { kind: 'lifecycle', action: 'created', label: '下書きを作った', actorStaffId: 'staff-sender', actorName: '見本 145', reason: null, createdAt: '2026-09-25T20:05:00+09:00' },
]

/** 機能6の一覧が本番口と同じく、行・KPI・ページ情報を一度に読むための固定値。 */
export const BROADCAST_LIST_META = {
  kpis: {
    scheduled: 4,
    drafts: 3,
    thisMonth: 12,
    delivered: 1842,
    openRate: 69.4,
  },
  pagination: { total: 24, limit: 20, cursor: 0, nextCursor: '20' },
  /*
   * 絞り込みの札の横の数（10の状態で数えたもの。V8 一覧が読む）。
   * 合計は pagination.total と同じ24にそろえる——数が合わないと
   * 絵の見比べで「札とページ送りで数が違う」に見える。
   */
  /* 板 `NtCE3` の札の数。エラーは失敗系の合計で1になる。 */
  statusCounts: { all: 24, scheduled: 4, draft: 3, pending_approval: 1, sent: 15, partial_failed: 0, failed: 1 },
}

/** 機能6。予約完了画面に出すSlack通知設定。 */
export const BROADCAST_NOTIFICATION_SETTINGS = {
  version: 1,
  started: true,
  completed: true,
  failed: true,
  displayText: '配信開始・完了・エラーはSlackの同じスレッドへ通知します。',
}

/** 二者承認（m12a / 設計 A）。確認画面の出し分けに使う境目と運用者数。 */
export const BROADCAST_APPROVAL_CONFIG = {
  lineAccountId: 'visual-qa-account',
  threshold: 1000,
  operatorCount: 2,
  singleOperator: false,
}

/** 二者承認（m12a）。承認を頼める相手。自分は除いてある。 */
export const BROADCAST_APPROVAL_CANDIDATES = [
  { id: 'staff-approver', name: '見本 121', role: 'admin', canApprove: true },
  { id: 'staff-sasaki-approver', name: '見本 110', role: 'admin', canApprove: true },
]

/** 二者承認（m12a）。承認待ちの配信の今の状態と判定。 */
export const BROADCAST_APPROVAL_STATE = {
  approval: {
    status: 'pending',
    requestedByStaffId: 'staff-approver',
    requestedAt: '2026-09-25T20:10:00+09:00',
    approverStaffId: 'staff-sasaki-approver',
    note: '秋の案内です。10時までに見てください',
    decidedByStaffId: null,
    decidedAt: null,
    rejectReason: null,
    confirmedCount: null,
  },
  gate: {
    required: true,
    recipientCount: 1248,
    threshold: 1000,
    singleOperator: false,
    operatorCount: 2,
  },
  viewer: {
    isApprover: true,
    canApprove: true,
    isRequester: false,
  },
}

/** 機能6 `sqFXf`。検索条件を保存済みの状態と、新規保存の固定結果。 */
export const BROADCAST_SAVED_VIEWS = [
  {
    id: 'broadcast-view-reserved',
    name: '予約中のみ',
    // 保存側（page.tsx saveCurrentView）と同じ形にする。旧形の
    // `statuses` では適用処理が読み替えられず復元不良になる（点検 #490 中5）。
    filters: { titleQuery: '', statusFilter: 'scheduled', dateFrom: '', dateTo: '', folderFilter: '' },
    sortKey: 'scheduled',
    pageSize: 20,
    createdBy: 'staff-owner',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    version: 1,
  },
  {
    id: 'broadcast-view-low-open-rate',
    name: '開封率が低い',
    filters: { openRateMax: 0.5, statuses: ['sent'] },
    sortKey: 'newest',
    pageSize: 20,
    createdBy: 'staff-owner',
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    version: 1,
  },
]

/** 機能6の対象確認。対象1,248人から35人を理由別に除き、1,213人へ送る。 */
export const BROADCAST_PREFLIGHT = {
  audienceCount: 1213,
  hiddenExcluded: 12,
  warnings: [
    { level: 'info', message: '送信開始時に対象をもう一度数えます。' },
    { level: 'warning', message: '同じ時刻に予約中の配信が1件あります。' },
  ],
  audience: {
    matched: 1248,
    sendable: 1213,
    evaluatedAt: '2026-08-24T00:55:00.000Z',
    representatives: [
      // 画面（broadcast-form 対象プレビュー）と口（BroadcastPreflight）の
      // 実形に合わせる。`note` だけでは画像と要約が空表示になる（点検 #490 中6）。
      { friendId: 'friend-1', displayName: 'Demo Person', pictureUrl: null, summary: '予約・未対応' },
      { friendId: 'friend-2', displayName: 'Masato S.', pictureUrl: null, summary: '予約・対応中' },
      { friendId: 'friend-3', displayName: '見本 15', pictureUrl: null, summary: '予約・未対応' },
    ],
  },
  exclusions: {
    blocked: 8,
    hidden: 12,
    missingDestination: 3,
    duplicate: 7,
    paused: 5,
    total: 35,
  },
  quota: {
    monthlyUsed: 1842,
    monthlyLimit: 5000,
    remaining: 3158,
    planned: 1213,
    state: 'available',
    reason: null,
  },
  concurrentBroadcasts: [
    { id: 'broadcast-concurrent', title: '予約空き枠のご案内', scheduledAt: '2026-08-24T01:30:00.000Z' },
  ],
  conditionAxes: {
    standard: [
      ['name', '名前'], ['private_memo', '個別メモ'], ['status_message', 'ステータスメッセージ'],
      ['registered_at', '友だち登録日'], ['tag', 'タグ'], ['friend_field', '友だち情報'],
      ['scenario', 'シナリオ'], ['event_booking', 'イベント予約'], ['calendar_booking', 'カレンダー予約'],
      ['common_var', '共通情報'], ['reminder', 'リマインダ'], ['form', '回答フォーム'],
      ['last_reaction_at', '最終反応日'], ['other', 'その他'], ['support_mark', '対応マーク'],
    ].map(([key, label]) => ({ key, label })),
    broadcastOnly: [
      ['assignee', '担当者'], ['inflow_route', '流入経路'], ['delivery_status', '配信状況'],
      ['booking_status', '予約状況'], ['purchase_history', '購入履歴'], ['block_status', 'ブロック状態'],
    ].map(([key, label]) => ({ key, label })),
  },
}

/** 機能6の送信済み2件。LINE集計の母数とリンク別クリックを同じ返事に置く。 */
export const BROADCAST_INSIGHTS = {
  'broadcast-2': {
    broadcastId: 'broadcast-2', delivered: 624, uniqueImpression: 444, uniqueClick: 96,
    uniqueMediaPlayed: null, openRate: 0.712, clickRate: 0.154, status: 'ready',
    fetchedAt: '2026-08-20T04:00:00.000Z',
    opens: { count: 444, denominator: 624, rate: 0.712, asOf: '2026-08-20T04:00:00.000Z', state: 'available', reason: null },
    links: [
      { id: 'tracked-broadcast-2-1', label: '商品を見る', url: 'https://nen.example/products', clickCount: 112, uniqueClickCount: 82, clickRate: 0.131, lastClickedAt: '2026-08-20T03:52:00.000Z' },
      { id: 'tracked-broadcast-2-2', label: '詳しく見る', url: 'https://nen.example/campaign', clickCount: 20, uniqueClickCount: 14, clickRate: 0.022, lastClickedAt: '2026-08-20T03:48:00.000Z' },
    ],
  },
  'broadcast-3': {
    broadcastId: 'broadcast-3', delivered: 203, uniqueImpression: 140, uniqueClick: 31,
    uniqueMediaPlayed: null, openRate: 0.689, clickRate: 0.153, status: 'ready',
    fetchedAt: '2026-08-18T10:30:00.000Z',
    opens: { count: 140, denominator: 203, rate: 0.689, asOf: '2026-08-18T10:30:00.000Z', state: 'available', reason: null },
    links: [
      { id: 'tracked-broadcast-3-1', label: '空き枠を見る', url: 'https://nen.example/bookings', clickCount: 34, uniqueClickCount: 31, clickRate: 0.153, lastClickedAt: '2026-08-18T10:12:00.000Z' },
    ],
  },
}

/** 一斉配信のフォルダ操作 `xkRDb` を開くための固定データ。 */
/* 一斉配信のフォルダ。板 `NtCE3` の数（予約配信6・キャンペーン8・
 * EC・フォロー5・未分類5）。未分類の件数は mock-api が数えて返す。 */
export const BROADCAST_FOLDERS = [
  ['bf-reserved', '予約配信', '#3B82F6', 6],
  ['bf-campaign', 'キャンペーン', '#10B981', 8],
  ['bf-ec', 'EC・フォロー', '#F59E0B', 5],
].map(([id, name, color, itemCount], index) => ({
  id: String(id),
  kind: 'broadcast',
  name: String(name),
  parentId: null,
  displayOrder: index,
  itemCount: Number(itemCount),
  color: String(color),
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}))

/**
 * 機能7 リマインダ。V8 板 `apLqS`（リマインダ一覧）の9件そのまま。
 * フォルダは絵のとおり予約3・契約更新2・イベント2・未分類2（「フォロー」
 * というフォルダは絵に無い）。未分類の2件は `folderId: null` で返し、
 * 件数は mock-api が `unfiledCount: 2` で返す。
 *
 * **`Reminder` の型に照らして書く。** 設計の言葉（「予約日時の1日前」）は
 * 見出しであって項目名ではない。`triggerType` は
 * `'manual' | 'booking' | 'event' | 'friend_field'` の4つしかなく、
 * ここに設計の日本語をそのまま入れると画面は既定値のまま描かれ、
 * **行が同じきっかけで撮れてしまう**（機能4で一度やった）。
 * 基準日の言い回しは `baseDateSummary`、時刻の言い回しは
 * `timingSummary` に書く（実装はそのままつなげて出す）。
 */
export const REMINDER_FOLDERS = [
  { id: 'rf-booking', kind: 'reminder', name: '予約', parentId: null, displayOrder: 1, color: '#2563eb', itemCount: 3 },
  { id: 'rf-contract', kind: 'reminder', name: '契約更新', parentId: null, displayOrder: 2, color: '#d97706', itemCount: 2 },
  { id: 'rf-event', kind: 'reminder', name: 'イベント', parentId: null, displayOrder: 3, color: '#7c3aed', itemCount: 2 },
]

/* 板 `apLqS` の9行を上から順に並べた（`displayOrder` が並び）。
 * 「次に送る」の日付は絵の `10/1（水）18:00` の形になるよう、曜日が合う
 * 2025年の同じ月日で持つ（実装は曜日を日付から計算する）。下書き・停止中
 * の行は実装が「—」で出すので `plannedDeliveries` と `nextScheduledAt` は
 * 空でも絵と同じになるが、他画面（詳細・編集）が読むため値は入れてある。 */
export const REMINDERS = [
  {
    id: 'reminder-1', name: '予約前日のご案内', description: '予約日時の1日前',
    isActive: true, triggerType: 'booking', deliveryMode: 'time',
    triggerOffsetMinutes: -1440, sendAtTime: '18:00', targetTagId: null,
    triggerFieldId: null, repeatYearly: false,
    folderId: 'rf-booking', stepCount: 1, displayOrder: 1,
    lifecycleStatus: 'published', timingSummary: '1日前 18:00 ／ テキスト 1通', baseDateSummary: '予約日時', plannedDeliveries: 42, nextScheduledAt: '2025-10-01T18:00:00+09:00', lastSentAt: '2026-08-22T09:00:00.000Z',
    createdAt: '2026-06-02T00:00:00.000Z', updatedAt: '2026-09-28T10:00:00+09:00',
  },
  {
    /* 絵の2行目には「失敗 2」の札が付く。 */
    id: 'reminder-2', name: '予約1時間前のご案内', description: '予約日時の1時間前',
    isActive: true, triggerType: 'booking', deliveryMode: 'countdown',
    triggerOffsetMinutes: -60, sendAtTime: null, targetTagId: null,
    triggerFieldId: null, repeatYearly: false,
    folderId: 'rf-booking', stepCount: 1, displayOrder: 2,
    hasFailure: true, failedCount: 2,
    lifecycleStatus: 'published', timingSummary: '1時間前 ／ テキスト 1通', baseDateSummary: '予約日時', plannedDeliveries: 39, nextScheduledAt: '2025-10-01T13:00:00+09:00', lastSentAt: '2026-08-22T13:00:00.000Z',
    createdAt: '2026-06-02T00:00:00.000Z', updatedAt: '2026-08-22T11:00:00.000Z',
  },
  {
    id: 'reminder-3', name: '契約更新30日前', description: '契約終了の30日前',
    isActive: true, triggerType: 'friend_field', deliveryMode: 'time',
    triggerOffsetMinutes: -43200, sendAtTime: '10:00', targetTagId: null,
    triggerFieldId: 'field-contract-end', repeatYearly: false,
    folderId: 'rf-contract', stepCount: 2, displayOrder: 3,
    lifecycleStatus: 'published', timingSummary: '30日前 10:00 ／ テキスト 2通', baseDateSummary: '契約終了日（友だち情報欄）', plannedDeliveries: 18, nextScheduledAt: '2025-10-03T10:00:00+09:00', lastSentAt: '2026-08-21T01:00:00.000Z',
    createdAt: '2026-05-11T00:00:00.000Z', updatedAt: '2026-08-21T01:00:00.000Z',
  },
  {
    /* 未分類（`folderId: null`）。絵の4行目。毎年くり返す誕生日。 */
    id: 'reminder-6', name: 'お誕生日のお祝い', description: '誕生日の当日',
    isActive: true, triggerType: 'friend_field', deliveryMode: 'time',
    triggerOffsetMinutes: 0, sendAtTime: '10:00', targetTagId: null,
    triggerFieldId: 'field-birthday', repeatYearly: true,
    folderId: null, stepCount: 1, displayOrder: 4,
    lifecycleStatus: 'published', timingSummary: '当日 10:00 ／ テキスト 1通', baseDateSummary: '誕生日（毎年くり返す）', plannedDeliveries: 7, nextScheduledAt: '2025-10-05T10:00:00+09:00', lastSentAt: null,
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
  },
  {
    /* 下書き。実装は「これから送る」「次に送る」を「—」で出す。 */
    id: 'reminder-4', name: 'イベント当日のご案内', description: 'イベント当日',
    isActive: false, triggerType: 'event', deliveryMode: 'time',
    triggerOffsetMinutes: 0, sendAtTime: '09:00', targetTagId: null,
    triggerFieldId: null, repeatYearly: false,
    folderId: 'rf-event', stepCount: 1, displayOrder: 5,
    lifecycleStatus: 'draft', timingSummary: '当日 09:00 ／ テキスト 1通', baseDateSummary: 'イベントの予約日時', plannedDeliveries: 0, nextScheduledAt: null, lastSentAt: null,
    createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
  },
  {
    /* 停止中。絵に「フォロー」フォルダは無いので未分類（`folderId: null`）。
       実装は `lifecycleStatus: 'stopped'` を「停止中」の札で出す。 */
    id: 'reminder-5', name: '未返信3日後フォロー', description: '最終送信の3日後',
    isActive: false, triggerType: 'manual', deliveryMode: 'time',
    triggerOffsetMinutes: 4320, sendAtTime: '12:00', targetTagId: null,
    triggerFieldId: null, repeatYearly: false,
    folderId: null, stepCount: 1, displayOrder: 6,
    lifecycleStatus: 'stopped', timingSummary: '3日後 12:00 ／ テキスト 1通', baseDateSummary: '最終送信日', plannedDeliveries: 25, nextScheduledAt: null, lastSentAt: '2026-08-19T03:00:00.000Z',
    createdAt: '2026-04-01T00:00:00.000Z', updatedAt: '2026-08-19T03:00:00.000Z',
  },
  {
    /* 以下3件はフォルダの数（予約3・契約更新2・イベント2）を絵に合わせる
       ための分。絵の見切れの下にいるとして `displayOrder` を後ろに置く。 */
    id: 'reminder-7', name: '来店後のお礼', description: '来店の3日後',
    isActive: true, triggerType: 'booking', deliveryMode: 'time',
    triggerOffsetMinutes: 4320, sendAtTime: '18:00', targetTagId: null,
    triggerFieldId: null, repeatYearly: false,
    folderId: 'rf-booking', stepCount: 1, displayOrder: 7,
    lifecycleStatus: 'published', timingSummary: '3日後 18:00 ／ テキスト 1通', baseDateSummary: '予約日時', plannedDeliveries: 5, nextScheduledAt: '2025-10-07T18:00:00+09:00', lastSentAt: null,
    createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
  },
  {
    id: 'reminder-8', name: '契約更新7日前', description: '契約終了の7日前',
    isActive: true, triggerType: 'friend_field', deliveryMode: 'time',
    triggerOffsetMinutes: -10080, sendAtTime: '10:00', targetTagId: null,
    triggerFieldId: 'field-contract-end', repeatYearly: false,
    folderId: 'rf-contract', stepCount: 1, displayOrder: 8,
    lifecycleStatus: 'published', timingSummary: '7日前 10:00 ／ テキスト 1通', baseDateSummary: '契約終了日（友だち情報欄）', plannedDeliveries: 11, nextScheduledAt: '2025-10-06T10:00:00+09:00', lastSentAt: null,
    createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
  },
  {
    id: 'reminder-9', name: 'イベント前日のご案内', description: 'イベントの前日',
    isActive: true, triggerType: 'event', deliveryMode: 'time',
    triggerOffsetMinutes: -1440, sendAtTime: '09:00', targetTagId: null,
    triggerFieldId: null, repeatYearly: false,
    folderId: 'rf-event', stepCount: 1, displayOrder: 9,
    lifecycleStatus: 'published', timingSummary: '1日前 09:00 ／ テキスト 1通', baseDateSummary: 'イベントの予約日時', plannedDeliveries: 9, nextScheduledAt: '2025-10-06T09:00:00+09:00', lastSentAt: null,
    createdAt: '2026-08-11T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
  },
]

/** 設計 `M1EXwB` の帯。リマインダ9件（有効7）／送信予定124通／今月386通／失敗2通。 */
export const REMINDER_STATS = { total: 9, active: 7, waiting: 124, sentThisMonth: 386, failed: 2 }

/** 機能7 `J64xI`。公開版を変えずに編集する通知ステップの固定下書き。 */
export const REMINDER_DRAFT = {
  reminderId: 'reminder-3',
  versionId: 'reminder-3-draft-v3',
  versionNumber: 3,
  status: 'draft',
  settings: {
    name: 'Google Meet相談の前日案内',
    description: '前日・1時間前・当日の3回で案内する',
    lineAccountId: 'visual-qa-account',
    triggerType: 'booking',
    deliveryMode: 'time',
    triggerFieldId: null,
    repeatYearly: false,
    triggerOffsetMinutes: null,
    sendAtTime: null,
    targetTagId: null,
    targetCondition: null,
    folderId: 'rf-booking',
    stopConditions: {
      bookingCancelled: true,
      supportMarkCompleted: true,
      daysAfterTarget: 7,
      friendBlocked: true,
    },
    steps: [
      { stableStepId: 'day-before', offsetMinutes: 0, messageType: 'text', messageContent: '明日のGoogle Meet相談のご案内です。日時と参加URLを差し込みます。', offsetDays: -1, sendAtTime: '18:00' },
      { stableStepId: 'hour-before', offsetMinutes: -60, messageType: 'text', messageContent: 'まもなく開始です。参加URLをもう一度お送りします。', offsetDays: null, sendAtTime: null },
      { stableStepId: 'same-day', offsetMinutes: 0, messageType: 'text', messageContent: '本日の相談についてのご案内と持ち物の確認です。', offsetDays: 0, sendAtTime: '09:00' },
    ],
  },
  lastTestStatus: 'succeeded',
  lastTestedAt: '2026-09-06T09:00:00.000Z',
  publishedAt: null,
}

/*
 * 板 `YChR6`・`p5YuP`・`T0nis`・`ltAaq`（リマインダを作る②〜⑤、
 * `id=reminder-new`）。名前・2通の本文・最終テスト日時を絵に合わせる。
 * 他IDは `REMINDER_DRAFT` のまま（`apLqS` の一覧に影響させない）。
 */
export const REMINDER_NEW_DRAFT = {
  ...REMINDER_DRAFT,
  reminderId: 'reminder-new',
  versionId: 'reminder-new-draft-v1',
  versionNumber: 1,
  settings: {
    ...REMINDER_DRAFT.settings,
    name: '予約前日のご案内',
    description: '前日・1時間前の2回で案内する',
    steps: [
      { stableStepId: 'day-before', offsetMinutes: 0, messageType: 'text', messageContent: '{名前}さん\n明日 {予約日時} からのご相談のご案内です。\n時間になったら下のURLから参加してください。\n{Google Meet の URL}', offsetDays: -1, sendAtTime: '18:00' },
      { stableStepId: 'hour-before', offsetMinutes: -60, messageType: 'text', messageContent: 'まもなくご予約のお時間です。', offsetDays: null, sendAtTime: null },
    ],
  },
  lastTestedAt: '2026-09-30T17:42:00+09:00',
}

/** 機能7の公開前チェック（`POST /api/reminders/:id/validate` の固定の返事）。 */
export const REMINDER_VALIDATE = {
  valid: true,
  checks: [
    { key: 'steps', label: '通知ステップ', status: 'passed', message: '3件の通知があります' },
    { key: 'bodies', label: '送る内容', status: 'passed', message: '空の通知はありません' },
    { key: 'test_send', label: 'テスト送信', status: 'passed', message: '直近のテストは成功しています' },
  ],
  audience: { matched: 398, excluded: 28 },
}

/** 機能7の対象者数え直し（`POST /api/reminders/:id/audience` の固定の返事）。R15。 */
export const REMINDER_AUDIENCE = {
  matched: 5,
  excluded: 2,
  sample: [
    { id: 'visual-friend-1', displayName: '山田花子' },
    { id: 'visual-friend-2', displayName: '佐藤太郎' },
  ],
}

/** 機能7の配信予定（`POST /api/reminders/:id/preview` の固定の返事）。 */
export const REMINDER_PREVIEW = {
  targetDate: '2026-08-25T00:00:00.000Z',
  items: [
    { stableStepId: 'day-before', stepNumber: 1, scheduledAt: '2026-08-24T09:00:00.000Z', label: '前日のお知らせ', state: 'scheduled' },
    { stableStepId: 'hour-before', stepNumber: 2, scheduledAt: '2026-08-25T01:00:00.000Z', label: '1時間前のお知らせ', state: 'scheduled' },
    { stableStepId: 'same-day', stepNumber: 3, scheduledAt: '2026-08-25T00:00:00.000Z', label: '当日のご案内', state: 'scheduled' },
  ],
  summary: { audience: 398, next7Days: 124, next30Days: 1194, duplicateCount: 2 },
}

/*
 * 板 `ltAaq`（確認）の配信予定の行は `今後7日 124通（重なり 3件はまとめる）`。
 * `T0nis` の表は「今後7日」を実時計で絞るため、行の日時は見本の API を立てた
 * 固定時計から数える（明日 18:00 ×2〈重なり〉・明後日 13:00・明後日 18:00 の4行）。
 */
function reminderNewPreviewAt(dayOffset, hour) {
  return storeAt(hour, 0, dayOffset)
}
export const REMINDER_NEW_PREVIEW = {
  ...REMINDER_PREVIEW,
  items: [
    { stableStepId: 'day-before', stepNumber: 1, scheduledAt: reminderNewPreviewAt(1, 18), label: '前日のお知らせ', state: 'scheduled' },
    { stableStepId: 'day-before', stepNumber: 1, scheduledAt: reminderNewPreviewAt(1, 18), label: '前日のお知らせ', state: 'duplicate' },
    { stableStepId: 'hour-before', stepNumber: 2, scheduledAt: reminderNewPreviewAt(2, 13), label: '1時間前のお知らせ', state: 'scheduled' },
    { stableStepId: 'day-before', stepNumber: 1, scheduledAt: reminderNewPreviewAt(2, 18), label: '前日のお知らせ', state: 'scheduled' },
  ],
  summary: { audience: 172, next7Days: 124, next30Days: 1194, duplicateCount: 3 },
}

/** 機能7のテスト送信（`POST /api/reminders/:id/test-send` の固定の返事）。 */
export const REMINDER_TEST_SEND = {
  sent: 1, recipientName: 'Demo Person', replayed: false,
  requestId: 'visual-qa-test-1', testedAt: '2026-09-06T09:00:00.000Z',
}

/** 機能7の公開（`POST /api/reminders/:id/publish` の固定の返事）。 */
export const REMINDER_PUBLISH = {
  reminderId: 'reminder-3', versionId: 'reminder-3-draft-v3', versionNumber: 3,
  publishedAt: '2026-09-06T09:00:00.000Z', audience: 398,
  plannedDeliveries: 1194, nextScheduledAt: '2025-10-01T09:00:00.000Z',
}

/**
 * 友だち情報欄の項目。リマインダの起点（`triggerFieldId`）に日付の欄が要る。
 *
 * **`FriendField` の型どおりに書く。** `type` は10種類の決まった言葉で、
 * ここに設計の日本語を入れると欄は既定の1行入力として描かれ、
 * 「日付の欄だけ選べる」という決まりを**何も確かめないまま**撮れてしまう。
 */
export const FRIEND_FIELDS = [
  {
    id: 'field-birthday', folderId: 'friend-field-folder-purchase', name: '誕生日', fieldKey: 'birthday',
    type: 'date', options: null, defaultValue: null, source: 'manual',
    ecFieldPath: null, ecIsMaster: false, isPersonal: false, isStarred: true,
    displayOrder: 1, createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-01-05T00:00:00.000Z',
  },
  {
    id: 'field-contract-end', folderId: null, name: '契約終了日', fieldKey: 'contract_end',
    type: 'date', options: null, defaultValue: null, source: 'manual',
    ecFieldPath: null, ecIsMaster: false, isPersonal: false, isStarred: false,
    displayOrder: 2, createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-01-05T00:00:00.000Z',
  },
  {
    id: 'field-next-delivery', folderId: null, name: '次回お届け日', fieldKey: 'next_delivery',
    type: 'date', options: null, defaultValue: null, source: 'ec',
    ecFieldPath: 'subscription.next_ship_at', ecIsMaster: true, isPersonal: false, isStarred: false,
    displayOrder: 3, createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-01-05T00:00:00.000Z',
  },
  {
    id: 'field-plan', folderId: null, name: 'ご契約プラン', fieldKey: 'plan',
    type: 'select', options: ['ライト', 'スタンダード', 'プレミアム'], defaultValue: null,
    source: 'manual', ecFieldPath: null, ecIsMaster: false, isPersonal: false, isStarred: false,
    displayOrder: 4, createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-01-05T00:00:00.000Z',
  },
]

/**
 * 機能4「友だち情報欄」。設計 `HBTk0` に見えている4行。
 * リマインダ等が使う `FRIEND_FIELDS` とは分け、`withUsage=1` の一覧だけで返す。
 */
export const FRIEND_ATTRIBUTE_FIELDS = [
  {
    id: 'field-dog-name', folderId: 'friend-field-folder-pets', name: '愛犬のお名前', fieldKey: 'dog_name',
    type: 'text', options: null, defaultValue: null, source: 'form',
    ecFieldPath: null, ecIsMaster: false, isPersonal: false, isStarred: false,
    displayOrder: 1, usageCount: 187, formUsageCount: 3,
    displayTargets: ['友だち詳細', 'テンプレート差し込み'],
    createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z',
  },
  {
    id: 'field-prefecture', folderId: 'friend-field-folder-contact', name: 'お住まい', fieldKey: 'prefecture',
    type: 'select', options: ['北海道', '東京都', '大阪府', '福岡県'], defaultValue: null, source: 'form',
    ecFieldPath: null, ecIsMaster: false, isPersonal: true, isStarred: false,
    displayOrder: 2, usageCount: 164, formUsageCount: 2,
    displayTargets: ['友だち詳細', '配信の絞り込み'],
    createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-08-19T00:00:00.000Z',
  },
  {
    id: 'field-birthday', folderId: 'friend-field-folder-purchase', name: '生年月日', fieldKey: 'birthday',
    type: 'date', options: null, defaultValue: null, source: 'form',
    ecFieldPath: null, ecIsMaster: false, isPersonal: true, isStarred: false,
    displayOrder: 3, usageCount: 141, formUsageCount: 1,
    displayTargets: ['友だち詳細', '誕生日配信'],
    createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z',
  },
  {
    id: 'field-delivery-status', folderId: null, name: '便の状態', fieldKey: 'delivery_status',
    type: 'select', options: ['準備中', '配送中', 'お届け済み'], defaultValue: null, source: 'automation',
    ecFieldPath: null, ecIsMaster: false, isPersonal: false, isStarred: false,
    displayOrder: 4, usageCount: 72, formUsageCount: 2,
    displayTargets: ['友だち詳細', 'オートメーション'],
    createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-08-17T00:00:00.000Z',
  },
  {
    id: 'field-phone', folderId: 'friend-field-folder-pets', name: '電話番号', fieldKey: 'phone_number',
    type: 'text', options: null, defaultValue: null, source: 'manual',
    ecFieldPath: null, ecIsMaster: false, isPersonal: true, isStarred: false,
    displayOrder: 5, usageCount: 78, formUsageCount: 1,
    displayTargets: ['友だち詳細', '配信の絞り込み'],
    createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-08-16T00:00:00.000Z',
  },
]

export const FRIEND_FIELD_FOLDERS = [
  // 板 q5gbcM：ペット・連絡先・購入（名前の前の色の丸もこの色）。
  { id: 'friend-field-folder-pets', kind: 'friend_field', name: 'ペット', color: '#2f6fde', displayOrder: 1 },
  { id: 'friend-field-folder-contact', kind: 'friend_field', name: '連絡先', color: '#1f9d55', displayOrder: 2 },
  { id: 'friend-field-folder-purchase', kind: 'friend_field', name: '購入', color: '#e07b24', displayOrder: 3 },
]

/**
 * 友だち情報欄を変える前の固定確認。#1092 の保存契約と同じ器で、
 * 値は変えずに「そのまま／人が確認／空欄」と使用先を返す。
 */
export const FRIEND_FIELD_MIGRATION_PREVIEW = {
  source: {
    ...FRIEND_ATTRIBUTE_FIELDS.find((field) => field.id === 'field-birthday'),
    status: 'active', version: 3, canInsertText: true,
  },
  target: {
    id: 'field-birthday-new', folderId: null, name: '生年月日（新）', fieldKey: 'birthday_new',
    type: 'date', options: null, optionDefinitions: null, defaultValue: null, source: 'manual',
    ecFieldPath: null, ecIsMaster: false, isPersonal: true, isStarred: false,
    displayOrder: 4, status: 'active', version: 1, canInsertText: true,
    createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z',
  },
  summary: { total: 141, convertible: 137, review: 3, invalid: 1 },
  rows: [
    { friendId: 'friend-birthday-review-1', sourceValue: '8月13日', convertedValue: null, status: 'review', reason: '年を含む日付か確認してください' },
    { friendId: 'friend-birthday-review-2', sourceValue: '2026/2/31', convertedValue: null, status: 'review', reason: '存在する日付か確認してください' },
    { friendId: 'friend-birthday-review-3', sourceValue: '平成5年4月2日', convertedValue: null, status: 'review', reason: '西暦の日付へ直してください' },
    { friendId: 'friend-birthday-invalid-1', sourceValue: '', convertedValue: null, status: 'invalid', reason: '値が空欄です' },
  ],
  usageTargets: [
    { kind: 'form', fieldId: 'field-birthday', id: 'form-5', name: '会員登録', switchable: true },
    { kind: 'reminder', fieldId: 'field-birthday', id: 'reminder-birthday', name: '誕生日のお知らせ', switchable: true },
    { kind: 'saved_search', fieldId: 'field-birthday', id: 'saved-search-birthday', name: '誕生日30日前', switchable: true },
  ],
  runId: 'field-migration-run-birthday-1',
  previewToken: 'visual-qa-field-migration-preview-token',
  previewExpiresAt: '2026-09-07T15:15:00.000Z',
}

/**
 * 板 GobMd：「愛犬のお名前」（1行テキスト）を「1つ選ぶ」へ変えるときの見本。
 * 種類だけの事前確認（移行先なし）なので確認番号は出ない。値は選ぶ候補に足して移す。
 */
export const FRIEND_FIELD_MIGRATION_PREVIEW_DOG = {
  source: {
    ...FRIEND_ATTRIBUTE_FIELDS.find((field) => field.id === 'field-dog-name'),
    status: 'active', version: 2, canInsertText: true,
  },
  summary: { total: 69, convertible: 0, review: 69, invalid: 0 },
  rows: [
    ...Array.from({ length: 41 }, (_, index) => ({ friendId: `friend-dog-pochi-${index + 1}`, sourceValue: 'ポチ', convertedValue: 'ポチ（選ぶ候補に足す）', status: 'review', reason: '選ぶ候補に足します' })),
    ...Array.from({ length: 28 }, (_, index) => ({ friendId: `friend-dog-coco-${index + 1}`, sourceValue: 'ココ', convertedValue: 'ココ（選ぶ候補に足す）', status: 'review', reason: '選ぶ候補に足します' })),
  ],
  usageTargets: [],
  runId: null,
  previewToken: null,
  previewExpiresAt: null,
}

/**
 * 機能8 自動応答。設計 `cmDfJ` の5行。
 *
 * **画面が読む形に合わせる。** `packages/shared` の `AutoReply` は
 * `keyword / matchType / responseType / responseContent / isActive` しか
 * 持たないが、画面（`auto-replies/page.tsx`）はそれより広い形を読む
 * （`priority` `folderId` `actions` `responseWeekdays` `hits` など）。
 * 狭いほうに合わせて書くと、優先順位も曜日も当たり回数も空のまま撮れて、
 * **設計の一覧と比べるものが何も無くなる。**
 */
/* V8 板 `uE9gf`（自動応答一覧）の5件に合わせた分け方。お問い合わせ2・
 * 予約1・営業時間外1・未分類1（「キーワード」というフォルダは絵に無い）。
 * 未分類の1件は `folderId: null` で返し、件数は mock-api が
 * `unfiledCount` で返す。 */
export const AUTO_REPLY_FOLDERS = [
  { id: 'arf-inquiry', kind: 'auto_reply', name: 'お問い合わせ', parentId: null, displayOrder: 1, color: '#2563eb', itemCount: 2 },
  { id: 'arf-booking', kind: 'auto_reply', name: '予約', parentId: null, displayOrder: 2, color: '#059669', itemCount: 1 },
  { id: 'arf-afterhours', kind: 'auto_reply', name: '営業時間外', parentId: null, displayOrder: 3, color: '#7c3aed', itemCount: 1 },
]

const AR_BASE = {
  templateId: null, lineAccountId: null, activeFrom: null, activeUntil: null,
  cooldownMinutes: null, skipWhenOperatorActive: false, messageKinds: null,
  receiveSources: ['line'],
  responseWeekdays: null, responseHolidayRule: null, oncePerFriend: false,
  friendConditions: null, respondToAll: false, keywordMatchMode: 'any',
}

export const AUTO_REPLIES = [
  {
    ...AR_BASE, id: 'ar-1', name: '営業時間外の自動返信', keyword: '', matchType: 'contains',
    responseType: 'text', responseContent: '本日の受付は終了しました。翌営業日にご連絡します。',
    isActive: true, priority: 1, folderId: 'arf-afterhours',
    activeFrom: '21:00', activeUntil: '09:00',
    responseWeekdays: [0, 1, 2, 3, 4, 5, 6], respondToAll: true,
    actions: [{ actionType: 'support_mark' }],
    keywords: [], hits: { period: 214, total: 1842 },
    // 絵 uE9gf：1行目（営業時間外）には「重なり」の札が無い。要確認の数（3）は別の口（集計）から出る。
    actionExecutionCount: 86, conflictAttentionCount: 0,
    createdAt: '2026-03-04T00:00:00.000Z',
  },
  {
    ...AR_BASE, id: 'ar-2', name: '予約変更のお問い合わせ', keyword: '予約変更', matchType: 'contains',
    responseType: 'text', responseContent: '予約変更を承ります。ご希望の日時をこのトークでお知らせください。',
    isActive: true, priority: 2, folderId: 'arf-booking', templateId: 'template-1',
    keywords: [{ keyword: '予約変更', matchType: 'contains' }, { keyword: '日程変更', matchType: 'contains' }, { keyword: 'キャンセル', matchType: 'contains' }],
    actions: [{ actionType: 'support_mark' }],
    hits: { period: 128, total: 902 }, actionExecutionCount: 64, conflictAttentionCount: 1,
    createdAt: '2026-04-18T00:00:00.000Z',
  },
  {
    ...AR_BASE, id: 'ar-3', name: '商品についての質問', keyword: '商品', matchType: 'contains',
    responseType: 'text', responseContent: '商品についてのご質問ありがとうございます。',
    isActive: true, priority: 3, folderId: 'arf-inquiry',
    keywords: [{ keyword: '商品', matchType: 'contains' }, { keyword: '価格', matchType: 'contains' }, { keyword: '在庫', matchType: 'contains' }, { keyword: 'サイズ', matchType: 'contains' }, { keyword: '送料', matchType: 'contains' }],
    actions: [{ actionType: 'tag' }],
    hits: { period: 210, total: 1235 }, actionExecutionCount: 64, conflictAttentionCount: 1,
    createdAt: '2026-05-06T00:00:00.000Z',
  },
  {
    /* 下書き。**当たった回数は0。** 「一度も当たっていない」と
       「まだ動かしていない」は違うので、0で撮れることが要る。 */
    ...AR_BASE, id: 'ar-4', name: 'キャンセル受付', keyword: 'キャンセル', matchType: 'contains',
    responseType: 'text', responseContent: 'キャンセルを承りました。',
    isActive: false, priority: 4, folderId: 'arf-inquiry',
    keywords: [{ keyword: 'キャンセル', matchType: 'contains' }, { keyword: '取消', matchType: 'contains' }],
    actions: [], hits: { period: 0, total: 0 }, actionExecutionCount: 0, conflictAttentionCount: 0,
    createdAt: '2026-08-12T00:00:00.000Z',
  },
  {
    ...AR_BASE, id: 'ar-5', name: '旧キーワードルール', keyword: '営業時間', matchType: 'exact',
    responseType: 'text', responseContent: '平日 09:00〜18:00 です。',
    isActive: false, priority: 5, folderId: null,
    keywords: [{ keyword: '営業時間', matchType: 'exact' }],
    actions: [], hits: { period: 0, total: 0 }, actionExecutionCount: 0, conflictAttentionCount: 0,
    createdAt: '2026-01-20T00:00:00.000Z',
  },
]

const autoReplyRun = (id, friendName, occurredAt, inputPreview, status, detail, overrides = {}) => ({
  id,
  ownerKind: 'auto_reply',
  ownerId: 'ar-2',
  lineAccountId: 'visual-qa-account',
  occurredAt,
  subject: friendName,
  accountLabel: '然-NEN-TEST',
  triggerLabel: '予約',
  reference: `message-${id}`,
  status,
  detail,
  durationMs: 800,
  canRetry: false,
  autoReplyId: 'ar-2',
  autoReplyName: '予約変更のお問い合わせ',
  friendId: `friend-${id}`,
  friendName,
  messageKind: 'text',
  inputPreview,
  matchedKeyword: '予約',
  versionNumber: 3,
  domainStatus: status === 'failed' ? 'reply_failed' : status === 'pending' ? 'actions_running' : 'completed',
  replyStatus: status === 'failed' ? 'failed' : status === 'pending' ? 'not_attempted' : 'accepted',
  actionSummary: {},
  lineRequestId: status === 'succeeded' ? `line-request-${id}` : null,
  ...overrides,
})

/* 板 `nWmLg`（実行結果）。開くID（`ar-2`）と名前を合わせないと画面が
 * 読み込み中のままになる。帯の数（214回・累計1842・36件・3件・0.8秒）は
 * 既に絵と一致。 */
export const AUTO_REPLY_RUNS = {
  rule: { id: 'ar-2', name: '予約変更のお問い合わせ', isActive: true, priorityPosition: 2 },
  summary: {
    monthHits: 214,
    totalHits: 1_842,
    handovers: 36,
    errors: 3,
    lastRunAt: '2026-08-25T10:32:00+09:00',
    averageResponseMs: 800,
  },
  handovers: { waiting: 8, inProgress: 21, completed: 7 },
  triggerBreakdown: [
    { trigger: '予約', count: 128, share: 0.598 },
    { trigger: '日程変更', count: 54, share: 0.252 },
    { trigger: 'キャンセル', count: 32, share: 0.15 },
  ],
  /* 板 `nWmLg` の実行の記録5行。行ったことは絵の文言そのまま（実装は
   * 中身が無いときだけ `detail` を出す）。見送りは `skipped` で数える。 */
  items: [
    autoReplyRun('1', 'Demo Person', '2026-08-25T10:32:00+09:00', '予約を変更したい', 'succeeded', '返信＋対応マーク「予約変更」', { replyStatus: 'sent', durationMs: 600 }),
    autoReplyRun('2', 'Masato S.', '2026-08-25T10:28:00+09:00', '予約の確認', 'succeeded', '返信＋対応マーク「予約変更」', { replyStatus: 'sent', durationMs: 700, matchedKeyword: '予約の確認' }),
    autoReplyRun('3', '見本 15', '2026-08-25T10:21:00+09:00', '予約キャンセル', 'pending', '返信＋担当者へ引き継ぎ', { replyStatus: 'not_attempted', domainStatus: 'actions_running', durationMs: 900, matchedKeyword: 'キャンセル' }),
    autoReplyRun('4', '見本 141', '2026-08-25T10:14:00+09:00', '予約', 'failed', 'LINEへの返信を受け付けてもらえませんでした', { durationMs: 1_200 }),
    autoReplyRun('5', '見本 25', '2026-08-25T10:02:00+09:00', '日程変更したい', 'skipped', '上のルール「営業時間外の自動返信」が先に動いた', { replyStatus: 'not_attempted', domainStatus: 'skipped', durationMs: null, matchedKeyword: '日程変更' }),
  ],
  pagination: { total: 214, limit: 20, offset: 0 },
}

/** 機能8の公開フロー。設計 g46ja / Yj6CQ / e6iJG と同じ1件を通す。 */
/* ★V8 作る②〜⑤（A0pDt・rfhIf・Guoye）の絵：作りかけの下書き「予約の日程変更」。
   一覧（uE9gf）の絵には出ないので AUTO_REPLIES には入れない。/api/auto-replies/ar-new だけが返す。 */
export const AUTO_REPLY_NEW_DRAFT = {
  autoReplyId: 'ar-new',
  versionId: 'ar-new-draft-v1',
  versionNumber: 1,
  status: 'draft',
  lastTestStatus: null,
  lastTestedAt: null,
  publishedAt: null,
  matchedLast28Days: null,
  conflictAttentionCount: 0,
  settings: {
    ...AR_BASE,
    name: '予約の日程変更',
    folderId: 'arf-booking',
    internalMemo: '',
    keyword: '予約変更',
    matchType: 'contains',
    keywords: [
      { keyword: '予約変更', matchType: 'contains' },
      { keyword: '日程変更', matchType: 'contains' },
      { keyword: '予約をずらしたい', matchType: 'contains' },
    ],
    keywordMatchMode: 'any',
    respondToAll: false,
    messageKinds: ['text'],
    responseWeekdays: [1, 2, 3, 4, 5],
    responseHolidayRule: 'ignore',
    friendConditions: null,
    responseType: 'text',
    templateId: null,
    responseContent: '{{name}}さん、ご連絡ありがとうございます。\n予約の変更は、下のボタンから日時を選び直せます。担当からも折り返しご連絡します。',
    lineAccountId: 'visual-qa-account',
    actions: [
      // 実際の形（markId・notificationRuleId）で持つ。名前は既存の見本（絵の「予約変更」「Demo Person」はデータの文字の違いとして扱う）。
      { actionType: 'support_mark', config: { markId: 'mark-in-progress' }, onFailure: 'continue' },
      { actionType: 'notify_staff', config: { notificationRuleId: 'operator-rule-1', notificationRuleVersion: 1, message: '予約の日程変更のお問い合わせがありました。' }, onFailure: 'stop' },
    ],
    replyDelaySeconds: 0,
    cooldownMinutes: 60,
    skipWhenOperatorActive: true,
    oncePerFriend: false,
    unmatchedAction: null,
    receiveSources: ['line'],
    priority: 6,
  },
}
/* 作る④（Guoye）の絵：下書き「予約の日程変更」と重なるのは 2番目「予約変更のお問い合わせ」（必ず）と 1番目「営業時間外の自動返信」（ことがある）。 */
export const AUTO_REPLY_NEW_CONFLICTS = [
  { autoReplyId: 'ar-2', name: '予約変更のお問い合わせ', certainty: 'certain', winnerAutoReplyId: 'ar-2', reason: '「予約変更」を含むメッセージに反応します。' },
  { autoReplyId: 'ar-1', name: '営業時間外の自動返信', certainty: 'possible', winnerAutoReplyId: 'ar-1', reason: '営業時間外は、すべてのメッセージに反応します。' },
]
export const AUTO_REPLY_NEW_LIVE = {
  ...AR_BASE, id: 'ar-new', name: '予約の日程変更', keyword: '予約変更', matchType: 'contains',
  responseType: 'text', responseContent: '', isActive: false, lifecycleStatus: 'draft', priority: 6,
  folderId: 'arf-booking', keywords: [], actions: [], hits: { period: 0, total: 0 },
  actionExecutionCount: 0, conflictAttentionCount: 0, createdAt: '2026-10-05T00:00:00.000Z',
}

export const AUTO_REPLY_PUBLISH_DRAFT = {
  autoReplyId: 'ar-2',
  versionId: 'ar-2-draft-v3',
  versionNumber: 3,
  status: 'draft',
  lastTestStatus: null,
  lastTestedAt: null,
  publishedAt: null,
  matchedLast28Days: 86,
  conflictAttentionCount: 0,
  settings: {
    keyword: '予約',
    matchType: 'contains',
    responseType: 'text',
    responseContent: '{{name}}さん、お問い合わせありがとうございます。\nご予約内容を確認します。日時の変更・キャンセルの場合は下のボタンからお選びください。',
    templateId: null,
    lineAccountId: 'visual-qa-account',
    activeFrom: null,
    activeUntil: null,
    cooldownMinutes: 5,
    skipWhenOperatorActive: true,
    priority: 2,
    messageKinds: ['text'],
    receiveSources: ['line', 'email'],
    friendConditions: { label: '予約者・未対応' },
    actions: [
      { actionType: 'add_tag', config: { tagId: 'tag-booking' } },
      { actionType: 'notify', config: { notificationDefinitionId: 'notify-operator' } },
    ],
    responseWeekdays: [0, 1, 2, 3, 4, 5, 6],
    responseHolidayRule: 'include',
    oncePerFriend: true,
    keywords: [{ keyword: '予約', matchType: 'contains' }],
    respondToAll: false,
    name: '予約変更のお問い合わせ',
    keywordMatchMode: 'any',
    folderId: 'arf-inquiry',
    internalMemo: '日程変更の一次対応。担当者に引き継ぐ前の受け止めとして使う。',
    replyDelaySeconds: 0,
    unmatchedAction: { type: 'notify_operator' },
  },
}

/** 機能8の一覧・競合画面が読む横断集計。公開前の1件用競合とは分ける。 */
export const AUTO_REPLY_CONFLICT_SUMMARY = {
  conflicts: [
    {
      leftAutoReplyId: 'ar-1', rightAutoReplyId: 'ar-2', winnerAutoReplyId: 'ar-1',
      certainty: 'possible', reason: '営業時間外は予約変更の言葉にも反応します。',
    },
    {
      leftAutoReplyId: 'ar-2', rightAutoReplyId: 'ar-3', winnerAutoReplyId: 'ar-2',
      certainty: 'possible', reason: '商品予約についての質問で条件が重なります。',
    },
    {
      leftAutoReplyId: 'ar-1', rightAutoReplyId: 'ar-3', winnerAutoReplyId: 'ar-1',
      certainty: 'possible', reason: '営業時間外の商品質問で条件が重なります。',
    },
  ],
  conflictCount: 3,
  receiveSourceCounts: [
    { source: 'text', count: 5740 },
    { source: 'image', count: 76 },
    { source: 'sticker', count: 26 },
  ],
  matchedLast28Days: 682,
}

export const AUTO_REPLY_PUBLISH_CONFLICTS = [
  {
    autoReplyId: 'ar-hours',
    name: '「営業時間」への一律返信',
    certainty: 'possible',
    winnerAutoReplyId: 'ar-2',
    reason: '時間帯によって同じメッセージに反応します。',
  },
  {
    autoReplyId: 'ar-booking-existing',
    name: '予約の問い合わせ',
    certainty: 'certain',
    winnerAutoReplyId: 'ar-2',
    reason: '「予約」を含むメッセージに反応します。',
  },
]

export const AUTO_REPLY_PUBLISH_TEST = {
  matched: true,
  draftWon: true,
  winner: {
    autoReplyId: 'ar-2',
    name: '予約変更のお問い合わせ',
    responseType: 'text',
    responseContent: '予約変更を承ります。ご希望の日時をこのトークでお知らせください。\n担当者から改めてご連絡します。',
  },
  candidates: [
    { autoReplyId: 'ar-2', name: '予約変更のお問い合わせ', priority: 1, result: 'won', reasonCodes: [] },
  ],
  actions: [{ kind: 'set_support_mark' }],
  stateChanged: false,
}

export const AUTO_REPLY_PUBLISH_VALIDATION = {
  valid: true,
  errors: [],
  warnings: ['同じメッセージに反応する自動応答があります。'],
  conflicts: AUTO_REPLY_PUBLISH_CONFLICTS,
  lastTestStatus: 'succeeded',
}

export const AUTO_REPLY_PUBLISH_RESULT = {
  autoReplyId: 'ar-2',
  versionId: 'ar-2-published-v3',
  versionNumber: 3,
  publishedAt: '2026-09-06T10:00:00.000Z',
  acknowledgedConflictIds: AUTO_REPLY_PUBLISH_CONFLICTS.map((item) => item.autoReplyId),
}

/*
  外部連携。設計 `k3WxrO` の「こちらから送る 6／こちらで受け取る 3」そのまま。

  **つなぎ先はサービス名で持つ。** 設計は Slack・Googleスプレッドシート・kintone と
  相手の名前で見せる。`Webhook` は仕組みの名前で、運用者が探すときの手がかりにならない。
  URLは設計と同じく途中を伏せる（実在しない作り物）。
*/
export const OUTGOING_WEBHOOKS = [
  {
    id: 'owh-slack-order', name: 'Slack ／ #注文チャンネル',
    url: 'https://hooks.slack.com/services/T0XXXXXXXXX/BXXXXXXXXX/visual-qa',
    eventTypes: ['conversion.confirmed'], hasSecret: true, isActive: true,
    maxRetries: 3, consecutiveFailures: 2, lastFailedAt: '2026-08-24T05:12:00.000Z',
    deliverySummary: {
      periodDays: 30, total: 486, succeeded: 480, failed: 6, pending: 0,
      successRate: 98.77,
      lastResult: { status: 'failed', responseStatus: 503, completedAt: '2026-08-24T05:12:00.000Z', failureReason: '相手が応答しませんでした' },
      canRetry: true,
    },
    createdAt: '2026-04-01T00:00:00.000Z', updatedAt: '2026-08-24T05:12:00.000Z',
  },
  {
    id: 'owh-sheets', name: 'Googleスプレッドシート ／ 顧客台帳',
    url: 'https://script.google.com/macros/s/visual-qa/exec',
    eventTypes: ['friend.added'], hasSecret: true, isActive: true,
    maxRetries: 3, consecutiveFailures: 0, lastFailedAt: null,
    deliverySummary: {
      periodDays: 30, total: 312, succeeded: 312, failed: 0, pending: 0,
      successRate: 100,
      lastResult: { status: 'succeeded', responseStatus: 200, completedAt: '2026-08-25T02:30:00.000Z', failureReason: null },
      canRetry: false,
    },
    createdAt: '2026-03-10T00:00:00.000Z', updatedAt: '2026-08-25T02:30:00.000Z',
  },
  {
    id: 'owh-kintone', name: 'kintone ／ 案件アプリ',
    url: 'https://visual-qa.cybozu.com/k/v1/record.json',
    eventTypes: ['form.submitted'], hasSecret: true, isActive: true,
    maxRetries: 3, consecutiveFailures: 0, lastFailedAt: null,
    deliverySummary: {
      periodDays: 30, total: 42, succeeded: 42, failed: 0, pending: 0,
      successRate: 100,
      lastResult: { status: 'succeeded', responseStatus: 200, completedAt: '2026-08-25T01:10:00.000Z', failureReason: null },
      canRetry: false,
    },
    createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-08-25T01:10:00.000Z',
  },
  {
    id: 'owh-zapier', name: 'Zapier ／ ひとまとめ',
    url: 'https://hooks.zapier.com/hooks/catch/000000/visual-qa/',
    eventTypes: ['form.submitted'], hasSecret: true, isActive: true,
    maxRetries: 3, consecutiveFailures: 0, lastFailedAt: null,
    deliverySummary: {
      periodDays: 30, total: 34, succeeded: 34, failed: 0, pending: 0,
      successRate: 100,
      lastResult: { status: 'succeeded', responseStatus: 200, completedAt: '2026-08-22T04:00:00.000Z', failureReason: null },
      canRetry: false,
    },
    createdAt: '2026-06-02T00:00:00.000Z', updatedAt: '2026-08-22T04:00:00.000Z',
  },
  {
    /* 設計の5行目。**合言葉なしの1本**でもある（健全性チェックの「注意」の元）。 */
    id: 'owh-inventory', name: '自社の在庫システム',
    url: 'https://api.example.com/stock/visual-qa',
    eventTypes: ['conversion.confirmed'], hasSecret: false, isActive: false,
    maxRetries: 0, consecutiveFailures: 0, lastFailedAt: null,
    deliverySummary: {
      periodDays: 30, total: 0, succeeded: 0, failed: 0, pending: 0,
      successRate: null, lastResult: null, canRetry: false,
    },
    createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  },
  {
    /*
      2ページ目の1本。設計の先頭5件へ割り込まないよう、送信実績は0件。
      V8 の一覧（ZSbFY）は名前順で先頭に来るので、絵の1行目と同じ
      「友だちになった・タグが付いた」を送る形にする。
    */
    id: 'owh-chatwork', name: 'Chatwork ／ 店舗連絡',
    url: 'https://api.chatwork.com/v2/rooms/000000/messages',
    eventTypes: ['friend_add', 'tag_change'], hasSecret: true, isActive: true,
    maxRetries: 3, consecutiveFailures: 0, lastFailedAt: null,
    deliverySummary: {
      periodDays: 30, total: 0, succeeded: 0, failed: 0, pending: 0,
      successRate: null, lastResult: null, canRetry: false,
    },
    createdAt: '2026-05-20T00:00:00.000Z', updatedAt: '2026-07-31T09:00:00.000Z',
  },
]

/** 機能26。外部送信は行わず、本番APIと同じ成功の器だけを返す。 */
export const OUTGOING_WEBHOOK_TEST_RESULT = { delivered: true, responseStatus: 204 }

/**
 * 受け取る口。V8 の絵 `gW0F2` の3本（申込フォーム・ネットショップの注文・旧予約システム）。
 * id は前と同じ（詳細・試しの見本が id で引くため）。
 */
export const INCOMING_WEBHOOKS = [
  {
    id: 'iwh-booking', name: '申込フォーム', sourceType: 'form',
    hasSecret: true, isActive: true,
    createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
  },
  {
    id: 'iwh-survey', name: 'ネットショップの注文', sourceType: 'ec',
    hasSecret: true, isActive: true,
    createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
  },
  {
    id: 'iwh-accounting', name: '旧予約システム', sourceType: 'booking',
    hasSecret: false, isActive: false,
    createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-08-31T00:00:00.000Z',
  },
]

/**
 * 受け取り口1件。本文は構造だけ残し、値をすべてマスクする。
 * 絵 `gW0F2`：メールアドレスで探す・見つからないときは友だち候補を作る・
 * 届いたらすること2つ・人が見つからなかった届物2件。
 */
export const INCOMING_WEBHOOK_DETAILS = {
  'iwh-booking': {
    ...INCOMING_WEBHOOKS[0],
    version: 3,
    identityMatching: {
      methods: [{ kind: 'verified_email', path: '$.email' }],
      onNotFound: 'create_candidate',
    },
    actions: [
      { refKind: 'tag', refId: 'tag-form-entry', refVersionId: null, displayName: 'フォーム申込' },
      { refKind: 'automation', refId: 'au-entry-thanks', refVersionId: null, displayName: '申込のお礼' },
    ],
    actionExecution: {
      state: 'connected',
      reason: null,
    },
    latestSample: null,
    templateFields: [
      { path: '$.email', type: 'string', token: '{{payload.email}}' },
      { path: '$.form', type: 'string', token: '{{payload.form}}' },
    ],
    pendingUnmatched: 2,
    previousSecretUsableUntil: null,
  },
}

/** 人が見つからなかった届物（絵 `gW0F2` の2行）。値は伏せた形だけ。 */
export const INCOMING_WEBHOOK_UNMATCHED = [
  {
    id: 'iwu-1', kind: 'candidate', status: 'pending',
    identityAttempts: [{ kind: 'verified_email', path: '$.email', value: 'm.sakamoto@…' }],
    maskedShape: null,
    candidates: [{ friendId: 'friend-1', displayName: '見本 25' }],
    resolvedFriendId: null, resolvedAt: null, receivedAt: '2026-09-30T00:31:00.000Z',
  },
  {
    id: 'iwu-2', kind: 'unmatched', status: 'pending',
    identityAttempts: [{ kind: 'verified_phone', path: '$.tel', value: '090-****-1234' }],
    maskedShape: null,
    candidates: [],
    resolvedFriendId: null, resolvedAt: null, receivedAt: '2026-09-29T09:02:00.000Z',
  },
]

/*
  流入経路。設計 `Q4bkTg` の6本そのまま。

  **`refCode` は運用者が決めてURLに出す符号**なので、値は設計の `summer-ig` などを使う。
  内部の列名は画面へ出さない。URLに出す運用者の符号とは区別する。
*/
/* 板 `xbHxg`（流入と計測一覧）の6行。フォルダは広告1・SNS1・店頭1・
 * 未分類3（紹介と紙の分類は絵に無いので `genre: null`）。メール署名は
 * 未登録（`orphan` の行）のため経路自体を持たない。動きが未設定の2件は
 * Google広告とチラシ（タグもシナリオも無い行）。
 * 「友だちになったら」は絵どおり、Instagram と紹介リンクはシナリオ無し（1行目が「—」）・タグだけ。 */
export const ENTRY_ROUTES = [
  { id: 'er-1', refCode: 'summer-ig', genre: 'SNS', name: '夏のInstagram投稿', tagId: 'tag-vip', scenarioId: null, redirectUrl: null, poolId: null, introTemplateId: null, runAccountFriendAddScenarios: true, isActive: true, stoppedAt: null, stoppedReason: null, createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-25T00:12:00.000Z' },
  { id: 'er-2', refCode: 'ref-tanaka', genre: null, name: '紹介リンク 見本 168', tagId: 'tag-purchase', scenarioId: null, redirectUrl: null, poolId: null, introTemplateId: null, runAccountFriendAddScenarios: true, isActive: true, stoppedAt: null, stoppedReason: null, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-24T09:40:00.000Z' },
  { id: 'er-3', refCode: 'shop-pop', genre: '店頭', name: '店頭POPのQRコード', tagId: null, scenarioId: 'scenario-0', redirectUrl: null, poolId: null, introTemplateId: null, runAccountFriendAddScenarios: true, isActive: true, stoppedAt: null, stoppedReason: null, createdAt: '2026-04-01T00:00:00.000Z', updatedAt: '2026-08-25T02:30:00.000Z' },
  { id: 'er-4', refCode: 'ad-summer', genre: '広告', name: 'Google広告 夏キャンペーン', tagId: null, scenarioId: null, redirectUrl: null, poolId: null, introTemplateId: null, runAccountFriendAddScenarios: false, isActive: true, stoppedAt: null, stoppedReason: null, createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z' },
  { id: 'er-6', refCode: 'flyer-26s', genre: null, name: 'チラシ計測リンク（2026春）', tagId: null, scenarioId: null, redirectUrl: null, poolId: null, introTemplateId: null, runAccountFriendAddScenarios: true, isActive: false, stoppedAt: '2026-06-30T00:00:00.000Z', stoppedReason: '春の配布が終わった', createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-06-30T00:00:00.000Z' },
]

/* 板 `xbHxg` の6行。友だち追加の合計は115人（帯の数と一致）。店頭と
 * チラシのクリックは絵のとおり空（`—` で出す）。メール署名は未登録の行
 * のため集計だけにいる。 */
export const INFLOW_SUMMARY = {
  routes: [
    { refCode: 'ad-summer', name: 'Google広告 夏キャンペーン', friendCount: 42, clickCount: 1204, latestAt: '2026-09-30T14:12:00+09:00' },
    { refCode: 'summer-ig', name: '夏のInstagram投稿', friendCount: 31, clickCount: 880, latestAt: '2026-09-30T09:40:00+09:00' },
    { refCode: 'shop-pop', name: '店頭POPのQRコード', friendCount: 27, clickCount: null, latestAt: '2026-09-29T18:40:00+09:00' },
    /* 絵（xbHxg）の並びは メール署名 → 紹介リンク の順。一覧は友だち追加が多い順なので、
     * メール署名を紹介リンク（12人）より1人多くして絵の並びにそろえる（絵の数「3人」はデータの違いとして残る）。 */
    { refCode: 'mail-sign', name: 'メール署名', friendCount: 13, clickCount: 96, latestAt: '2026-09-26T11:02:00+09:00' },
    { refCode: 'ref-tanaka', name: '紹介リンク 見本 168', friendCount: 12, clickCount: 230, latestAt: '2026-09-29T10:21:00+09:00' },
    { refCode: 'flyer-26s', name: 'チラシ計測リンク（2026春）', friendCount: 0, clickCount: null, latestAt: '2026-05-31T18:00:00+09:00' },
  ],
  totalFriends: 115,
  friendsWithRef: 289,
  friendsWithoutRef: 23,
  routeTotal: 6,
  totalClicks: 8420,
  averageAddRate: 6.4,
}

export const SITE_TRACKING_SUMMARY = {
  todayEvents: 24583,
  todayPageViews: 24583,
  linkedEvents: 20397,
  unlinkedEvents: 4186,
  pathCount: 3,
  eventTypeCount: 4,
  lastEventAt: '2026-08-25T11:17:00.000Z',
}

/* #514-14: 計測先ホストとパスを分け、本番と同じ形で返す。 */
export const SITE_TRACKING_PAGES = [
  { host: 'shop.example.com', path: '/', views: 12480, visitors: 186 },
  { host: 'shop.example.com', path: '/shop/', views: 8120, visitors: 94 },
  { host: 'campaign.example.com', path: '/lp/summer/', views: 2403, visitors: 2 },
  { host: null, path: '/blog/old-page/', views: 620, visitors: 0 },
]

/* ★V8 サイトスクリプト（XjOte）：本番の GET /api/measurement-sites と同じ形。 */
export const MEASUREMENT_SITES = [
  { id: 'site-1', label: '然 公式サイト', domains: ['nen.example'], createdAt: '2026-06-01T00:00:00.000Z', rejectedCount: 0, lastRejectedHost: null, lastRejectedAt: null, stoppedAt: null, stoppedReason: null, lastReceivedAt: '2026-10-01T12:14:00.000Z' },
  { id: 'site-2', label: '然 オンラインショップ', domains: ['shop.nen.example'], createdAt: '2026-06-01T00:00:00.000Z', rejectedCount: 0, lastRejectedHost: null, lastRejectedAt: null, stoppedAt: null, stoppedReason: null, lastReceivedAt: '2026-10-01T11:58:00.000Z' },
  { id: 'site-3', label: '秋のキャンペーン LP', domains: ['lp.nen.example'], createdAt: '2026-08-01T00:00:00.000Z', rejectedCount: 0, lastRejectedHost: null, lastRejectedAt: null, stoppedAt: '2026-09-20T00:00:00.000Z', stoppedReason: 'キャンペーン終了', lastReceivedAt: '2026-09-15T01:02:00.000Z' },
]

export const AD_PLATFORMS = [
  { id: 'ad-meta', name: 'meta', displayName: 'Meta広告', config: { pixel_id: 'PIXEL-8420', monthly_cost: 170000, synced_at: '2026-08-25T11:20:00.000Z', sent_count: 866, pending_count: 12, failed_count: 7, retry_success_count: 23 }, isActive: true, createdAt: '2026-01-10T00:00:00.000Z', updatedAt: '2026-08-25T11:20:00.000Z' },
  { id: 'ad-google', name: 'google', displayName: 'Google広告', config: { customer_id: '123-456-7890', monthly_cost: 312000, synced_at: '2026-08-25T11:20:00.000Z' }, isActive: true, createdAt: '2026-01-10T00:00:00.000Z', updatedAt: '2026-08-25T11:20:00.000Z' },
  { id: 'ad-x', name: 'x', displayName: 'X（旧Twitter）', config: { connection_error: '権限が足りません' }, isActive: false, createdAt: '2026-01-10T00:00:00.000Z', updatedAt: '2026-08-22T09:00:00.000Z' },
]

/*
 * #818 流入元ごとの広告費の台帳。数は V8 の板（`qSTVR`・`ZxKL5`）にそろえる。
 * この30日の広告費 ¥86,000（Google ¥52,000＋Meta ¥34,000）・
 * 友だち追加 73 人（42＋31）・つないだ広告 2 件。
 * 友だち1人あたりは ¥1,178（86,000÷73、四捨五入）で板と合う。
 * 通貨は円（JPYは最小単位が円そのもの）。日時は固定。
 */
export const AD_COST_ROWS = [
  { sourceLabel: 'Google広告', adPlatformId: 'ad-google', entryRouteId: 'er-4', source: 'import', totals: [{ currency: 'JPY', amountMinor: 52000 }], friendAdds: 42, costPerFriendMinor: 1238, lastImportedAt: '2026-10-01T06:00:00+09:00' },
  { sourceLabel: 'Meta広告', adPlatformId: 'ad-meta', entryRouteId: 'er-1', source: 'import', totals: [{ currency: 'JPY', amountMinor: 34000 }], friendAdds: 31, costPerFriendMinor: 1097, lastImportedAt: '2026-10-01T06:00:00+09:00' },
  /* ★V8 広告連携（qSTVR）の3行目：手入力だけの流入元。この30日に費用が無いので「—」。 */
  { sourceLabel: 'チラシ計測リンク（2026春）', adPlatformId: null, entryRouteId: 'er-6', source: 'manual', totals: [], friendAdds: 0, costPerFriendMinor: null, lastImportedAt: null },
]

/* ★V8 広告連携（qSTVR）の「手で入れた費用」2件と、成果1件あたり（86,000÷15＝¥5,733）。 */
export const AD_COST_MANUAL_ENTRIES = [
  { id: 'adc-1', sourceLabel: 'チラシ計測リンク（2026春）', day: '2026-09-15', amountMinor: 12000, currency: 'JPY', entryRouteId: 'er-6', cancelledAt: null, cancelReason: null, createdAt: '2026-09-15T09:00:00+09:00' },
  { id: 'adc-2', sourceLabel: '店頭ポスター', day: '2026-09-01', amountMinor: 4500, currency: 'JPY', entryRouteId: null, cancelledAt: null, cancelReason: null, createdAt: '2026-09-01T09:00:00+09:00' },
]
export const AD_CONVERSION_COST = { from: '2026-09-01', to: '2026-09-30', confirmedConversionCount: 15, costPerConversionMinor: 5733, currency: 'JPY' }

export const AD_COST_PLATFORMS = [
  { id: 'ad-google', name: 'google', displayName: 'Google広告', lastSuccessAt: '2026-10-01T06:00:00+09:00', lastRunStatus: 'success', lastRunAt: '2026-10-01T06:00:00+09:00', lastError: null },
  { id: 'ad-meta', name: 'meta', displayName: 'Meta広告', lastSuccessAt: '2026-10-01T06:00:00+09:00', lastRunStatus: 'success', lastRunAt: '2026-10-01T06:00:00+09:00', lastError: null },
]

/*
  #514-8: 本番の口が返す形だけにする。friendName・conversionName・nextRetryAt は
  口が返さない(画面も読まない)。豊富な形を返すとずれを隠す。
*/
/* 板 `p0kA3`（広告への送信履歴）の5行。数の帯（`FDBsG`）は口の summary（この30日 送った15・待っている2・断られた1）を読む。 */
export const AD_CONVERSION_LOGS = [
  { id: 'adlog-1', adPlatformId: 'ad-google', friendId: 'friend-inflow-1', eventName: '初回購入', clickId: 'fixed-gclid-1', clickIdType: 'gclid', status: 'pending', errorMessage: null, createdAt: '2026-10-01T12:14:00.000Z' },
  { id: 'adlog-2', adPlatformId: 'ad-meta', friendId: 'friend-inflow-2', eventName: '定期便の申し込み', clickId: 'fixed-fbclid-1', clickIdType: 'fbclid', status: 'pending', errorMessage: null, createdAt: '2026-10-01T09:02:00.000Z' },
  { id: 'adlog-3', adPlatformId: 'ad-google', friendId: 'friend-inflow-3', eventName: '初回購入', clickId: 'fixed-gclid-2', clickIdType: 'gclid', status: 'sent', errorMessage: null, createdAt: '2026-09-30T11:40:00.000Z' },
  { id: 'adlog-4', adPlatformId: 'ad-meta', friendId: 'friend-inflow-4', eventName: '初回購入', clickId: 'fixed-fbclid-2', clickIdType: 'fbclid', status: 'failed', errorMessage: 'クリックの目印の期限（90日）が切れていました', createdAt: '2026-09-29T03:11:00.000Z' },
  { id: 'adlog-5', adPlatformId: 'ad-google', friendId: 'friend-inflow-5', eventName: '定期便の申し込み', clickId: 'fixed-gclid-3', clickIdType: 'gclid', status: 'sent', errorMessage: null, createdAt: '2026-09-28T00:30:00.000Z' },
]
export const AD_CONVERSION_LOG_SUMMARY = { sentLast30Days: 15, pendingLast30Days: 2, failedLast30Days: 1 }

/*
 * 板 `FDBsG`（広告とのつなぎ）の対応表（F-21 `GET /api/ad-platforms/mappings`）。
 * 口は成果地点ごとに Google・Meta の2行を返す。来店予約は両方「結びつけない」で、
 * Meta だけ自動の名前（Schedule）があるので選ぶ欄が出る（絵どおり）。
 */
export const AD_EVENT_MAPPINGS = [
  { pointId: 'cp-first', pointName: '初回購入', eventType: 'purchase_first', provider: 'google', mode: 'manual', eventName: 'purchase_first', automaticEventName: 'purchase', googleActionId: null, version: 2 },
  { pointId: 'cp-first', pointName: '初回購入', eventType: 'purchase_first', provider: 'meta', mode: 'auto', eventName: 'Purchase', automaticEventName: 'Purchase', googleActionId: null, version: 1 },
  { pointId: 'cp-teiki', pointName: '定期便の申し込み', eventType: 'subscribe_teiki', provider: 'google', mode: 'manual', eventName: 'subscribe_teiki', automaticEventName: 'subscribe', googleActionId: null, version: 1 },
  { pointId: 'cp-teiki', pointName: '定期便の申し込み', eventType: 'subscribe_teiki', provider: 'meta', mode: 'auto', eventName: 'Subscribe', automaticEventName: 'Subscribe', googleActionId: null, version: 1 },
  { pointId: 'cp-visit', pointName: '来店予約', eventType: 'store_visit', provider: 'google', mode: 'off', eventName: null, automaticEventName: null, googleActionId: null, version: 1 },
  { pointId: 'cp-visit', pointName: '来店予約', eventType: 'store_visit', provider: 'meta', mode: 'off', eventName: null, automaticEventName: 'Schedule', googleActionId: null, version: 1 },
]

/*
  #514-9: 撮影環境で tracked_link 行と展開行を確認するための計測リンク。
  本番の GET /api/tracked-links と同じ形。flyer-spring は entry_route が
  停止中のため tracked_link 行として出て、停止中譲りの分岐も写る。
*/
export const TRACKED_LINKS = [
  { id: 'flyer-spring', name: 'チラシ計測リンク（2026春）', originalUrl: 'https://example.com/lp/spring/', trackingUrl: 'https://example.com/t/flyer-spring', shortCode: null, tagId: null, scenarioId: null, introTemplateId: null, rewardTemplateId: null, lineAccountId: null, isActive: true, clickCount: 12, ogTitle: null, ogDescription: null, ogImageUrl: null, createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-06-28T16:02:00.000Z' },
]

/*
  ログインユーザー。設計 `e3jz3` の並びそのまま。

  **2段階の確認を入れていない人を混ぜる**（設計の帯「2段階の確認 6／8人」）。
  全員 true にすると、帯が「全員入れています」に化けて、見張りたい状態が撮れない。
*/
export const STAFF_MEMBERS = [
  { id: 'stf-1', name: '見本 110', email: 'sasaki@example.com', role: 'admin', lineLinked: true, twoFactorEnabled: true, isActive: true, permissionKeys: [], notificationPreferences: {}, inviteStatus: 'active', createdAt: '2026-01-10T00:00:00.000Z', updatedAt: '2026-08-25T00:02:00.000Z', assignedLineAccountId: null, canAccessDescendantAccounts: true, accountScope: 'all' },
  { id: 'stf-2', name: '見本 138', email: 'yamamoto@example.com', role: 'admin', lineLinked: true, twoFactorEnabled: true, isActive: true, permissionKeys: [], notificationPreferences: {}, inviteStatus: 'active', createdAt: '2026-01-10T00:00:00.000Z', updatedAt: '2026-08-24T23:40:00.000Z', assignedLineAccountId: null, canAccessDescendantAccounts: true, accountScope: 'all' },
  { id: 'stf-3', name: '見本 30', email: 'nakagawa@example.com', role: 'staff', lineLinked: true, twoFactorEnabled: true, isActive: true, permissionKeys: [], notificationPreferences: {}, inviteStatus: 'active', createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-08-24T10:00:00.000Z', assignedLineAccountId: 'visual-qa-account', canAccessDescendantAccounts: false, accountScope: 'accounts', scopedLineAccountIds: ['visual-qa-account'] },
  { id: 'stf-4', name: '見本 18', email: 'takada@example.com', role: 'staff', lineLinked: false, twoFactorEnabled: false, isActive: true, permissionKeys: [], notificationPreferences: {}, inviteStatus: 'active', createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-08-18T10:00:00.000Z', assignedLineAccountId: 'visual-qa-account', canAccessDescendantAccounts: false, accountScope: 'accounts', scopedLineAccountIds: ['visual-qa-account'] },
  { id: 'stf-5', name: '外部デザイン', email: 'design@partner.example.com', role: 'viewer', lineLinked: false, twoFactorEnabled: true, isActive: true, permissionKeys: [], notificationPreferences: {}, inviteStatus: 'active', createdAt: '2026-05-01T00:00:00.000Z', updatedAt: '2026-08-01T10:00:00.000Z', assignedLineAccountId: 'visual-qa-account', canAccessDescendantAccounts: false, accountScope: 'accounts', scopedLineAccountIds: ['visual-qa-account'] },
  { /* 設計の「90日 入っていない 1」。 */ id: 'stf-6', name: '見本 31', email: 'sano@example.com', role: 'viewer', lineLinked: false, twoFactorEnabled: false, isActive: true, permissionKeys: [], notificationPreferences: {}, inviteStatus: 'active', createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-05-20T10:00:00.000Z', assignedLineAccountId: null, canAccessDescendantAccounts: false, accountScope: 'all' },
  { /* 設計の「招待中 2」。 */ id: 'stf-7', name: '見本 147', email: 'arai@example.com', role: 'staff', lineLinked: false, twoFactorEnabled: false, isActive: true, permissionKeys: [], notificationPreferences: {}, inviteStatus: 'pending_email', createdAt: '2026-08-18T00:00:00.000Z', updatedAt: '2026-08-18T00:00:00.000Z', assignedLineAccountId: 'visual-qa-account', canAccessDescendantAccounts: false, accountScope: 'accounts', scopedLineAccountIds: ['visual-qa-account'] },
  { id: 'stf-8', name: '見本 157', email: 'mori@example.com', role: 'staff', lineLinked: false, twoFactorEnabled: false, isActive: true, permissionKeys: [], notificationPreferences: {}, inviteStatus: 'pending_line', createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z', assignedLineAccountId: 'visual-qa-account', canAccessDescendantAccounts: false, accountScope: 'accounts', scopedLineAccountIds: ['visual-qa-account'] },
]

/*
  入った記録。設計 `jwVlo` は「気になるもの 1」を札で持つので、
  **失敗した記録を1件混ぜる**。全部成功にすると、その札が撮れない。
*/
export const LOGIN_AUDIT = [
  { id: 'la-1', adminUserId: 'stf-1', userName: '見本 110', role: 'admin', lineLinked: true, isActive: true, action: 'login', screen: null, ip: '203.0.113.10', connectionSource: '社内', result: 'success', createdAt: '2026-08-25T00:02:00.000Z' },
  { id: 'la-2', adminUserId: 'stf-2', userName: '見本 138', role: 'admin', lineLinked: true, isActive: true, action: 'settings_changed', screen: '機能設定', ip: '203.0.113.11', connectionSource: '社内', result: 'success', createdAt: '2026-08-24T23:41:00.000Z' },
  { id: 'la-3', adminUserId: 'stf-3', userName: '見本 30', role: 'staff', lineLinked: true, isActive: true, action: 'broadcast_sent', screen: '一斉配信', ip: '203.0.113.12', connectionSource: '社内', result: 'success', createdAt: '2026-08-24T10:05:00.000Z' },
  { id: 'la-4', adminUserId: 'stf-4', userName: '見本 18', role: 'staff', lineLinked: false, isActive: true, action: 'delete', screen: 'テンプレート', ip: '203.0.113.13', connectionSource: '社外', result: 'success', createdAt: '2026-08-23T08:20:00.000Z' },
  { id: 'la-5', adminUserId: null, userName: '名前を取得できませんでした', role: null, lineLinked: false, isActive: false, action: 'login', screen: null, ip: '198.51.100.7', connectionSource: '社外', result: 'failure', createdAt: '2026-08-22T19:44:00.000Z' },
]

/** 機能30。ログインユーザーの一覧・役割・監査を実API契約で撮る固定値。 */
/*
 * access表は本番では staff_members と同じ表が元なので、同じ人は
 * STAFF_MEMBERS とID・メールを一致させる(#530)。違うID・メールの
 * ままでは画面の名寄せが「要確認」になり、EOTS4の撮影が回らない。
 */
export const accessUser = (id, name, roleBundle, status, options = {}) => ({
  id, name, email: options.email ?? `${id}@example.invalid`, jobTitle: options.jobTitle ?? null,
  roleBundle, featureCount: roleBundle === 'administrator' ? null : (options.featureCount ?? 8),
  hasFieldMasks: null,
  accountScope: options.accountScope ?? {
    type: 'accounts', assignedLineAccountId: 'visual-qa-account',
    lineAccountIds: ['visual-qa-account'], includesDescendants: false,
  },
  lastLoginAt: options.lastLoginAt !== undefined ? options.lastLoginAt : (status === 'active' ? '2026-09-06T23:02:00.000Z' : null),
  lastActionAt: options.lastActionAt !== undefined ? options.lastActionAt : (status === 'active' ? '2026-09-07T00:18:00.000Z' : null),
  mfaEnabled: options.mfaEnabled ?? false,
  status, policyVersion: options.policyVersion ?? 1,
  createdAt: options.createdAt ?? '2026-01-10T00:00:00.000Z',
  updatedAt: options.updatedAt ?? '2026-09-01T00:00:00.000Z',
})

/*
 * 設計 `nku0f`（ログインユーザー V8）の5人＋止めた1人＋招待中2人。
 * メールは権限で伏せ字（***入り）になる形で返す。名寄せは ID で行う（stf-1・stf-3・stf-6 は STAFF_MEMBERS と同じ人）。
 * Demo Person はいま入っている本人（visual-qa-owner）。「いま」は返す時刻から作る（mock-api.mjs）。
 */
export const ACCESS_USERS = {
  items: [
    accessUser('visual-qa-owner', 'Demo Person', 'administrator', 'active', {
      email: 'kenta@***.jp', mfaEnabled: true, policyVersion: 4, jobTitle: '代表',
      accountScope: { type: 'all', assignedLineAccountId: null, lineAccountIds: [], includesDescendants: true },
      lastLoginAt: '2026-10-01T01:12:00.000Z', lastActionAt: '2026-10-01T01:12:00.000Z',
    }),
    accessUser('stf-masato', 'Masato', 'administrator', 'active', {
      email: 'masato@***.jp', mfaEnabled: true, policyVersion: 3, jobTitle: '管理責任者',
      accountScope: { type: 'all', assignedLineAccountId: null, lineAccountIds: [], includesDescendants: true },
      lastLoginAt: '2026-09-30T08:40:00.000Z', lastActionAt: '2026-09-30T09:10:00.000Z',
    }),
    accessUser('stf-1', '見本 110', 'operations', 'active', {
      email: 'sasaki@***.jp', mfaEnabled: true, policyVersion: 2, featureCount: 14, jobTitle: '配信担当',
      lastLoginAt: '2026-09-30T02:00:00.000Z', lastActionAt: '2026-09-30T02:30:00.000Z',
    }),
    accessUser('stf-3', '見本 30', 'reception', 'active', {
      email: 'nakagawa@***.jp', mfaEnabled: false, policyVersion: 2, featureCount: 6, jobTitle: '店長',
      lastLoginAt: '2026-09-29T09:02:00.000Z', lastActionAt: '2026-09-29T09:02:00.000Z',
    }),
    accessUser('stf-tax', '外部の税理士', 'view_only', 'active', {
      email: 'tax@***.jp', featureCount: 1, jobTitle: '請求の確認',
      lastLoginAt: '2026-09-01T03:20:00.000Z', lastActionAt: null,
    }),
    accessUser('stf-6', '見本 31', 'view_only', 'suspended', {
      email: 'sano@***.jp', featureCount: 4, jobTitle: '閲覧担当', lastLoginAt: '2026-05-20T01:00:00.000Z', lastActionAt: null,
    }),
    accessUser('access-user-9', '招待中 運用担当', 'operations', 'invited', {
      featureCount: 10, createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z',
    }),
    accessUser('access-user-10', '招待中 個別権限', 'custom', 'invited', {
      featureCount: 3, createdAt: '2026-09-06T00:00:00.000Z', updatedAt: '2026-09-06T00:00:00.000Z',
    }),
  ],
  summary: {
    active: 5, invited: 2, expiredInvitations: 0, unused90Days: 0,
    mfaEnabled: 3, mfaRate: 60,
    roleCounts: { administrator: 2, operations: 2, reception: 1, view_only: 2, custom: 1 },
  },
  pagination: { total: 8, limit: 200, offset: 0 },
}

export const ACCESS_ROLES = {
  items: [
    { id: 'administrator', name: '管理者', description: '全機能と権限・監査を管理', featureAccess: 'edit', requiresMfa: true, assignedUserCount: 2 },
    { id: 'operations', name: '運用', description: '配信・予約・コンテンツを運用', featureAccess: 'edit', requiresMfa: false, assignedUserCount: 3, featurePermissions: { '/dashboard': 'view', '/broadcasts': 'edit', '/friends': 'view', '/settings': 'none' } },
    { id: 'reception', name: '受付', description: '受信箱・友だち・予約を担当', featureAccess: 'edit', requiresMfa: false, assignedUserCount: 2 },
    { id: 'view_only', name: '見るだけ', description: '選択した機能を閲覧', featureAccess: 'view', requiresMfa: false, assignedUserCount: 2, featurePermissions: { '/broadcasts': 'view', '/friends': 'view', '/settings': 'none' } },
    { id: 'custom', name: 'カスタム', description: '機能ごとに個別設定', featureAccess: 'custom', requiresMfa: false, assignedUserCount: 1 },
  ],
  totalBundles: 5,
  totalAssignedUsers: 10,
}

export const ACCESS_AUDIT_EVENTS = {
  items: [
    { id: 'audit-access-1', category: 'auth', lineAccountId: 'visual-qa-account', actor: { id: 'stf-1', name: '見本 110', role: 'admin' }, action: 'auth.login', target: null, result: 'success', before: null, after: null, reason: null, requestTraceId: null, ipPrefix: '203.0.113.***', regionLabel: '東京', deviceFamily: 'mac', riskLevel: 'normal', retentionClass: 'security', createdAt: '2026-09-07T00:02:00.000Z' },
    { id: 'audit-access-2', category: 'business', lineAccountId: 'visual-qa-account', actor: { id: 'stf-2', name: '見本 138', role: 'admin' }, action: 'broadcast.send', target: { kind: 'broadcast', id: 'broadcast-september' }, result: 'success', before: null, after: { status: 'sent', count: 1842 }, reason: null, requestTraceId: null, ipPrefix: '203.0.113.***', deviceFamily: 'windows', riskLevel: 'normal', retentionClass: 'general', createdAt: '2026-09-06T23:41:00.000Z' },
    { id: 'audit-access-3', category: 'business', lineAccountId: 'visual-qa-account', actor: { id: 'stf-3', name: '見本 30', role: 'staff' }, action: 'booking.update', target: { kind: 'booking', id: 'booking-1008' }, result: 'success', before: { status: 'pending' }, after: { status: 'confirmed' }, reason: null, requestTraceId: null, ipPrefix: '203.0.113.***', deviceFamily: 'mobile', riskLevel: 'normal', retentionClass: 'general', createdAt: '2026-09-06T10:05:00.000Z' },
    { id: 'audit-access-4', category: 'business', lineAccountId: 'visual-qa-account', actor: { id: 'stf-4', name: '見本 18', role: 'staff' }, action: 'template.delete', target: { kind: 'template', id: 'template-old' }, result: 'success', before: { status: 'draft' }, after: null, reason: '不要になったため', requestTraceId: null, ipPrefix: '203.0.113.***', deviceFamily: 'mac', riskLevel: 'normal', retentionClass: 'general', createdAt: '2026-09-06T08:20:00.000Z' },
    { id: 'audit-access-5', category: 'auth', lineAccountId: 'visual-qa-account', actor: { id: null, name: null, role: null }, action: 'auth.login', target: null, result: 'failed', before: null, after: null, reason: '本人確認に失敗しました', requestTraceId: null, ipPrefix: '198.51.100.***', regionLabel: '大阪', deviceFamily: 'other', riskLevel: 'suspicious', retentionClass: 'security', createdAt: '2026-09-05T19:44:00.000Z' },
    { id: 'audit-access-6', category: 'business', lineAccountId: 'visual-qa-account', actor: { id: 'stf-1', name: '見本 110', role: 'admin' }, action: 'access.user.change', target: { kind: 'staff_member', id: 'stf-5' }, result: 'success', before: { roleBundle: 'custom' }, after: { roleBundle: 'view_only' }, reason: '閲覧だけに変更', requestTraceId: null, ipPrefix: '203.0.113.***', deviceFamily: 'mac', riskLevel: 'normal', retentionClass: 'security', createdAt: '2026-09-05T04:10:00.000Z' },
    { id: 'audit-access-7', category: 'business', lineAccountId: 'visual-qa-account', actor: { id: 'stf-2', name: '見本 138', role: 'admin' }, action: 'webhook.send', target: { kind: 'outgoing_webhook', id: 'owh-slack-order' }, result: 'denied', before: null, after: null, reason: '相手が応答しませんでした', requestTraceId: null, ipPrefix: '203.0.113.***', deviceFamily: 'windows', riskLevel: 'high', retentionClass: 'general', createdAt: '2026-09-04T05:12:00.000Z' },
  ],
  summary: { periodDays: 30, total: 4286, deleted: 12, sent: 18, changed: 46, logins: 286, suspiciousLogins: 1 },
  pagination: { total: 4286, limit: 20, offset: 0 },
}

/*
  紹介者。設計 `PouPn` の「アフィリエイター 12」のうち、札の内訳が撮れる6人。

  **状態を混ぜる。** 全員を有効にすると、設計の札（すべて12／有効10／停止中2／
  未払いあり4／重複の疑い1）が撮れない。停止中を1人、率0%（定額の人）を1人入れる。
  `code` は運用者が決めてURLに出す符号なので、設計と同じ値を使う。
*/
export const AFFILIATES = [
  { id: 'af-1', name: '見本 168', code: 'tanaka-a', commissionRate: 0, isActive: true, email: 'tanaka@example.com', holdDays: 14, payoutCycle: '毎月末', notifyOnConversion: true, friendId: 'friend-1', createdAt: '2026-02-01T00:00:00.000Z' },
  { id: 'af-2', name: '合同会社ノース', code: 'north', commissionRate: 10, isActive: true, email: 'north@example.com', holdDays: 14, payoutCycle: '月末締め翌月末払い', notifyOnConversion: false, createdAt: '2026-03-12T00:00:00.000Z' },
  { id: 'af-3', name: '見本 26', code: 'kimura', commissionRate: 0, isActive: true, email: 'kimura@example.com', holdDays: 14, payoutCycle: '月末締め翌月末払い', notifyOnConversion: true, createdAt: '2026-04-02T00:00:00.000Z' },
  { id: 'af-4', name: '見本 27', code: 'nakamura', commissionRate: 0, isActive: true, email: null, holdDays: null, payoutCycle: null, notifyOnConversion: false, createdAt: '2026-05-20T00:00:00.000Z' },
  { id: 'af-5', name: '見本 135', code: 'yamaguchi', commissionRate: 0, isActive: true, email: 'yamaguchi@example.com', holdDays: 14, payoutCycle: '四半期', notifyOnConversion: false, createdAt: '2026-01-15T00:00:00.000Z' },
  { /* 設計の「停止中 1」。 */ id: 'af-6', name: '旧パートナーA', code: 'old-a', commissionRate: 10, isActive: false, email: null, holdDays: 14, payoutCycle: null, notifyOnConversion: false, createdAt: '2025-11-01T00:00:00.000Z' },
]

/** 案件。V8 の板（`h7dmB`）の「案件 4」（公開中 3・下書き 1）。名前・報酬・動きは板どおり。 */
/* 案件のフォルダ（板 h7dmB）：定期便 2・新商品 1・キャンペーン 1・未分類 0。 */
export const AFFILIATE_OFFER_FOLDERS = [
  ['aof-teiki', '定期便', '#3B82F6', 2],
  ['aof-new', '新商品', '#10B981', 1],
  ['aof-campaign', 'キャンペーン', '#F59E0B', 1],
].map(([id, name, color, itemCount], index) => ({
  id: String(id),
  kind: 'affiliate_offer',
  name: String(name),
  parentId: null,
  displayOrder: index,
  itemCount: Number(itemCount),
  color: String(color),
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
}))

export const AFFILIATE_OFFERS = [
  { id: 'ao-1', folderId: 'aof-teiki', name: '定期便の初回', description: '初回の定期便が確定したとき', rewardAmount: 2000, rewardMiles: 0, mileageProgramId: 'mp-1', lineAccountId: 'visual-qa-account', tagId: 'tag-1', scenarioId: null, isActive: true, createdAt: '2026-09-01T00:00:00.000Z' },
  { id: 'ao-2', folderId: 'aof-campaign', name: '夏の紹介キャンペーン', description: '商品を買ったとき', rewardAmount: 0, rewardMiles: 100, mileageProgramId: 'mp-1', lineAccountId: 'visual-qa-account', tagId: null, scenarioId: null, isActive: true, createdAt: '2026-07-01T00:00:00.000Z' },
  { id: 'ao-3', folderId: 'aof-new', name: '資料請求', description: '資料をダウンロードしたとき', rewardAmount: 0, rewardMiles: 0, mileageProgramId: 'mp-1', lineAccountId: 'visual-qa-account', tagId: null, scenarioId: null, isActive: true, createdAt: '2026-06-01T00:00:00.000Z' },
  { /* 下書き。 */ id: 'ao-4', folderId: 'aof-teiki', name: '秋の紹介キャンペーン', description: '商品を買ったとき', rewardAmount: 1500, rewardMiles: 0, mileageProgramId: 'mp-1', lineAccountId: 'visual-qa-account', tagId: null, scenarioId: null, isActive: false, createdAt: '2026-05-01T00:00:00.000Z' },
]

/*
 * #823 案件の決まりの版と上限の残り・成果の付け方の記録。
 * 型どおりの名前（api.ts の OfferVersion・OfferCapStatus・AttributionDecisionView）で返す。
 */
export const OFFER_VERSIONS = [
  { id: 'aov-2', offerId: 'ao-2', versionNumber: 2, rewardAmount: 5000, rewardMiles: 500, windowDays: 30, capTotal: 200, capMonthlyPerAffiliate: 10, receptionFrom: '2026-10-01T00:00:00.000+09:00', receptionTo: '2026-12-31T23:59:59.000+09:00', effectiveFrom: null, createdAt: '2026-09-27T00:00:00.000+09:00' },
  { id: 'aov-1', offerId: 'ao-2', versionNumber: 1, rewardAmount: 5000, rewardMiles: 500, windowDays: 30, capTotal: null, capMonthlyPerAffiliate: null, receptionFrom: null, receptionTo: null, effectiveFrom: null, createdAt: '2026-02-10T00:00:00.000+09:00' },
]

export const OFFER_CAP_STATUS = {
  version: OFFER_VERSIONS[0],
  capped: false,
  capTotal: 200,
  totalUsed: 162,
  totalRemaining: 38,
  capMonthlyPerAffiliate: 10,
  monthlyUsed: 3,
  monthlyRemaining: 7,
}

export const ATTRIBUTION_DECISION = {
  conversionEventId: 'ev-1',
  affiliateId: 'af-1',
  refCode: 'ref-1',
  offerId: 'ao-2',
  offerVersionId: 'aov-2',
  reason: 'matched_last_touch',
  windowDays: 30,
  candidates: [
    { affiliateId: 'af-1', affiliateName: 'はなこ', refCode: 'ref-1', touchedAt: '2026-09-20T10:02:00.000+09:00', offerId: 'ao-2', offerName: '定期便のお申し込み', chosen: true, skipReason: null, windowDays: 30 },
    { affiliateId: 'af-2', affiliateName: 'けんた', refCode: 'ref-2', touchedAt: '2026-09-18T21:40:00.000+09:00', offerId: 'ao-2', offerName: '定期便のお申し込み', chosen: false, skipReason: 'out_of_window', windowDays: 30 },
    { affiliateId: 'af-3', affiliateName: '本人', refCode: 'ref-3', touchedAt: '2026-09-20T09:58:00.000+09:00', offerId: 'ao-2', offerName: '定期便のお申し込み', chosen: false, skipReason: 'self_referral', windowDays: 30 },
  ],
  createdAt: '2026-09-27T12:00:00.000+09:00',
}

/*
  マイルの残高。設計 `s98Vfw` の並びそのまま。

  **`/api/mileage/overview` は器の形が要る。** 画面の `isMileageAdminOverview` は
  `summary` の5つの数と `pagination` を見て、1つでも欠けると
  「友だちのマイルを表示できませんでした」に落ちる。既定の器が返っていたので、
  固定データ以前に**この画面は一度も中身が撮れていなかった。**
*/
const mileageMember = (id, name, available, pending, lifetime, actions, days) => ({
  identityKey: `ik-${id}`, primaryFriendId: id, displayName: name, pictureUrl: null,
  accountCount: 1, accountNames: ['LINE 本店'],
  available, pending, lifetimeEarned: lifetime,
  actionCount: actions, messageCount: 0, linkClickCount: 0, formCount: 0,
  bookingCount: 0, webinarCount: 0, instagramCount: 0,
  followingDays: days, unfollowCount: 0, referralMiles: 0, qualityReferralCount: 0,
  lastActivityAt: '2026-08-25T00:00:00.000Z',
})

export const MILEAGE_OVERVIEW = {
  summary: {
    totalMembers: 1284,
    totalAvailable: 486200,
    activeMembers30d: 642,
    totalActions: 4180,
    queuedEvents: 12,
  },
  members: [
    mileageMember('friend-1', '見本 16', 8420, 0, 12400, 42, 296),
    mileageMember('friend-2', '見本 17', 6150, 300, 9800, 31, 216),
    mileageMember('friend-3', '見本 26', 4980, 0, 7200, 24, 377),
    mileageMember('friend-4', '見本 27', 2310, 0, 3100, 12, 120),
    mileageMember('friend-5', '見本 28', 860, 0, 1200, 6, 64),
    mileageMember('friend-6', '見本 45', 120, 0, 200, 2, 21),
  ],
  pagination: { total: 1284, limit: 20, offset: 0 },
}

/**
 * 機能17の新しい友だち別残高契約。
 * 旧 `/overview` と違い、失効予定・今月の増減・財布の範囲を1行ずつ返す。
 */
export const MILEAGE_FRIENDS = { balanceSource: 'musubo',
  summary: {
    totalMembers: 1284,
    withBalanceCount: 1284,
    available: 486200,
    pending: 300,
    expiringMiles30d: 24600,
    nextExpiringAt: '2026-09-20T00:00:00.000Z',
    monthChange: 960,
    rankCounts: [
      { rewardId: 'rank-bronze', rankName: 'ブロンズ', requiredMiles: 0, friendCount: 886 },
      { rewardId: 'rank-silver', rankName: 'シルバー', requiredMiles: 2000, friendCount: 312 },
      { rewardId: 'rank-gold', rankName: 'ゴールド', requiredMiles: 5000, friendCount: 86 },
    ],
  },
  items: [
    ['friend-1', '見本 16', 'gold', 8420, 0, 1200, 2100, 12400, 3980, '2026-08-25T00:12:00.000Z', 'LINE 本店'],
    ['friend-2', '見本 17', 'gold', 6150, 300, 300, null, 9800, 3650, '2026-08-24T09:40:00.000Z', 'LINE 本店'],
    ['friend-3', '見本 26', 'silver', 3900, 0, 240, 900, 7200, 3300, '2026-08-24T05:02:00.000Z', 'LINE 二号店'],
    ['friend-4', '佐藤 千尋', 'silver', 2480, 0, -1000, null, 5480, 3000, '2026-08-24T09:40:00.000Z', 'LINE 本店'],
    ['friend-5', '見本 19', 'bronze', 620, 0, 120, null, 920, 300, '2026-08-22T07:20:00.000Z', 'LINE 本店'],
    ['friend-6', '見本 28', 'bronze', 100, 0, 100, null, 100, 0, '2026-08-22T01:05:00.000Z', 'LINE 二号店'],
  ].map(([
    friendId, displayName, rank, available, pending, monthChange, expiringMiles30d,
    lifetimeEarned, spent, lastChangedAt, accountName,
  ], index) => ({
    friendId, displayName, pictureUrl: null, rank,
    rankReason: rank === 'gold' ? '5,000マイル以上' : rank === 'silver' ? '2,000マイル以上' : '2,000マイル未満',
    rankThreshold: rank === 'gold' ? 5000 : rank === 'silver' ? 2000 : 0,
    nextRank: rank === 'gold' ? null : rank === 'silver' ? 'ゴールド' : 'シルバー',
    milesToNextRank: rank === 'gold' ? null : rank === 'silver' ? Math.max(0, 5000 - available) : Math.max(0, 2000 - available),
    monthChange, available, pending, expiringMiles30d, lifetimeEarned, spent, lastChangedAt,
    walletScope: index < 2 ? 'verified_user' : 'friend',
    lineAccount: {
      id: accountName === 'LINE 二号店' ? 'visual-qa-account-2' : 'visual-qa-account',
      name: accountName,
    },
  })),
  pagination: { total: 1284, limit: 20, offset: 0 },
  measuredAt: '2026-08-25T01:00:00.000Z',
}

/*
  たまる決めごと。設計 `N46cQ` の「すべて 9／動いている 7／止めている 2」。
  **止めているものを2本入れる。** 全部動いていると、その札が撮れない。
*/
/**
 * たまる決めごと1本。**`conditions` を空にしない。**
 * 画面（`earning-rule-view.ts`）は `rule.conditions.uniquePerReferredFriendPerSubject` を
 * 直に読むので、`conditions` ごと無いと `Cannot read properties of undefined` で
 * 一覧が丸ごと落ちる。
 */
const mileageRule = (id, name, eventType, amount, conditions, isActive = true) => ({
  id, name, eventType, source: null, amount,
  initialStatus: 'available', conditions,
  /* #532(#521): 旧口も帰属アカウントを持つ。新規は必須。 */
  lineAccountId: 'visual-qa-account', isActive,
  validFrom: null, validUntil: null,
  createdAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-08-25T00:00:00.000Z',
})

export const MILEAGE_RULES = [
  mileageRule('mr-1', 'LINEでメッセージを送ってくれた', 'message_received', 50, { dailyCapActions: 1 }),
  mileageRule('mr-2', 'Instagramから戻ってきた', 'inflow_return', 100, { uniquePerSubjectPerDay: true }),
  mileageRule('mr-3', 'ストーリーズのリンクからLINEに来た人', 'inflow_story', 120, { uniquePerSubject: true }),
  mileageRule('mr-4', '予約してくれた', 'booking_created', 300, {}),
  mileageRule('mr-5', '回答フォームに答えてくれた', 'form_submitted', 80, { uniquePerSubject: true }),
  mileageRule('mr-6', 'ウェビナーを見てくれた', 'webinar_watched', 200, {}),
  mileageRule('mr-7', '口コミを書いてくれた', 'review_posted', 200, { uniquePerSubject: true }),
  /* 設計の「止めている 2」。全部動いていると、その札が撮れない。 */
  mileageRule('mr-8', '誕生日クーポンを受け取った', 'birthday', 500, {}, false),
  mileageRule('mr-9', '旧キャンペーン（終了）', 'campaign_2025', 1000, {}, false),
]

const mileageEarningRule = ({
  id, name, eventType, source, amount, initialStatus = 'available', granted,
  excluded = 0, status = 'published', expiresAfterDays = 365,
  cancellationEventTypes = [], targetConditions = null, sortOrder,
  grantedMiles = granted * amount, validUntil = null, draftVersion = 3,
  publishedVersion = status === 'published' ? draftVersion : null,
}) => {
  const definition = {
    name, eventType, source, amount, initialStatus,
    validFrom: null, validUntil, expiresAfterDays,
    cancellationEventTypes, targetConditions, sortOrder,
  }
  return {
    id,
    published: {
      name, eventType, source, amount, initialStatus,
      validFrom: null, validUntil, status,
      updatedAt: '2026-08-25T00:00:00.000Z',
    },
    draft: definition,
    draftVersion,
    publishedVersion,
    draftUpdatedAt: '2026-08-25T00:00:00.000Z',
    metrics30d: { eligible: granted + excluded, granted, grantedMiles, excluded },
  }
}

/*
  機能17の公開版・下書き版・直近30日集計を同じ行で返す新契約。
  並びと数は V8 たまる決めごと `OC0gy` の表（6行。誕生日だけ止めている下書き）。
  有効期間は「1年・12/31」（1年で消える・12/31 まで）。
*/
const RULE_UNTIL = '2026-12-31T00:00:00+09:00'
export const MILEAGE_EARNING_RULES = {
  items: [
    mileageEarningRule({ id: 'mer-1', name: '友だち追加', eventType: 'friend_added', source: 'line', amount: 100, granted: 124, grantedMiles: 12400, excluded: 0, sortOrder: 1, validUntil: RULE_UNTIL }),
    mileageEarningRule({ id: 'mer-2', name: '商品を買った', eventType: 'purchase_completed', source: 'stripe', amount: 1, initialStatus: 'pending', granted: 182, grantedMiles: 18200, excluded: 4, sortOrder: 2, validUntil: RULE_UNTIL, draftVersion: 5 }),
    mileageEarningRule({ id: 'mer-3', name: '紹介した', eventType: 'friend_registered', source: 'tag_referral', amount: 300, granted: 12, grantedMiles: 3600, excluded: 1, sortOrder: 3, validUntil: RULE_UNTIL, draftVersion: 2 }),
    mileageEarningRule({ id: 'mer-4', name: '回答フォームに答えた', eventType: 'form_submitted', source: 'form', amount: 50, granted: 38, grantedMiles: 1900, excluded: 12, sortOrder: 4, validUntil: RULE_UNTIL, draftVersion: 1 }),
    mileageEarningRule({ id: 'mer-5', name: '予約した', eventType: 'booking_created', source: 'booking', amount: 100, initialStatus: 'pending', granted: 47, grantedMiles: 4700, excluded: 3, cancellationEventTypes: ['booking_cancelled'], sortOrder: 5, validUntil: RULE_UNTIL, draftVersion: 2 }),
    mileageEarningRule({ id: 'mer-6', name: '誕生日', eventType: 'birthday', source: null, amount: 200, granted: 0, status: 'stopped', sortOrder: 6, validUntil: RULE_UNTIL, draftVersion: 2 }),
  ],
  pagination: { total: 6, limit: 20, offset: 0 },
  unassignedLegacyCount: 0,
  measuredAt: '2026-08-25T01:00:00.000Z',
}

/*
  機能17の全体履歴。新契約の行に期間集計を添える。並びと数は V8 履歴 `oRbJi` の表（6行：確定待ち・交換・紹介・友だち追加・回答・手で直した取り消し）。
*/
export const MILEAGE_HISTORY = {
  items: [
    ['ml-1', 'friend-1', 'Demo Person', 'grant', 'pending', 128, '商品を買った', 'stripe', '注文 #10482', 'automatic', null, '2026-09-30T05:12:00.000Z'],
    ['ml-2', 'friend-2', 'Masato S.', 'spend', 'available', -500, '交換：送料無料クーポン', 'reward', null, 'automatic', null, '2026-09-30T02:05:00.000Z'],
    ['ml-3', 'friend-3', '見本 15', 'grant', 'available', 300, '紹介した（見本 143さん）', 'tag_referral', null, 'automatic', null, '2026-09-29T09:40:00.000Z'],
    ['ml-4', 'friend-4', '見本 141', 'grant', 'available', 100, '友だち追加', 'friend_add_routing', null, 'automatic', null, '2026-09-29T01:21:00.000Z'],
    ['ml-5', 'friend-5', '見本 25', 'grant', 'available', 50, '回答フォームに答えた', 'form', '来店アンケート', 'automatic', null, '2026-09-28T11:02:00.000Z'],
    ['ml-6', 'friend-6', '見本 171', 'adjustment', 'available', -80, '取り消し：注文 #10422', 'manual', '注文 #10422', 'manual', 'オーナー', '2026-09-28T00:15:00.000Z'],
  ].map(([
    id, primaryFriendId, displayName, entryType, status, amount, reason, source,
    sourceReferenceId, mode, executedByStaffName, occurredAt,
  ]) => ({
    id, primaryFriendId, displayName, pictureUrl: null, entryType, status, amount, reason, source,
    hasSourceEvent: sourceReferenceId !== null, sourceReferenceId,
    ruleName: reason, mode, executedByStaffName, occurredAt,
    lineAccountName: primaryFriendId === 'friend-3' || primaryFriendId === 'friend-6' ? '然 渋谷店' : '然 本店',
    balanceAfter: ({ 'ml-1': 2340, 'ml-2': 1820, 'ml-3': 1560, 'ml-4': 640, 'ml-5': 450, 'ml-6': 200 })[id],
  })),
  pagination: { total: 1245, limit: 20, offset: 0 },
  summary: {
    from: '2026-08-01',
    to: '2026-08-25',
    byType: [
      { entryType: 'grant', count: 1206, amount: 40800 },
      { entryType: 'spend', count: 36, amount: -33100 },
      { entryType: 'reversal', count: 3, amount: -900 },
    ],
    totalAmount: 12600,
    manualCount: 12,
    pendingCount: 18,
    measuredAt: '2026-08-25T01:00:00.000Z',
  },
}

/*
  成果地点。設計 `ZrpKn` の「すべて 12／動いている 10／止めている 2／
  どこからも使われていない 2」の内訳が撮れる6件。
*/
export const CONVERSION_POINTS = [
  { id: 'cp-1', name: '商品を買った', eventType: 'ec_order_confirmed', value: 1587, measureMethod: 'webhook', targetUrl: null, countRepeat: true, deduplicationMode: 'every', deduplicationWindowDays: null, valueMode: 'source', attributionDays: 90, lineAccountId: null, isActive: true, createdAt: '2026-01-10T00:00:00.000Z' },
  { id: 'cp-4', name: '初回の定期便が確定', eventType: 'ec_subscription_confirmed', value: 3000, measureMethod: 'webhook', targetUrl: null, countRepeat: false, deduplicationMode: 'once_per_friend', deduplicationWindowDays: null, valueMode: 'fixed', attributionDays: 30, lineAccountId: null, isActive: true, createdAt: '2026-02-20T00:00:00.000Z' },
  { id: 'cp-3', name: '予約が入った', eventType: 'reservation_confirmed', value: null, measureMethod: 'webhook', targetUrl: null, countRepeat: true, deduplicationMode: 'window', deduplicationWindowDays: 30, valueMode: 'none', attributionDays: 90, lineAccountId: null, isActive: true, createdAt: '2026-02-01T00:00:00.000Z' },
  { id: 'cp-2', name: '体験申込フォームの送信', eventType: 'form_submitted', value: null, measureMethod: 'webhook', targetUrl: null, countRepeat: false, deduplicationMode: 'once_per_friend', deduplicationWindowDays: null, valueMode: 'none', attributionDays: 90, lineAccountId: null, isActive: true, createdAt: '2026-01-10T00:00:00.000Z' },
  { id: 'cp-5', name: 'ウェビナーを最後まで見た', eventType: 'webinar_completed', value: null, measureMethod: 'webhook', targetUrl: null, countRepeat: false, deduplicationMode: 'once_per_friend', deduplicationWindowDays: null, valueMode: 'none', attributionDays: 30, lineAccountId: null, isActive: true, createdAt: '2026-03-05T00:00:00.000Z' },
  { id: 'cp-6', name: '資料をダウンロードした', eventType: 'url_reach', value: null, measureMethod: 'url_reach', targetUrl: 'https://example.com/download', countRepeat: false, deduplicationMode: 'once_per_friend', deduplicationWindowDays: null, valueMode: 'none', attributionDays: 90, lineAccountId: null, isActive: false, createdAt: '2025-12-01T00:00:00.000Z' },
]

/*
  成果地点レポート。現期間148件・466,000円、直前期間127件・
  435,000円を固定し、一覧・レポート・作成前の同種集計が同じ数字を読む。
*/
export const CONVERSION_REPORT_CURRENT = [
  { conversionPointId: 'cp-1', conversionPointName: '商品を買った', eventType: 'ec_order_confirmed', totalCount: 52, totalValue: 412000 },
  { conversionPointId: 'cp-4', conversionPointName: '初回の定期便が確定', eventType: 'ec_subscription_confirmed', totalCount: 18, totalValue: 54000 },
  { conversionPointId: 'cp-3', conversionPointName: '予約が入った', eventType: 'reservation_confirmed', totalCount: 41, totalValue: 0 },
  { conversionPointId: 'cp-2', conversionPointName: '体験申込フォームの送信', eventType: 'form_submitted', totalCount: 23, totalValue: 0 },
  { conversionPointId: 'cp-5', conversionPointName: 'ウェビナーを最後まで見た', eventType: 'webinar_completed', totalCount: 14, totalValue: 0 },
  { conversionPointId: 'cp-6', conversionPointName: '資料をダウンロードした', eventType: 'url_reach', totalCount: 0, totalValue: 0 },
]

export const CONVERSION_REPORT_PREVIOUS = [
  { conversionPointId: 'cp-1', conversionPointName: '商品を買った', eventType: 'ec_order_confirmed', totalCount: 44, totalValue: 390000 },
  { conversionPointId: 'cp-4', conversionPointName: '初回の定期便が確定', eventType: 'ec_subscription_confirmed', totalCount: 15, totalValue: 45000 },
  { conversionPointId: 'cp-3', conversionPointName: '予約が入った', eventType: 'reservation_confirmed', totalCount: 35, totalValue: 0 },
  { conversionPointId: 'cp-2', conversionPointName: '体験申込フォームの送信', eventType: 'form_submitted', totalCount: 20, totalValue: 0 },
  { conversionPointId: 'cp-5', conversionPointName: 'ウェビナーを最後まで見た', eventType: 'webinar_completed', totalCount: 13, totalValue: 0 },
  { conversionPointId: 'cp-6', conversionPointName: '資料をダウンロードした', eventType: 'url_reach', totalCount: 0, totalValue: 0 },
]

/*
  成果地点の一覧契約。代表6件と、
  全体件数（12件／動作中10件／停止2件）と利用先・期間集計を一緒に返す。
  取消イベント台帳はまだ無いため、本番契約と同じく純件数は記録件数と同値。
*/
const CONVERSION_RANGE = {
  from: '2026-07-27 00:00:00',
  to: '2026-08-25 23:59:59',
  timeZone: 'Asia/Tokyo',
}

const CONVERSION_PREVIOUS_RANGE = {
  from: '2026-06-27 00:00:00',
  to: '2026-07-26 23:59:59',
  timeZone: 'Asia/Tokyo',
}

const CONVERSION_USAGE_COUNTS = new Map([
  ['cp-1', 3], ['cp-4', 2], ['cp-3', 1], ['cp-2', 1], ['cp-5', 0], ['cp-6', 1],
])

const CONVERSION_CURRENT_BY_ID = new Map(CONVERSION_REPORT_CURRENT.map((row) => [row.conversionPointId, row]))
const CONVERSION_PREVIOUS_BY_ID = new Map(CONVERSION_REPORT_PREVIOUS.map((row) => [row.conversionPointId, row]))

/** 成果地点一覧の3分類。名前と色と件数は、同じ一覧の見本に合わせる。 */
export const CONVERSION_FOLDERS = [
  ['conversion-purchase', '購入', '#2563EB'],
  ['conversion-booking', '予約・申込', '#10B981'],
  ['conversion-material', '資料・視聴', '#F59E0B'],
].map(([id, name, color], index) => ({ id, name, color, kind: 'conversion', parentId: null, displayOrder: index, itemCount: 2, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' }))

export const CONVERSION_DEFINITIONS = {
  items: CONVERSION_POINTS.map((point) => {
    const current = CONVERSION_CURRENT_BY_ID.get(point.id)
    return {
      id: point.id,
      name: point.name,
      folderId: ['cp-1', 'cp-4'].includes(point.id) ? 'conversion-purchase' : ['cp-3', 'cp-2'].includes(point.id) ? 'conversion-booking' : 'conversion-material',
      sourceType: point.eventType,
      value: point.value,
      measureMethod: point.measureMethod,
      targetUrl: point.targetUrl,
      countRepeat: point.countRepeat,
      deduplicationMode: point.deduplicationMode,
      deduplicationWindowDays: point.deduplicationWindowDays,
      valueMode: point.valueMode,
      attributionDays: point.attributionDays,
      lineAccountId: point.lineAccountId,
      status: point.isActive ? 'active' : 'stopped',
      // 一覧の状態の札・取り消しの決め方・受け口（本物の口と同じ形。V8 の一覧 r6dJFy が読む）。
      state: point.isActive ? 'active' : 'stopped',
      stateReason: null,
      sourceConfig: {},
      reversalPolicy: point.eventType === 'ec_order_confirmed' ? 'source_cancelled' : 'manual',
      ingest: { configured: point.measureMethod === 'webhook', disabledAt: null },
      version: 1,
      usageCount: CONVERSION_USAGE_COUNTS.get(point.id) ?? 0,
      usageNames: {
        'cp-1': ['ファネル 2', 'アフィリエイト 1', 'マイル「商品を買った」'],
        'cp-4': ['アフィリエイト 1', '広告への送信'],
        'cp-3': ['オートメーション 1'],
        'cp-2': ['ファネル 1'],
        'cp-5': [],
        'cp-6': ['アフィリエイト 1'],
      }[point.id] ?? [],
      metrics: {
        recordedCount: current?.totalCount ?? 0,
        netCount: current?.totalCount ?? 0,
        reversedCount: null,
        netValue: current?.totalValue ?? 0,
        reversalState: 'unavailable',
        reversalReason: '取消イベント台帳はまだ接続されていません',
        cancellationCount: null,
        cancellationValue: null,
      },
      stoppedAt: point.isActive ? null : '2026-09-20T09:00:00.000Z',
      createdAt: point.createdAt,
      updatedAt: point.isActive ? '2026-08-25T09:00:00.000Z' : '2026-09-20T09:00:00.000Z',
    }
  }),
  stateCounts: { active: 5, draft: 0, stopped: 1, invalid: 0, sourceStopped: 0, unused: 1 },
  range: CONVERSION_RANGE,
  pagination: { total: 6, limit: 20, cursor: '0', nextCursor: null },
}

/* 機能19 GtylA: 入力中の条件だけで行う保存前試算。保存・成果追加はしない。 */
export const CONVERSION_DEFINITION_PREVIEW = {
  range: CONVERSION_RANGE,
  matchedCount: 386,
  // 条件に合う人数と、数えない条件で除いた件数（V8 の作る画面 j8p3yj の右の列が読む）。
  uniqueFriendCount: 47,
  excludedCount: 3,
  estimatedCount: 214,
  estimatedValue: 402800,
  duplicateExcludedCount: 172,
  cancellationCount: 4,
  excludedReasons: [],
  // R42: 金額のない過去の成果の件数。撮影用の見本は0件のまま。
  missingValueCount: 0,
  dailyAverage: 7.1,
  deduplicationWindowDays: null,
}

/* 機能19 d8d3Mz: 利用先、停止影響、差し替え候補、物理削除可否。 */
export const CONVERSION_DEFINITION_DELETE_IMPACT = {
  definition: {
    ...CONVERSION_DEFINITIONS.items[3],
    sourceConfig: { triggerKind: 'form' },
    deduplicationMode: 'once_per_friend',
    deduplicationWindowDays: null,
    valueMode: 'fixed',
    reversalPolicy: 'source_cancelled',
    currentVersion: {
      id: 'cp-2:v1', number: 1, sourceType: 'form_submitted', measureMethod: 'webhook',
      targetUrl: null, countRepeat: false, fixedValue: 12000, attributionDays: 90,
    },
    usages: [],
  },
  usages: [
    { id: 'conversion-usage-offer', conversionPointId: 'cp-2', definitionVersion: 1, lineAccountId: 'visual-qa-account', refKind: 'affiliate_offer', refId: 'offer-trial', refVersionId: 'v3', usageName: '案件「無料体験の申込」' },
    { id: 'conversion-usage-reply', conversionPointId: 'cp-2', definitionVersion: 1, lineAccountId: 'visual-qa-account', refKind: 'auto_reply', refId: 'reply-thanks', refVersionId: 'v2', usageName: '自動応答「申し込みありがとうございます」' },
    { id: 'conversion-usage-analysis', conversionPointId: 'cp-2', definitionVersion: 1, lineAccountId: 'visual-qa-account', refKind: 'analytics', refId: 'conversion-trend', refVersionId: null, usageName: '分析「成果のうつり変わり」' },
  ],
  eventCount: 23,
  canDelete: false,
  stopImpact: { affectedUsageCount: 3, preservesPastEvents: true, preservesUsages: true },
  replacementCandidates: [
    { id: 'cp-1', name: '商品を買った', version: 1 },
    { id: 'cp-3', name: '予約が入った', version: 1 },
  ],
}

/*
  設計の積み上げグラフ用。期間の30日を省略せず、8/13の山を含める。
  地点別の合計も一覧KPIの486件と一致する（商品386、申込42、予約38、定期12、視聴8）。
*/
const CONVERSION_DAILY_COUNTS = [
  ['2026-07-27', 2, 0, 1, 1, 0, 0],
  ['2026-07-28', 2, 2, 0, 0, 1, 0],
  ['2026-07-29', 2, 0, 2, 0, 0, 0],
  ['2026-07-30', 2, 1, 1, 1, 1, 0],
  ['2026-07-31', 1, 0, 1, 0, 0, 0],
  ['2026-08-01', 2, 0, 2, 2, 0, 0],
  ['2026-08-02', 2, 1, 1, 0, 0, 0],
  ['2026-08-03', 1, 0, 1, 1, 0, 0],
  ['2026-08-04', 1, 2, 0, 0, 1, 0],
  ['2026-08-05', 1, 0, 1, 2, 0, 0],
  ['2026-08-06', 1, 1, 1, 1, 1, 0],
  ['2026-08-07', 2, 0, 2, 0, 0, 0],
  ['2026-08-08', 2, 0, 2, 2, 1, 0],
  ['2026-08-09', 2, 0, 1, 0, 0, 0],
  ['2026-08-10', 2, 0, 2, 2, 0, 0],
  ['2026-08-11', 1, 2, 0, 0, 1, 0],
  ['2026-08-12', 2, 0, 1, 1, 0, 0],
  ['2026-08-13', 8, 3, 6, 3, 2, 0],
  ['2026-08-14', 1, 0, 1, 0, 0, 0],
  ['2026-08-15', 2, 0, 1, 2, 2, 0],
  ['2026-08-16', 2, 0, 2, 0, 0, 0],
  ['2026-08-17', 2, 0, 2, 1, 0, 0],
  ['2026-08-18', 1, 2, 0, 0, 0, 0],
  ['2026-08-19', 0, 0, 2, 1, 0, 0],
  ['2026-08-20', 1, 2, 2, 0, 2, 0],
  ['2026-08-21', 1, 0, 2, 0, 0, 0],
  ['2026-08-22', 1, 0, 2, 2, 2, 0],
  ['2026-08-23', 2, 0, 1, 0, 0, 0],
  ['2026-08-24', 2, 0, 1, 1, 0, 0],
  ['2026-08-25', 1, 2, 0, 0, 0, 0],
]

const CONVERSION_DAILY_VALUES = [7923, 3000, 0, 0, 0, 0]
const CONVERSION_DAILY_FINAL_ADJUSTMENTS = [0, 0, 0, 0, 0, 0]

export const CONVERSION_DEFINITION_REPORT = {
  range: CONVERSION_RANGE,
  previousRange: CONVERSION_PREVIOUS_RANGE,
  kpis: {
    recordedCount: 148,
    reversedCount: null,
    netCount: 148,
    netValue: 466_000,
    averageNetValue: 3148.65,
    previousNetCount: 127,
    previousNetValue: 435_000,
    countChangeRate: 16.54,
    reversalState: 'unavailable',
    reversalReason: '取消イベント台帳はまだ接続されていません',
    cancellationCount: null,
    cancellationValue: null,
    fastestGrowing: {
      conversionPointId: 'cp-1',
      conversionPointName: '商品を買った',
      sourceType: 'ec_order_confirmed',
      netCount: 52,
      netValue: 412_000,
      previousNetCount: 44,
      previousNetValue: 390_000,
      countChange: 8,
    },
  },
  daily: CONVERSION_DAILY_COUNTS.flatMap(([day, ...counts]) => counts.map((netCount, index) => ({
    day,
    conversionPointId: CONVERSION_REPORT_CURRENT[index].conversionPointId,
    conversionPointName: CONVERSION_REPORT_CURRENT[index].conversionPointName,
    netCount,
    netValue: netCount * CONVERSION_DAILY_VALUES[index]
      - (day === '2026-08-25' ? CONVERSION_DAILY_FINAL_ADJUSTMENTS[index] : 0),
  }))),
  /* 板 `AzrZq`：成果地点ごとの表は 商品を買った・予約が入った・初回の定期便が確定・体験申込… の順（絵の並び）。 */
  byDefinition: ['cp-1', 'cp-3', 'cp-4', 'cp-2', 'cp-5', 'cp-6'].map((id) => CONVERSION_CURRENT_BY_ID.get(id)).map((current) => {
    const previous = CONVERSION_PREVIOUS_BY_ID.get(current.conversionPointId)
    return {
      conversionPointId: current.conversionPointId,
      conversionPointName: current.conversionPointName,
      sourceType: current.eventType,
      netCount: current.totalCount,
      netValue: current.totalValue,
      previousNetCount: previous?.totalCount ?? 0,
      previousNetValue: previous?.totalValue ?? 0,
      countChange: current.totalCount - (previous?.totalCount ?? 0),
      cancellationCount: null,
      cancellationValue: null,
      routes: {
        'cp-1': [
          { routeKey: 'nen-regular', label: 'NEN配信「定期便のご案内」', attributionState: 'attributed', netCount: 30, netValue: 240000, audience: null, conversionRate: null },
          { routeKey: 'google-summer', label: 'Google広告 夏キャンペーン', attributionState: 'attributed', netCount: 14, netValue: 112000, audience: null, conversionRate: null },
          { routeKey: 'unattributed', label: '未帰属', attributionState: 'unattributed', netCount: 8, netValue: 60000, audience: null, conversionRate: null },
        ],
        'cp-4': [{ routeKey: 'nen-regular', label: 'NEN配信「定期便のご案内」', attributionState: 'attributed', netCount: 18, netValue: 54000, audience: null, conversionRate: null }],
        'cp-3': [{ routeKey: 'rich-menu-booking', label: 'リッチメニュー「予約する」', attributionState: 'attributed', netCount: 41, netValue: 0, audience: null, conversionRate: null }],
        'cp-2': [{ routeKey: 'google-summer', label: 'Google広告 夏キャンペーン', attributionState: 'attributed', netCount: 23, netValue: 0, audience: null, conversionRate: null }],
        'cp-5': [{ routeKey: 'rich-menu-booking', label: 'リッチメニュー「予約する」', attributionState: 'attributed', netCount: 14, netValue: 0, audience: null, conversionRate: null }],
        'cp-6': [],
      }[current.conversionPointId] ?? [],
    }
  }),
  byRoute: [
    { routeKey: 'nen-regular', label: 'NEN配信「定期便のご案内」', attributionState: 'attributed', netCount: 48, netValue: 294_000, audience: null, conversionRate: null },
    { routeKey: 'google-summer', label: 'Google広告 夏キャンペーン', attributionState: 'attributed', netCount: 37, netValue: 112_000, audience: null, conversionRate: null },
    { routeKey: 'rich-menu-booking', label: 'リッチメニュー「予約する」', attributionState: 'attributed', netCount: 55, netValue: 0, audience: null, conversionRate: null },
    { routeKey: 'unattributed', label: '未帰属', attributionState: 'unattributed', netCount: 8, netValue: 60_000, audience: null, conversionRate: null },
  ],
}

export const CONVERSION_EXPORT_CSV = `\uFEFF${[
  ['期間開始', '期間終了', 'タイムゾーン', '純額定義', '成果地点ID', '成果地点名', '起点', '状態', '成果件数', '純成果件数', '取消件数', '純金額', '利用先数', '更新日時'],
  ...CONVERSION_DEFINITIONS.items.map((item) => [
    CONVERSION_RANGE.from,
    CONVERSION_RANGE.to,
    CONVERSION_RANGE.timeZone,
    item.metrics.reversalReason,
    item.id,
    item.name,
    item.sourceType,
    item.status,
    item.metrics.recordedCount,
    item.metrics.netCount,
    '',
    item.metrics.netValue,
    item.usageCount,
    item.updatedAt,
  ]),
].map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\r\n')}\r\n`

/*
  紹介者ごとの集計。設計 `jwrbf`（成果内訳）が読む。

  **紹介者の一覧に居る人は、ここにも全員入れる。** 片方に居て片方に居ないと、
  内訳の面が `Cannot read properties of undefined (reading 'toLocaleString')` で
  落ちる（実装が行の有無を確かめずに数を整形しているため。別途 Issue に出した）。
*/
/*
 * 今月の成果の合計は V8 の板（`nJlxX`）の 38 件にそろえる。
 * 6人の並び・承認済み報酬の列は変えない（別の板が読む）。
 */
export const AFFILIATE_REPORT = [
  /* V8 の板（nJlxX・Eo56k）の数：成果 14・9・8・5・2・0 件（今月 38 件）、報酬 ¥28,000・¥31,400・¥8,000・¥0・¥3,000・¥0。
     1件ごとの人は割合 0% で、認めた定額（confirmedReward）が報酬。ノースは売上 ¥314,000 の 10%。 */
  { affiliateId: 'af-1', affiliateName: '見本 168', code: 'tanaka-a', commissionRate: 0, totalClicks: 820, totalConversions: 14, totalRevenue: 412000, confirmedReward: 28000, linkCount: 2, friendAdds: 186 },
  { affiliateId: 'af-2', affiliateName: '合同会社ノース', code: 'north', commissionRate: 10, totalClicks: 1240, totalConversions: 9, totalRevenue: 314000, confirmedReward: 0, linkCount: 3, friendAdds: 240 },
  { affiliateId: 'af-5', affiliateName: '見本 135', code: 'yamaguchi', commissionRate: 0, totalClicks: 300, totalConversions: 8, totalRevenue: 256000, confirmedReward: 8000, linkCount: 1, friendAdds: 72 },
  { affiliateId: 'af-4', affiliateName: '見本 27', code: 'nakamura', commissionRate: 0, totalClicks: 260, totalConversions: 5, totalRevenue: 0, confirmedReward: 0, linkCount: 1, friendAdds: 45 },
  { affiliateId: 'af-3', affiliateName: '見本 26', code: 'kimura', commissionRate: 0, totalClicks: 90, totalConversions: 2, totalRevenue: 64000, confirmedReward: 3000, linkCount: 1, friendAdds: 30 },
  { /* 成果0の人。0と未取得を混ぜないため、0はきちんと0で返す。 */ affiliateId: 'af-6', affiliateName: '旧パートナーA', code: 'old-a', commissionRate: 10, totalClicks: 0, totalConversions: 0, totalRevenue: 0, confirmedReward: 0, linkCount: 1, friendAdds: 0 },
]

/*
  紹介者ひとりぶんの内訳。設計 `jwrbf` が読む（`/api/affiliates/:id/report`）。

  **器そのものが要る。** 既定の配列が返っていたので、内訳の面は
  `report.clicks.toLocaleString()` で落ちていた。
  `duplicateFlags` に1件入れてあるのは、設計の「重複の疑い 1」を撮るため。
*/
export const AFFILIATE_REPORT_DETAIL = {
  affiliateId: 'af-1', affiliateName: '見本 168', code: 'tanaka-a', commissionRate: 0,
  clicks: 820, linkClicks: 760, friendAdds: 58,
  conversions: 24, conversionsApproved: 18, conversionsPending: 4, conversionsRejected: 2,
  conversionsByPoint: [
    { conversionPointId: 'cp-1', name: 'ECの注文が確定したとき', count: 14, value: 512000 },
    { conversionPointId: 'cp-4', name: '体験の申し込み', count: 8, value: 24000 },
    { conversionPointId: 'cp-5', name: '資料請求', count: 2, value: 3000 },
  ],
  byOffer: [
    { offerId: 'ao-1', offerName: '体験の申し込み', rewardAmount: 3000, conversionsApproved: 12, conversionsPending: 2, confirmedReward: 36000 },
    { offerId: 'ao-2', offerName: '定期便のお申し込み', rewardAmount: 5000, conversionsApproved: 5, conversionsPending: 1, confirmedReward: 25000 },
    { offerId: 'ao-4', offerName: '資料請求', rewardAmount: 1500, conversionsApproved: 1, conversionsPending: 1, confirmedReward: 1500 },
  ],
  revenue: 860000, estimatedCommission: 86000, confirmedReward: 86000,
  duplicateFlags: [{ friendId: 'friend-4', identityKey: 'ik-friend-4' }],
}

/*
 * 機能16。成果を締め、振込データと明細を作る新しい実API契約。
 * 今月の報酬の合計は V8 の板（`nJlxX`）の ¥70,400 にそろえる。
 * 内訳3人の合計も 70,400 に合わせる（合計と内訳が違う絵にしない）。
 */
export const AFFILIATE_SETTLEMENT_PREVIEW = {
  lineAccountId: 'visual-qa-account',
  periodFrom: '2026-08-01T00:00:00.000Z',
  periodTo: '2026-08-31T23:59:59.999Z',
  currency: 'JPY',
  /* V8 の板（aINnz・usDpO・nJlxX）の今回払う額 ¥70,400・4人・33件。見本 26は振込先が未登録。 */
  totalAmount: 70400,
  conversionCount: 33,
  affiliates: [
    { affiliateId: 'af-2', affiliateName: '合同会社ノース', code: 'north', amount: 31400, grossAmount: 31400, deduction: 0, conversionCount: 9, bankProfileRegistered: true },
    { affiliateId: 'af-1', affiliateName: '見本 168', code: 'tanaka-a', amount: 28000, grossAmount: 30000, deduction: 2000, conversionCount: 14, bankProfileRegistered: true },
    { affiliateId: 'af-5', affiliateName: '見本 135', code: 'yamaguchi', amount: 8000, grossAmount: 8000, deduction: 0, conversionCount: 8, bankProfileRegistered: true },
    { affiliateId: 'af-3', affiliateName: '見本 26', code: 'kimura', amount: 3000, grossAmount: 3000, deduction: 0, conversionCount: 2, bankProfileRegistered: false },
  ],
  previewVersion: '82e052367d36df0428262a3c69e38ec22e45b05de382deec83e924960f1aa13d',
}

export const AFFILIATE_SETTLEMENT_CREATED = {
  kind: 'created', settlementId: 'visual-qa-settlement-2026-08',
  totalAmount: AFFILIATE_SETTLEMENT_PREVIEW.totalAmount, conversionCount: AFFILIATE_SETTLEMENT_PREVIEW.conversionCount, version: 1,
  closedAt: '2026-09-07T02:00:00.000Z',
}

export const AFFILIATE_PAYOUT_BATCH = {
  id: 'visual-qa-payout-batch-2026-08', lineAccountId: 'visual-qa-account',
  settlementId: AFFILIATE_SETTLEMENT_CREATED.settlementId,
  totalAmount: AFFILIATE_SETTLEMENT_CREATED.totalAmount, currency: 'JPY', lineCount: AFFILIATE_SETTLEMENT_CREATED.conversionCount, state: 'created',
  bankFormat: 'zengin_csv', fileChecksum: null, version: 1,
  downloadExpiresAt: null, createdAt: '2026-09-07T02:01:00.000Z',
}

export const AFFILIATE_STATEMENT = {
  id: 'visual-qa-affiliate-statement-2026-08', lineAccountId: 'visual-qa-account',
  affiliateId: 'af-1', settlementId: AFFILIATE_SETTLEMENT_CREATED.settlementId,
  totalAmount: AFFILIATE_SETTLEMENT_PREVIEW.affiliates.find((item) => item.affiliateId === 'af-1').amount, status: 'generated', version: 1,
  expiresAt: '2026-10-07T02:02:00.000Z', createdAt: '2026-09-07T02:02:00.000Z',
}

/** 紹介者が配っているリンク。設計 `jwrbf` の下半分。 */
export const AFFILIATE_LINKS = [
  /* V8 の板（tnTn9）の「発行ずみの紹介リンク」2本。 */
  { id: 'al-1', affiliate_id: 'af-1', ref_code: 'ref-tanaka-teiki', label: '秋の定期便キャンペーン用', line_account_id: 'visual-qa-account', click_count: 620, friend_adds: 42, conversions: 9, is_active: 1, created_at: '2026-09-01T00:00:00.000Z', offer_id: 'ao-1', offer_name: '秋の定期便キャンペーン' },
  { id: 'al-2', affiliate_id: 'af-1', ref_code: 'ref-tanaka-furikake', label: '鹿肉ふりかけ用', line_account_id: 'visual-qa-account', click_count: 160, friend_adds: 12, conversions: 5, is_active: 1, created_at: '2026-09-10T00:00:00.000Z', offer_id: 'ao-2', offer_name: '鹿肉ふりかけ 新登場' },
]

/*
  共通アクション。設計 `xOpDs` の「共通アクション 14」のうち、札の内訳が撮れる5本。

  **版と呼び出し元を混ぜる。** 設計の札は 公開中11／下書き3／**古い版あり2**／
  **呼ばれていない1**。全部が公開中・呼ばれている状態だと、その4つが撮れない。
  版が見えないと「直してよいか」が判断できない、というのが設計の言いたいこと。
*/
/*
 * 共通アクションの一覧（V8 の板 `LnGNw`）。公開中5・下書き1・保管2。
 * 呼び出し元の合計12か所・今月動いた 3,210 回・失敗 2 件（数の帯と同じ）。
 */
const COMMON_ACTION_METRICS = {
  'ca-2': [52, 0, '2026-09-30T10:31:00+09:00'],
  'ca-3': [1_800, 1, '2026-09-30T09:42:00+09:00'],
  'ca-1': [900, 1, '2026-09-29T09:05:00+09:00'],
  'ca-6': [248, 0, '2026-09-29T14:02:00+09:00'],
  'ca-5': [210, 0, '2026-09-28T18:40:00+09:00'],
  'ca-7': [0, 0, null],
  'ca-8': [0, 0, null], 'ca-9': [0, 0, null],
}

export const COMMON_ACTIONS = [
  { id: 'ca-2', name: '購入のお礼', description: '買ってくれた人へのお礼とフォロー', status: 'published', draftVersion: null, publishedVersion: 3, actionCount: 3, bindingCount: 3, oldVersionBindingCount: 0, updatedAt: '2026-09-30T01:00:00.000Z' },
  { id: 'ca-3', name: '予約が入ったとき', description: '予約のお礼と担当への連絡', status: 'published', draftVersion: null, publishedVersion: 5, actionCount: 3, bindingCount: 4, oldVersionBindingCount: 1, updatedAt: '2026-09-29T01:00:00.000Z' },
  { id: 'ca-1', name: '体験申込を受けたとき', description: '申込の内容で案内を分ける', status: 'published', draftVersion: null, publishedVersion: 2, actionCount: 3, bindingCount: 2, oldVersionBindingCount: 0, updatedAt: '2026-09-28T01:00:00.000Z' },
  { id: 'ca-6', name: '写真を通したとき', description: '掲載のお知らせ', status: 'published', draftVersion: null, publishedVersion: 1, actionCount: 2, bindingCount: 1, oldVersionBindingCount: 0, updatedAt: '2026-09-27T01:00:00.000Z' },
  { id: 'ca-5', name: 'アンケートの回収', description: '回答を友だち情報へ', status: 'published', draftVersion: 5, publishedVersion: 4, actionCount: 2, bindingCount: 2, oldVersionBindingCount: 0, updatedAt: '2026-09-26T01:00:00.000Z' },
  { id: 'ca-7', name: '解約を止めたいとき', description: '引き止めの案内', status: 'draft', draftVersion: 1, publishedVersion: null, actionCount: 3, bindingCount: 0, oldVersionBindingCount: 0, updatedAt: '2026-09-25T01:00:00.000Z' },
  { /* 保管（通常の一覧には出ない）。 */ id: 'ca-8', name: '旧キャンペーンのお礼', description: '保管した処理', status: 'archived', draftVersion: null, publishedVersion: 2, actionCount: 2, bindingCount: 0, oldVersionBindingCount: 0, updatedAt: '2026-08-01T01:00:00.000Z' },
  { id: 'ca-9', name: '休業のお知らせ', description: '保管した処理', status: 'archived', draftVersion: null, publishedVersion: 3, actionCount: 1, bindingCount: 0, oldVersionBindingCount: 0, updatedAt: '2026-07-30T01:00:00.000Z' },
].map((action) => ({
  ...action,
  executionCountThisMonth: COMMON_ACTION_METRICS[action.id][0],
  failureCountThisMonth: COMMON_ACTION_METRICS[action.id][1],
  lastRunAt: COMMON_ACTION_METRICS[action.id][2],
}))

/**
 * 機能25の一覧。V8 の板（`LWQXd`・`En14p`・`nH9L8`）の6本（動いている5・止めている1）。
 * この30日に動いた数の合計は 2,988 回・失敗は 6 回（数の帯と同じ）。
 * 並びは更新が新しい順（絵の上から）。
 */
const AUTOMATION_METRICS = {
  'au-1': [312, 0], 'au-2': [128, 0], 'au-3': [52, 1], 'au-4': [2_410, 5], 'au-5': [86, 0], 'au-6': [0, 0],
}

export const AUTOMATIONS = [
  { id: 'au-1', name: '問い合わせを担当へ知らせる', description: 'メッセージを受けたら担当へ知らせ、問い合わせのタグを付ける', eventType: 'message_received', triggerConfig: {}, conditions: {}, actions: [{ type: 'notify_staff', params: { notifyStaffIds: ['staff-1'] } }, { type: 'add_tag', params: { tagId: 'tag-support' } }], isActive: true, priority: 100, lineAccountId: 'visual-qa-account', createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-09-30T01:00:00.000Z' },
  { id: 'au-2', name: '予約が入ったらお礼', description: '予約が確定したらお礼を送り、予約済みのタグを付ける', eventType: 'calendar_booked', triggerConfig: {}, conditions: {}, actions: [{ type: 'send_message', params: { templateId: 'booking-thanks' } }, { type: 'add_tag', params: { tagId: 'tag-booked' } }], isActive: true, priority: 90, lineAccountId: 'visual-qa-account', createdAt: '2026-07-02T00:00:00.000Z', updatedAt: '2026-09-29T01:00:00.000Z' },
  { id: 'au-3', name: '購入のお礼とフォロー', description: 'はじめて買った人に共通アクション「購入のお礼」を呼ぶ', eventType: 'ec.order.confirmed', triggerConfig: {}, conditions: { firstOrder: true }, actions: [{ type: 'common_action', params: { commonActionId: 'ca-2' } }], isActive: true, priority: 80, lineAccountId: 'visual-qa-account', createdAt: '2026-07-03T00:00:00.000Z', updatedAt: '2026-09-28T01:00:00.000Z' },
  { id: 'au-4', name: '定期フォロー 1', description: '友だちになって7日たった購入前の人に使い方のコツを送る', eventType: 'friend_add', triggerConfig: {}, conditions: { tagId: 'tag-before-purchase' }, actions: [{ type: 'send_message', params: { templateId: 'tips' } }], isActive: true, priority: 70, lineAccountId: 'visual-qa-account', createdAt: '2026-07-04T00:00:00.000Z', updatedAt: '2026-09-27T01:00:00.000Z' },
  { id: 'au-5', name: 'アンケートの回答でタグ', description: '来店アンケートに答えた人に回答済みのタグを付ける', eventType: 'form_submitted', triggerConfig: {}, conditions: {}, actions: [{ type: 'add_tag', params: { tagId: 'tag-answered' } }], isActive: true, priority: 60, lineAccountId: 'visual-qa-account', createdAt: '2026-07-05T00:00:00.000Z', updatedAt: '2026-09-26T01:00:00.000Z' },
  { id: 'au-6', name: '旧キャンペーンの自動返信', description: '「キャンペーン」と送られたら案内を返す（止めている）', eventType: 'message_received', triggerConfig: { keyword: 'キャンペーン' }, conditions: {}, actions: [{ type: 'send_message', params: { templateId: 'campaign-old' } }], isActive: false, priority: 50, lineAccountId: 'visual-qa-account', createdAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-09-01T01:00:00.000Z' },
].map((automation) => ({
  ...automation,
  triggerConfig: automation.triggerConfig ?? automation.conditions,
  status: automation.isActive ? 'active' : 'stopped',
  versionId: `${automation.id}-version-3`,
  version: 3,
  executionCount30d: AUTOMATION_METRICS[automation.id][0],
  failureCount30d: AUTOMATION_METRICS[automation.id][1],
  lastRunAt: AUTOMATION_METRICS[automation.id][0] === 0 ? null : '2026-08-25T10:31:00+09:00',
}))

/**
 * 機能25「動いた記録」（設計 `DkPY0`）。
 *
 * 成功・条件外・失敗を混ぜ、通常状態で3つの結果表示を確かめられるようにする。
 * `detail` は顧客本文ではなく、実行した処理の固定ラベルだけを持つ。
 */
const automationRun = ({
  id, occurredAt, subject, accountLabel, triggerLabel, status, detail, durationMs,
  automationId, automationName, domainStatus, successfulActions = [], failedAction = null,
  failureReason = null,
}) => ({
  id,
  ownerKind: 'automation',
  ownerId: automationId,
  lineAccountId: 'visual-qa-account',
  occurredAt,
  subject,
  accountLabel,
  triggerLabel,
  reference: null,
  status,
  detail,
  durationMs,
  canRetry: status === 'permanent_failed' && failedAction !== null,
  automationId,
  automationName,
  automationVersionId: `${automationId}-version-3`,
  // #942 N-354: 実行時に固定された版番号とテスト印。
  versionNumber: 3,
  isTest: false,
  // #942 N-353: 終わっていない実行だけ取りやめられる。見本の行は終了済み。
  canCancel: false,
  friendId: `friend-${id}`,
  friendName: subject,
  sourceEventId: `event-${id}`,
  domainStatus,
  startedAt: occurredAt,
  completedAt: durationMs === null ? null : occurredAt,
  successfulActions,
  skippedActions: [],
  failedAction,
  failureReason,
})

/*
 * 動いた数の見本は V8 の板（`LWQXd`・`g98F9`）の数にそろえる。
 * 今月動いた 2,988 回・条件に外れた 1,240 回・失敗 6 件。
 * 明細の7行は見本の行（撮影用）で、集計の数とは別。
 */
export const AUTOMATION_RUNS = {
  summary: {
    total: 9666,
    executed: 2988,
    skipped: 1240,
    failed: 6,
    mostRunName: '問い合わせを担当へ知らせる',
    mostRunCount: 312,
  },
  /* 板 `g98F9` の5行（動いた3・失敗1・条件に外れた1。5行目はテスト実行）。 */
  items: [
    { ...automationRun({ id: 'run-1', occurredAt: '2026-09-30T14:12:00+09:00', subject: 'Demo Person', accountLabel: '然 本店', triggerLabel: 'メッセージが届いたとき', status: 'succeeded', detail: '担当者通知／タグを追加', durationMs: 800, automationId: 'au-1', automationName: '問い合わせを担当へ知らせる', domainStatus: 'success', successfulActions: ['担当へ知らせる', 'タグ'] }), versionNumber: 4 },
    { ...automationRun({ id: 'run-2', occurredAt: '2026-09-30T11:05:00+09:00', subject: 'Masato S.', accountLabel: '然 本店', triggerLabel: '注文が確定したとき', status: 'permanent_failed', detail: 'ブロック中で送れず', durationMs: 300, automationId: 'au-3', automationName: '購入のお礼とフォロー', domainStatus: 'failed', successfulActions: ['購入のお礼'], failedAction: null, failureReason: 'ブロック中で送れず' }), versionNumber: 2 },
    automationRun({ id: 'run-3', occurredAt: '2026-09-30T09:40:00+09:00', subject: '見本 15', accountLabel: '然 渋谷店', triggerLabel: '予約が確定したとき', status: 'succeeded', detail: 'メッセージ／タグ', durationMs: 1100, automationId: 'au-2', automationName: '予約が入ったらお礼', domainStatus: 'success', successfulActions: ['メッセージ', 'タグ'] }),
    { ...automationRun({ id: 'run-4', occurredAt: '2026-09-29T21:18:00+09:00', subject: '見本 141', accountLabel: '然 本店', triggerLabel: '友だちが追加されたとき', status: 'skipped', detail: 'タグ「購入前」がない', durationMs: 100, automationId: 'au-4', automationName: '定期フォロー 1', domainStatus: 'skipped_condition' }), versionNumber: 6 },
    { ...automationRun({ id: 'run-5', occurredAt: '2026-09-29T19:22:00+09:00', subject: '見本 25', accountLabel: '然 本店', triggerLabel: 'フォームに回答したとき', status: 'succeeded', detail: 'タグ「回答済み」', durationMs: 400, automationId: 'au-5', automationName: 'アンケートの回答でタグ', domainStatus: 'success', successfulActions: ['タグ「回答済み」'] }), isTest: true, versionNumber: 1 },
  ],
  pagination: { total: 4234, limit: 20, offset: 0 },
}

/*
 * 見本テンプレートの `triggerLabel` は、**きっかけの種類名ではなく説明文**。
 *
 * 「誕生日の◯日前になったとき」「行動スコアが80になったとき」のように
 * 具体的な条件を含んでいて、`AUTOMATION_TRIGGER_LABELS`(正本)の種類名
 * (「行動スコアが条件に達したとき」)とは**別のものを指している**。
 * カタログとして「こういう自動化ができます」を見せる文言なので、
 * **正本へ寄せない**(#735)。
 *
 * 一方、`AUTOMATION_RUNS` の実行記録は実口が
 * `automationTriggerLabel(row.trigger_type)` で正本から引くので、
 * そちらは正本の値でなければならない。`cross-contracts.test.ts` が見張る。
 */
/*
 * 板 `c7dxp`（オートメーション 見本）の12枚。きっかけは本物の口と同じ「〇〇とき」の言い方で返し、
 * 画面が「とき」を落として出す（絵：「友だちになった」）。
 */
export const AUTOMATION_TEMPLATES = [
  { key: 'welcome', name: '友だち追加のあいさつとタグ', description: '追加された友だちへあいさつします', triggerLabel: '友だちになったとき', actionLabel: 'メッセージを送る・タグを付ける' },
  { key: 'reservation', name: '「予約」と送られたら担当へ', description: '予約したい人を迷わせません', triggerLabel: 'メッセージを受け取ったとき（含まれる言葉）', actionLabel: '担当に知らせる・タグを付ける' },
  { key: 'vip-scenario', name: 'VIP タグでシナリオ開始', description: '自由に組み替えられる見本です', triggerLabel: 'タグが付いたとき', actionLabel: 'シナリオを始める' },
  { key: 'survey-tag', name: 'アンケートの回答でタグ', description: '回答で友だちを分けます', triggerLabel: 'フォームに答えたとき', actionLabel: 'タグを付ける' },
  { key: 'booking', name: '予約のお礼と前日リマインド', description: '来店忘れを減らします', triggerLabel: '予約が確定したとき', actionLabel: 'メッセージを送る' },
  { key: 'purchase', name: '購入のお礼とフォロー', description: '購入後のお礼を自動化します', triggerLabel: '注文が確定したとき', actionLabel: '共通アクション「購入のお礼」' },
  { key: 'first-order', name: '初回購入でマイル付与', description: '初回購入のお礼を自動化します', triggerLabel: '注文が確定したとき（初回）', actionLabel: 'マイルを付ける' },
  { key: 'winback', name: '休眠の人へ声かけ', description: '休眠した友だちへ定期的に案内します', triggerLabel: '決めた時刻・曜日（毎週月曜）', actionLabel: 'メッセージを送る' },
  { key: 'birthday', name: '誕生月のクーポン', description: '誕生日に合わせて特典を届けます', triggerLabel: '決めた時刻・曜日（毎月1日）', actionLabel: 'クーポンを送る' },
  { key: 'unblock', name: 'ブロック解除で再あいさつ', description: '解除後にもう一度あいさつします', triggerLabel: '友だちになったとき（再追加）', actionLabel: 'メッセージを送る' },
  { key: 'shipping', name: '発送のお知らせ', description: '発送を知らせます', triggerLabel: '注文が発送されたとき', actionLabel: 'メッセージを送る' },
  { key: 'pause', name: '定期便の休止で引き止め', description: '休止した人へ案内します', triggerLabel: '定期便が休止されたとき', actionLabel: 'メッセージを送る・タグを付ける' },
]

const caStep = (id, type, params = {}, onFailure = 'stop') => ({ id, type, params, onFailure })
export const COMMON_ACTION_DETAIL = {
  id: 'ca-1', name: '体験申込を受けたとき', description: 'タグ・シナリオ・担当の3つ', status: 'published',
  currentDraftVersionId: null, currentPublishedVersionId: 'cav-4',
  versions: [
    { id: 'cav-4', versionNumber: 4, status: 'published', draftRevision: 1, actions: [caStep('s41', 'add_tag', { tagId: 'tag-trial' }), caStep('s42', 'wait', { minutes: 30 }), caStep('s43', 'send_message', { templateId: 'template-usage-1', templateName: '体験のご案内', templateVersion: 4 }, 'continue'), caStep('s44', 'start_scenario', { scenarioId: 'scenario-0' }), caStep('s45', 'set_metadata', { assignee: '佐々木' }, 'continue')], createdBy: '佐々木', createdAt: '2026-08-20T05:02:00.000Z', publishedAt: '2026-08-20T05:02:00.000Z' },
    { id: 'cav-3', versionNumber: 3, status: 'published', draftRevision: 1, actions: [caStep('s31', 'add_tag'), caStep('s32', 'wait', { minutes: 30 }), caStep('s33', 'send_message'), caStep('s34', 'start_scenario')], createdBy: '田中', createdAt: '2026-08-12T00:40:00.000Z', publishedAt: '2026-08-12T00:40:00.000Z' },
    { id: 'cav-2', versionNumber: 2, status: 'published', draftRevision: 1, actions: [caStep('s21', 'add_tag'), caStep('s22', 'wait', { minutes: 10 }), caStep('s23', 'start_scenario')], createdBy: '佐々木', createdAt: '2026-08-04T08:20:00.000Z', publishedAt: '2026-08-04T08:20:00.000Z' },
    { id: 'cav-1', versionNumber: 1, status: 'published', draftRevision: 1, actions: [caStep('s11', 'add_tag'), caStep('s12', 'send_message')], createdBy: '佐々木', createdAt: '2026-07-28T02:15:00.000Z', publishedAt: '2026-07-28T02:15:00.000Z' },
  ],
  bindings: [
    { id: 'cab-1', consumerType: 'scenario', consumerId: 'scenario-0', consumerPath: '体験前フォロー・1通目のあと', versionId: 'cav-4', versionNumber: 4, latestVersionNumber: 4, hasNewerVersion: false, runningCount: 8, waitingCount: 2, olderRunningCount: 0, olderWaitingCount: 0, updatedAt: '2026-08-25T00:00:00.000Z' },
    { id: 'cab-2', consumerType: 'form', consumerId: 'form-1', consumerPath: '体験のお申し込み・送信後', versionId: 'cav-3', versionNumber: 3, latestVersionNumber: 4, hasNewerVersion: true, runningCount: 4, waitingCount: 1, olderRunningCount: 0, olderWaitingCount: 0, updatedAt: '2026-08-24T00:00:00.000Z' },
    { id: 'cab-3', consumerType: 'auto_reply', consumerId: 'ar-1', consumerPath: '「体験」と送られたとき', versionId: 'cav-4', versionNumber: 4, latestVersionNumber: 4, hasNewerVersion: false, runningCount: 2, waitingCount: 1, olderRunningCount: 0, olderWaitingCount: 0, updatedAt: '2026-08-23T00:00:00.000Z' },
    { id: 'cab-4', consumerType: 'rich_menu', consumerId: 'rm-1', consumerPath: '体験を申し込む を押したとき', versionId: 'cav-4', versionNumber: 4, latestVersionNumber: 4, hasNewerVersion: false, runningCount: 2, waitingCount: 1, olderRunningCount: 0, olderWaitingCount: 0, updatedAt: '2026-08-22T00:00:00.000Z' },
    { id: 'cab-5', consumerType: 'automation', consumerId: 'au-3', consumerPath: 'タグ「体験申込」が付いたとき', versionId: 'cav-4', versionNumber: 4, latestVersionNumber: 4, hasNewerVersion: false, runningCount: 2, waitingCount: 1, olderRunningCount: 0, olderWaitingCount: 0, updatedAt: '2026-08-21T00:00:00.000Z' },
  ],
}

/*
 * 「購入のお礼」の版と使われている場所（V8 の板 `ziSgL`）。
 * 下書き v4・いまの版 v3（9/24 公開）・古い版 v2。呼び出し元4か所（うち1か所は v2 のまま＝新版あり）。
 */
export const COMMON_ACTION_DETAIL_PURCHASE = {
  id: 'ca-2', name: '購入のお礼', description: '買ってくれた人へのお礼とフォロー', status: 'published',
  currentDraftVersionId: 'cav2-4', currentPublishedVersionId: 'cav2-3',
  versions: [
    { id: 'cav2-4', versionNumber: 4, status: 'draft', draftRevision: 2, actions: [caStep('p41', 'add_tag', { tagId: 'tag-purchased' }), caStep('p42', 'wait', { minutes: 1440 }), caStep('p43', 'send_message', { templateId: 'template-thanks-autumn', templateName: 'お礼（秋）' })], createdBy: '見本 30', createdAt: '2026-09-29T01:00:00.000Z', publishedAt: null },
    { id: 'cav2-3', versionNumber: 3, status: 'published', draftRevision: 1, actions: [caStep('p31', 'add_tag', { tagId: 'tag-purchased' }), caStep('p32', 'wait', { minutes: 1440 }), caStep('p33', 'send_message', { templateId: 'template-thanks', templateName: 'お礼' })], createdBy: '見本 18', createdAt: '2026-09-24T01:00:00.000Z', publishedAt: '2026-09-24T01:00:00.000Z' },
    { id: 'cav2-2', versionNumber: 2, status: 'published', draftRevision: 1, actions: [caStep('p21', 'add_tag', { tagId: 'tag-purchased' }), caStep('p22', 'send_message', { templateId: 'template-thanks', templateName: 'お礼' })], createdBy: '見本 18', createdAt: '2026-08-30T06:20:00.000Z', publishedAt: '2026-08-30T06:20:00.000Z' },
  ],
  bindings: [
    { id: 'cab2-1', consumerType: 'automation', consumerId: 'au-3', consumerPath: '購入のお礼とフォロー', versionId: 'cav2-3', versionNumber: 3, latestVersionNumber: 3, hasNewerVersion: false, runningCount: 0, waitingCount: 4, olderRunningCount: 0, olderWaitingCount: 0, updatedAt: '2026-09-28T00:00:00.000Z' },
    { id: 'cab2-2', consumerType: 'automation', consumerId: 'au-mile', consumerPath: '初回購入でマイル付与', versionId: 'cav2-3', versionNumber: 3, latestVersionNumber: 3, hasNewerVersion: false, runningCount: 0, waitingCount: 0, olderRunningCount: 0, olderWaitingCount: 0, updatedAt: '2026-09-27T00:00:00.000Z' },
    { id: 'cab2-3', consumerType: 'scenario', consumerId: 'scenario-sub', consumerPath: '定期便のはじめての方', versionId: 'cav2-3', versionNumber: 3, latestVersionNumber: 3, hasNewerVersion: false, runningCount: 1, waitingCount: 12, olderRunningCount: 0, olderWaitingCount: 0, updatedAt: '2026-09-26T00:00:00.000Z' },
    { id: 'cab2-4', consumerType: 'automation', consumerId: 'au-6', consumerPath: '旧キャンペーンの自動返信', versionId: 'cav2-2', versionNumber: 2, latestVersionNumber: 3, hasNewerVersion: true, runningCount: 0, waitingCount: 0, olderRunningCount: 0, olderWaitingCount: 0, updatedAt: '2026-09-01T00:00:00.000Z' },
  ],
}

/*
  予約メニュー。設計 `QSLEH` の「メニュー 8／止めているもの 2つ」。
  料金は設計の ¥8,400／¥12,600／¥4,200／¥1,200／¥2,800。
  **`is_active` は 0/1 の数**（この口は DB の行をそのまま返す）。
*/
const BOOKING_MENU_ASSIGNED_STAFF = [
  { id: 'bs-1', display_name: '佐々木' },
  { id: 'bs-3', display_name: '高田' },
]
/**
 * 本番の `GET /api/booking/admin/menus` と同じ器。
 * `price_mode`・`version`・`effectiveBookingRules` が無いと、
 * これを根拠に実装した画面で項目漏れになる。
 * 店舗共通の初期値は BOOKING_SETTINGS(受付60日・締切1440分・取消1440分)。
 */
const BOOKING_MENU_STORE_RULES = { bookingWindowDays: 60, cutoffMinutesBefore: 1440, cancelDeadlineMinutesBefore: 1440 }
const bookingMenuRules = (windowDays, cutoffHours) => ({
  bookingWindowDays: windowDays ?? BOOKING_MENU_STORE_RULES.bookingWindowDays,
  cutoffMinutesBefore: cutoffHours == null ? BOOKING_MENU_STORE_RULES.cutoffMinutesBefore : cutoffHours * 60,
  cancelDeadlineMinutesBefore: BOOKING_MENU_STORE_RULES.cancelDeadlineMinutesBefore,
  source: {
    bookingWindowDays: windowDays == null ? 'store' : 'menu',
    cutoffMinutesBefore: cutoffHours == null ? 'store' : 'menu',
    cancelDeadlineMinutesBefore: 'store',
  },
})
export const BOOKING_MENUS = [
  { id: 'bm-1', name: 'トリミング（小型犬）', category_label: 'トリミング', description: 'シャンプー・カット・爪切り', duration_minutes: 105, buffer_after_minutes: 15, base_price: 8400, price_mode: 'fixed', version: 1, sort_order: 1, is_active: 1, auto_tag_id: null, intake_question: '気になるところ・アレルギーがあれば教えてください', concurrent_capacity: 1, booking_window_days: 60, cutoff_hours_before: 24, cancel_deadline_hours_before: null, assigned_staff: BOOKING_MENU_ASSIGNED_STAFF, booking_count_30_days: 3, effectiveBookingRules: bookingMenuRules(60, 24) },
  { id: 'bm-2', name: 'トリミング（中型犬）', category_label: 'トリミング', description: 'シャンプー・カット・爪切り', duration_minutes: 150, buffer_after_minutes: 15, base_price: 12600, price_mode: 'fixed', version: 1, sort_order: 2, is_active: 1, auto_tag_id: null, concurrent_capacity: 1, booking_window_days: 60, cutoff_hours_before: 24, cancel_deadline_hours_before: null, assigned_staff: BOOKING_MENU_ASSIGNED_STAFF, booking_count_30_days: 0, effectiveBookingRules: bookingMenuRules(60, 24) },
  { id: 'bm-3', name: 'シャンプーのみ', category_label: 'トリミング', description: null, duration_minutes: 60, buffer_after_minutes: 10, base_price: 4200, price_mode: 'fixed', version: 1, sort_order: 3, is_active: 1, auto_tag_id: null, concurrent_capacity: 2, booking_window_days: 60, cutoff_hours_before: 12, cancel_deadline_hours_before: null, assigned_staff: BOOKING_MENU_ASSIGNED_STAFF, booking_count_30_days: 1, effectiveBookingRules: bookingMenuRules(60, 12) },
  { id: 'bm-4', name: '爪切り', category_label: 'お手入れ', description: null, duration_minutes: 15, buffer_after_minutes: 5, base_price: 1200, price_mode: 'fixed', version: 1, sort_order: 6, is_active: 1, auto_tag_id: null, concurrent_capacity: 2, booking_window_days: 30, cutoff_hours_before: 2, cancel_deadline_hours_before: null, assigned_staff: BOOKING_MENU_ASSIGNED_STAFF, booking_count_30_days: 0, effectiveBookingRules: bookingMenuRules(30, 2) },
  { id: 'bm-5', name: '初回相談', category_label: '相談', description: 'はじめての方向け', duration_minutes: 30, buffer_after_minutes: 0, base_price: 0, price_mode: 'free', version: 1, sort_order: 4, is_active: 1, auto_tag_id: null, concurrent_capacity: 1, booking_window_days: 60, cutoff_hours_before: 12, cancel_deadline_hours_before: null, assigned_staff: BOOKING_MENU_ASSIGNED_STAFF, booking_count_30_days: 0, effectiveBookingRules: bookingMenuRules(60, 12) },
  { id: 'bm-6', name: '歯みがき教室', category_label: 'お手入れ', description: null, duration_minutes: 60, buffer_after_minutes: 5, base_price: 2800, price_mode: 'fixed', version: 1, sort_order: 5, is_active: 0, auto_tag_id: null, concurrent_capacity: 1, booking_window_days: 30, cutoff_hours_before: 6, cancel_deadline_hours_before: null, assigned_staff: [], booking_count_30_days: 0, effectiveBookingRules: bookingMenuRules(30, 6) },
  { id: 'bm-7', name: '足裏ケア', category_label: 'お手入れ', description: null, duration_minutes: 20, buffer_after_minutes: 5, base_price: 1800, price_mode: 'fixed', version: 1, sort_order: 7, is_active: 1, auto_tag_id: null, concurrent_capacity: 2, booking_window_days: 30, cutoff_hours_before: 2, cancel_deadline_hours_before: null, assigned_staff: BOOKING_MENU_ASSIGNED_STAFF, booking_count_30_days: 0, effectiveBookingRules: bookingMenuRules(30, 2) },
  { id: 'bm-8', name: '夏の毛刈り（終了）', category_label: '季節', description: null, duration_minutes: 60, buffer_after_minutes: 10, base_price: 6000, price_mode: 'fixed', version: 1, sort_order: 8, is_active: 0, auto_tag_id: null, concurrent_capacity: 1, booking_window_days: null, cutoff_hours_before: null, cancel_deadline_hours_before: null, assigned_staff: [], booking_count_30_days: 0, effectiveBookingRules: bookingMenuRules(null, null) },
]

/** 予約の店舗共通設定。設計 `W6465r` の受付期間・承認・営業時間。 */
export const BOOKING_SETTINGS = {
  id: 'booking-settings-visual-qa', lineAccountId: 'visual-qa-account',
  organizationName: '然-NEN- 本店', version: 1, timeZone: 'Asia/Tokyo',
  bookingWindowDays: 60, cutoffMinutesBefore: 1440, cancelDeadlineMinutesBefore: 1440,
  maxActiveBookingsPerFriend: 2, approvalMode: 'manual', holdMinutes: 15, slotGranularityMinutes: 15,
  liffDateView: 'list',
  menuCount: 8, activeMenuCount: 6, inactiveMenuCount: 2,
  /* 週の営業時間は保存済み（V8 受付枠 yRPxl は「まだ保存していません」の帯なしの絵）。 */
  businessHoursConfigured: true,
  businessHours: [
    { weekday: 0, intervals: [{ start: '10:00', end: '17:00', capacity: 2 }] },
    { weekday: 1, intervals: [{ start: '09:00', end: '12:00', capacity: 3 }, { start: '13:00', end: '19:00', capacity: 3 }] },
    { weekday: 2, intervals: [{ start: '09:00', end: '12:00', capacity: 3 }, { start: '13:00', end: '19:00', capacity: 3 }] },
    { weekday: 3, intervals: [] },
    { weekday: 4, intervals: [{ start: '09:00', end: '12:00', capacity: 3 }, { start: '13:00', end: '19:00', capacity: 3 }] },
    { weekday: 5, intervals: [{ start: '09:00', end: '19:00', capacity: 3 }] },
    { weekday: 6, intervals: [{ start: '09:00', end: '18:00', capacity: 2 }] },
  ],
  /* 臨時休業（V8 休業日 KRgTQ の「10/13（火）・10/14（水） 店舗の改装」）。 */
  exceptions: [
    {
      id: 'booking-exception-renovation', lineAccountId: 'visual-qa-account',
      scopeKind: 'store', scopeId: null, date: null,
      dateFrom: '2026-10-13', dateTo: '2026-10-14', kind: 'closed', intervals: [],
      reason: '店舗の改装', note: '店舗の改装', version: 1,
      createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
    },
  ],
  updatedAt: '2026-08-22T09:20:00.000Z',
}

/** 機能28 tksPc 用の店舗資源。実APIの resources 契約と同じ形で返す。 */
export const BOOKING_RESOURCES = [
  {
    id: 'resource-room-a', name: 'トリミング台', type: '台', capacity: 2, isActive: true,
    version: 1,
    businessHours: BOOKING_SETTINGS.businessHours, exceptions: BOOKING_SETTINGS.exceptions,
    usage: { menuCount: 2, bookingCount: 5, exceptionCount: 1, referenced: true },
  },
  {
    id: 'resource-room-b', name: 'シャンプー台', type: '台', capacity: 1, isActive: true,
    version: 1,
    businessHours: BOOKING_SETTINGS.businessHours, exceptions: [],
    usage: { menuCount: 0, bookingCount: 0, exceptionCount: 0, referenced: false },
  },
]

/** 予約スタッフ。設計 `tksPc` の押し口「佐々木」を含む。 */
/* 予約設定の担当スタッフ。板 `ooufy` の列の順（佐々木・高田・中川）。 */
export const BOOKING_STAFF = [
  { id: 'bs-1', name: '見本 110', display_name: '佐々木', role: 'トリマー', profile_image_url: null, bio: '小型犬が得意です。', sort_order: 1, is_designation_optional: 0, is_active: 1 },
  { id: 'bs-3', name: '見本 18', display_name: '高田', role: 'トリマー', profile_image_url: null, bio: null, sort_order: 2, is_designation_optional: 0, is_active: 1 },
  { id: 'bs-2', name: '見本 30', display_name: '中川', role: '受付', profile_image_url: null, bio: null, sort_order: 3, is_designation_optional: 1, is_active: 1 },
]

/* 機能28のメニュー×担当表。板 `ooufy` の升目どおり（佐々木と高田が4件、
 * 中川は無し）。佐々木×トリミング（小型犬）だけ上書き（120分・9400円）で、
 * 歯みがき教室は誰も担当しない（0人の注意書きが出る）。 */
const BOOKING_STAFF_OFFERED = {
  'bs-1': ['bm-1', 'bm-2', 'bm-3', 'bm-5'],
  'bs-3': ['bm-1', 'bm-2', 'bm-3', 'bm-5'],
  'bs-2': [],
}
export const BOOKING_STAFF_MENUS = Object.fromEntries(
  BOOKING_STAFF.map((staff) => [
    staff.id,
    BOOKING_MENUS.map((menu) => ({
      menu_id: menu.id,
      name: menu.name,
      is_offered: Number((BOOKING_STAFF_OFFERED[staff.id] ?? []).includes(menu.id)),
      override_duration_minutes: staff.id === 'bs-1' && menu.id === 'bm-1' ? 120 : null,
      override_price: staff.id === 'bs-1' && menu.id === 'bm-1' ? 9400 : null,
    })),
  ]),
)

/*
  メニューに就ける担当。設計 `GFDqW`（代理予約・内容確認）が読む。

  **`/api/booking/admin/menus/:id/staff` は道の途中にIDが入る。**
  `RAW` に載せられないので `RAW_PATTERNS` で返す。器は `{staff}` で、
  包むと `res.staff` が `undefined` になり、選ぶ口が0件のまま撮れない。
*/
export const BOOKING_MENU_STAFF = [
  { id: 'bs-1', display_name: '佐々木', role: 'トリマー', profile_image_url: null, bio: '小型犬が得意です。', is_designation_optional: 0, price: 8400, duration_minutes: 90 },
  { id: 'bs-3', display_name: '高田', role: 'トリマー', profile_image_url: null, bio: null, is_designation_optional: 0, price: 8400, duration_minutes: 90 },
]

/*
  空いている時間。設計 `GFDqW`（代理予約・内容確認）が読む。

  **時刻は動かさない。** 撮るたびに枠が変わると画像が毎回違うものになる。
  `10:00〜11:45` は「トリミング（小型犬）」の90分＋間隔15分ぶん。
  台帳の手順がこの表記で選ぶので、幅を変えるときは両方を直す。
*/
export const BOOKING_AVAILABILITY = {
  by_staff: [
    {
      staff_id: 'bs-1', display_name: '佐々木',
      slots: [
        { date: '2026-09-03', start: '10:00', end: '11:45' },
        { date: '2026-09-03', start: '13:00', end: '14:45' },
        /* 台帳の `Lg8ff`（予約枠の重なりと入力エラー）が選ぶ枠。 */
        { date: '2026-09-03', start: '14:00', end: '15:45' },
        { date: '2026-09-04', start: '10:00', end: '11:45' },
        { date: '2026-09-08', start: '09:00', end: '10:45' },
        { date: '2026-09-08', start: '13:00', end: '14:45' },
        { date: '2026-09-09', start: '10:00', end: '11:45' },
        { date: '2026-09-11', start: '09:00', end: '10:45' },
        { date: '2026-09-11', start: '15:00', end: '16:45' },
        { date: '2026-09-12', start: '13:00', end: '14:45' },
        { date: '2026-09-13', start: '10:00', end: '11:45' },
        { date: '2026-09-14', start: '09:00', end: '10:45' },
        { date: '2026-09-15', start: '13:00', end: '14:45' },
        { date: '2026-09-17', start: '09:00', end: '10:45' },
        { date: '2026-09-18', start: '15:00', end: '16:45' },
        { date: '2026-09-19', start: '10:00', end: '11:45' },
        { date: '2026-09-20', start: '10:00', end: '11:45' },
        { date: '2026-09-21', start: '13:00', end: '14:45' },
      ],
    },
    {
      staff_id: 'bs-3', display_name: '高田',
      slots: [
        { date: '2026-09-03', start: '15:00', end: '16:45' },
        { date: '2026-09-08', start: '15:00', end: '16:45' },
        { date: '2026-09-10', start: '09:00', end: '10:45' },
        { date: '2026-09-10', start: '13:00', end: '14:45' },
        { date: '2026-09-12', start: '15:00', end: '16:45' },
        { date: '2026-09-14', start: '13:00', end: '14:45' },
        { date: '2026-09-16', start: '09:00', end: '10:45' },
        { date: '2026-09-16', start: '15:00', end: '16:45' },
        { date: '2026-09-18', start: '09:00', end: '10:45' },
        { date: '2026-09-20', start: '15:00', end: '16:45' },
      ],
    },
  ],
  // LIFFカレンダーの「休」の印の見本（枠が無い日と区別する）。
  closed_dates: ['2026-09-05', '2026-09-06'],
}

/* #414 の availability 契約。予約枠ごとの定員・残数・状態を固定する。 */
for (const staff of BOOKING_AVAILABILITY.by_staff) {
  for (const slot of staff.slots) {
    // resources は実APIも画面も使わない(点検#516の中5)。あると本番との差に気づけない。
    delete slot.resources
    Object.assign(slot, {
      capacity: 2,
      remaining: slot.start === '14:00' ? 0 : 1,
      state: slot.start === '14:00' ? 'full' : 'limited',
    })
  }
}

/*
  予約設定の右の写し（お客さまの予約画面）が読む空き。店舗のルールを当てた見え方（apply_store_rules=1）。
  板 yRPxl・KRgTQ・x1OZS6 の写し：金 10/2 から5日（空き・空き・満・休み・空き）、10/2 は 9:00〜16:00 の6枠で 10:00・16:00 が満。
  ほかの画面（予約台帳・新しい予約・勤務）は BOOKING_AVAILABILITY のまま。
*/
const storeSlot = (date, start, end, remaining) => ({ date, start, end, capacity: 2, remaining, state: remaining > 0 ? 'limited' : 'full' })
export const BOOKING_AVAILABILITY_STORE_VIEW = {
  by_staff: [
    {
      staff_id: 'bs-1', display_name: '佐々木',
      slots: [
        storeSlot('2026-10-02', '09:00', '10:45', 1),
        storeSlot('2026-10-02', '10:00', '11:45', 0),
        storeSlot('2026-10-02', '13:00', '14:45', 1),
        storeSlot('2026-10-02', '14:00', '15:45', 1),
        storeSlot('2026-10-02', '15:00', '16:45', 1),
        storeSlot('2026-10-02', '16:00', '17:45', 0),
        storeSlot('2026-10-03', '10:00', '11:45', 1),
        storeSlot('2026-10-06', '13:00', '14:45', 1),
      ],
    },
  ],
  closed_dates: ['2026-10-05'],
}

/*
  V8 の絵（板 d5fmnM・E3YDK・CcA4k・wvGke・yRPxl・KRgTQ・x1OZS6 など）の右のスマホの見本が読む空き。
  絵は 10/2（金）始まり：最初の空きが金曜で 9:00〜16:00 の6枠（10:00 と 16:00 は満）、
  10/3（土）空き・10/4（日）満・10/5（月）休み・10/6（火）空き。
  「トリミング（小型犬）」の90分＋間隔15分で 105 分の枠。
  上の BOOKING_AVAILABILITY（9/3 始まり）は代理予約の手順が日付で選ぶので残し、
  見本の API は「10/1 以降の範囲」を聞かれたときだけこちらを返す（V8 の画面は今日から聞く）。
*/
const OCT_SLOT = (date, start, remaining) => {
  const [h, m] = start.split(':').map(Number)
  const end = h * 60 + m + 105
  return {
    date, start, end: `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`,
    capacity: 2, remaining, state: remaining === 0 ? 'full' : 'limited',
  }
}
export const BOOKING_AVAILABILITY_OCT = {
  by_staff: [
    {
      staff_id: 'bs-1', display_name: '佐々木',
      slots: [
        OCT_SLOT('2026-10-01', '16:00', 1),
        OCT_SLOT('2026-10-02', '09:00', 1), OCT_SLOT('2026-10-02', '10:00', 0), OCT_SLOT('2026-10-02', '13:00', 1),
        OCT_SLOT('2026-10-02', '14:00', 1), OCT_SLOT('2026-10-02', '15:00', 1), OCT_SLOT('2026-10-02', '16:00', 0),
        OCT_SLOT('2026-10-03', '10:00', 1), OCT_SLOT('2026-10-03', '13:00', 1),
        OCT_SLOT('2026-10-04', '10:00', 0), OCT_SLOT('2026-10-04', '13:00', 0),
        OCT_SLOT('2026-10-06', '09:00', 1), OCT_SLOT('2026-10-06', '13:00', 1),
        OCT_SLOT('2026-10-09', '10:00', 1), OCT_SLOT('2026-10-10', '13:00', 1),
        OCT_SLOT('2026-10-13', '09:00', 1), OCT_SLOT('2026-10-16', '15:00', 1),
        OCT_SLOT('2026-10-17', '15:00', 1), OCT_SLOT('2026-10-19', '10:00', 1),
        OCT_SLOT('2026-10-20', '13:00', 1),
      ],
    },
    {
      staff_id: 'bs-3', display_name: '高田',
      slots: [
        OCT_SLOT('2026-10-01', '16:00', 1), OCT_SLOT('2026-10-02', '15:00', 1), OCT_SLOT('2026-10-03', '09:00', 1),
        OCT_SLOT('2026-10-06', '15:00', 1), OCT_SLOT('2026-10-08', '13:00', 1),
        OCT_SLOT('2026-10-14', '09:00', 1), OCT_SLOT('2026-10-16', '13:00', 1),
      ],
    },
    { staff_id: 'bs-2', display_name: '中川', slots: [OCT_SLOT('2026-10-01', '16:00', 1)] },
  ],
  closed_dates: ['2026-10-05'],
}

/*

/*
  受付枠画面 `tksPc` が読む、担当者ごとの通常応答。
  現行APIが持つのは1曜日1区間と特別営業で、休けい・店舗上限・
  明示休業はまだ返せない。その項目は画面側で作らず「—」にする。
*/
/* 板 `d5fmnM`・`E3YDK` のいつもの勤務時間。月火水金 10:00-19:00・
 * 土 10:00-17:00・木日は休み（行を作らない）。 */
export const BOOKING_AVAILABILITY_RULES = [
  { id: 'bar-1', weekday: 1, start_time: '10:00', end_time: '19:00' },
  { id: 'bar-2', weekday: 2, start_time: '10:00', end_time: '19:00' },
  { id: 'bar-3', weekday: 3, start_time: '10:00', end_time: '19:00' },
  { id: 'bar-4', weekday: 5, start_time: '10:00', end_time: '19:00' },
  { id: 'bar-5', weekday: 6, start_time: '10:00', end_time: '17:00' },
]

/*
  担当者の休憩(N-405 #655)。本番の GET breaks と同じ器で返す。
  枠への差し引きは #1471 合流まで効かないので、画面は保存のみを約束する。
*/
/* 板 `d5fmnM`・`E3YDK` のいつもの休憩。月〜金 13:00-14:00。 */
export const BOOKING_BREAKS = {
  breaks: [
    { id: 'bb-1', weekday: 1, start_time: '13:00', end_time: '14:00', time_zone: 'Asia/Tokyo' },
    { id: 'bb-2', weekday: 2, start_time: '13:00', end_time: '14:00', time_zone: 'Asia/Tokyo' },
    { id: 'bb-3', weekday: 3, start_time: '13:00', end_time: '14:00', time_zone: 'Asia/Tokyo' },
    { id: 'bb-4', weekday: 4, start_time: '13:00', end_time: '14:00', time_zone: 'Asia/Tokyo' },
    { id: 'bb-5', weekday: 5, start_time: '13:00', end_time: '14:00', time_zone: 'Asia/Tokyo' },
  ],
  version: 'mock-breaks-v1',
}

/* 板 `d5fmnM` のこの日だけは休み1件とシフト1件だけ。この日だけの休憩は無い。 */
export const BOOKING_BREAK_DATES = {
  breaks: [],
  version: 'mock-break-dates-v1',
}

export const BOOKING_STAFF_SHIFTS = [
  { id: 'bss-1', work_date: '2026-10-17', start_time: '13:00', end_time: '19:00' },
]

/* 板 `d5fmnM` のこの日だけの休み。10/12（月）は研修のため休み。 */
export const BOOKING_EXCEPTIONS = {
  items: [
    {
      id: 'bex-1', lineAccountId: 'visual-qa-account', scopeKind: 'staff', scopeId: 'bs-1',
      date: '2026-10-12', dateFrom: '2026-10-12', dateTo: '2026-10-12', kind: 'closed',
      intervals: [], reason: '研修のため', note: null, version: 1,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    },
  ],
}

/* 予約経路の連携（V8 予約設定 ZyDd6 のスタッフの Google カレンダーと予約経路）。 */
export const BOOKING_CHANNELS = {
  timeZone: 'Asia/Tokyo',
  autoAssign: true,
  staff: [
    { staffId: 'bs-ch-1', displayName: '見本 18', status: 'connected', externalEventsThisWeek: 12, lastReadAt: '2026-10-02T09:40:00.000Z', readError: null },
    { staffId: 'bs-ch-2', displayName: '見本 30', status: 'connected', externalEventsThisWeek: 8, lastReadAt: '2026-10-02T09:40:00.000Z', readError: null },
    { staffId: 'bs-ch-3', displayName: '見本 31', status: 'not_connected', externalEventsThisWeek: null, lastReadAt: null, readError: null },
    { staffId: 'bs-1', displayName: 'Demo Person', status: 'connected', externalEventsThisWeek: 3, lastReadAt: '2026-10-02T09:40:00.000Z', readError: null },
    { staffId: 'bs-ch-4', displayName: '見本 157', status: 'expired', externalEventsThisWeek: null, lastReadAt: '2026-09-28T01:02:00.000Z', readError: null },
  ],
  channels: [
    { key: 'line', status: 'active', todayCount: 14 },
    { key: 'hot_pepper_beauty', status: 'confirm', todayCount: null },
    { key: 'google_reserve', status: 'preparing', todayCount: null },
    { key: 'epark', status: 'preparing', todayCount: null },
    { key: 'manual', status: 'active', todayCount: 3 },
  ],
}

export const BOOKING_GOOGLE_CALENDAR = {
  connection: {
    id: 'bgc-1', calendar_id: 'visual-qa-calendar@example.invalid',
    auth_type: 'service_account', is_active: 1,
    last_verified_at: '2026-09-02T00:00:00.000Z', last_error: null,
  },
  service_account: {
    configured: true,
    email: 'visual-qa-calendar@example.invalid',
  },
}

/*
  代理予約の登録結果。画面確認用なのでDB保存・通知は起こさない。
  10:00は登録完了、14:00は同じ枠を別の予約が取った競合として返す。
  本番の `POST /api/booking/admin/bookings` と同じHTTP状態・本文の形にする。
*/
export const BOOKING_PROXY_CREATE = {
  success: {
    status: 201,
    body: {
      booking_id: 'visual-qa-booking-1000',
      booking_customer_id: null,
      status: 'confirmed',
      calendar_sync: 'not_configured',
      line_notification: 'queued',
      reminders: [
        { id: 'br-proxy-day', kind: 'day_before', scheduled_at: '2026-09-02T01:00:00.000Z', sent_at: null, status: 'pending' },
        { id: 'br-proxy-hour', kind: 'hours_before', scheduled_at: '2026-09-03T00:00:00.000Z', sent_at: null, status: 'pending' },
      ],
      operations: [
        { id: 'bor-line-proxy', kind: 'confirmation_line', status: 'queued', scheduledAt: null, completedAt: null, openedAt: null, result: { notificationKind: 'approved' }, errorCode: null },
        { id: 'bor-calendar-proxy', kind: 'google_calendar', status: 'skipped', scheduledAt: null, completedAt: '2026-09-02T02:05:00.000Z', openedAt: null, result: { calendarSync: 'not_configured' }, errorCode: null },
        { id: 'bor-automation-proxy', kind: 'automation', status: 'succeeded', scheduledAt: null, completedAt: '2026-09-02T02:05:01.000Z', openedAt: null, result: { eventType: 'calendar_booked' }, errorCode: null },
      ],
      customer_context: {
        id: 'friend-kanno', friendId: 'friend-kanno', displayName: '見本 15', isLineLinked: true,
        phone: '090-0000-5678', petName: 'こむぎ',
        tags: [{ id: 'tag-nen', name: 'NEN会員' }, { id: 'tag-delivery', name: '定期便' }],
        mileageBalance: 1240, previousHandover: '前回は右耳を短めに整えました。',
        previousHandoverBooking: { id: 'bk-kanno-1', startsAt: '2026-08-03T01:00:00.000Z', status: 'completed' },
        recentBookings: [
          { id: 'bk-kanno-1', startsAt: '2026-08-03T01:00:00.000Z', status: 'completed', customerNote: '顔まわりは丸く', handoverNote: '右耳を短めに整えました。', price: 8400, menuName: 'トリミング（小型犬）', staffName: '佐々木' },
          { id: 'bk-kanno-2', startsAt: '2026-07-04T01:00:00.000Z', status: 'completed', customerNote: null, handoverNote: null, price: 4200, menuName: 'シャンプーのみ', staffName: '高田' },
        ],
      },
      replayed: false,
    },
  },
  conflict: {
    status: 409,
    body: {
      error: 'slot_conflict',
      data: {
        conflict: { from: '2026-09-03T05:00:00.000Z', to: '2026-09-03T06:45:00.000Z', count: 1, source: 'internal_booking' },
        nearbySlots: [
          { date: '2026-09-03', start: '10:00', end: '11:45', capacity: 2, remaining: 1, state: 'limited' },
          { date: '2026-09-03', start: '13:00', end: '14:45', capacity: 2, remaining: 1, state: 'limited' },
        ],
        alternateStaff: [
          { staffId: 'bs-3', displayName: '高田', slot: { date: '2026-09-03', start: '15:00', end: '16:45', capacity: 2, remaining: 1, state: 'limited' } },
        ],
      },
    },
  },
  unavailable: {
    status: 422,
    body: { error: 'slot_not_available' },
  },
}

/** #444。代理予約の確認前に読む顧客カルテと、サーバー計算済みの通知予定。 */
export const BOOKING_CUSTOMER_CONTEXT = BOOKING_PROXY_CREATE.success.body.customer_context
export const BOOKING_REMINDER_PREVIEW = {
  reminders: [
    { kind: 'day_before', scheduledAt: '2026-09-02T01:00:00.000Z' },
    { kind: 'hours_before', scheduledAt: '2026-09-03T00:00:00.000Z' },
  ],
}
export const BOOKING_CONFLICT_ALTERNATIVES = BOOKING_PROXY_CREATE.conflict.body.data

/** #444。一覧の先頭 `bk-1` を開いたときの顧客・履歴・通知実績。 */
export const BOOKING_ADMIN_DETAIL = {
  booking: {
    id: 'bk-1', startsAt: '2026-09-03T00:00:00.000Z', endsAt: '2026-09-03T01:45:00.000Z', status: 'confirmed',
    staffId: 'bs-1', menuId: 'bm-1', lockVersion: 1,
    notificationPolicy: { send_line_confirmation: true, day_before: true, hours_before: true },
    auditLogTotal: 0, auditLogs: [],
    customerNote: '顔まわりはふんわり仕上げてください。', internalNote: '皮膚の赤みに注意。', price: 8400,
    requestedAt: '2026-09-02T02:00:00.000Z', decidedAt: '2026-09-02T02:05:00.000Z', source: 'liff',
    createdByStaffId: 'visual-qa-owner', calendarSync: 'synced', menuName: 'トリミング（小型犬）', staffName: '佐々木',
    customer: {
      friendId: 'friend-1', bookingCustomerId: null, displayName: '見本 16', isLineLinked: true,
      phone: '090-0000-8765', petName: 'ももちゃん', tags: [{ id: 'tag-vip', name: 'VIP' }], mileageBalance: 2860,
    },
    previousHandover: '前回は足先を短めに整えました。',
    previousHandoverBooking: { id: 'bk-history-1', startsAt: '2026-08-03T00:00:00.000Z', status: 'completed' },
    history: [
      { id: 'bk-history-1', startsAt: '2026-08-03T00:00:00.000Z', status: 'completed', customerNote: '足先は短め', handoverNote: '耳の赤みは落ち着いています。', price: 8400, menuName: 'トリミング（小型犬）', staffName: '佐々木' },
      { id: 'bk-history-2', startsAt: '2026-07-05T01:00:00.000Z', status: 'completed', customerNote: null, handoverNote: null, price: 4200, menuName: 'シャンプーのみ', staffName: '高田' },
    ],
    historyTotal: 2,
    reminders: [
      { id: 'br-detail-day', kind: 'day_before', scheduledAt: '2026-09-02T00:00:00.000Z', sentAt: '2026-09-02T00:00:03.000Z', status: 'sent', retryCount: 0 },
      { id: 'br-detail-hour', kind: 'hours_before', scheduledAt: '2026-09-02T23:00:00.000Z', sentAt: null, status: 'pending', retryCount: 0 },
    ],
    operations: [
      { id: 'bor-line-detail', kind: 'confirmation_line', status: 'succeeded', scheduledAt: null, completedAt: '2026-09-02T02:05:02.000Z', openedAt: '2026-09-02T03:10:00.000Z', result: { notificationKind: 'approved' }, errorCode: null },
      { id: 'bor-calendar-detail', kind: 'google_calendar', status: 'succeeded', scheduledAt: null, completedAt: '2026-09-02T02:05:03.000Z', openedAt: null, result: { calendarSync: 'synced' }, errorCode: null },
    ],
  },
}

/** T: 予約メニューの版の履歴。新しい順。いちばん新しい版だけ in_use。 */
export const BOOKING_MENU_VERSIONS = [
  {
    version_number: 2, title: '第2版', status: 'in_use',
    summary: '値段 7,800円→8,400円', author: '店長', at: '2026-09-27T10:00:00+09:00',
    lines: [
      '名前：トリミング（小型犬）',
      '分類：トリミング',
      '説明：小型犬の全身カットとシャンプー',
      '時間：105分（後片付け15分）',
      '値段：8,400円',
      '受付：30日先まで・3時間前締切・取消期限なし',
      '状態：公開中',
    ],
  },
  {
    version_number: 1, title: '第1版', status: 'past',
    summary: '最初の版', author: null, at: '2026-09-02T10:00:00+09:00',
    lines: [
      '名前：トリミング（小型犬）',
      '分類：トリミング',
      '説明：小型犬の全身カットとシャンプー',
      '時間：105分（後片付け15分）',
      '値段：7,800円',
      '受付：30日先まで・3時間前締切・取消期限なし',
      '状態：公開中',
    ],
  },
]

/** 機能34。サーバ判定を画面側で作り直さず、そのまま描く固定応答。 */
export const GETTING_STARTED = {
  accountId: 'visual-qa-account',
  doneCount: 2,
  total: 6,
  allDone: false,
  steps: [
    { key: 'accounts', state: 'done', href: '/accounts', reason: null, webhook: [{ id: 'visual-qa-account', status: 'matched' }] },
    { key: 'featureSet', state: 'done', href: '/settings', reason: null },
    { key: 'attributes', state: 'todo', href: '/tags?tab=tags', reason: null },
    { key: 'friendAdd', state: 'stalled', href: '/friend-add-settings', reason: '下書きのルールが1本ありますが、まだ公開していません。公開すると動きはじめます。' },
    { key: 'scenario', state: 'stalled', href: '/scenarios', reason: null },
    { key: 'firstMessage', state: 'todo', href: '/chats', reason: null },
  ],
}

const SIGNUP_RECIPE_ITEMS = [
  { kind: 'タグ', name: '新規', note: '友だち追加時のルールから付きます' },
  { kind: '友だち追加時のルール', name: 'はじめて', note: 'タグを付けて、シナリオを開始します' },
  { kind: 'シナリオ', name: '新規登録 7日間フォロー', note: '7通。0日目・1日目・3日目・5日目・7日目・質問1通・完了時のタグ付け' },
  { kind: 'テンプレート', name: '1通目 はじめまして ほか6本', note: '本文は見本です。会社名などは共通情報から入ります' },
  { kind: 'タグ', name: 'フォロー完了', note: 'シナリオを最後まで受け取った人に付きます' },
]

export const RECIPES = [
  {
    id: 'signup-7day-follow', name: '新規登録 7日間フォロー',
    purpose: '友だちが増えたあと、7日かけて関係を作ります。',
    creates: 'タグ1つ、友だち追加時のルール1本、シナリオ7通、テンプレート7本',
    version: 1, origin: 'builtin',
    requiredFeatures: ['friend_add_routing', 'scenarios', 'templates'], missingFeatures: [],
    items: SIGNUP_RECIPE_ITEMS, itemCount: 16, cloneCount: 12,
  },
  {
    id: 'booking-reminder', name: '予約のリマインド',
    purpose: '前日と当日に、予約を思い出してもらいます。',
    creates: 'タグ1つ、リマインダ2本、テンプレート2本',
    version: 1, origin: 'builtin', requiredFeatures: ['reminders', 'templates'], missingFeatures: [],
    items: null, itemCount: 5, cloneCount: 5,
  },
  {
    id: 'webinar-guide', name: 'ウェビナーの案内と当日',
    purpose: '申し込みから当日の入室まで、順に案内します。',
    creates: 'タグ2つ、ウェビナー1件、リマインダ3本、テンプレート4本',
    version: 1, origin: 'builtin', requiredFeatures: ['webinars', 'reminders', 'templates'], missingFeatures: ['webinars'],
    items: null, itemCount: 10, cloneCount: 0,
  },
]

export const MANUAL_LINKS = {
  /* ★V8 cIdA2 の3行（開けます1・開けません1・まだ決めていない1）。 */
  items: [
    { key: '2-1', keyKind: 'screen', name: '受信箱', url: 'https://help.musubo.example/inbox', status: 'ok', lastCheckedAt: '2026-09-30T19:00:00.000Z', lastHttpStatus: 200, lastError: null, version: 2 },
    { key: '4-1', keyKind: 'screen', name: '友だち属性・タグ', url: 'https://help.musubo.example/tags', status: 'broken', lastCheckedAt: '2026-09-30T19:00:00.000Z', lastHttpStatus: 404, lastError: 'HTTP_404', version: 3 },
    { key: '33-1', keyKind: 'screen', name: 'LINEアカウント', url: null, status: 'broken', lastCheckedAt: null, lastHttpStatus: null, lastError: 'URL_UNSET', version: 1 },
  ],
  total: 3,
  brokenCount: 2,
}

/*
  予約。設計 `TV2DI`（予約管理）の台帳そのまま。

  **LINEからと電話からを混ぜる。** 設計は「LINEから 9・電話 3」を色で分けて
  同じところに並べる。片方だけだと、その読み分けが撮れない。
  **LINEの友だちと結びついていない行**も1つ入れる（設計の
  「LINEの友だちと結びついていません。当日の連絡ができません」を出すため）。
*/
/* 担当はスタッフ一覧（bs-1 佐々木・bs-3 高田・bs-2 中川）の id でも持つ。名前だけだと予約の当日盤が「担当未設定」に落とす（GcyTr）。 */
const BOOKING_STAFF_IDS = { 佐々木: 'bs-1', 高田: 'bs-3', 中川: 'bs-2' }
const booking = (id, friendId, name, start, end, menu, staff, price, status = 'confirmed') => ({
  id, friend_id: friendId, starts_at: start, ends_at: end, status,
  customer_note: null, internal_note: null, price_at_booking: price,
  menu_name: menu, staff_id: BOOKING_STAFF_IDS[staff] ?? null, staff_name: staff, friend_name: name,
  requested_at: '2026-09-02T02:00:00.000Z', decided_at: '2026-09-02T02:05:00.000Z',
  external_event_id: null,
})

/* 予約管理「今日」（絵 O2Z8u・時計 2026-10-01）用。この日の窓で読んだときだけ返す（ほかの画面の件数は変えない）。 */
export const BOOKING_TODAY_REQUESTS = [
  { ...booking('bt-1', 'friend-1', 'ぽん太 さん', '2026-10-01T00:00:00.000Z', '2026-10-01T01:00:00.000Z', 'トリミング（小型犬）', '佐々木', 8400), source: 'liff' },
  { ...booking('bt-2', 'friend-2', 'ココ さん', '2026-10-01T01:00:00.000Z', '2026-10-01T01:30:00.000Z', 'シャンプーのみ', '高田', 4200), source: 'phone' },
  { ...booking('bt-3', 'friend-3', 'ハナ さん', '2026-10-01T02:00:00.000Z', '2026-10-01T02:15:00.000Z', '爪切り', '高田', 1200), source: 'liff' },
  { ...booking('bt-4', 'friend-4', 'レオ さん', '2026-10-01T02:00:00.000Z', '2026-10-01T02:30:00.000Z', '足裏ケア', '中川', 2000), source: 'liff' },
  { ...booking('bt-5', 'friend-5', 'マロン さん', '2026-10-01T04:00:00.000Z', '2026-10-01T05:30:00.000Z', 'トリミング（中型犬）', '佐々木', 9800), source: 'liff' },
  { ...booking('bt-6', 'friend-6', '見本 50', '2026-10-01T06:00:00.000Z', '2026-10-01T06:30:00.000Z', '初回相談', '中川', 0), source: 'liff' },
  /* 同じ人の同じ時間に重なった電話の予約（受付1人ずつを超える・赤い帯）。 */
  { ...booking('bt-7', '', null, '2026-10-01T04:30:00.000Z', '2026-10-01T04:45:00.000Z', '爪切り', '佐々木', 1200), friend_name: '見本 32', source: 'phone' },
]

export const BOOKING_REQUESTS = [
  booking('bk-1', 'friend-1', '見本 16', '2026-09-03T00:00:00.000Z', '2026-09-03T01:45:00.000Z', 'トリミング（小型犬）', '佐々木', 8400),
  booking('bk-2', 'friend-2', '見本 17', '2026-09-03T02:00:00.000Z', '2026-09-03T03:45:00.000Z', 'トリミング（大型犬）', '佐々木', 12600),
  booking('bk-3', 'friend-3', '見本 26', '2026-09-03T04:00:00.000Z', '2026-09-03T04:45:00.000Z', 'シャンプーのみ', '高田', 4200),
  booking('bk-4', 'friend-4', '見本 27', '2026-09-03T05:00:00.000Z', '2026-09-03T05:15:00.000Z', '爪切りだけ', '中川', 1200),
  /* 電話で受けた予約。**LINEの友だちと結びついていない。** */
  { ...booking('bk-5', '', null, '2026-09-03T06:00:00.000Z', '2026-09-03T07:45:00.000Z', 'トリミング（小型犬）', '佐々木', 8400), friend_name: null },
  /* まだ決めていない1件。設計の「承認待ち」。 */
  booking('bk-6', 'friend-5', '見本 28', '2026-09-04T01:00:00.000Z', '2026-09-04T02:45:00.000Z', 'トリミング（小型犬）', '高田', 8400, 'requested'),
  /* ③-2 第2弾（B4）：毎週金曜 14:00 の繰り返し 8 回のうち 4 回目。詳細パネルの「繰り返し」の段と確かめの窓の見本。 */
  { ...booking('bk-series-4', 'friend-6', '見本 143', '2026-12-11T05:00:00.000Z', '2026-12-11T06:45:00.000Z', 'トリミング（小型犬）', '佐々木', 8400), series_id: 's1' },
]

/*
  お知らせの種類。設計 `festr`（24-1 LINE通知）の「お知らせの種類 9つ」。

  **止めているものを2つ入れる。** 設計の札は 出している7／止めている2／
  文面が未設定1。全部が出ている状態だと、その3つが撮れない。
  台帳の `Q55bb`（お知らせの中身を編集する）は「発送した」を押すので、
  その名前の行が要る。
*/
const ecNotification = (eventType, label, category, order, isEnabled = true, title = null) => ({
  eventType, label, isEnabled,
  title: title ?? label,
  introText: 'いつもご利用ありがとうございます。',
  outroText: 'ご不明な点はこのままご返信ください。',
  category, buttonLabel: '注文を見る', buttonUrl: 'https://example.com/orders',
  imageUrl: '', displayOrder: order,
  fixedFields: ['注文番号', '金額'],
  fixedPreview: 'ご注文 NEN-1001 / ¥12,800',
  updatedAt: '2026-08-25T00:00:00.000Z',
})

export const EC_NOTIFICATION_SETTINGS = [
  ecNotification('ec.order.confirmed', '注文が確定した', 'order', 1),
  ecNotification('ec.order.payment_received', '入金を確認した', 'payment', 2),
  ecNotification('ec.order.shipped', '発送した', 'shipping', 3),
  ecNotification('ec.order.bank_transfer_reminder', 'お届けした', 'shipping', 4),
  ecNotification('ec.subscription.upcoming', '定期便が続いた', 'subscription', 5),
  /* 設計の「止めている 2」（★V8 g3iDs では定期便の決済失敗が止めている）。 */
  ecNotification('ec.subscription.payment_failed', '定期便を止めた', 'subscription', 6, false),
  ecNotification('ec.order.cancelled', 'キャンセルした', 'support', 7),
  ecNotification('ec.order.refunded', '返金した', 'support', 8),
  /* 設計の「文面が未設定 1」。**空文字は「まだ決めていない」で、0件ではない。** */
  { ...ecNotification('ec.subscription.card_updated', '入荷待ちになった', 'order', 9, false), title: null, introText: '', outroText: '' },
]

export const LINE_NOTIFICATION_DEFINITIONS = EC_NOTIFICATION_SETTINGS.map((setting, index) => ({
  id: `line-notification-${index + 1}`,
  lineAccountId: 'visual-qa-account',
  key: setting.eventType,
  name: setting.label,
  category: setting.category,
  sourceEventType: setting.eventType,
  status: setting.isEnabled ? 'published' : 'stopped',
  draft: { title: setting.title, introText: setting.introText, outroText: setting.outroText, buttonLabel: setting.buttonLabel, buttonUrl: setting.buttonUrl, fixedFields: setting.fixedFields },
  currentVersionId: setting.isEnabled ? `line-notification-${index + 1}-v2` : null,
  currentVersionNumber: setting.isEnabled ? 2 : null,
  transactionalOnly: true,
  version: setting.isEnabled ? 2 : 1,
  updatedAt: setting.updatedAt,
}))

export const LINE_NOTIFICATION_METRICS = {
  items: LINE_NOTIFICATION_DEFINITIONS.map((definition, index) => ({
    definitionId: definition.id,
    notificationName: definition.name,
    accepted: { value: [148, 132, 96, 88, 74, 51, 23, 3, 0][index] },
    // 8件目は集計待ち。本番の waiting が画面の pending に寄ることを撮る。
    displayed: index === 7
      ? { state: 'pending', value: null, reason: '集計中です' }
      : { state: 'unavailable', value: null, reason: 'LINE側の個人開封は取得できません' },
    clicked: { value: [42, 31, 18, 16, 12, 9, 4, 0, 0][index] },
  })),
  coverage: { individualOpenAvailable: false, lineAggregateOnly: true, unavailableIsNull: true },
}

/** 機能24。送信履歴から数えたJSTの今日・この30日（`send-counts` の見本）。 */
export const LINE_NOTIFICATION_SEND_COUNTS = {
  sentToday: 38,
  sentLast30d: 1041,
  /* ★V8 g3iDs の並び（画面は今日の数の多い順）：注文確定・発送・入金・振込期限・キャンセル・返金・定期便・止めている・未設定。この30日は絵の数。 */
  byEventType: EC_NOTIFICATION_SETTINGS.map((setting, index) => ({
    eventType: setting.eventType,
    today: [12, 6, 8, 3, 0, 0, 2, 1, 0][index],
    last30d: [412, 86, 398, 12, 3, 0, 9, 4, 0][index],
  })),
  period: { today: '2026-08-25', from30d: '2026-07-27', to: '2026-08-25' },
}

/** 機能24。LINE受付までの事実だけを持ち、届いた・既読は作らない。 */
export const EC_NOTIFICATION_RUNS = {
  items: [
    {
      id: 'ec-run-1', recipientType: 'customer', notificationName: '注文確定のお知らせ', source: 'EC連携',
      sourceEventId: 'ec-event-1001', friendId: 'friend-1', friendName: '見本 16', orderNumber: 'NEN-10482',
      channel: 'line', status: 'accepted', reason: null,
      receivedAt: '2026-08-25T10:32:00+09:00', acceptedAt: '2026-08-25T10:32:01+09:00',
      attemptCount: null, nextRetryAt: null, clickedAt: null, version: null,
      executionMode: 'automatic', retryAvailable: false,
    },
    {
      id: 'ec-run-2', recipientType: 'customer', notificationName: '発送のお知らせ', source: 'EC連携',
      sourceEventId: 'ec-event-1002', friendId: 'friend-2', friendName: '見本 17', orderNumber: 'NEN-10481',
      channel: 'line', status: 'pending', reason: 'LINEへの送信処理を待っています',
      receivedAt: '2026-08-25T10:28:00+09:00', acceptedAt: null,
      attemptCount: null, nextRetryAt: null, clickedAt: null, version: null,
      executionMode: 'automatic', retryAvailable: false,
    },
    {
      id: 'ec-run-3', recipientType: 'customer', notificationName: '返金のお知らせ', source: 'EC連携',
      sourceEventId: 'ec-event-1003', friendId: 'friend-3', friendName: '見本 15', orderNumber: 'NEN-10480',
      channel: 'line', status: 'excluded', reason: 'LINEの友だちと結び付いていないため、送信しませんでした',
      receivedAt: '2026-08-25T10:21:00+09:00', acceptedAt: null,
      attemptCount: null, nextRetryAt: null, clickedAt: null, version: null,
      executionMode: 'automatic', retryAvailable: false,
    },
    {
      id: 'ec-run-4', recipientType: 'customer', notificationName: '定期便更新のお知らせ', source: 'EC連携',
      sourceEventId: 'ec-event-1004', friendId: 'friend-4', friendName: '見本 141', orderNumber: 'NEN-10479',
      channel: 'line', status: 'failed', reason: 'LINEが送信を受け付けませんでした。受信箱からご連絡ください',
      receivedAt: '2026-08-25T10:14:00+09:00', acceptedAt: null,
      attemptCount: null, nextRetryAt: null, clickedAt: null, version: null,
      executionMode: 'automatic', retryAvailable: false,
    },
  ],
  summary: { accepted: 148, failed: 3, excluded: 12, pending: 2 },
  coverage: {
    source: 'current_ec_events',
    unassignedHistoricalRowsExcluded: true,
    attemptHistoryAvailable: false,
    retryAvailable: false,
  },
}

const deliveryRun = (id, name, friendId, friendName, orderNumber, status, receivedAt, extras = {}) => ({
  id, recipientType: 'customer', notificationName: name, source: 'EC連携',
  sourceEventId: `event-${id}`, friendId, friendName, orderNumber,
  channel: 'line', status, reason: null, receivedAt,
  acceptedAt: status === 'accepted' ? receivedAt : null,
  attemptCount: status === 'excluded' ? 0 : 1,
  nextRetryAt: null, clickedAt: null, version: 2, recordVersion: 1,
  providerStatus: status === 'accepted' ? 'provider_accepted' : null,
  executionMode: 'automatic', retryAvailable: false,
  resolved: false, resolvedAt: null, resolvedBy: null,
  attemptHistory: status === 'excluded' ? [] : [{
    number: 1, outcome: status === 'accepted' ? 'provider_accepted' : status === 'pending' ? 'retry_wait' : 'failed',
    attemptedAt: receivedAt, providerRequestId: null, errorCode: null, error: null,
  }],
  ...extras,
})

export const LINE_NOTIFICATION_DELIVERIES = {
  items: [
    deliveryRun('ec-run-1', '発送のお知らせ', 'friend-1', '見本 169', '#A-10425', 'accepted', '2026-10-01T21:30:00+09:00', { clickedAt: '2026-10-01T21:35:00+09:00' }),
    deliveryRun('ec-run-2', '注文ありがとうございます', 'friend-2', '山本 大輔', '#A-10424', 'pending', '2026-10-01T21:20:00+09:00'),
    deliveryRun('ec-run-3', '定期便のお届け日', 'friend-3', '見本 27', '#S-2201', 'excluded', '2026-10-01T20:02:00+09:00', { reason: '通知を受け取らない設定' }),
    deliveryRun('ec-run-4', '発送のお知らせ', 'friend-4', '見本 16', '#A-10422', 'failed', '2026-10-01T21:14:00+09:00', { reason: 'ブロックされています（対応不要）' }),
    deliveryRun('ec-run-5', '新しい予約が入りました', null, '見本 157', null, 'failed', '2026-10-01T18:02:00+09:00', { recipientType: 'operator', source: '予約管理', reason: 'LINE未ログイン', retryAvailable: false }),
    deliveryRun('ec-run-6', '入金の確認', 'friend-6', '佐藤 由美', '#A-10398', 'failed', '2026-09-30T12:40:00+09:00', {
      attemptCount: 3, reason: '一時的なエラー', nextRetryAt: '2026-10-02T06:00:00+09:00', retryAvailable: true,
      attemptHistory: [1, 2, 3].map(number => ({ number, outcome: 'failed', attemptedAt: '2026-09-30T12:40:00+09:00', providerRequestId: null, errorCode: null, error: '一時的なエラー' })),
    }),
  ],
  summary: { accepted: 1, pending: 1, excluded: 1, failed: 3 },
  coverage: { source: 'notification_delivery_ledger', unassignedHistoricalRowsExcluded: true, attemptHistoryAvailable: true, retryAvailable: true },
}

export const OPERATOR_NOTIFICATION_RECIPIENTS = {
  items: [
    { id: 'staff-owner', name: '見本 16', lineLinked: true, emailVerified: true, channels: { line: true, email: false, dashboard: true }, canReceive: true },
    { id: 'staff-support', name: '見本 111', lineLinked: true, emailVerified: false, channels: { line: true, email: false, dashboard: true }, canReceive: true },
    { id: 'staff-store', name: '見本 101', lineLinked: false, emailVerified: true, channels: { line: false, email: false, dashboard: true }, canReceive: true },
    // 絵 hiBO8 の4人目（選んでいない人）。なおす画面で「選ばない人も並ぶ」を見せる。
    { id: 'staff-part', name: '見本 118', lineLinked: true, emailVerified: false, channels: { line: true, email: false, dashboard: true }, canReceive: true },
  ],
  summary: { staff: 4, canReceive: 4, line: 3, email: 0, dashboard: 4, unavailable: 0 },
}

const operatorRule = (id, name, eventType, recipientLabel, occurredToday, status = 'published', recipientIds = ['staff-owner', 'staff-support']) => ({
  id, name, eventType,
  conditions: { importance: 'important', recipientIds, recipientLabel, scheduleLabel: 'いつでも', dedupeMinutes: 10 },
  channels: ['dashboard', 'line'], isActive: status === 'published', status,
  recipientCount: recipientIds.length, lineRecipientCount: recipientIds.filter((value) => value !== 'staff-store').length,
  occurredToday, acceptedToday: occurredToday * 2, excludedToday: 0,
  lastOccurredAt: occurredToday ? '2026-09-07T11:20:00+09:00' : null,
  createdAt: '2026-09-01T09:00:00+09:00', updatedAt: '2026-09-07T10:00:00+09:00',
})

/* 運用者へのお知らせのチーム。作る画面（gjUz3）は最初のチームを選んでおき、スタッフの箱を出さない。 */
export const OPERATOR_NOTIFICATION_TEAMS = [
  { id: 'team-nakameguro', lineAccountId: 'visual-qa-account', name: '中目黒店', staffIds: ['staff-owner', 'staff-support', 'staff-store'], version: 1, archivedAt: null },
]

export const OPERATOR_NOTIFICATION_RULES = [
  operatorRule('operator-rule-1', '新しい予約が入りました', 'booking_created', '予約チーム 3人', 18, 'published', ['staff-owner', 'staff-support', 'staff-store']),
  operatorRule('operator-rule-2', 'フォームに回答がありました', 'form_submitted', '審査チーム 2人', 4),
  operatorRule('operator-rule-3', '一斉配信が完了しました', 'broadcast_completed', '運用チーム 2人', 2),
  operatorRule('operator-rule-4', 'マニュアルのリンクが開きません', 'manual_link_broken', '運用チーム 2人', 0),
  operatorRule('operator-rule-5', '誕生日クーポンを確認してください', 'nen_birthday_coupon_failed', '店長 1人', 1, 'published', ['staff-owner']),
  operatorRule('operator-rule-6', '共通情報の期限が近づきました', 'common_var_expiry', '受け取る人がいません', 0, 'draft', []),
]

/*
  イベント。設計 `ugP5y`（29-1 イベント予約）の
  「これからの回 6／受付前 2／終わった回 24」の内訳が撮れる4件。
*/
const adminEvent = (id, name, nextSlot, capacity, active, pending, published = 1) => ({
  id, name, venue_name: '店内スペース（2階）', venue_url: null, image_url: null,
  description: 'はじめての方むけに、おうちでできるコツをお伝えします。',
  description_centered: 0, max_bookings_per_friend: 1, requires_approval: 1,
  cancel_deadline_hours_before: 24, reminder_day_before_enabled: 1, reminder_hours_before: 3,
  is_published: published, lifecycle_status: published === 1 ? 'published' : 'draft', sort_order: 1,
  created_at: '2026-09-01T01:00:00.000Z', updated_at: '2026-09-02T01:00:00.000Z',
  next_slot_starts_at: nextSlot,
  total_capacity: capacity, total_active: active, pending_count: pending,
  visible_tag_id: null, visible_tag_name: null,
})

/*
  イベント。設計 `ugP5y` の「これからの回 6／受付前 2／終わった回 24」の内訳が撮れる4件。

  **`total_active` と `pending_count` は必ず数で入れる。** 画面は
  `items.reduce((sum, e) => sum + e.total_active, 0)` で足すので、
  入っていないと帯が `NaN人` `NaN件` になる（一度そうなった）。
*/
export const ADMIN_EVENTS = [
  adminEvent('ev-1', '秋のしつけ教室（第1回）', '2026-10-12T05:00:00.000Z', 20, 18, 2),
  adminEvent('ev-2', 'ごはん相談会', '2026-10-15T02:00:00.000Z', 12, 3, 0),
  /* 設計の「申し込みが少ない 1」。 */
  adminEvent('ev-3', '爪切り体験', '2026-10-19T04:00:00.000Z', 8, 8, 0),
  /* 設計の「受付前 2」。公開していないので、埋まり具合の分母にも入らない。 */
  adminEvent('ev-4', '冬のしつけ教室', '2026-12-07T05:00:00.000Z', 20, 0, 0, 0),
].map((event, index) => ({
  ...event,
  /* 板 `e2ekFu` の名前の前の丸：教室・体験・相談会・未分類（上から）。 */
  venue_name: ['渋谷ベース 3F', 'オンライン', '然 渋谷店', '渋谷ベース 3F'][index],
  folderId: ['event-folder-class', 'event-folder-consult', 'event-folder-trial', 'event-folder-class'][index] ?? null,
}))

/** イベントのフォルダ（kind=event）。板 `e2ekFu` の左の列の名前と、行の丸の色。件数は上の4件から数える。 */
export const EVENT_FOLDERS = [
  ['event-folder-class', '教室', '#2f6fde'],
  ['event-folder-trial', '体験', '#1f9d55'],
  ['event-folder-consult', '相談会', '#e07b24'],
].map(([id, name, color], index) => ({
  id, kind: 'event', name, parentId: null, displayOrder: index, color,
  itemCount: ADMIN_EVENTS.filter((event) => event.folderId === id).length,
  createdAt: '2026-09-01T01:00:00.000Z', updatedAt: '2026-09-01T01:00:00.000Z',
}))

/** 機能29の編集画面。詳細・枠・待ち列はID入りの動的URLから読む。 */
export const EVENT_DETAIL = {
  id: 'ev-1',
  name: '秋のしつけ教室（第1回）',
  venue_name: '店内スペース（2階）',
  venue_url: null,
  image_url: null,
  description: 'はじめての方向けに、おうちでできるしつけのコツを90分でお伝えします。',
  description_centered: 0,
  max_bookings_per_friend: 1,
  requires_approval: 1,
  cancel_deadline_hours_before: 24,
  reminder_day_before_enabled: 1,
  reminder_hours_before: 24,
  is_published: 1,
  lifecycle_status: 'published',
  sort_order: 1,
  confirmation_message_extra: null,
  reminder_message_extra: null,
  og_title: null,
  og_description: null,
  og_image_url: null,
  visible_tag_id: null,
  waitlist_enabled: 1,
  entry_cutoff_hours_before: 20,
  target_type: 'single',
  account_ids: null,
  line_account_id: 'visual-qa-account',
}

/*
  開催回。設計 `hmr2P` の「10/12・10/19・9/28（終わった回）」の3回。
  1つ目は申込者（`Mu8qW`）・待ち列（EVENT_WAITLIST）と同じ回。
*/
export const EVENT_SLOTS = [
  { id: 'event-slot-1', event_id: 'ev-1', starts_at: '2026-10-12T01:00:00.000Z', ends_at: '2026-10-12T03:00:00.000Z', capacity: 12, is_active: 1, sort_order: 1, active_count: 10, version: 1 },
  { id: 'event-slot-2', event_id: 'ev-1', starts_at: '2026-10-19T01:00:00.000Z', ends_at: '2026-10-19T03:00:00.000Z', capacity: 12, is_active: 1, sort_order: 2, active_count: 6, version: 1 },
  { id: 'event-slot-3', event_id: 'ev-1', starts_at: '2026-09-28T01:00:00.000Z', ends_at: '2026-09-28T03:00:00.000Z', capacity: 12, is_active: 1, sort_order: 3, active_count: 12, version: 1 },
]

/*
  申込者の画面（`Mu8qW`）の開催回ごとの一覧。実API（occurrences/:id/applicants）と同じ器。
  設計の「申込 18/20・承認待ち 2・キャンセル待ち 3・キャンセル 1」「参加済 9・無断欠席 1・受付前 8」。
*/
const occApplicant = (row) => ({
  pictureUrl: null, partySize: 1, answers: null, offeredAt: null, offerExpiresAt: null,
  firstParticipation: { isFirst: row.isFirst ?? null, attendedCount: row.isFirst ? 0 : 2, checkedAt: '2026-09-30T00:00:00.000Z' },
  ...row,
})
export const EVENT_OCCURRENCE_APPLICANTS = {
  occurrence: { id: 'event-slot-1', eventId: 'ev-1', startsAt: '2026-10-12T05:00:00.000Z', endsAt: '2026-10-12T06:30:00.000Z', capacity: 20, activeSeats: 18, version: 3 },
  summary: { bookingCount: 18, waitingCount: 3, activeSeats: 18, confirmedSeats: 16, requestedSeats: 2, waitingSeats: 2, offeredSeats: 1, remainingSeats: 2 },
  applicants: [
    occApplicant({ source: 'booking', id: 'eb-occ-1', friendId: 'friend-occ-1', displayName: '見本 141', status: 'requested', appliedAt: '2026-10-01T03:00:00.000Z', isFirst: true, offerExpiresAt: '2026-10-03T03:00:00.000Z' }),
    occApplicant({ source: 'booking', id: 'eb-occ-2', friendId: 'friend-occ-2', displayName: '見本 33', status: 'requested', appliedAt: '2026-10-01T09:00:00.000Z', isFirst: false, offerExpiresAt: '2026-10-03T09:00:00.000Z' }),
    occApplicant({ source: 'booking', id: 'eb-occ-3', friendId: 'friend-occ-3', displayName: '見本 169', status: 'confirmed', appliedAt: '2026-09-28T03:00:00.000Z', isFirst: false }),
    occApplicant({ source: 'booking', id: 'eb-occ-4', friendId: 'friend-occ-4', displayName: '見本 114', status: 'confirmed', appliedAt: '2026-09-28T05:00:00.000Z', isFirst: true }),
    occApplicant({ source: 'waitlist', id: 'ew-occ-1', friendId: 'friend-occ-5', displayName: '見本 182', status: 'offered', appliedAt: '2026-09-28T01:12:00.000Z', isFirst: false, offeredAt: '2026-10-01T12:00:00.000Z', offerExpiresAt: '2026-10-02T12:00:00.000Z' }),
    occApplicant({ source: 'waitlist', id: 'ew-occ-2', friendId: 'friend-occ-6', displayName: '見本 34', status: 'waiting', appliedAt: '2026-09-29T09:40:00.000Z', isFirst: true }),
  ],
  waitlistHistory: [
    { id: 'ew-occ-3', friendId: 'friend-occ-7', displayName: '見本 27', status: 'expired', partySize: 1, createdAt: '2026-09-27T00:02:00.000Z', offeredAt: '2026-09-30T03:00:00.000Z', offerExpiresAt: '2026-10-01T03:00:00.000Z', notifiedAt: '2026-09-30T03:00:00.000Z', updatedAt: '2026-10-01T03:00:00.000Z', convertedBookingId: null },
    { id: 'eb-occ-9', friendId: 'friend-occ-8', displayName: '見本 14', status: 'cancelled', partySize: 1, createdAt: '2026-09-26T00:00:00.000Z', offeredAt: null, offerExpiresAt: null, notifiedAt: null, updatedAt: '2026-09-29T13:15:00.000Z', convertedBookingId: null },
  ],
  attendance: { attendedSeats: 9, noShowSeats: 1, entries: [] },
  snapshotId: 'snap-visual-qa',
  snapshotExpiresAt: '2026-10-12T00:00:00.000Z',
}

export const EVENT_WAITLIST = [
  { id: 'ew-1', slot_id: 'event-slot-1', friend_id: 'friend-4', status: 'waiting', notified_at: null, created_at: '2026-09-02T01:00:00.000Z', slot_starts_at: '2026-09-25T05:00:00.000Z', friend_name: '見本 27' },
  { id: 'ew-2', slot_id: 'event-slot-1', friend_id: 'friend-5', status: 'waiting', notified_at: null, created_at: '2026-09-02T02:00:00.000Z', slot_starts_at: '2026-09-25T05:00:00.000Z', friend_name: '見本 28' },
]

/* U: 変更の確認・状態・待ちの手動操作・開催回の変更の見本（実APIと同じ器）。 */
export const EVENT_CHANGE_PREVIEW = {
  event_id: 'ev-1',
  impacts: [
    {
      slot_id: 'event-slot-1',
      starts_at: '2026-10-12T01:30:00.000Z',
      ends_at: '2026-10-12T03:30:00.000Z',
      capacity: 12,
      confirmed_seats: 10,
      waiting_seats: 2,
      pending_reminders: 10,
      errors: [],
      notices: [],
    },
  ],
  event_notices: [],
  blocked: false,
  total_confirmed: 10,
  total_waiting: 2,
  total_pending_reminders: 10,
}

export const EVENT_CHANGE_APPLY_RESULT = {
  success: true,
  version: 4,
  log_id: 'ecl-1',
  affected_confirmed: 9,
  affected_waiting: 2,
  notified: 9,
}

export const EVENT_LIFECYCLE_RESULT = {
  success: true,
  lifecycle_status: 'paused',
  version: 4,
  log_id: 'ecl-2',
}

export const EVENT_WAITLIST_REORDER_RESULT = {
  success: true,
  occurrence_version: 5,
  order: ['ew-2', 'ew-1'],
  log_id: 'ecl-3',
}

export const EVENT_WAITLIST_SKIP_RESULT = {
  success: true,
  occurrence_version: 6,
  waitlist_id: 'ew-1',
  log_id: 'ecl-4',
}

export const EVENT_LIFF_CHANGE_RESULT = { id: 'ev-booking-2', status: 'confirmed' }

/*
  イベントの申込者。設計 `i5SN2j` の「申し込み12／キャンセル待ち3／取り消した2」。
  **同伴のペット**も入れる（設計は「ももちゃん（犬・4歳）」のように出す）。
*/
/*
  実APIの申込一覧と同じ器にする(点検#520の中7)。JOIN列がないと、画面の
  「予約枠は未取得」「友だちは未取得」が出たままになり、本番との差に気づけない。
  eb-4 は実DBのCHECK制約に無い 'waitlist' だったので 'requested' に直した。
  キャンセル待ちの札は待ち列(EVENT_WAITLIST)の画面で撮る。
*/
const eventBookingRow = (row) => ({
  slot_id: 'event-slot-1',
  line_account_id: 'visual-qa-account',
  slot_starts_at: '2026-09-25T05:00:00.000Z',
  slot_ends_at: '2026-09-25T06:30:00.000Z',
  friend_line_user_id: `Uev${row.id}`,
  requested_at: row.created_at,
  ...row,
  friend_display_name: row.friend_name,
})
export const EVENT_BOOKINGS = [
  eventBookingRow({ id: 'eb-requested', event_id: 'ev-1', friend_id: 'friend-requested', friend_name: '見本 35', status: 'requested', companion_count: 1, companion_note: 'ももちゃん（犬・4歳）', is_first_time: 1, requested_at: '2026-09-03T01:30:00.000Z', decided_at: null, decided_by_staff_id: null, cancelled_at: null, created_at: '2026-09-03T01:30:00.000Z', updated_at: '2026-09-03T01:30:00.000Z' }),
  eventBookingRow({ id: 'eb-1', event_id: 'ev-1', friend_id: 'friend-1', friend_name: '見本 16', status: 'confirmed', companion_count: 1, companion_note: 'ももちゃん（犬・4歳）', is_first_time: 1, created_at: '2026-09-01T02:00:00.000Z' }),
  eventBookingRow({ id: 'eb-2', event_id: 'ev-1', friend_id: 'friend-2', friend_name: '見本 17', status: 'confirmed', companion_count: 1, companion_note: 'そらくん（猫・2歳）', is_first_time: 0, created_at: '2026-09-01T03:00:00.000Z' }),
  eventBookingRow({ id: 'eb-3', event_id: 'ev-1', friend_id: 'friend-3', friend_name: '見本 26', status: 'confirmed', companion_count: 1, companion_note: 'こむぎちゃん（犬・7歳）', is_first_time: 1, created_at: '2026-09-01T04:00:00.000Z' }),
  eventBookingRow({ id: 'eb-4', event_id: 'ev-1', friend_id: 'friend-4', friend_name: '見本 27', status: 'requested', companion_count: 1, companion_note: 'ぷりんちゃん（うさぎ・3歳）', is_first_time: 1, created_at: '2026-09-02T01:00:00.000Z' }),
  eventBookingRow({ /* 取り消した1件。 */ id: 'eb-5', event_id: 'ev-1', friend_id: 'friend-5', friend_name: '見本 28', status: 'cancelled', companion_count: 1, companion_note: 'レオくん（犬・1歳）', is_first_time: 0, created_at: '2026-09-01T05:00:00.000Z' }),
]

const lineAccount = (id, channelId, name, displayOrder, options = {}) => ({
  id, channelId, name,
  channelAccessTokenConfigured: true, channelSecretConfigured: true,
  loginChannelId: `login-${channelId}`, loginChannelSecretConfigured: true,
  liffId: `liff-${channelId}`, isActive: true,
  channelAccessTokenLast4: null, channelAccessTokenUpdatedAt: null,
  channelSecretLast4: null, channelSecretUpdatedAt: null,
  loginChannelSecretLast4: null, loginChannelSecretUpdatedAt: null,
  isDefault: false, archivedAt: null, friendCapacity: 50000, capacityWarnAt: 45000,
  iconUrl: null, country: '日本', role: '店舗', displayOrder,
  ogSiteName: null, ogDefaultDescription: null, ogDefaultImageUrl: null,
  parentLineAccountId: null,
  createdAt: '2026-01-05T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z',
  webhook: {
    expectedUrl: 'https://api.example/webhook', actualUrl: 'https://api.example/webhook',
    active: true, status: 'matched', checkedAt: '2026-08-22T00:00:00.000Z',
  },
  stats: { friendCount: 0, activeScenarios: 0, messagesThisMonth: 0 },
  ...options,
})

/** 統括のアカウントのタグ（絵 `JKjsE`：渋谷エリア・イベント・テスト）。`/api/line-account-tags` と各アカウントの `tags`。 */
export const LINE_ACCOUNT_TAGS = [
  { id: 'tag-shibuya', name: '渋谷エリア', color: '#2f6fdf', displayOrder: 0 },
  { id: 'tag-event', name: 'イベント', color: '#087a3e', displayOrder: 1 },
  { id: 'tag-test', name: 'テスト', color: '#d9822b', displayOrder: 2 },
]
const tagSummary = (...ids) => LINE_ACCOUNT_TAGS.filter((tag) => ids.includes(tag.id)).map(({ id, name, color }) => ({ id, name, color }))

/**
 * LINEアカウント一覧。設計 `QT91v` の稼働3・停止1・保管2と親子関係。
 * 統括ホーム（絵 `JKjsE`）のために、タグ・接続状態（`connection`）・権限者の数（`stats.staffCount`）を足した（2026-10-06）。
 * 2026-10-07：絵 `JKjsE`・`a7lUk`・`V7vn3` の5件にそろえた（本店→渋谷店→TEST→2025年イベント→旧キャンペーンの並び、
 * 渋谷店の親は本店、2025年イベントは稼働・旧キャンペーンはアーカイブ、LINE ID は @nen-…、旧テストアカウントは外した）。
 * 名前を使う66枚を前後で測り、下がった板なし（a7lUk 73→89）。
 */
export const LINE_ACCOUNTS = [
  lineAccount('visual-qa-account', '2007123456', '然-NEN-TEST', 2, {
    basicId: 'nen-test', isDefault: true, role: '検証用。本番の配信には使わない',
    stats: { friendCount: 231, activeScenarios: 4, messagesThisMonth: 1842, staffCount: 2 },
    tags: tagSummary('tag-test'), connection: { status: 'warn', checkedAt: '2026-09-30T09:00:00.000Z' },
  }),
  lineAccount('visual-qa-account-prod', '2007111222', '然-NEN- 本店', 0, {
    basicId: 'nen-honten', stats: { friendCount: 1284, activeScenarios: 3, messagesThisMonth: 1820, staffCount: 4 },
    iconUrl: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22%3E%3Crect width=%2264%22 height=%2264%22 rx=%2214%22 fill=%22%23087a3e%22/%3E%3Ctext x=%2232%22 y=%2243%22 text-anchor=%22middle%22 font-family=%22sans-serif%22 font-size=%2230%22 font-weight=%22700%22 fill=%22white%22%3EN%3C/text%3E%3C/svg%3E',
    tags: tagSummary('tag-shibuya'), connection: { status: 'ok', checkedAt: '2026-09-30T09:00:00.000Z' },
  }),
  lineAccount('visual-qa-account-store', '2007333444', '然-NEN- 渋谷店', 1, {
    basicId: 'nen-shibuya', parentLineAccountId: 'visual-qa-account-prod', stats: { friendCount: 612, activeScenarios: 1, messagesThisMonth: 946, staffCount: 3 },
    webhook: { expectedUrl: 'https://api.example/webhook', actualUrl: 'https://old.example/webhook', active: true, status: 'mismatched', checkedAt: '2026-08-22T00:00:00.000Z' },
    tags: tagSummary('tag-shibuya'), connection: { status: 'ok', checkedAt: '2026-09-30T09:00:00.000Z' },
  }),
  lineAccount('visual-qa-account-old', '2007555666', '旧キャンペーン', 4, {
    basicId: 'nen-old', isActive: false, archivedAt: '2026-04-01T00:00:00.000Z', stats: { friendCount: 0, activeScenarios: 0, messagesThisMonth: 0, staffCount: 0 },
    webhook: { expectedUrl: 'https://api.example/webhook', actualUrl: null, active: null, status: 'unknown', checkedAt: '2026-08-12T00:00:00.000Z' },
    tags: tagSummary('tag-event'), connection: { status: 'unknown', checkedAt: null },
  }),
  lineAccount('visual-qa-account-event-2025', '2007777888', '2025年イベント', 3, {
    basicId: 'nen-event', stats: { friendCount: 18, activeScenarios: 0, messagesThisMonth: 634, staffCount: 2 },
    tags: tagSummary('tag-event'), connection: { status: 'ok', checkedAt: '2026-09-30T09:00:00.000Z' },
  }),
]
/** 運用状態画面だけが読む固定ヘルスログ。見出し行を実データ状態で撮る。 */
export const ACCOUNT_HEALTH_LOGS = {
  'visual-qa-account': [
    {
      id: 'health-log-1', lineAccountId: 'visual-qa-account', errorCode: 429,
      errorCount: 3, checkPeriod: '直近24時間', riskLevel: 'warning',
      createdAt: '2026-09-07T02:20:00.000Z',
    },
  ],
}

/** 登録前の接続確認。設計 `b2NGxk` と同じく3段目で止める。保存は行わない。 */
export const LINE_ACCOUNT_VERIFY_CONNECTION = {
  messagingApi: true,
  webhook: false,
  lineLogin: true,
  liff: true,
  webhookUrl: 'https://old-tool.example/webhook',
  errors: ['Webhook URLの一致・利用設定・接続テストを確認してください'],
}

/**
 * アカウント詳細（★V8 ihjfd ほか）。資格情報の末尾だけを持ち、秘密値そのものは置かない。
 * 名前・ID・友だち数・上限・役割メモ・Webhook の URL は絵（ihjfd）の値。読むのは詳細と乗り換えだけ。
 * 最後の確認（10/2 06:00）が通っていないので、題の下は「要確認」になる。
 */
export const LINE_ACCOUNT_DETAIL = {
  ...LINE_ACCOUNTS[0],
  name: '然-NEN-TEST', channelId: '@nen-test', isDefault: false,
  role: '本店の検証用。お客さまへの配信には使わない',
  friendCapacity: 5000, capacityWarnAt: 4500,
  stats: { friendCount: 1284, activeScenarios: 4, messagesThisMonth: 1842 },
  channelAccessTokenLast4: 'x9Qa', channelAccessTokenUpdatedAt: '2026-09-28T01:10:00.000Z',
  channelSecretLast4: null, channelSecretUpdatedAt: null,
  loginChannelSecretLast4: null, loginChannelSecretUpdatedAt: null,
  webhook: {
    expectedUrl: 'https://api.musubo.jp/webhook/nen-test', actualUrl: 'https://api.musubo.jp/webhook/nen-test',
    active: true, status: 'matched', checkedAt: '2026-10-01T21:00:00.000Z',
  },
  connection: {
    lastTestAt: '2026-10-01T21:00:00.000Z', lastTestStatus: 'failed',
    lastReceivedAt: null,
  },
}

/** 止めたアカウントの詳細（★V8 WOfBN アーカイブの窓の後ろ）。止めた理由と日時を持つ。 */
export const LINE_ACCOUNT_DETAIL_STOPPED = {
  ...LINE_ACCOUNT_DETAIL,
  id: 'visual-qa-account-old', isActive: false,
  inactiveReason: 'manual', inactiveReasonDetail: '乗り換えの準備のため', inactivatedAt: '2026-10-01T22:00:00.000Z',
}

/**
 * 乗り換え事前確認（★V8 x2dSNv）。4区分の合計は元の友だち14人と一致させる（自動10・要確認2・一致しない1・別人の可能性1）。
 * 判断の行は絵の4人。要確認2人のうち1人が未判断（unresolvedReviews は mock-api で 1）。
 */
export const ACCOUNT_HANDOVER = {
  id: 'account-handover-1', fromAccountId: 'visual-qa-account', toAccountId: 'visual-qa-account-prod',
  code: 'NEN-4F2K-8H1Q', codeExpiresAt: '2026-09-08T03:00:00.000Z', status: 'previewed',
  providerMatch: 'different', counts: { sourceTotal: 14, auto: 10, review: 2, unmatched: 1, lookalike: 1 },
  movedCount: 0, failedCount: 0, failureReason: null,
  createdAt: '2026-09-07T01:00:00.000Z', linkedAt: '2026-09-07T01:10:00.000Z',
  previewedAt: '2026-09-07T01:15:00.000Z', resolvedAt: null, executedAt: null, completedAt: null,
}

export const ACCOUNT_HANDOVER_DECISIONS = [
  { id: 'handover-decision-1', handover_id: 'account-handover-1', from_friend_id: 'friend-naoto-takahashi', to_friend_id: 'friend-naoto-t', decision: 'link', bucket: 'review', note: '電話番号が同じ', decided_by: 'visual-qa-owner', decided_at: '2026-09-07T01:18:00.000Z', sourceName: '見本 16', candidateName: '高橋 なおと', evidenceLabel: '電話番号が同じ' },
  { id: 'handover-decision-2', handover_id: 'account-handover-1', from_friend_id: 'friend-yumi', to_friend_id: 'friend-yumi-sato', decision: 'skip', bucket: 'lookalike', note: '名前と画像だけが似ている', decided_by: 'visual-qa-owner', decided_at: '2026-09-07T01:19:00.000Z', sourceName: 'ゆみ🐶', candidateName: '佐藤 由美', evidenceLabel: '名前と画像だけが似ている' },
  { id: 'handover-decision-3', handover_id: 'account-handover-1', from_friend_id: 'friend-demo-person', to_friend_id: null, decision: 'new', bucket: 'unmatched', note: null, decided_by: 'visual-qa-owner', decided_at: '2026-09-07T01:20:00.000Z', sourceName: 'Demo Person', candidateName: null, evidenceLabel: '—' },
  { id: 'handover-decision-4', handover_id: 'account-handover-1', from_friend_id: 'friend-ryota-mori', to_friend_id: 'friend-ryota-m', decision: 'link', bucket: 'auto', note: 'メールアドレスが同じ', decided_by: 'visual-qa-owner', decided_at: '2026-09-07T01:21:00.000Z', sourceName: '見本 157', candidateName: '森 りょうた', evidenceLabel: 'メールアドレスが同じ' },
]

/*
  写真審査。設計 `cqWo8` の格子。

  **状態を4つとも混ぜる。** 設計の札は 審査待ち／採用／見送り／公式サイト掲載。
  全部が審査待ちだと、残り3つの札が撮れない。
  戻したものには**理由**を入れる（`N2J629`「写真を戻す理由をえらぶ」の元）。
  `image_url` は作り物の SVG。外の絵を読みに行かないので、撮るたびに同じになる。
*/
const petPhoto = (id, owner, pet, caption, status, hours, reason = null, note = null) => ({
  id, owner_name: owner, pet_name: pet,
  pet_gender: ['そら', 'レオ'].includes(pet) ? 'male' : 'female',
  pet_call_name: `${pet}${['そら', 'レオ'].includes(pet) ? 'くん' : 'ちゃん'}`,
  caption,
  image_url: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="640" height="640" fill="%23eef6f0"/></svg>',
  status,
  review_version: 1,
  created_at: new Date(Date.parse('2026-08-25T09:00:00.000Z') - hours * 3600 * 1000).toISOString(),
  publication_consent_at: '2026-08-20T00:00:00.000Z',
  publication_withdrawn_at: null,
  review_reason_code: reason, review_reason_note: note,
  review_notification_status: status === 'rejected' ? 'sent' : null,
})

/* Worker と同じ完成済みの呼び名を返し、男の子=くん／女の子=ちゃんを撮影でも固定する。
   ★V8-B 投稿（TkA4D・cniyw）の絵と同じ並び・名前・日付（新しい順）。
   採用・見送りの審査日は「今月」に入るよう、見本 API を立てた時刻から決める（数の帯の今月の数）。 */
const reviewedThisMonth = () => new Date().toISOString()
const photoOn = (base, createdAt, extra = {}) => ({ ...base, created_at: createdAt, ...extra })
export const NEN_PHOTOS = [
  photoOn(petPhoto('ph-3', '見本 169', 'こむぎ', '散歩のあと、満足そうな顔です', 'pending', 0), '2026-09-30T01:00:00.000Z', { customer_id: '10234' }),
  photoOn(petPhoto('ph-2', '見本 114', 'そら', '日なたで寝ているところ', 'pending', 0), '2026-09-29T01:00:00.000Z', { customer_id: '10198' }),
  photoOn(petPhoto('ph-1', '見本 182', 'もも', '鹿肉ジャーキーに夢中', 'pending', 0), '2026-09-28T01:00:00.000Z', { customer_id: '10311' }),
  photoOn(petPhoto('ph-4', '佐藤 由美', 'きなこ', 'ひなたぼっこ', 'adopted', 0), '2026-09-27T01:00:00.000Z', {
    customer_id: '10088', reviewed_at: reviewedThisMonth(), awarded_points: 100, point_sync_status: 'synced', review_notification_status: 'sent',
  }),
  photoOn(petPhoto('ph-5', '山本 大輔', 'レオ', '新しい首輪', 'adopted', 0), '2026-09-25T01:00:00.000Z', {
    customer_id: '10102', reviewed_at: reviewedThisMonth(), awarded_points: 100, point_sync_status: 'synced',
    publication_consent_at: null, review_notification_status: 'failed',
  }),
  /* 戻したもの。**理由が無いと、なぜ戻したのかが画面から読めない。**
     理由はDB制約・API許可値にある正規値を使う（`other_person` は存在しない値）。 */
  photoOn(petPhoto('ph-6', '見本 45', 'むぎ', '店内で撮影', 'rejected', 0, 'quality', '暗くて見えにくいです'), '2026-09-26T01:00:00.000Z', { reviewed_at: reviewedThisMonth() }),
]
const NEN_PHOTO_FIRST = NEN_PHOTOS.find((photo) => photo.id === 'ph-1')

export const NEN_PHOTO_DETAIL = {
  ...NEN_PHOTO_FIRST, pet_name: 'レオくん', owner_name: '見本 19（LINE 本店）',
  caption: 'はじめて海に行きました', image_width: 2048, image_height: 1536,
  image_byte_size: 1887437, captured_device: 'iPhone 15', animal_type: 'dog',
  breed: 'ラブラドール', birthday: '2025-08-24', submission_count: 3, returned_count: 0,
  // #817: 重複なし・いま使っている報酬の決まり（第3版・10pt）。
  duplicate: null, rewardPolicy: { versionNumber: 3, policyKey: 'v3', points: 10 },
  risks: [
    { flag: 'face', confidence: 0.78, note: 'うしろに人の顔', provider: 'visual-qa', model_version: 'fixture-1', assessed_at: '2026-08-25T08:10:00.000Z' },
    { flag: 'blur', confidence: 0.04, note: '明るさ・ぶれは問題ありません', provider: 'visual-qa', model_version: 'fixture-1', assessed_at: '2026-08-25T08:10:00.000Z' },
  ],
}

/** 機能22の実APIで返す一覧集計。設計 `cqWo8` の通常状態。 */
export const NEN_PHOTO_REVIEW_METRICS = {
  // ★V8-B 投稿の数の帯：審査待ち 3枚・いちばん古いもの 2日前（見本 API を立てた時刻から）。
  pendingCount: 3,
  reviewedCount: 142,
  averageReviewMinutes: 22 / 60,
  oldestPendingAt: new Date(Date.now() - 2 * 24 * 3600 * 1000 - 3600 * 1000).toISOString(),
  attentionCount: 2,
}

/** 派生画像処理の最新状態。原本のURLや秘密値は含めない。 */
export const NEN_PHOTO_ASSET_STATUS = {
  reviewVersion: 1,
  jobs: [
    {
      id: 'photo-asset-job-1', photoId: 'ph-1', lineAccountId: 'visual-qa-account',
      requestedVersion: 1, status: 'completed', requestedBy: 'visual-qa-owner', operation: 'all',
      createdAt: '2026-08-25T00:10:00.000Z', startedAt: '2026-08-25T00:10:01.000Z',
      completedAt: '2026-08-25T00:10:04.000Z', errorMessage: null,
    },
  ],
}

/** 実際に作成済みとして見せる3種類の派生画像。 */
export const NEN_PHOTO_DERIVATIVES = {
  reviewVersion: 1,
  items: [
    { kind: 'public', sourceVersion: 1, objectKey: 'public/ph-1-v1.webp', contentType: 'image/webp', byteSize: 184320, width: 1280, height: 960, createdAt: '2026-08-25T00:10:04.000Z' },
    { kind: 'review', sourceVersion: 1, objectKey: 'review/ph-1-v1.webp', contentType: 'image/webp', byteSize: 286720, width: 1600, height: 1200, createdAt: '2026-08-25T00:10:03.000Z' },
    { kind: 'thumbnail', sourceVersion: 1, objectKey: 'thumbnail/ph-1-v1.webp', contentType: 'image/webp', byteSize: 24576, width: 320, height: 240, createdAt: '2026-08-25T00:10:02.000Z' },
  ],
  knownUrls: [
    { kind: 'review', url: NEN_PHOTO_FIRST.image_url, sourceVersion: 1 },
    { kind: 'public', url: NEN_PHOTO_FIRST.image_url, sourceVersion: 1 },
  ],
}

/** POSTは保存せず、本番と同じ受付結果だけを返す。 */
export const NEN_PHOTO_ASSET_PROCESS_RESULT = {
  id: 'photo-asset-job-2', photoId: 'ph-1', lineAccountId: 'visual-qa-account',
  requestedVersion: 1, status: 'queued', requestedBy: 'visual-qa-owner', operation: 'all',
  createdAt: '2026-08-25T00:12:00.000Z', startedAt: null, completedAt: null, errorMessage: null,
}

export const NEN_PHOTO_BULK_DECISION_RESULT = {
  updatedCount: 3,
  items: [
    { photoId: 'ph-1', decision: 'approve', reviewVersion: 2 },
    { photoId: 'ph-2', decision: 'approve', reviewVersion: 2 },
    { photoId: 'ph-3', decision: 'approve', reviewVersion: 2 },
  ],
}

/** #817: 報酬の決まりの版。新しい版から返す。status は in_use / reserved / past。 */
export const NEN_PHOTO_REWARD_POLICY_VERSIONS = [
  /* ★V8-B 版の履歴（N1br7）の絵と同じ4つの版。 */
  {
    versionNumber: 4, policyKey: 'v4', points: 120, publicationPoints: 200, summary: '10月のキャンペーンに合わせて',
    effectiveFrom: '2026-10-15T00:00:00+09:00', createdBy: '見本 18',
    createdAt: '2026-09-25T20:40:00+09:00', status: 'reserved',
  },
  {
    versionNumber: 3, policyKey: 'v3', points: 100, publicationPoints: 200, summary: '審査の決まりに「顔が写る写真は不可」を追加',
    effectiveFrom: null, createdBy: '見本 18',
    createdAt: '2026-09-20T10:00:00+09:00', status: 'in_use',
  },
  {
    versionNumber: 2, policyKey: 'v2', points: 50, publicationPoints: 150, summary: '掲載の追加報酬を始める',
    effectiveFrom: null, createdBy: '見本 30',
    createdAt: '2026-08-01T09:30:00+09:00', status: 'past',
  },
  {
    versionNumber: 1, policyKey: 'v1', points: 50, publicationPoints: 0, summary: '最初の報酬の決まり',
    effectiveFrom: null, createdBy: '見本 18',
    createdAt: '2026-06-12T14:00:00+09:00', status: 'past',
  },
]

const publicationPhoto = (id, photoId, petName, ownerName, count, label, type = 'column') => ({
  id, photo_id: photoId, status: 'published', show_owner_name: ownerName ? 1 : 0,
  view_count: count, version: 1, published_at: '2026-08-20T00:00:00.000Z',
  image_url: NEN_PHOTO_FIRST.image_url, publication_consent_at: '2026-08-20T00:00:00.000Z',
  pet_name: petName, owner_name: ownerName,
  placements: label ? [{ id: `${id}-place`, placement_type: type, placement_label: label, view_count: count }] : [],
})

export const NEN_PHOTO_PUBLICATIONS = {
  // #580 軽: 概要は現物8件と一致させる（実APIは items.length を数える）。
  // 掲載先は type:label の重なりなし5か所（pub-6は掲載先なし）。
  summary: {
    publishedCount: 8, placementCount: 5,
    topPhoto: { pet_name: 'ももちゃん', view_count: 1240 }, consentedCount: 8,
  },
  items: [
    publicationPhoto('pub-1', 'ph-11', 'ももちゃん', '見本 16 さま', 1240, 'リッチメニュー', 'rich_menu'),
    publicationPhoto('pub-2', 'ph-12', 'そらくん', '見本 17 さま', 860, 'コラム「歯みがき」'),
    publicationPhoto('pub-3', 'ph-13', 'こむぎちゃん', '見本 26 さま', 642, 'サイトのトップ', 'site'),
    publicationPhoto('pub-4', 'ph-14', 'ぷりんちゃん', '見本 27 さま', 418, '回答フォーム', 'form'),
    publicationPhoto('pub-5', 'ph-15', 'だいふく', '見本 45 さま', 286, 'コラム「フード」'),
    publicationPhoto('pub-6', 'ph-16', 'ここちゃん', '見本 44 さま', 204, ''),
    publicationPhoto('pub-7', 'ph-17', 'まるくん', '見本 28 さま', 186, 'リッチメニュー', 'rich_menu'),
    publicationPhoto('pub-8', 'ph-18', 'レオくん', null, 92, 'リッチメニュー', 'rich_menu'),
  ],
}

/*
  ECの取り込み記録。設計 `eI3gs` の一覧。

  **成功だけにしない。** 設計の札は 送信完了／処理中／送信なし／失敗。
  `identity_pending`（LINEの友だちが見つからない）と `failed` を混ぜないと、
  「LINEとのつき合わせが必要」の行と失敗の行が撮れない。
*/
const ecEvent = (id, type, label, order, friendId, friendName, status, minutes, error = null) => ({
  id, externalEventId: `ext-${id}`, eventType: type, eventLabel: label,
  customerId: `cus-${id}`, friendId, friendName, orderNumber: order, status,
  errorMessage: error,
  receivedAt: new Date(Date.parse('2026-08-25T09:00:00.000Z') - minutes * 60 * 1000).toISOString(),
  processedAt: status === 'processed'
    ? new Date(Date.parse('2026-08-25T09:00:00.000Z') - (minutes - 1) * 60 * 1000).toISOString()
    : null,
})

export const EC_EVENTS = [
  ecEvent('ece-1', 'ec.order.confirmed', '注文が確定した', 'NEN-12492', 'friend-1', '見本 16', 'processed', 12),
  ecEvent('ece-2', 'ec.order.payment_received', '入金を確認した', 'NEN-12488', 'friend-2', '見本 17', 'processed', 40),
  ecEvent('ece-3', 'ec.order.shipped', '発送した', 'NEN-12471', 'friend-3', '見本 26', 'processed', 90),
  /* LINEの友だちが見つからない。**取り込めたが送れていない**、を分けて出すため。 */
  ecEvent('ece-4', 'ec.order.confirmed', '注文が確定した', 'NEN-12486', null, null, 'identity_pending', 20),
  ecEvent('ece-5', 'ec.subscription.payment_failed', '定期便の支払いを確認', 'NEN-12480', 'friend-4', '見本 27', 'processing', 5),
  /* 失敗。理由を空にしない。 */
  ecEvent('ece-6', 'ec.order.refunded', '返金した', 'NEN-12402', 'friend-5', '見本 28', 'failed', 180, 'LINEへの送信が拒否されました（ブロック済み）'),
]

/** 取り込みの帯。設計 `eI3gs` の「注文96・入金32・発送20」。 */
export const EC_OVERVIEW = {
  total: 2486, processed: 2412, identityPending: 24, failed: 2, skipped: 48,
  last24h: 148, lastReceivedAt: '2026-08-25T08:48:00.000Z',
  byType: [
    { eventType: 'ec.order.confirmed', label: '注文', count: 96 },
    { eventType: 'ec.order.payment_received', label: '入金', count: 32 },
    { eventType: 'ec.order.shipped', label: '発送', count: 20 },
  ],
  monthlyStats: [
    { month: '2026-06', count: 158, amount: 1248000 },
    { month: '2026-07', count: 169, amount: 1324000 },
    { month: '2026-08', count: 172, amount: 1482000 },
  ],
  impact: { nenCampaigns: 3, conversions: 18, mileageRules: 2, friendFields: 7, analytics: 5 },
}

/** 機能23。注文・個別処理・会員照合を実APIの読み取り模型で返す。 */
export const EC_ORDERS = {
  items: [
    {
      id: 'ec-order-1', lineAccountId: 'visual-qa-account', externalOrderId: 'external-order-12492',
      orderNumber: 'NEN-12492', customerId: 'customer-1', friendId: 'friend-1', customerName: '見本 16',
      status: 'current', providerStatus: 'confirmed', currency: 'JPY', totalAmount: 12800, refundedAmount: 0,
      orderedAt: '2026-08-25T08:48:00.000Z', detailUrl: 'https://example.invalid/orders/NEN-12492', version: 2,
      orderLines: [
        { id: 'ec-order-line-1', productId: 'nen-venison-1kg', productName: '鹿肉ドッグフード 1kg', quantity: 2, unitAmount: 5400, lineAmount: 10800, productUrl: 'https://example.invalid/products/nen-venison-1kg' },
        { id: 'ec-order-line-2', productId: 'nen-topping', productName: '季節のトッピング', quantity: 1, unitAmount: 2000, lineAmount: 2000, productUrl: 'https://example.invalid/products/nen-topping' },
      ],
    },
    {
      id: 'ec-order-2', lineAccountId: 'visual-qa-account', externalOrderId: 'external-order-12488',
      orderNumber: 'NEN-12488', customerId: 'customer-2', friendId: 'friend-2', customerName: '見本 17',
      status: 'current', providerStatus: 'paid', currency: 'JPY', totalAmount: 8400, refundedAmount: 0,
      orderedAt: '2026-08-25T08:20:00.000Z', detailUrl: 'https://example.invalid/orders/NEN-12488', version: 1,
      orderLines: [{ id: 'ec-order-line-3', productId: 'nen-fish-1kg', productName: '魚のドッグフード 1kg', quantity: 2, unitAmount: 4200, lineAmount: 8400, productUrl: null }],
    },
    {
      id: 'ec-order-3', lineAccountId: 'visual-qa-account', externalOrderId: 'external-order-12486',
      orderNumber: 'NEN-12486', customerId: 'customer-3', friendId: null, customerName: null,
      status: 'current', providerStatus: 'confirmed', currency: 'JPY', totalAmount: 5400, refundedAmount: 0,
      orderedAt: '2026-08-25T08:40:00.000Z', detailUrl: 'https://example.invalid/orders/NEN-12486', version: 1,
      orderLines: [{ id: 'ec-order-line-4', productId: 'nen-venison-1kg', productName: '鹿肉ドッグフード 1kg', quantity: 1, unitAmount: 5400, lineAmount: 5400, productUrl: null }],
    },
    {
      id: 'ec-order-4', lineAccountId: 'visual-qa-account', externalOrderId: 'external-order-12471',
      orderNumber: 'NEN-12471', customerId: 'customer-4', friendId: 'friend-3', customerName: '見本 26',
      status: 'current', providerStatus: 'shipped', currency: 'JPY', totalAmount: 16200, refundedAmount: 0,
      orderedAt: '2026-08-25T07:30:00.000Z', detailUrl: 'https://example.invalid/orders/NEN-12471', version: 3,
      orderLines: [{ id: 'ec-order-line-5', productId: 'nen-subscription', productName: '定期便セット', quantity: 1, unitAmount: 16200, lineAmount: 16200, productUrl: null }],
    },
    {
      id: 'ec-order-5', lineAccountId: 'visual-qa-account', externalOrderId: 'external-order-12402',
      orderNumber: 'NEN-12402', customerId: 'customer-5', friendId: 'friend-5', customerName: '見本 28',
      status: 'refunded', providerStatus: 'refunded', currency: 'JPY', totalAmount: 10800, refundedAmount: 10800,
      orderedAt: '2026-08-25T06:00:00.000Z', detailUrl: 'https://example.invalid/orders/NEN-12402', version: 4,
      orderLines: [{ id: 'ec-order-line-6', productId: 'nen-venison-1kg', productName: '鹿肉ドッグフード 1kg', quantity: 2, unitAmount: 5400, lineAmount: 10800, productUrl: null }],
    },
    {
      id: 'ec-order-6', lineAccountId: 'visual-qa-account', externalOrderId: 'external-order-12398',
      orderNumber: 'NEN-12398', customerId: 'customer-6', friendId: 'friend-4', customerName: '見本 27',
      status: 'cancelled', providerStatus: 'cancelled', currency: 'JPY', totalAmount: 6400, refundedAmount: 0,
      orderedAt: '2026-08-24T23:30:00.000Z', detailUrl: null, version: 2,
      orderLines: [{ id: 'ec-order-line-7', productId: 'nen-trial', productName: 'お試しセット', quantity: 1, unitAmount: 6400, lineAmount: 6400, productUrl: null }],
    },
  ],
  total: 2486,
  summary: { total: 2486, current: 2412, refunded: 48, cancelled: 26, totalAmount: 31820400 },
}

export const EC_ACTION_EXECUTIONS = {
  items: [
    /* ★V8 GmVR5 の5行の並び（処理完了・処理完了・処理中・送信なし・失敗）。数の帯は summary のまま。 */
    { id: 'ec-action-1', eventId: 'ece-1', eventType: 'ec.order.confirmed', actionType: 'line_notification', ruleVersion: 'ec-rule-v4', status: 'succeeded', attemptCount: 1, maxAttempts: 3, errorCode: null, errorMessage: null, lastAttemptedAt: '2026-08-25T08:49:00.000Z', nextRetryAt: null, version: 2, receivedAt: '2026-08-25T08:48:00.000Z', orderNumber: 'NEN-12492', customerName: '見本 16', retryAvailable: false },
    { id: 'ec-action-3', eventId: 'ece-3', eventType: 'ec.order.shipped', actionType: 'line_notification', ruleVersion: 'ec-rule-v4', status: 'succeeded', attemptCount: 1, maxAttempts: 3, errorCode: null, errorMessage: null, lastAttemptedAt: '2026-08-25T07:31:00.000Z', nextRetryAt: null, version: 1, receivedAt: '2026-08-25T07:30:00.000Z', orderNumber: 'NEN-12471', customerName: '見本 26', retryAvailable: false },
    { id: 'ec-action-2', eventId: 'ece-2', eventType: 'ec.order.payment_received', actionType: 'line_notification', ruleVersion: 'ec-rule-v4', status: 'processing', attemptCount: 1, maxAttempts: 3, errorCode: null, errorMessage: null, lastAttemptedAt: '2026-08-25T08:21:00.000Z', nextRetryAt: null, version: 1, receivedAt: '2026-08-25T08:20:00.000Z', orderNumber: 'NEN-12488', customerName: '見本 17', retryAvailable: false },
    { id: 'ec-action-4', eventId: 'ece-4', eventType: 'ec.order.confirmed', actionType: 'line_notification', ruleVersion: 'ec-rule-v4', status: 'skipped', attemptCount: 0, maxAttempts: 3, errorCode: 'IDENTITY_PENDING', errorMessage: 'LINEの友だちとのつき合わせが必要です', lastAttemptedAt: null, nextRetryAt: null, version: 1, receivedAt: '2026-08-25T08:40:00.000Z', orderNumber: 'NEN-12486', customerName: null, retryAvailable: false },
    { id: 'ec-action-6', eventId: 'ece-6', eventType: 'ec.order.refunded', actionType: 'conversion_mileage_adjustment', ruleVersion: 'ec-rule-v4', status: 'retryable_failed', attemptCount: 1, maxAttempts: 3, errorCode: 'LINE_REJECTED', errorMessage: 'LINEが送信を受け付けませんでした', lastAttemptedAt: '2026-08-25T06:01:00.000Z', nextRetryAt: '2026-08-25T09:10:00.000Z', version: 2, receivedAt: '2026-08-25T06:00:00.000Z', orderNumber: 'NEN-12402', customerName: '見本 28', retryAvailable: true },
  ],
  total: 2486,
  summary: { pending: 24, processing: 48, succeeded: 2394, skipped: 18, retryable_failed: 2, permanent_failed: 0 },
}

export const EC_IDENTITY_CANDIDATES = {
  items: [
    {
      id: 'ec-identity-1', status: 'pending', version: 1, confidenceScore: 94,
      left: { externalCustomerId: 'customer-3', displayName: '見本 170', attributes: [{ label: 'メール', valuePreview: 'mi***@example.com' }, { label: '電話', valuePreview: '***4821' }] },
      right: { friendId: 'friend-candidate-1', displayName: '見本 162', attributes: [{ label: 'メール', valuePreview: 'mi***@example.com' }] },
      evidence: [{ label: 'メールアドレス', matched: true }, { label: '氏名', matched: true }],
      impact: [{ key: 'orders', value: 3, unit: '件' }, { key: 'revenue', value: 18600, unit: '円' }],
      detectedAt: '2026-08-25T08:40:00.000Z', reviewedAt: null,
    },
    {
      id: 'ec-identity-2', status: 'pending', version: 2, confidenceScore: 82,
      left: { externalCustomerId: 'customer-7', displayName: '見本 114', attributes: [{ label: 'メール', valuePreview: 'ke***@example.com' }, { label: '電話', valuePreview: '***1034' }] },
      right: { friendId: 'friend-candidate-2', displayName: '見本 113', attributes: [{ label: '電話', valuePreview: '***1034' }] },
      evidence: [{ label: '電話番号', matched: true }, { label: '氏名', matched: true }],
      impact: [{ key: 'orders', value: 2, unit: '件' }, { key: 'revenue', value: 12400, unit: '円' }],
      detectedAt: '2026-08-25T08:12:00.000Z', reviewedAt: null,
    },
    {
      id: 'ec-identity-3', status: 'pending', version: 1, confidenceScore: 71,
      left: { externalCustomerId: 'customer-8', displayName: '見本 175', attributes: [{ label: 'メール', valuePreview: 'ao***@example.com' }] },
      right: { friendId: 'friend-candidate-3', displayName: '見本 185', attributes: [{ label: 'メール', valuePreview: 'ao***@example.com' }] },
      evidence: [{ label: 'メールアドレス', matched: true }, { label: '氏名', matched: false }],
      impact: [{ key: 'orders', value: 1, unit: '件' }, { key: 'revenue', value: 4800, unit: '円' }],
      detectedAt: '2026-08-25T07:50:00.000Z', reviewedAt: null,
    },
    {
      id: 'ec-identity-4', status: 'pending', version: 1, confidenceScore: 63,
      left: { externalCustomerId: 'customer-9', displayName: '見本 36', attributes: [{ label: '電話', valuePreview: '***7788' }] },
      right: { friendId: 'friend-candidate-4', displayName: '見本 37', attributes: [{ label: '電話', valuePreview: '***7788' }] },
      evidence: [{ label: '電話番号', matched: true }, { label: '氏名', matched: false }],
      impact: [{ key: 'orders', value: 9, unit: '件' }, { key: 'revenue', value: 122000, unit: '円' }],
      detectedAt: '2026-08-25T07:20:00.000Z', reviewedAt: null,
    },
  ],
  total: 16,
  summary: { unmatched: 24, candidates: 6, candidateExternalCustomers: 6, withoutCandidates: 18, duplicateSuspicions: 2, linked: 1128, potentialRevenue: 84300 },
}

/**
 * `/api/mileage/rewards` — マイルの使い道（`qlVLJ` 17-1-B）。
 *
 * 設計の数字をそのまま置き、本物の口が返す未交換人数と特典名も同じ形で持つ。
 */
function mileageRewardVersion(requiredMiles, stockLimit, extra = {}) {
  return {
    id: `mrv-${requiredMiles}`, versionNumber: 1, status: 'published',
    requiredMiles, stockLimit, perFriendLimit: null,
    startsAt: null, endsAt: null, benefitExpiresDays: 30,
    commonActionVersionId: null, failurePolicy: 'refund',
    targetConditions: { operator: 'AND', rules: [{ type: 'tag_exists', value: 'tag-0' }] },
    customerMessage: '交換ありがとうございます。', publishedAt: '2026-08-01T00:00:00.000Z',
    ...extra,
  }
}

/* 使い道のフォルダ（板 S35pO）：クーポン 3・商品 2・体験 0・未分類 0。 */
export const MILEAGE_REWARD_FOLDERS = [
  ['mrf-coupon', 'クーポン', '#3B82F6', 3],
  ['mrf-goods', '商品', '#10B981', 2],
  ['mrf-experience', '体験', '#F59E0B', 0],
].map(([id, name, color, itemCount], index) => ({
  id: String(id), kind: 'mileage_reward', name: String(name), parentId: null, displayOrder: index,
  itemCount: Number(itemCount), color: String(color), createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
}))

export const MILEAGE_REWARDS = {
  rewards: [
    { id: 'mr-1', folderId: 'mrf-coupon', name: '送料無料', description: '次のお買い物の送料が無料になります', rewardKind: 'coupon', benefitName: '送料無料', status: 'published', sortOrder: 1, currentVersion: mileageRewardVersion(500, null), exchangedThisMonth: 32, availableCodeCount: null },
    { id: 'mr-2', folderId: 'mrf-coupon', name: '500円ぶんのクーポン', description: '1回のお買い物で使えます', rewardKind: 'coupon', benefitName: '500円引き', status: 'published', sortOrder: 2, currentVersion: mileageRewardVersion(1000, null), exchangedThisMonth: 18, availableCodeCount: 168 },
    { id: 'mr-3', folderId: 'mrf-coupon', name: '1,000円ぶんのクーポン', description: '1回のお買い物で使えます', rewardKind: 'coupon', benefitName: '1,000円引き', status: 'published', sortOrder: 3, currentVersion: mileageRewardVersion(1800, null), exchangedThisMonth: 6, availableCodeCount: 94 },
    { id: 'mr-4', folderId: 'mrf-goods', name: '新商品の先行案内', description: 'ふつうより3日早くお知らせします', rewardKind: 'early_access', benefitName: '先行案内', status: 'published', sortOrder: 4, currentVersion: mileageRewardVersion(3000, null), exchangedThisMonth: 2, availableCodeCount: null },
    // 引換コードを数える経路がまだ無い使い道。**残りを 0 と書かない。**
    { id: 'mr-5', folderId: 'mrf-goods', name: 'オリジナルトートバッグ', description: '数量に限りがあります', rewardKind: 'template', benefitName: '発送先の確認メッセージ', status: 'draft', sortOrder: 5, currentVersion: mileageRewardVersion(5000, 12), exchangedThisMonth: 0, availableCodeCount: 12 },
  ].map((reward) => ({
    lineAccountId: 'visual-qa-account', programId: 'mp-1', imageUrl: null,
    currentDraftVersionId: null, currentPublishedVersionId: reward.currentVersion.id,
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-08-30T00:00:00.000Z',
    ...reward,
  })),
  summary: {
    publishedCount: 4,
    redeemedMilesThisMonth: 18900,
    neverRedeemedFriendCount: 786,
    mostRedeemedRewardName: '送料無料',
    mostRedeemedRewardCount: 32,
  },
  reachMetrics: [
    { rewardId: 'mr-1', rewardName: '送料無料', rewardKind: 'coupon', requiredMiles: 500, reachableFriendCount: 1042, redeemedFriendCount: 32, exchangeRate: 32 / 1042 },
    { rewardId: 'mr-2', rewardName: '500円ぶんのクーポン', rewardKind: 'coupon', requiredMiles: 1000, reachableFriendCount: 486, redeemedFriendCount: 18, exchangeRate: 18 / 486 },
    { rewardId: 'mr-3', rewardName: '1,000円ぶんのクーポン', rewardKind: 'coupon', requiredMiles: 1800, reachableFriendCount: 398, redeemedFriendCount: 6, exchangeRate: 6 / 398 },
    { rewardId: 'mr-4', rewardName: '新商品の先行案内', rewardKind: 'early_access', requiredMiles: 3000, reachableFriendCount: 172, redeemedFriendCount: 2, exchangeRate: 2 / 172 },
    { rewardId: 'mr-5', rewardName: 'オリジナルトートバッグ', rewardKind: 'template', requiredMiles: 5000, reachableFriendCount: 86, redeemedFriendCount: 0, exchangeRate: 0 },
  ],
  rankBenefits: [
    { rewardId: 'rank-bronze', rewardName: 'ブロンズ', rewardKind: 'rank', requiredMiles: 0, reachableFriendCount: 886, redeemedFriendCount: 0, exchangeRate: null },
    { rewardId: 'rank-silver', rewardName: 'シルバー', rewardKind: 'rank', requiredMiles: 2000, reachableFriendCount: 312, redeemedFriendCount: 0, exchangeRate: null },
    { rewardId: 'rank-gold', rewardName: 'ゴールド', rewardKind: 'rank', requiredMiles: 5000, reachableFriendCount: 86, redeemedFriendCount: 0, exchangeRate: null },
  ],
  measuredAt: '2026-08-25T01:00:00.000Z',
}

/** 機能9の最終確認と公開完了を描く、保存を伴わない固定応答。 */
export const FRIEND_ADD_RULE_VALIDATE = {
  canPublish: true,
  // 確認は鍵付きで返し、説明文はサーバ値をそのまま出す (順番に意味を持たせない)。
  checks: [{
    key: 'first_time',
    status: 'passed',
    label: '配信内容と参照先を確認できました。',
    detail: '保存済みのルールと参照先を確認できました。',
  }],
}

export const FRIEND_ADD_RULE_PUBLISH = {
  id: 'rule-referral',
  versionNumber: 1,
  publishedAt: '2026-01-13T10:01:00+09:00',
}

/*
  行動スコアの決めごと（`s6MBc` 17-2-A `/mileage/score-rules`）。

  **帯の境目は 30 / 70。** `packages/db` の `DEFAULT_BANDS` と同じ値にしてある。
  同じファイルの `/api/action-scores/friends` は長く `normalMin: 40` を返していて、
  一覧と決めごとの画面で**同じ人が別の帯に入って見えた**。40 に根拠は無かったので
  30 にそろえた。

  **止めているルールを1本入れる。** 全部動かしていると、スイッチが切れている行と
  「止める」の文字が撮れない。
*/
function scoreRule(id, name, eventType, source, operation, value, kind, limit, enabled = true) {
  return {
    id, name, eventType, source, operation, value,
    frequency: { kind, limit }, sameSourceEventOnce: true,
    validFrom: null, validUntil: null, enabled,
  }
}

const ACTION_SCORE_BUNDLE = {
  rules: [
    scoreRule('asr-1', 'メッセージに返信した', 'message_received', 'line_webhook', 'delta', 4, 'per_day', 1),
    scoreRule('asr-2', '配信のURLを押した', 'link_clicked', 'tracked_link', 'delta', 2, 'per_subject_per_day', 1),
    scoreRule('asr-3', '回答フォームに答えた', 'form_submitted', 'form', 'delta', 6, 'per_subject', 1),
    scoreRule('asr-4', '予約した', 'booking_created', null, 'delta', 10, 'unlimited', 1),
    scoreRule('asr-5', '購入した', 'purchase_completed', 'stripe', 'delta', 12, 'unlimited', 1),
    scoreRule('asr-6', '30日間反応がない', 'inactivity_30d', 'scheduler', 'delta', -6, 'once_per_period', 1),
    scoreRule('asr-7', 'ブロックした', 'friend_unfollow', 'line_webhook', 'set', 0, 'unlimited', 1, false),
  ],
  bands: { min: 0, max: 100, normalMin: 30, highMin: 70 },
}

export const ACTION_SCORE_RULES = {
  configured: true,
  status: 'published',
  currentDraftVersionId: 'asrv-3',
  currentPublishedVersionId: 'asrv-2',
  editableVersion: {
    ...ACTION_SCORE_BUNDLE,
    id: 'asrv-3', versionNumber: 3, status: 'draft',
    createdAt: '2026-08-30T10:00:00.000Z', publishedAt: null,
  },
  publishedVersion: {
    ...ACTION_SCORE_BUNDLE,
    id: 'asrv-2', versionNumber: 2, status: 'published',
    createdAt: '2026-08-20T10:00:00.000Z', publishedAt: '2026-08-21T02:00:00.000Z',
  },
}


const fail = (status, error, code) => ({
  status,
  body: { success: false, error, ...(code ? { code } : {}) },
})
const ok = (status, data) => ({ status, body: { success: true, data } })

/**
 * 機能17の画面確認専用の書き込み応答。
 * DBは変えず、本番口と同じ成功・入力不足・競合の器だけを再現する。
 */
export function mileageWriteResponse(method, pathname, body = {}, headers = {}) {
  if (method === 'POST' && pathname === '/api/mileage/rules') {
    if (!String(body.name ?? '').trim() || !String(body.eventType ?? '').trim()
      || !Number.isInteger(body.amount) || body.amount <= 0 || !String(body.lineAccountId ?? '').trim()) {
      return fail(400, 'name, eventType, lineAccountId and a positive integer amount are required')
    }
    return ok(201, { ...MILEAGE_RULES[0], ...body, id: 'mileage-rule-visual-new', isActive: true })
  }

  const mileageRule = /^\/api\/mileage\/rules\/([^/]+)$/.exec(pathname)
  if (method === 'PUT' && mileageRule) {
    if (body.amount !== undefined && (!Number.isInteger(body.amount) || body.amount <= 0)) {
      return fail(400, 'amount must be a positive integer')
    }
    if (mileageRule[1] === 'mileage-rule-global') {
      return fail(409, '全店共通の旧ルールは変更できません')
    }
    return ok(200, { ...MILEAGE_RULES[0], ...body, id: mileageRule[1] })
  }

  const rewardOperation = /^\/api\/mileage\/rewards\/([^/]+)\/(test|publish|stop)$/.exec(pathname)
  if (method === 'POST' && rewardOperation) {
    if (!String(body.accountId ?? '').trim()) return fail(400, 'accountId is required')
    if (rewardOperation[1] === 'mr-conflict') {
      return fail(409, '別の人が新版を作りました。再読み込みしてください', 'version_conflict')
    }
    const reward = MILEAGE_REWARDS.rewards.find((item) => item.id === rewardOperation[1])
      ?? MILEAGE_REWARDS.rewards[0]
    if (rewardOperation[2] === 'test') {
      return ok(200, {
        rewardId: reward.id,
        versionId: reward.currentVersion.id,
        requiredMiles: reward.currentVersion.requiredMiles,
        canDeliver: true,
        warning: null,
        ledgerChanged: false,
      })
    }
    return ok(200, {
      ...reward,
      status: rewardOperation[2] === 'stop' ? 'stopped' : 'published',
    })
  }

  if (method === 'POST' && pathname === '/api/mileage/adjustments') {
    const key = String(headers['idempotency-key'] ?? headers['Idempotency-Key'] ?? '')
    if (!key || !String(body.accountId ?? '').trim() || !String(body.friendId ?? '').trim()
      || !['increase', 'decrease'].includes(body.direction) || !Number.isInteger(body.amount)
      || body.amount <= 0 || !String(body.reason ?? '').trim()) {
      return fail(400, 'accountId, friendId, direction, reason and Idempotency-Key are required')
    }
    if (key === 'visual-conflict') {
      return fail(409, '同じIdempotency-Keyが別の内容で使われています', 'idempotency_conflict')
    }
    const signed = body.direction === 'decrease' ? -body.amount : body.amount
    return ok(201, {
      entryId: 'mileage-adjustment-visual',
      balanceBefore: 1240,
      amount: signed,
      balanceAfter: 1240 + signed,
      replayed: false,
      expiresAt: body.expiresAt ?? null,
      notification: null,
    })
  }

  if (method === 'PATCH' && pathname === '/api/action-scores/rules/draft') {
    if (!String(body.accountId ?? '').trim() || !body.configuration) {
      return fail(400, 'accountId and configuration are required')
    }
    if (body.expectedDraftVersionId === 'stale-version') {
      return fail(409, '別の人が下書きを更新しました', 'version_conflict')
    }
    return ok(200, { ...ACTION_SCORE_RULES, status: 'draft' })
  }

  if (method === 'POST' && pathname === '/api/action-scores/rules/test') {
    if (!String(body.accountId ?? '').trim() || !body.configuration || !String(body.eventType ?? '').trim()) {
      return fail(400, 'accountId, configuration and eventType are required')
    }
    return ok(200, {
      scoreBefore: Number(body.currentScore ?? 0),
      scoreAfter: Number(body.currentScore ?? 0) + 4,
      bandBefore: 'normal',
      bandAfter: 'normal',
      matched: [{ ruleId: 'asr-1', ruleName: 'メッセージに返信した', scoreBefore: 40, scoreAfter: 44 }],
    })
  }

  if (method === 'POST' && pathname === '/api/action-scores/rules/publish') {
    if (!String(body.accountId ?? '').trim() || !String(body.draftVersionId ?? '').trim()) {
      return fail(400, 'accountId and draftVersionId are required')
    }
    if (body.draftVersionId === 'stale-version') {
      return fail(409, '公開する下書きが変わりました', 'version_conflict')
    }
    return ok(200, { ...ACTION_SCORE_RULES, status: 'published' })
  }

  if (method === 'POST' && pathname === '/api/action-scores/rules/stop') {
    if (!String(body.accountId ?? '').trim()) return fail(400, 'accountId is required')
    return ok(200, { ...ACTION_SCORE_RULES, status: 'stopped' })
  }

  return null
}

/**
 * 機能10 ウェビナーのフォルダ。設計 `ZC13r` の名前と件数。
 * `count` は全18件を取得しなくても左の絞り込み件数を描ける一覧集計値。
 */
export const WEBINAR_FOLDERS = [
  /* 色は板 `UyUMw` の行の名前の前の丸（フォルダの色）。 */
  ['webinar-folder-seminars', 'セミナー', 2, '#2f6fde'],
  ['webinar-folder-products', '商品説明', 1, '#1f9d55'],
  ['webinar-folder-cases', '導入事例', 1, '#e07b24'],
].map(([id, name, count, color], index) => ({
  id, kind: 'webinar', accountId: 'visual-qa-account', name, parentId: null, displayOrder: index, count,
  color, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-25T02:00:00.000Z',
}))

export const WEBINAR_FOLDER_SUMMARY = { rows: 5, total: 18 }

/** 機能32 緊急コントロール。設計 `b3HfZ` の通常運用と影響数。 */
const OPERATION_RUNNING_STATES = {
  broadcast_dispatch: 'running',
  scenario_dispatch: 'running',
  reminder_dispatch: 'running',
  automation_actions: 'running',
  auto_reply_dispatch: 'running',
  webhook_outgoing: 'running',
  ad_postback: 'running',
}

/** 機能32。5分ごとのサーバー確認を同じ時刻・同じ値で描く。 */
export const OPERATION_HEALTH = {
  latestRun: {
    id: 'operation-health-20260825-1145',
    lineAccountId: 'visual-qa-account',
    source: 'scheduled',
    status: 'completed',
    overallStatus: 'normal',
    startedAt: '2026-08-25T11:45:00+09:00',
    completedAt: '2026-08-25T11:45:00+09:00',
    results: [
      ['line_connection', '3アカウントすべて 応答あり'],
      ['message_quota', '86,420 / 200,000通'],
      ['external_integrations', '取り込みが3件失敗'],
      ['webhook', '送る 6本・受ける 3本 ／ 失敗 0'],
      ['dispatch_jobs', '待っている 148通 ／ 遅れ 0分'],
      ['friend_change', '今日 ＋16 ／ －6（純増 ＋10）'],
      ['monitoring_heartbeat', '5分ごとの確認 応答あり'],
      ['infra_canary', 'DB・保管庫・順番待ち 応答あり'],
      ['credential_expiry', 'いちばん近い期限 82日後'],
    ].map(([checkKey, summary], index) => ({
      id: `operation-health-result-${index + 1}`,
      runId: 'operation-health-20260825-1145',
      checkKey,
      /* ★V8 Y4LkX1：API・外部連携だけ「注意」（取り込みが3件失敗）。 */
      status: checkKey === 'external_integrations' ? 'warning' : 'normal',
      summary,
      value: {},
      threshold: {},
      source: 'visual_qa_fixture',
      observedAt: '2026-08-25T11:45:00+09:00',
    })),
  },
  overallStatus: 'normal',
  lastCheckedAt: '2026-08-25T11:45:00+09:00',
  nextCheckAt: '2026-08-25T11:50:00+09:00',
  serverNow: '2026-08-25T11:46:00+09:00',
}

/** ★V8 Y4LkX1 の「開いている異常 1件」。API・外部連携の注意（受領前・通知1件送信済み）。 */
export const OPERATION_ALERTS = [
  {
    id: 'operation-alert-1', lineAccountId: 'visual-qa-account', checkKey: 'external_integrations',
    status: 'open', severity: 'warning', summary: '取り込みが3件失敗',
    sourceRunId: 'operation-health-20260825-1145',
    firstDetectedAt: '2026-10-02T10:15:00+09:00', lastDetectedAt: '2026-10-02T10:15:00+09:00',
    acknowledgedAt: null, acknowledgedById: null, acknowledgementNote: null, resolvedAt: null,
    version: 1, reopenedCount: 0,
    createdAt: '2026-10-02T10:15:00+09:00', updatedAt: '2026-10-02T10:15:00+09:00',
    notification: { queued: 0, sending: 0, sent: 1, failed: 0, unconfigured: 0, total: 1 },
    events: [{
      id: 'operation-alert-1-opened', action: 'opened', severity: 'warning', summary: '取り込みが3件失敗',
      actorId: null, note: null, alertVersion: 1, createdAt: '2026-10-02T10:15:00+09:00',
    }],
  },
]

export const OPERATION_CONTROL_PREVIEW = {
  control: {
    scopeKey: 'all', lineAccountId: null, version: 8,
    states: OPERATION_RUNNING_STATES, activeIncidentId: null,
    reason: null, actorId: null, stoppedAt: null,
    updatedAt: '2026-08-25T06:00:00+09:00',
  },
  counts: {
    broadcast_dispatch: 1, scenario_dispatch: 4, reminder_dispatch: 10,
    automation_actions: 14, auto_reply_dispatch: 10,
    webhook_outgoing: 0, ad_postback: 0,
  },
  impact: {
    broadcast_dispatch: {
      itemCount: 1, friendCount: 8_486, pendingCount: 1,
      nearestScheduledAt: '2026-08-28T20:00:00+09:00',
    },
    scenario_dispatch: { itemCount: 4, friendCount: 486 },
    reminder_dispatch: { itemCount: 10, friendCount: 12 },
    automation_actions: { itemCount: 14, friendCount: 320, pendingCount: 50 },
    auto_reply_dispatch: { itemCount: 10, friendCount: null },
  },
  permissions: { canControl: true },
  calculatedAt: '2026-08-25T06:00:00+09:00',
}

function operationControlSnapshot({ version, activeIncidentId, reason, actorId, stoppedAt, capturedAt, stoppedCapabilities = [] }) {
  return {
    version,
    states: Object.fromEntries(Object.entries(OPERATION_RUNNING_STATES).map(([capability, state]) => [
      capability,
      stoppedCapabilities.includes(capability) ? 'stopped' : state,
    ])),
    activeIncidentId, reason, actorId, stoppedAt, capturedAt,
  }
}

/** 機能32 更新履歴。設計 `UhC2O` の停止→復旧済み3件。 */
export const OPERATION_HISTORY = [
  {
    id: 'operation-incident-20260824', scopeKey: 'all', lineAccountId: null,
    status: 'resolved', capabilities: ['webhook_outgoing'],
    reason: 'その他', detail: '外部連携の応答遅延を確認するため停止',
    actorId: '見本 110（管理者・東京）', resolvedByActorId: '見本 110（管理者・東京）',
    controlVersion: 8,
    stoppedAt: '2026-08-24T18:20:00+09:00', resolvedAt: '2026-08-24T18:52:00+09:00',
    createdAt: '2026-08-24T18:20:00+09:00', updatedAt: '2026-08-24T18:52:00+09:00',
    errorMessage: null,
  },
  {
    id: 'operation-incident-20260612', scopeKey: 'all', lineAccountId: null,
    status: 'resolved',
    capabilities: ['broadcast_dispatch', 'scenario_dispatch', 'reminder_dispatch', 'automation_actions', 'auto_reply_dispatch'],
    reason: '誤配信の防止', detail: '配信条件を確認してから復旧',
    actorId: '見本 138（管理者・大阪）', resolvedByActorId: '見本 138（管理者・大阪）',
    controlVersion: 6,
    stoppedAt: '2026-06-12T09:05:00+09:00', resolvedAt: '2026-06-12T09:40:00+09:00',
    createdAt: '2026-06-12T09:05:00+09:00', updatedAt: '2026-06-12T09:40:00+09:00',
    errorMessage: null,
  },
  {
    id: 'operation-incident-20260302', scopeKey: 'line-account-main', lineAccountId: '本店アカウント',
    status: 'resolved', capabilities: ['broadcast_dispatch', 'scenario_dispatch', 'reminder_dispatch'],
    reason: '障害対応', detail: 'LINE側の障害が解消したことを確認して復旧',
    actorId: '見本 110（管理者・東京）', resolvedByActorId: '見本 110（管理者・東京）',
    controlVersion: 4,
    stoppedAt: '2026-03-02T14:00:00+09:00', resolvedAt: '2026-03-02T15:10:00+09:00',
    createdAt: '2026-03-02T14:00:00+09:00', updatedAt: '2026-03-02T15:10:00+09:00',
    errorMessage: null,
  },
].map((incident) => ({
  ...incident,
  // サーバーの履歴口が付ける項目(#518 中5)。無いと配備分岐の目視ができない。
  historyKind: 'incident',
  occurredAt: incident.createdAt,
  beforeSnapshot: operationControlSnapshot({
    version: incident.controlVersion - 2, activeIncidentId: null, reason: null,
    actorId: null, stoppedAt: null, capturedAt: incident.createdAt,
  }),
  stoppedSnapshot: operationControlSnapshot({
    version: incident.controlVersion - 1, activeIncidentId: incident.id,
    reason: incident.reason, actorId: incident.actorId, stoppedAt: incident.stoppedAt,
    capturedAt: incident.stoppedAt, stoppedCapabilities: incident.capabilities,
  }),
  restoredSnapshot: operationControlSnapshot({
    version: incident.controlVersion, activeIncidentId: null, reason: null,
    actorId: incident.resolvedByActorId, stoppedAt: null, capturedAt: incident.resolvedAt,
  }),
})).concat([
  // サーバーが返す配備要素の形(#518 中5)。更新履歴タブの「管理画面の更新」
  // 欄(`historyKind === 'deployment'` 分岐)の目視確認用。
  {
    id: 'deployment:deploy-20260825-0800',
    historyKind: 'deployment',
    occurredAt: '2026-08-25T08:00:00+09:00',
    scopeKey: '*',
    lineAccountId: null,
    status: 'resolved',
    capabilities: [],
    reason: '管理画面の更新 v0.14.1',
    detail: 'v0.14.1',
    actorId: '自動配備',
    resolvedByActorId: null,
    controlVersion: null,
    beforeSnapshot: null,
    stoppedSnapshot: null,
    restoredSnapshot: null,
    errorMessage: null,
    stoppedAt: null,
    resolvedAt: '2026-08-25T08:00:00+09:00',
    createdAt: '2026-08-25T08:00:00+09:00',
    updatedAt: '2026-08-25T08:05:00+09:00',
    deployment: {
      deploymentId: 'deploy-20260825-0800',
      phase: 'succeeded',
      environment: 'staging',
      version: 'v0.14.1',
      pullRequest: 1234,
      actor: '自動配備',
      occurredAt: '2026-08-25T08:00:00+09:00',
    },
  },
])

/**
 * 機能10 ウェビナー。Pencil `ZC13r` の5行を一覧契約の値だけで表す。
 *
 * `status` に型外の「公開予定」「非公開」を入れない。保存状態は従来の
 * draft / active / archived、公開の見え方は `publicationState` で分ける。
 * 申込・視聴の未取得は0で埋めず null にする。
 */
export const WEBINARS = [
  /* 並びは設計 `UyUMw` の上から（更新が新しい順）。行のフォルダは絵の丸の並び（セミナー・商品説明・導入事例・未分類・セミナー・商品説明）。 */
  {
    id: 'webinar-1', title: 'NEN活用スタートセミナー', slug: 'nen-start', status: 'active',
    folderId: 'webinar-folder-seminars', folderName: 'セミナー',
    durationSeconds: 2_538, registrationCount: 124, viewerCount: 98,
    publicationState: 'always', publicationStartsAt: null, publicationEndsAt: null,
    updatedAt: '2026-08-25T06:00:00.000Z',
  },
  {
    id: 'webinar-2', title: 'EC連携 実践講座', slug: 'ec-practice', status: 'active',
    folderId: 'webinar-folder-products', folderName: '商品説明',
    durationSeconds: 2_160, registrationCount: 58, viewerCount: null,
    publicationState: 'scheduled', publicationStartsAt: '2026-10-08T20:00:00+09:00', publicationEndsAt: null,
    updatedAt: '2026-08-25T05:00:00.000Z',
  },
  {
    id: 'webinar-3', title: '予約機能の使い方', slug: 'booking', status: 'active',
    folderId: 'webinar-folder-cases', folderName: '導入事例',
    durationSeconds: 1_920, registrationCount: 42, viewerCount: 39,
    publicationState: 'period', publicationStartsAt: '2026-09-01T00:00:00+09:00', publicationEndsAt: '2026-10-31T23:59:59+09:00',
    updatedAt: '2026-08-25T04:00:00.000Z',
  },
  {
    id: 'webinar-4', title: '顧客対応の自動化', slug: 'automation', status: 'active',
    folderId: null, folderName: null,
    durationSeconds: 1_800, registrationCount: 24, viewerCount: 20,
    publicationState: 'always', publicationStartsAt: null, publicationEndsAt: null,
    updatedAt: '2026-08-25T03:00:00.000Z',
  },
  {
    id: 'webinar-5', title: '旧機能説明会', slug: 'old', status: 'draft',
    folderId: 'webinar-folder-seminars', folderName: 'セミナー',
    durationSeconds: 1_500, registrationCount: 85, viewerCount: 99,
    publicationState: 'ended', publicationStartsAt: '2026-08-01T00:00:00+09:00', publicationEndsAt: '2026-08-20T23:59:59+09:00',
    updatedAt: '2026-08-25T02:00:00.000Z',
  },
  {
    id: 'webinar-6', title: '秋の新商品説明会', slug: 'autumn', status: 'draft',
    folderId: 'webinar-folder-products', folderName: '商品説明',
    durationSeconds: 0, registrationCount: 0, viewerCount: null,
    publicationState: 'unset', publicationStartsAt: null, publicationEndsAt: null,
    updatedAt: '2026-08-25T01:00:00.000Z',
  },
].map((webinar) => ({
  accountId: 'visual-qa-account', videoPrefix: `webinars/${webinar.slug}`,
  schedule: [{ type: 'daily', time: '20:00' }],
  cta: { label: '個別相談を予約する', url: 'https://example.com/consultation', showAtSeconds: 1_920 },
  tagOnAttend: '配信済み', tagOnCtaClick: '相談希望',
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-25T02:00:00.000Z',
  ...webinar,
}))

export const WEBINAR_OVERVIEW = {
  state: 'partial', registrationMode: 'people',
  metrics: {
    webinars: { value: 6, state: 'available', reason: null },
    activeWebinars: { value: 3, state: 'available', reason: null },
    registrations: { value: 248, state: 'available', reason: null },
    registrationBookings: { value: 260, state: 'available', reason: null },
    viewers: { value: 118, state: 'available', reason: null },
    viewRate: { value: 0.476, state: 'available', reason: null },
    averageWatchSeconds: { value: null, state: 'unavailable', reason: '一覧では未取得' },
    ctaUniquePeople: { value: 18, state: 'available', reason: null },
    ctaTotalClicks: { value: 41, state: 'available', reason: null },
  },
}

export const WEBINAR_NOTIFICATIONS = {
  settings: {
    webinarId: 'webinar-1', version: 3,
    registrationEnabled: true, dayBeforeEnabled: true, dayBeforeTime: '19:00',
    hourBeforeEnabled: true, hourBeforeMinutes: 15, startEnabled: true,
    missedEnabled: false, missedTime: '10:00', missedWindowDays: 3, completedEnabled: true,
    updatedAt: '2026-08-25T02:00:00.000Z',
  },
  overview: {
    total: 455, pending: 32, sent: 412, failed: 3, skipped: 8, cancelled: 0,
    audience: { people: 184, bookings: 184, definition: 'active_registrations' },
  },
}

/**
 * N: 動画の準備の段の見本。「配信の形」まで進んだ状態。
 * 準備が済むまで公開できないことの撮影に使う。
 */
export const WEBINAR_VIDEO_ASSET = {
  id: 'video-asset-1', stage: 'packaging', stageLabel: '配信の形', provider: 'r2_hls',
  durationSeconds: 2_538, errorCode: null, expiresAt: null, purgedAt: null,
  createdAt: '2026-09-20T00:00:00+09:00', updatedAt: '2026-09-20T01:00:00+09:00',
}

/* 板 Q0Jrk：12:00 の申し込みカード（回答フォーム）と、40:00 の資料（URL）。 */
export const WEBINAR_CTAS = [{
  id: 'webinar-cta-1', atSeconds: 720, kind: 'form',
  title: '個別導入診断、受付中です', body: 'この配信を見ている方限定・枠が少なめです',
  buttonLabel: '無料で診断を受ける', autoOpen: true, formId: 'form-1', url: null,
}, {
  id: 'webinar-cta-2', atSeconds: 2_400, kind: 'url',
  title: '資料をダウンロード', body: null,
  buttonLabel: '資料を受け取る', autoOpen: false, formId: null, url: 'https://example.com/nen-guide.pdf',
}]

export const WEBINAR_ACTIONS = [
  { id: 'webinar-action-1', trigger: 'completed', actionType: 'add_tag', config: { tagId: '視聴完了' }, position: 0, version: 2 },
  { id: 'webinar-action-2', trigger: 'cta_clicked', actionType: 'start_scenario', config: { scenarioId: '相談のご案内' }, position: 1, version: 2 },
]

/* 板 Omqd4：流すコメント5件（マイナスは開始前の待機ルーム）。 */
export const WEBINAR_COMMENTS = [
  [-60, '田中', 'こんばんは、楽しみです'],
  [-30, 'さくら', '音声きこえます'],
  [45, 'まさ', 'わかりやすい！'],
  [370, 'ゆか', 'この画面、うちでも使えそう'],
  [740, '田中', '診断うけてみます'],
].map(([atSeconds, authorName, body], index) => ({ id: `webinar-comment-${index + 1}`, webinarId: 'webinar-1', atSeconds, authorName, body }))

/** 機能10の編集・公開・運用画面だけが読む固定応答。 */
export const WEBINAR_EDITOR = {
  version: 4,
  deliveryKind: 'on_demand',
  ctaCount: 2,
  viewingCondition: { kind: 'registered', label: '申込済みの友だち' },
  publicDescription: 'LINE活用の基本から、申込後の自動フォローまでを実演します。',
  registrationFormId: 'form-1',
  notificationMessages: {
    registration: 'お申し込みありがとうございます。視聴ページはこちらです。',
    dayBefore: '明日 20:00 から「NEN活用スタートセミナー」です。\n▶ こちらから入れます',
    hourBefore: '開始まであと1時間です。',
  },
  notificationTest: { status: 'passed', sent: 1, failed: 0, testedAt: '2026-09-07T04:30:00.000Z' },
  actionPolicy: {
    templateBody: '最後までご視聴ありがとうございました。',
    missingResultPolicy: 'escalate',
  },
  publicPage: {
    liffId: '2000000000-visualqa',
    url: 'https://liff.line.me/2000000000-visualqa/webinar/nen-start',
    unavailableReason: null,
    description: 'LINE活用の基本から、申込後の自動フォローまでを実演します。',
    test: { status: 'passed', testedAt: '2026-09-07T04:31:00.000Z' },
    form: {
      id: 'form-1', name: 'ウェビナー申込フォーム', active: true,
      fields: ['お名前', '会社名・屋号', 'メールアドレス'],
      completionActions: ['タグを付ける', 'シナリオを開始する', '完了メッセージを送る'],
    },
  },
  publication: {
    status: 'active', draftVersion: 4, publishedVersion: 3,
    publishedAt: '2026-08-25T02:00:00.000Z',
  },
  monitoring: {
    notificationFailures: 0, duplicateRegistrations: 0,
    viewSegmentFailures: 0, actionFailures: 0,
  },
}

export const WEBINAR_PUBLISH_VALIDATION = {
  version: 4,
  /* 板 XCUNf：8つのうち公開ページの確認だけがまだ（7/8）。 */
  checks: [
    ['video_ready', '動画の準備ができている', null, 'passed'],
    ['form_active', '申込フォームが公開中', null, 'passed'],
    ['cta_range', 'CTA の時刻とリンク', null, 'passed'],
    ['schedule', '配信枠が1件以上', '3件', 'passed'],
    ['notification_test', '通知のテスト送信', '10/2 18:40', 'passed'],
    ['public_page_test', '公開ページを確かめた', 'ページをテストしてください', 'failed'],
    ['notification_duplicates', '通知が重なっていない', null, 'passed'],
    ['action_dependencies', 'アクションの参照先がある', null, 'passed'],
  ].map(([key, label, detail, status]) => ({ key, label, detail, status })),
  blockers: ['公開ページをまだ確かめていません。'], warnings: [],
}

export const WEBINAR_ANALYTICS = {
  summary: {
    reservations: 124, viewers: 100, registeredAndJoined: 100, watched5m: 92,
    watched15m: 81, completed: 71, avgWatchedSeconds: 372, ctaClicks: 23, formSubmissions: 9,
  },
  daily: [],
  /* 板 uNsEy の5人（視聴完了・途中で離れた・入場のみ・申込のみ・視聴完了）。 */
  participants: [
    ['friend-1', 'Demo Person', 2_538, '2026-09-30T10:12:00+09:00', true, false, 2, true],
    ['friend-2', 'Masato S.', 1_066, '2026-09-30T09:40:00+09:00', false, false, 1, false],
    ['friend-3', '見本 15', 0, '2026-09-29T21:18:00+09:00', false, false, 1, true],
    ['friend-4', '見本 141', 0, null, false, false, 0, true],
    ['friend-5', '見本 25', 2_436, '2026-09-29T12:05:00+09:00', false, true, 1, true],
  ].map(([friendId, friendName, maxWatchedSeconds, latestJoinedAt, cta, form, sessions, registered]) => ({
    friendId, friendName, pictureUrl: null, sessions,
    firstJoinedAt: latestJoinedAt, latestJoinedAt, maxWatchedSeconds,
    ctaClickedAt: cta ? latestJoinedAt : null, registered,
    formSubmittedAt: form ? latestJoinedAt : null,
  })),
  sessions: [], dropoff: [],
  viewSegments: [
    { startSeconds: 0, endSeconds: 300, viewers: 142 },
    { startSeconds: 300, endSeconds: 1_100, viewers: 136 },
    { startSeconds: 1_100, endSeconds: 1_800, viewers: 101 },
    { startSeconds: 1_800, endSeconds: 2_538, viewers: 98 },
  ],
  // J-1「どこまで見られたか」の見本。申し込みボタンは25分（1_500秒）。
  retention: {
    bucketSeconds: 60,
    started: 112,
    points: [
      { atSeconds: 0, viewers: 112 },
      { atSeconds: 60, viewers: 108 },
      { atSeconds: 720, viewers: 84 },
      { atSeconds: 1_440, viewers: 61 },
      { atSeconds: 1_500, viewers: 58 },
      { atSeconds: 2_400, viewers: 41 },
    ],
  },
  startedViewers: 112,
  heartbeatRejects: 2,
  ctaAtSeconds: 720,
  measurement: { state: 'available', reason: null },
  formFunnel: {
    ctaImpressions: 96, ctaClicks: 52, formOpens: 41, formStarts: 32,
    submitAttempts: 21, submitSuccesses: 18, submitErrors: 3, fieldCompletions: [],
  },
}

export const WEBINAR_PARTICIPANTS = {
  items: WEBINAR_ANALYTICS.participants.map((participant, index) => ({
    ...participant,
    actionStatus: 'completed',
    errorDetail: null,
    staffIntegrationStatus: 'completed',
    classification: ['completed', 'dropped_off', 'dropped_off', 'unviewed', 'completed'][index],
  })),
  nextCursor: null,
}

/**
 * 共通情報を**変える前**の確認（`uNBlA` 14-1-B。口は #773）。
 *
 * 削除前の使用先に、保存すると何がどう変わるかを足したもの。
 * `nextValue` は呼ぶ側が入れる。ここでは形と**言い分けの見本**だけを持つ。
 *
 * わざと4通りを混ぜてある。1通りだけだと、画面の書き分けが撮れない：
 *   1. ふつうに変わる行
 *   2. 送信済みで**変わらない**行
 *   3. 差し込みの目印を読み取れず、**保存後の文を作れない**行
 *   4. 上限を超えて、**保存を止める**行
 */
/* 板 `AYc6O`（営業時間の編集・変える前に影響を見る）。8か所のうち先頭
 * 3件は絵のとおり、残り5件は「ほか5か所を見る」の中に畳まれる。 */
export function commonVarChangeImpactHours(nextValue) {
  const currentValue = '平日 10:00〜19:00'
  const rows = [
    ['template', 'テンプレート', '店舗のご案内', '使われています', '営業時間は平日 10:00〜19:00です。'],
    ['broadcast', '一斉配信', '10月のお知らせ（10/3送信）', '配信予約中', '平日 10:00〜19:00…'],
    ['auto_reply', '自動応答', '営業時間外の自動返信', '有効', '受付は平日 10:00〜19:00です。'],
    ['template', 'テンプレート', '初めてのご来店案内', '使われています', '営業時間は平日 10:00〜19:00です。'],
    ['template', 'テンプレート', '予約確認のご連絡', '使われています', '営業時間は平日 10:00〜19:00です。'],
    ['template', 'テンプレート', '定休日のお知らせ', '使われています', '営業時間は平日 10:00〜19:00です。'],
    ['template', 'テンプレート', '年末年始のご案内', '使われています', '営業時間は平日 10:00〜19:00です。'],
    ['template', 'テンプレート', '移転のお知らせ', '使われています', '営業時間は平日 10:00〜19:00です。'],
  ]
  const items = rows.map(([kind, kindLabel, name, status, currentPreview]) => ({
    kind, kindLabel, name, status,
    blocksDeletion: true,
    changesOnSave: true,
    previewAvailable: true,
    currentPreview,
    nextPreview: currentPreview.replaceAll(currentValue, nextValue),
    currentCharacterCount: currentPreview.length,
    nextCharacterCount: currentPreview.replaceAll(currentValue, nextValue).length,
    characterLimit: 5000,
    exceedsCharacterLimit: false,
    errors: [],
    warnings: [],
  }))
  return {
    variable: {
      id: 'common-var-hours', name: '営業時間', varKey: 'shop_hours',
      currentValue, nextValue,
    },
    total: 8,
    blockingTotal: 8,
    historicalTotal: 0,
    unscopedFormTotal: 0,
    canDelete: false,
    byKind: { template: 6, broadcast: 1, scenario: 0, reminder: 0, auto_reply: 1, form: 0, automation: 0, friend_add: 0, common_action: 0 },
    items,
    unavailableReferences: [],
    checkedAt: '2026-09-07T10:00:00.000+09:00',
    errorTotal: 0,
    warningTotal: 0,
    canSave: true,
    recommendedAction: 'save',
  }
}

export function commonVarChangeImpact(nextValue) {
  const items = COMMON_VAR_DELETE_IMPACT.items.map((item, index) => {
    const nextPreview = item.currentPreview.replaceAll('株式会社NEN', nextValue)
    const limited = index === 1
    const characterLimit = limited ? 60 : 5000
    const nextCharacterCount = limited ? 66 : nextPreview.length
    return {
      ...item,
      changesOnSave: true,
      previewAvailable: true,
      nextPreview,
      currentCharacterCount: item.currentPreview.length,
      nextCharacterCount,
      characterLimit,
      exceedsCharacterLimit: limited,
      errors: limited ? ['変更後の文が60文字を超えます'] : [],
      warnings: [],
    }
  })
  return {
    variable: {
      id: 'common-var-delete-target', name: '会社名', varKey: 'company_name',
      currentValue: '株式会社NEN', nextValue,
    },
    total: 15,
    blockingTotal: 15,
    historicalTotal: 0,
    unscopedFormTotal: 0,
    canDelete: false,
    byKind: { template: 12, broadcast: 0, scenario: 0, reminder: 0, auto_reply: 0, form: 3, automation: 0, friend_add: 0, common_action: 0 },
    items,
    unavailableReferences: [],
    checkedAt: '2026-09-07T10:00:00.000+09:00',
    errorTotal: items.reduce((sum, item) => sum + item.errors.length, 0),
    warningTotal: items.reduce((sum, item) => sum + item.warnings.length, 0),
    canSave: items.every((item) => item.errors.length === 0),
    recommendedAction: 'fix_errors',
  }
}

/*
 * 全ルート監査（2026-09-25）担当Aの欠け埋め。
 * いずれも本物の Worker（`apps/worker/src/routes/`）が返す形。
 * 画面側は変えず、偽APIの返しだけを実APIの形に直す。
 */

/** テスト送信先の候補（LINE連携済みのログインユーザー）。本物は配列。 */
export const TEST_RECIPIENT_LOGIN_USERS = [
  { id: 'friend-test-kenta', displayName: 'Demo Person', pictureUrl: null, staffName: 'Demo Person', sameAccount: true },
  { id: 'friend-test-masato', displayName: 'Masato S.', pictureUrl: null, staffName: 'Masato S.', sameAccount: true },
]

/** 統括バナー生成のプリセット。本物は `BANNER_PRESETS` から `medium` を除いた形。 */
export const HQ_BANNER_PRESETS = [
  { key: 'line_rich_message', group: 'line', label: 'リッチメッセージ', note: '1040×1040。トークに大きく出る正方形の画像', apiSize: '1024x1024', targetWidth: 1040, targetHeight: 1040, aspectRatio: '1:1' },
  { key: 'line_image_message', group: 'line', label: '画像メッセージ・クーポン', note: '1040×1040。画像だけを送るメッセージやクーポンの絵', apiSize: '1024x1024', targetWidth: 1040, targetHeight: 1040, aspectRatio: '1:1' },
  { key: 'line_card', group: 'line', label: 'カードタイプ・カルーセル', note: '1200×795（1.51:1）。横にめくれるカードの画像', apiSize: '1536x1024', targetWidth: 1200, targetHeight: 795, aspectRatio: '1.51:1' },
  { key: 'line_rich_menu_large', group: 'line', label: 'リッチメニュー（大）', note: '2500×1686。トーク画面の下に常時表示されるメニュー', apiSize: '1536x1024', targetWidth: 2500, targetHeight: 1686, aspectRatio: '3:2' },
  { key: 'line_rich_menu_small', group: 'line', label: 'リッチメニュー（小）', note: '2500×843。高さが半分のメニュー', apiSize: '1536x1024', targetWidth: 2500, targetHeight: 843, aspectRatio: '3:1' },
  { key: 'line_voom_square', group: 'line', label: 'LINE VOOM（正方形）', note: '1080×1080。VOOM の投稿画像', apiSize: '1024x1024', targetWidth: 1080, targetHeight: 1080, aspectRatio: '1:1' },
  { key: 'line_voom_vertical', group: 'line', label: 'LINE VOOM（縦長）', note: '1080×1920。縦いっぱいの投稿', apiSize: '1024x1536', targetWidth: 1080, targetHeight: 1920, aspectRatio: '9:16' },
  { key: 'sns_instagram_feed', group: 'sns', label: 'Instagram フィード（正方形）', note: '1080×1080', apiSize: '1024x1024', targetWidth: 1080, targetHeight: 1080, aspectRatio: '1:1' },
  { key: 'sns_instagram_portrait', group: 'sns', label: 'Instagram フィード（縦長）', note: '1080×1350（4:5）', apiSize: '1024x1536', targetWidth: 1080, targetHeight: 1350, aspectRatio: '4:5' },
  { key: 'sns_story', group: 'sns', label: 'ストーリー・リール・TikTok', note: '1080×1920（9:16）', apiSize: '1024x1536', targetWidth: 1080, targetHeight: 1920, aspectRatio: '9:16' },
  { key: 'sns_x_post', group: 'sns', label: 'X（旧Twitter）投稿', note: '1200×675（16:9）', apiSize: '1536x1024', targetWidth: 1200, targetHeight: 675, aspectRatio: '16:9' },
  { key: 'sns_ogp', group: 'sns', label: 'OGP・Facebook リンク画像', note: '1200×630（1.91:1）。リンクを共有したときに出る画像', apiSize: '1536x1024', targetWidth: 1200, targetHeight: 630, aspectRatio: '1.91:1' },
  { key: 'sns_youtube_thumbnail', group: 'sns', label: 'YouTube サムネイル', note: '1280×720（16:9）', apiSize: '1536x1024', targetWidth: 1280, targetHeight: 720, aspectRatio: '16:9' },
]

/** 統括バナー生成の利用状況。本物は `usageSnapshot` の形。絵（B9ZAr）の数：今月 40/150・今日 6/30。 */
export const HQ_BANNER_USAGE = {
  month: { used: 40, limit: 150, remaining: 110 },
  today: { used: 6, limit: 30, remaining: 24 },
  paused: false,
  blocked: false,
  blockedReason: null,
  planState: 'active',
  pausedReason: null,
}

/** 統括バナー生成の集計。本物は `getBannerStats` の形。絵（B9ZAr）：5件・アーカイブ1・渡した9枚・3アカウント。 */
export const HQ_BANNER_STATS = {
  projects: { active: 5, archived: 1 },
  deliveredImages: 9,
  deliveredAccounts: 3,
}

/** 統括バナーのプロジェクト。本物は `serializeProject` の形。並びと文言は絵（B9ZAr）。 */
export const HQ_BANNER_PROJECTS = [
  {
    id: 'banner-project-qa-1', name: '秋のキャンペーン', description: '一斉配信の上の写真・10月',
    isFavorite: true, archivedAt: null, imageCount: 8, runningCount: 0,
    createdBy: '見本 16', createdAt: '2026-09-01T09:00:00+09:00', updatedAt: '2026-09-30T10:12:00+09:00',
  },
  {
    id: 'banner-project-qa-2', name: 'リッチメニューの秋', description: '2500×1686・6分割',
    isFavorite: true, archivedAt: null, imageCount: 4, runningCount: 0,
    createdBy: '見本 111', createdAt: '2026-09-03T09:00:00+09:00', updatedAt: '2026-09-28T10:00:00+09:00',
  },
  {
    id: 'banner-project-qa-3', name: '2周年 春の感謝祭', description: 'バナー・リッチメッセージ',
    isFavorite: false, archivedAt: null, imageCount: 0, runningCount: 1,
    createdBy: '見本 16', createdAt: '2026-09-27T09:00:00+09:00', updatedAt: '2026-09-27T09:00:00+09:00',
  },
  {
    id: 'banner-project-qa-4', name: '定期便のご案内', description: 'LINE のカード 1040×1040',
    isFavorite: false, archivedAt: null, imageCount: 6, runningCount: 0,
    createdBy: '見本 111', createdAt: '2026-09-05T09:00:00+09:00', updatedAt: '2026-09-12T10:00:00+09:00',
  },
  {
    id: 'banner-project-qa-5', name: '新商品 鹿肉ふりかけ', description: '商品写真の加工',
    isFavorite: false, archivedAt: null, imageCount: 3, runningCount: 0,
    createdBy: '見本 16', createdAt: '2026-08-28T09:00:00+09:00', updatedAt: '2026-09-02T10:00:00+09:00',
  },
]

/** アーカイブしたプロジェクト（絵 AnwtH の後ろの一覧）。 */
export const HQ_BANNER_ARCHIVED_PROJECTS = [
  {
    id: 'banner-project-qa-6', name: 'お盆休みのお知らせ', description: 'アーカイブ済み',
    isFavorite: false, archivedAt: '2026-08-20T10:00:00+09:00', imageCount: 2, runningCount: 0,
    createdBy: '見本 111', createdAt: '2026-08-01T09:00:00+09:00', updatedAt: '2026-08-10T10:00:00+09:00',
  },
]

/** 秋のキャンペーンの生成の条件（絵 rI5uh の「生成時の条件」）。 */
const HQ_BANNER_GENERATION_1 = {
  id: 'banner-generation-qa-1', projectId: 'banner-project-qa-1', status: 'done', mode: 'banner',
  presetKey: 'line_rich_message', aspectRatio: '1:1', apiSize: '1024x1024', quality: 'medium',
  textLines: ['秋の新商品、はじまりました', '10/31 まで 送料無料'], emphasisLines: [false, false],
  baseColor: null, mainColor: '#8B5A2B', subColor: '#F3E9DC', accentColor: null,
  personOption: 'without', customPrompt: '木のテーブル、湯気を少し強めに。文字は大きく読みやすく', freePrompt: null,
  finalPrompt: '', engine: 'openai', modelName: 'gpt-image-1', requestedCount: 4, doneCount: 4, failedCount: 0,
  unitsPerImage: 1, errorMessage: null, references: [{ imageId: 'banner-image-qa-12', mode: 'inspire' }],
  createdBy: '見本 16', createdAt: '2026-09-30T10:12:00+09:00', startedAt: '2026-09-30T10:12:00+09:00', finishedAt: '2026-09-30T10:14:00+09:00',
}

const bannerGeneration = (id, projectId, presetKey, aspectRatio, apiSize, textLines) => ({
  ...HQ_BANNER_GENERATION_1, id, projectId, presetKey, aspectRatio, apiSize, textLines,
  emphasisLines: textLines.map(() => false), references: null,
})

const BANNER_GEN_CARD = bannerGeneration('banner-generation-qa-2', 'banner-project-qa-1', 'line_card', '3:2', '1536x1024', ['秋の鹿肉コース'])
const BANNER_GEN_MENU = bannerGeneration('banner-generation-qa-3', 'banner-project-qa-2', 'line_rich_menu_large', '3:2', '1536x1024', ['秋のメニュー'])
const BANNER_GEN_TEIKI = bannerGeneration('banner-generation-qa-4', 'banner-project-qa-4', 'line_rich_message', '1:1', '1024x1024', ['定期便のご案内'])
const BANNER_GEN_INSTA = bannerGeneration('banner-generation-qa-5', 'banner-project-qa-5', 'sns_instagram_portrait', '4:5', '1024x1536', ['鹿肉ふりかけ'])
const BANNER_GEN_STORY = bannerGeneration('banner-generation-qa-6', 'banner-project-qa-5', 'sns_story', '9:16', '1024x1536', ['鹿肉ふりかけ'])
const BANNER_GEN_MIKAKU = bannerGeneration('banner-generation-qa-7', 'banner-project-qa-1', 'line_rich_message', '1:1', '1024x1024', ['秋の味覚'])

const bannerImage = (n, projectId, generation, { favorite = false, delivered = [], minutesAgo = n * 10 } = {}) => {
  const created = new Date(Date.parse('2026-09-30T10:12:00+09:00') - minutesAgo * 60000).toISOString()
  const [w, h] = generation?.apiSize?.split('x').map(Number) ?? [1040, 1040]
  return {
    id: `banner-image-qa-${n}`, projectId, generationId: generation?.id ?? null,
    sequence: n, source: generation ? 'generated' : 'upload', parentImageId: null, isFavorite: favorite,
    createdBy: '見本 16', createdAt: created,
    media: { id: `banner-media-qa-${n}`, filename: `banner-${n}.png`, mimeType: 'image/png', sizeBytes: 184320, width: w, height: h, url: mediaPreview(n % 2 ? '#f3e9dc' : '#e7f7ef') },
    generation,
    deliveredAccountIds: delivered,
  }
}

const DELIVERED = ['visual-qa-account-prod', 'visual-qa-account-old']

/**
 * 統括バナーの画像。本物は `serializeImage` の形。新しい順。
 * 先頭12枚が絵 W5Wxr の画像ライブラリ、秋のキャンペーンの8枚が絵 iMnph の一覧。
 * 全部で23枚・お気に入り3・渡し済み9・未使用14（絵の「見る」の数）。
 */
export const HQ_BANNER_IMAGES = [
  bannerImage(1, 'banner-project-qa-1', HQ_BANNER_GENERATION_1, { favorite: true, delivered: DELIVERED }),
  bannerImage(2, 'banner-project-qa-1', HQ_BANNER_GENERATION_1, { delivered: DELIVERED }),
  bannerImage(3, 'banner-project-qa-1', { ...HQ_BANNER_GENERATION_1, textLines: ['10/31 まで 送料無料'] }),
  bannerImage(4, 'banner-project-qa-1', HQ_BANNER_GENERATION_1, { favorite: true, delivered: DELIVERED }),
  bannerImage(5, 'banner-project-qa-2', BANNER_GEN_MENU, { favorite: true, delivered: DELIVERED }),
  bannerImage(6, 'banner-project-qa-2', BANNER_GEN_MENU, { delivered: DELIVERED }),
  bannerImage(7, 'banner-project-qa-4', BANNER_GEN_TEIKI, { delivered: DELIVERED }),
  bannerImage(8, 'banner-project-qa-4', BANNER_GEN_TEIKI),
  bannerImage(9, 'banner-project-qa-5', BANNER_GEN_INSTA),
  bannerImage(10, 'banner-project-qa-5', BANNER_GEN_STORY),
  bannerImage(11, 'banner-project-qa-1', BANNER_GEN_CARD),
  bannerImage(12, 'banner-project-qa-1', BANNER_GEN_MIKAKU),
  bannerImage(13, 'banner-project-qa-1', BANNER_GEN_CARD),
  bannerImage(14, 'banner-project-qa-1', BANNER_GEN_CARD),
  bannerImage(15, 'banner-project-qa-2', BANNER_GEN_MENU, { delivered: DELIVERED }),
  bannerImage(16, 'banner-project-qa-2', BANNER_GEN_MENU),
  bannerImage(17, 'banner-project-qa-4', BANNER_GEN_TEIKI, { delivered: DELIVERED }),
  bannerImage(18, 'banner-project-qa-4', BANNER_GEN_TEIKI, { delivered: DELIVERED }),
  bannerImage(19, 'banner-project-qa-4', BANNER_GEN_TEIKI),
  bannerImage(20, 'banner-project-qa-4', BANNER_GEN_TEIKI),
  bannerImage(21, 'banner-project-qa-5', BANNER_GEN_INSTA),
  bannerImage(22, 'banner-project-qa-6', null),
  bannerImage(23, 'banner-project-qa-6', null),
]

/** 画像ライブラリの「見る」の数。本物は `withCounts=1` で返る。 */
export const HQ_BANNER_IMAGE_COUNTS = {
  all: HQ_BANNER_IMAGES.length,
  favorite: HQ_BANNER_IMAGES.filter((i) => i.isFavorite).length,
  delivered: HQ_BANNER_IMAGES.filter((i) => i.deliveredAccountIds.length > 0).length,
  unused: HQ_BANNER_IMAGES.filter((i) => i.deliveredAccountIds.length === 0).length,
}

/** 然-NEN- 会員のランク設定。本物は `settingsResponse` の形。 */
export const NEN_RANK_SETTINGS = {
  ranks: [
    { id: 'nen-rank-platinum', key: 'platinum', name: 'プラチナ', annualThresholdYen: 200000, mileRatePercent: 3, tagId: 'tag-nen-platinum', tagName: '会員ランク：プラチナ', memberCount: 1 },
    { id: 'nen-rank-gold', key: 'gold', name: 'ゴールド', annualThresholdYen: 50000, mileRatePercent: 2, tagId: 'tag-nen-gold', tagName: '会員ランク：ゴールド', memberCount: 3 },
    { id: 'nen-rank-silver', key: 'silver', name: 'シルバー', annualThresholdYen: 20000, mileRatePercent: 1.5, tagId: 'tag-nen-silver', tagName: '会員ランク：シルバー', memberCount: 2 },
    { id: 'nen-rank-bronze', key: 'bronze', name: 'ブロンズ', annualThresholdYen: 0, mileRatePercent: 1, tagId: 'tag-nen-bronze', tagName: '会員ランク：ブロンズ', memberCount: 6 },
  ],
  rules: {
    yearStartMonth: 1, applyOnReach: 'immediate', keepUntil: 'next_year_end', countOrders: 'paid',
    version: 3, syncStatus: 'synced', syncError: null,
    /* 板 fb9NJ・e5yBLx・dEv6G の「最後に送った日時 9/30 10:12」。 */
    syncedAt: '2026-09-30T10:12:00+09:00', updatedAt: '2026-09-30T10:12:00+09:00',
  },
  /* 板 `zQ5vY`（ライフタイム）の節目の3行。称号・特典・到達人数を絵に合わせる。
   * `最上位` の小さい札は今の画面に無い（画面担当へ）。 */
  milestones: [
    { id: 'nen-milestone-1', thresholdYen: 50000, title: 'なかよし', benefitKind: null, benefitNote: '送料無料クーポン 1 枚', notifyOnReach: true, reachedCount: 5 },
    { id: 'nen-milestone-2', thresholdYen: 100000, title: 'だいすき', benefitKind: null, benefitNote: '鹿肉ジャーキー 1 袋', notifyOnReach: true, reachedCount: 2 },
    { id: 'nen-milestone-3', thresholdYen: 300000, title: 'ずっといっしょ', benefitKind: null, benefitNote: '限定グッズ（決まり次第ここで設定）', notifyOnReach: true, reachedCount: 1 },
  ],
  kpis: { members: 12, annualTotalYen: 1840000, lifetimeTotalYen: 772800, balanceTotal: 48200, usedThisMonth: 3200, byRank: { platinum: 1, gold: 3, silver: 2, bronze: 6 }, linkedMembers: 9, petMembers: 8, monthPurchaseYen: 186400, monthBuyers: 7 },
}

/** 然-NEN- 会員の一覧。本物は `GET /api/nen/members` の形。 */
export const NEN_MEMBER_LIST = {
  items: [
    {
      friendId: 'friend-1', name: '見本 169', pictureUrl: null, customerId: '10234',
      rankKey: 'platinum', rankName: 'プラチナ', mileRatePercent: 3,
      annualMilesYen: 82400, lifetimeMilesYen: 312000, mileBalance: 1240,
      rankValidUntil: '2026-12-31', lastPurchasedAt: '2026-09-28T10:00:00+09:00', purchaseCount: 14,
      petCount: 2, petNames: 'こむぎ・ハナ', syncedAt: '2026-09-07T09:00:00+09:00',
    },
    {
      friendId: 'friend-2', name: '見本 114', pictureUrl: null, customerId: '10198',
      rankKey: 'gold', rankName: 'ゴールド', mileRatePercent: 2,
      annualMilesYen: 56100, lifetimeMilesYen: 148300, mileBalance: 860,
      rankValidUntil: '2026-12-31', lastPurchasedAt: '2026-09-21T10:00:00+09:00', purchaseCount: 9,
      petCount: 2, petNames: 'そら・ピヨ', syncedAt: '2026-09-07T09:00:00+09:00',
    },
    {
      friendId: 'friend-3', name: '見本 182', pictureUrl: null, customerId: '10311',
      rankKey: 'silver', rankName: 'シルバー', mileRatePercent: 1.5,
      annualMilesYen: 31800, lifetimeMilesYen: 64500, mileBalance: 420,
      rankValidUntil: '2026-12-31', lastPurchasedAt: '2026-09-30T10:00:00+09:00', purchaseCount: 6,
      petCount: 2, petNames: 'もも・ちび', syncedAt: '2026-09-07T09:00:00+09:00',
    },
    {
      friendId: 'friend-4', name: '見本 141', pictureUrl: null, customerId: '10288',
      rankKey: 'gold', rankName: 'ゴールド', mileRatePercent: 2,
      annualMilesYen: 52000, lifetimeMilesYen: 98000, mileBalance: 640,
      rankValidUntil: '2026-12-31', lastPurchasedAt: '2026-09-12T10:00:00+09:00', purchaseCount: 8,
      petCount: 0, petNames: null, syncedAt: '2026-09-07T09:00:00+09:00',
    },
    {
      friendId: 'friend-5', name: '見本 25', pictureUrl: null, customerId: '10301',
      rankKey: 'gold', rankName: 'ゴールド', mileRatePercent: 2,
      annualMilesYen: 50400, lifetimeMilesYen: 76200, mileBalance: 510,
      rankValidUntil: '2026-12-31', lastPurchasedAt: '2026-09-18T10:00:00+09:00', purchaseCount: 7,
      petCount: 1, petNames: 'レオ', syncedAt: '2026-09-07T09:00:00+09:00',
    },
    {
      friendId: 'friend-6', name: '見本 27', pictureUrl: null, customerId: '10340',
      rankKey: 'silver', rankName: 'シルバー', mileRatePercent: 1.5,
      annualMilesYen: 28700, lifetimeMilesYen: 41900, mileBalance: 300,
      rankValidUntil: '2026-12-31', lastPurchasedAt: '2026-08-30T10:00:00+09:00', purchaseCount: 5,
      petCount: 1, petNames: 'くう', syncedAt: '2026-09-07T09:00:00+09:00',
    },
    {
      friendId: 'friend-7', name: '見本 34', pictureUrl: null, customerId: null,
      rankKey: 'bronze', rankName: 'ブロンズ', mileRatePercent: 1,
      annualMilesYen: 12000, lifetimeMilesYen: 12000, mileBalance: 0,
      rankValidUntil: '2026-12-31', lastPurchasedAt: '2026-09-25T10:00:00+09:00', purchaseCount: 2,
      petCount: 1, petNames: 'ラッキー', syncedAt: '2026-09-07T09:00:00+09:00',
    },
    {
      friendId: 'friend-8', name: '見本 33', pictureUrl: null, customerId: '10455',
      rankKey: 'bronze', rankName: 'ブロンズ', mileRatePercent: 1,
      annualMilesYen: 8900, lifetimeMilesYen: 8900, mileBalance: 90,
      rankValidUntil: '2026-12-31', lastPurchasedAt: '2026-09-02T10:00:00+09:00', purchaseCount: 1,
      petCount: 1, petNames: 'まる', syncedAt: '2026-09-07T09:00:00+09:00',
    },
    {
      friendId: 'friend-9', name: '見本 39', pictureUrl: null, customerId: null,
      rankKey: 'bronze', rankName: 'ブロンズ', mileRatePercent: 1,
      annualMilesYen: 6200, lifetimeMilesYen: 6200, mileBalance: 0,
      rankValidUntil: '2026-12-31', lastPurchasedAt: '2026-08-18T10:00:00+09:00', purchaseCount: 1,
      petCount: 0, petNames: null, syncedAt: '2026-09-07T09:00:00+09:00',
    },
    {
      friendId: 'friend-10', name: '見本 14', pictureUrl: null, customerId: '10470',
      rankKey: 'bronze', rankName: 'ブロンズ', mileRatePercent: 1,
      annualMilesYen: 4800, lifetimeMilesYen: 4800, mileBalance: 48,
      rankValidUntil: '2026-12-31', lastPurchasedAt: '2026-09-27T10:00:00+09:00', purchaseCount: 1,
      petCount: 1, petNames: 'ココ', syncedAt: '2026-09-07T09:00:00+09:00',
    },
  ],
  total: 12,
  page: 1,
  pageSize: 10,
  kpis: { members: 12, annualTotalYen: 1840000, lifetimeTotalYen: 5620000, balanceTotal: 48200, usedThisMonth: 3200, byRank: { platinum: 1, gold: 3, silver: 2, bronze: 6 }, linkedMembers: 9, petMembers: 8, monthPurchaseYen: 186400, monthBuyers: 7 },
  ranks: [
    { key: 'platinum', name: 'プラチナ', annualThresholdYen: 200000, mileRatePercent: 3 },
    { key: 'gold', name: 'ゴールド', annualThresholdYen: 50000, mileRatePercent: 2 },
    { key: 'silver', name: 'シルバー', annualThresholdYen: 20000, mileRatePercent: 1.5 },
    { key: 'bronze', name: 'ブロンズ', annualThresholdYen: 0, mileRatePercent: 1 },
  ],
}

/**
 * 然-NEN- マイペットの一覧。本物は `GET /api/nen/pets` の形。
 * ★V8-B 板 wTIej・t2SMXX・eLjeQ（マイペット）の絵の8匹（犬4・猫3・その他1）に合わせた。
 */
const nenPet = (id, name, callName, gender, animalType, breed, birthday, ageLabel, weightKg, neutered, activityLevel, activityLabel, productName, feeding, weightUpdatedAt, weightStale, owner) => ({
  id, name, callName, gender, animalType, breed, birthday, ageLabel, weightKg, neutered, activityLevel, activityLabel, productName, feeding,
  imageUrl: null, updatedAt: weightUpdatedAt, weightUpdatedAt, weightStale, owner,
})
const nenOwner = (friendId, name, customerId) => ({ friendId, name, pictureUrl: null, customerId })
export const NEN_PET_LIST = {
  items: [
    nenPet('nen-pet-komugi', 'こむぎ', 'こむぎちゃん', 'female', 'dog', '柴', '2022-04-03', '4歳', 9.2, 'yes', 'normal', 'ふつう', 'ドライフード（成犬）',
      { dailyKcal: 560, dailyGrams: 128, factorLabel: '避妊・去勢済み', stageLabel: '成犬', venisonGrams: 12, venisonKcal: 56, treatName: '然 鹿肉ジャーキー' },
      '2026-09-28T10:00:00+09:00', false, nenOwner('friend-3', '見本 169', '10234')),
    nenPet('nen-pet-sora', 'そら', 'そらくん', 'male', 'cat', '雑種', '2019-05-10', '7歳', 4.8, 'yes', 'low', '少なめ', 'ドライフード（成猫）',
      { dailyKcal: 230, dailyGrams: 62, factorLabel: '避妊・去勢済み', stageLabel: '成猫', venisonGrams: 5, venisonKcal: 23, treatName: '然 鹿肉ジャーキー' },
      '2026-09-20T10:00:00+09:00', false, nenOwner('friend-2', '見本 114', '10198')),
    nenPet('nen-pet-momo', 'もも', 'ももちゃん', 'female', 'dog', 'トイプードル', '2024-09-02', '2歳', 3.1, 'no', 'high', '多め', 'ドライフード（成犬）',
      { dailyKcal: 250, dailyGrams: 58, factorLabel: 'していない', stageLabel: '成犬', venisonGrams: null, venisonKcal: 0, treatName: null },
      '2026-09-30T10:00:00+09:00', false, nenOwner('friend-1', '見本 182', '10311')),
    nenPet('nen-pet-lucky', 'ラッキー', 'ラッキーくん', 'male', 'dog', 'ゴールデン', '2020-06-21', '6歳', 29.8, 'yes', 'high', '多め', 'ドライフード（成犬）',
      { dailyKcal: 1280, dailyGrams: 340, factorLabel: '避妊・去勢済み', stageLabel: '成犬', venisonGrams: 30, venisonKcal: 128, treatName: '然 鹿肉ジャーキー' },
      '2026-09-25T10:00:00+09:00', false, nenOwner('friend-4', '見本 34', null)),
    nenPet('nen-pet-hana', 'ハナ', 'ハナちゃん', 'female', 'cat', '雑種', '2017-02-14', '9歳', 4.1, 'yes', 'normal', 'ふつう', 'ドライフード（成猫）',
      { dailyKcal: 210, dailyGrams: 55, factorLabel: '避妊・去勢済み', stageLabel: 'シニア', venisonGrams: null, venisonKcal: 0, treatName: null },
      '2026-06-12T10:00:00+09:00', true, nenOwner('friend-3', '見本 169', '10234')),
    nenPet('nen-pet-maru', 'まる', 'まるくん', 'male', 'dog', 'ミックス', '2015-03-01', '11歳', 12.4, 'yes', 'low', '少なめ', null,
      { dailyKcal: 610, dailyGrams: null, factorLabel: '避妊・去勢済み', stageLabel: 'シニア', venisonGrams: null, venisonKcal: 0, treatName: null },
      '2026-05-30T10:00:00+09:00', true, nenOwner('friend-5', '見本 33', '10455')),
    nenPet('nen-pet-chibi', 'ちび', 'ちびくん', 'male', 'cat', 'スコティッシュ', '2025-07-07', '1歳', null, 'no', 'normal', 'ふつう', null,
      null, '', false, nenOwner('friend-1', '見本 182', '10311')),
    nenPet('nen-pet-piyo', 'ピヨ', 'ピヨちゃん', 'unknown', 'other', 'セキセイインコ', '2023-08-01', '3歳', 0.04, 'unknown', 'normal', 'ふつう', null,
      null, '2026-09-01T10:00:00+09:00', false, nenOwner('friend-2', '見本 114', '10198')),
  ],
  total: 8,
  page: 1,
  pageSize: 10,
  kpis: { total: 8, dogs: 4, cats: 3, newThisMonth: 2, computable: 5, staleWeight: 2 },
  products: [
    { id: 'feeding-staple-1', name: 'ドライフード（成犬・成猫用／総合栄養食）' },
    { id: 'feeding-staple-2', name: 'ドライフード（シニア用）' },
    { id: 'feeding-staple-3', name: 'ウェットフード' },
    { id: 'feeding-staple-4', name: '手作り（目安）' },
  ],
  treatLimitPercent: 10,
}

/** 然-NEN- ごはんの目安（主食と然の商品）。本物は `GET /api/nen/feeding-products` の形。板 h7A2F。 */
export const NEN_FEEDING_PRODUCTS = {
  products: [
    { id: 'feeding-staple-1', name: 'ドライフード（成犬・成猫用／総合栄養食）', kcalPer100g: 380, isDefault: true, kind: 'staple' },
    { id: 'feeding-staple-2', name: 'ドライフード（シニア用）', kcalPer100g: 340, isDefault: false, kind: 'staple' },
    { id: 'feeding-staple-3', name: 'ウェットフード', kcalPer100g: 90, isDefault: false, kind: 'staple' },
    { id: 'feeding-staple-4', name: '手作り（目安）', kcalPer100g: 150, isDefault: false, kind: 'staple' },
    { id: 'feeding-nen-1', name: '然 鹿肉ジャーキー', kcalPer100g: 330, isDefault: true, kind: 'nen' },
    { id: 'feeding-nen-2', name: '然 鹿肉ふりかけ', kcalPer100g: 360, isDefault: false, kind: 'nen' },
  ],
  treatLimitPercent: 10,
  petCount: 8,
}

/**
 * 然-NEN- 健康日記の一覧。本物は `GET /api/nen/health` の形。
 * ★V8-B 板 mIwA4・BVuYh・z2tvtX（健康日記）の絵の6匹に合わせた。
 */
const nenHealthRow = (pet, owner, lastLoggedOn, lastLoggedLabel, daysSinceLast, count30d, weightSeries, latestStool, latestAppetite, changes) => ({
  pet, owner, lastLoggedOn, lastLoggedLabel, daysSinceLast, count30d, totalRecords: count30d * 3,
  weightSeries, latestWeightKg: weightSeries.filter((v) => v != null).at(-1) ?? null,
  weightChangePercent: null, latestStool, latestAppetite, changes,
  concerning: changes.some((change) => change.tone === 'warn'),
})
const nenHealthPet = (id, name, callName, animalType, breed, ageLabel) => ({ id, name, callName, animalType, breed, ageLabel, imageUrl: null })
export const NEN_HEALTH_LIST = {
  items: [
    nenHealthRow(nenHealthPet('nen-pet-komugi', 'こむぎ', 'こむぎちゃん', 'dog', '柴', '4歳'), { friendId: 'friend-3', name: '見本 169', customerId: '10234' },
      '2026-09-30', '7日前', 7, 28, [9.8, 9.7, 9.7, 9.6, 9.5, 9.4, 9.3, 9.2], '良い', 'ふつう',
      [{ key: 'weight_drop', label: '体重 −6%（8週）', tone: 'warn' }]),
    nenHealthRow(nenHealthPet('nen-pet-sora', 'そら', 'そらくん', 'cat', '雑種', '7歳'), { friendId: 'friend-2', name: '見本 114', customerId: '10198' },
      '2026-09-29', '8日前', 8, 25, [4.8, 4.8, 4.9, 4.8, 4.8, 4.8, 4.8, 4.8], 'ふつう', '不良',
      [{ key: 'appetite_poor', label: '食いつき不良が3回続く', tone: 'warn' }]),
    nenHealthRow(nenHealthPet('nen-pet-momo', 'もも', 'ももちゃん', 'dog', 'トイプードル', '2歳'), { friendId: 'friend-1', name: '見本 182', customerId: '10311' },
      '2026-09-30', '7日前', 7, 30, [3.1, 3.1, 3.0, 3.1, 3.1, 3.1, 3.1, 3.1], '良い', '良い', []),
    nenHealthRow(nenHealthPet('nen-pet-maru', 'まる', 'まるくん', 'dog', 'ミックス', '11歳'), { friendId: 'friend-5', name: '見本 33', customerId: '10455' },
      '2026-09-28', '9日前', 9, 22, [12.4, 12.4, 12.4, 12.4, 12.4, 12.4, 12.4, 12.4], 'ふつう', 'ふつう', []),
    nenHealthRow(nenHealthPet('nen-pet-chibi', 'ちび', 'ちびくん', 'cat', 'スコティッシュ', '1歳'), { friendId: 'friend-1', name: '見本 182', customerId: '10311' },
      '2026-08-20', '08/20', 48, 0, [null, null, null, null, null, null, null, null], null, null,
      [{ key: 'silent', label: '30日以上 記録なし', tone: 'faint' }]),
    nenHealthRow(nenHealthPet('nen-pet-hana', 'ハナ', 'ハナちゃん', 'cat', '雑種', '9歳'), { friendId: 'friend-3', name: '見本 169', customerId: '10234' },
      '2026-08-26', '08/26', 42, 0, [null, null, null, null, null, null, null, null], null, null,
      [{ key: 'silent', label: '30日以上 記録なし', tone: 'faint' }]),
  ],
  total: 6,
  page: 1,
  pageSize: 10,
  kpis: { recordsThisWeek: 38, petsWithRecords: 6, petsTotal: 8, concerning: 2, silent30: 2 },
}

/**
 * 然-NEN- 健康日記 30日のまとめ。本物は `GET /api/nen/health/:petId/summary` の形。
 * 板 BVuYh（こむぎ）の絵の記録。ほかのペットは一覧の値から組み立てる（mock-api）。
 */
export const NEN_HEALTH_SUMMARY_KOMUGI = {
  pet: { id: 'nen-pet-komugi', name: 'こむぎ', callName: 'こむぎちゃん', animalType: 'dog', breed: '柴', ageLabel: '4歳', weightKg: 9.2 },
  owner: { friendId: 'friend-3', name: '見本 169' },
  generatedAt: '2026-09-30T10:00:00+09:00',
  summary: {
    days: 30,
    records: 28,
    weight: { first: 9.8, last: 9.2, min: 9.2, max: 9.8 },
    heartRateAvg: 96,
    respiratoryRateAvg: 24,
    stool: { normal: 24, soft: 4 },
    appetite: { good: 10, normal: 18 },
    skin: { normal: 27, itchy: 1 },
    tearStain: { normal: 27, mild: 1 },
    notes: [
      { loggedOn: '2026-09-30', note: '散歩を短めにした' },
      { loggedOn: '2026-09-26', note: '耳をかいていた' },
      { loggedOn: '2026-09-18', note: 'トリミング' },
    ],
    logs: [
      { loggedOn: '2026-09-30', weightKg: 9.2, heartRateBpm: 96, respiratoryRateBpm: 24, stool: 'normal', appetite: 'normal', skin: 'normal', tearStain: 'normal' },
      { loggedOn: '2026-09-28', weightKg: 9.2, heartRateBpm: 98, respiratoryRateBpm: 24, stool: 'normal', appetite: 'normal', skin: 'normal', tearStain: 'normal' },
      { loggedOn: '2026-09-26', weightKg: 9.3, heartRateBpm: 95, respiratoryRateBpm: 23, stool: 'soft', appetite: 'normal', skin: 'itchy', tearStain: 'normal' },
      { loggedOn: '2026-09-24', weightKg: 9.3, heartRateBpm: 96, respiratoryRateBpm: 24, stool: 'normal', appetite: 'normal', skin: 'normal', tearStain: 'normal' },
      { loggedOn: '2026-09-21', weightKg: 9.4, heartRateBpm: 97, respiratoryRateBpm: 25, stool: 'normal', appetite: 'good', skin: 'normal', tearStain: 'mild' },
      { loggedOn: '2026-09-18', weightKg: 9.4, heartRateBpm: 95, respiratoryRateBpm: 24, stool: 'normal', appetite: 'good', skin: 'normal', tearStain: 'normal' },
    ],
  },
  labels: {
    stool: { normal: '問題なし', soft: '少し気になる', hard: 'かたい', diarrhea: '下痢', bloody: '血が混じる', other: 'その他' },
    appetite: { good: '良い', normal: 'ふつう', poor: '不良' },
  },
}

/** 友だち追加時配信の実行詳細。本物は `GET /api/friend-add-runs/:id` の形。 */
export const FRIEND_ADD_RUN_DETAIL = {
  id: 'friend-add-run-1', receivedAt: '2026-09-07T01:32:00.000Z', processedAt: '2026-09-07T01:32:00.800Z',
  friend: { id: 'visual-friend-add-1', displayName: 'Demo Person' }, friendKind: 'first_time',
  attribution: { status: 'captured', routeId: 'route-shop', routeName: '店頭QR', reason: 'store-qr' },
  rule: { id: 'rule-shop', name: '店頭QRの初回案内', versionId: 'rule-shop-v1', versionNumber: 1 },
  configuredActions: [],
  actionRuns: [
    {
      id: 'friend-add-action-run-1', stableId: 'action-welcome', type: 'send_message', status: 'completed',
      attemptCount: 1, nextRetryAt: null, errorCode: null,
      startedAt: '2026-09-07T01:32:00.100Z', completedAt: '2026-09-07T01:32:00.500Z', updatedAt: '2026-09-07T01:32:00.500Z',
    },
    {
      id: 'friend-add-action-run-2', stableId: 'action-tag', type: 'add_tag', status: 'completed',
      attemptCount: 1, nextRetryAt: null, errorCode: null,
      startedAt: '2026-09-07T01:32:00.500Z', completedAt: '2026-09-07T01:32:00.800Z', updatedAt: '2026-09-07T01:32:00.800Z',
    },
  ],
  status: 'completed',
  errorCode: null,
}

/** 実行の詳細（失敗あり）。絵 N43uVX：案内は届き、タグは付いたが、シナリオを始めるところで止まった。 */
export const FRIEND_ADD_RUN_DETAIL_FAILED = {
  id: 'friend-add-run-4', receivedAt: '2026-09-07T01:14:01.000Z', processedAt: '2026-09-07T01:14:02.000Z',
  friend: { id: 'visual-friend-add-4', displayName: '見本 141', redacted: false }, friendKind: 'first_time',
  attribution: { status: 'unavailable', routeId: null, routeName: null, reason: null },
  rule: {
    id: 'rule-fallback', name: '経路が分からなかった人', versionId: 'rule-fallback-v1', versionNumber: 1,
    definition: {
      routeIds: [], scenarioId: 'scenario-common', messageType: 'text', messageText: 'ご登録ありがとうございます', timing: 'immediate',
      actions: [
        { type: 'add_tag', label: 'タグ「経路が分からない」を付ける', targetId: 'tag-unknown-route' },
        { type: 'start_scenario', label: 'シナリオ「共通のあいさつ」を始める', targetId: 'scenario-common' },
      ],
      friendCondition: '', activeFrom: null, activeUntil: null,
    },
  },
  configuredActions: [
    { type: 'add_tag', label: 'タグ「経路が分からない」を付ける', targetId: 'tag-unknown-route' },
    { type: 'start_scenario', label: 'シナリオ「共通のあいさつ」を始める', targetId: 'scenario-common' },
  ],
  actionRuns: [
    {
      id: 'friend-add-action-run-4a', stableId: 'rule-fallback-v1:0', type: 'tag', status: 'completed',
      attemptCount: 1, nextRetryAt: null, errorCode: null,
      startedAt: '2026-09-07T01:14:02.000Z', completedAt: '2026-09-07T01:14:02.000Z', updatedAt: '2026-09-07T01:14:02.000Z',
    },
    {
      id: 'friend-add-action-run-4b', stableId: 'rule-fallback-v1:1', type: 'scenario', status: 'failed',
      attemptCount: 1, nextRetryAt: null, errorCode: 'action_failed',
      startedAt: '2026-09-07T01:14:02.000Z', completedAt: null, updatedAt: '2026-09-07T01:14:02.000Z',
    },
  ],
  status: 'failed',
  errorCode: 'action_failed',
}

/** 緊急停止の送信経路の台帳。本物は `GET /api/operations/send-paths` の形。 */
export const OPERATION_SEND_PATHS = {
  evaluatedAt: '2026-09-07T10:00:00+09:00',
  capabilities: [
    'broadcast_dispatch', 'scenario_dispatch', 'reminder_dispatch', 'automation_actions',
    'auto_reply_dispatch', 'webhook_outgoing', 'ad_postback',
  ],
  problems: [],
  paths: [
    { id: 'broadcast-send', label: '一斉配信（予約・今すぐ送信・分割送信）', kind: 'scheduled', capability: 'broadcast_dispatch', state: 'running', excludedReason: null, note: '束と束のあいだで止まる。' },
    { id: 'scenario-send', label: 'シナリオ配信', kind: 'scheduled', capability: 'scenario_dispatch', state: 'running', excludedReason: null, note: null },
    { id: 'reminder-send', label: 'リマインダ配信', kind: 'scheduled', capability: 'reminder_dispatch', state: 'running', excludedReason: null, note: null },
    { id: 'automation-actions', label: '自動化の処理', kind: 'auto', capability: 'automation_actions', state: 'running', excludedReason: null, note: null },
    { id: 'auto-reply-send', label: '自動応答の送信', kind: 'auto', capability: 'auto_reply_dispatch', state: 'running', excludedReason: null, note: null },
    { id: 'webhook-outgoing', label: 'Webhookの送信', kind: 'external', capability: 'webhook_outgoing', state: 'running', excludedReason: null, note: null },
    { id: 'ad-postback', label: '広告の成果通知', kind: 'external', capability: 'ad_postback', state: 'running', excludedReason: null, note: null },
    { id: 'manual-reply', label: '1対1の手動返信', kind: 'manual', capability: null, state: null, excludedReason: '担当者が手で送る1対1の返信は止めない', note: null },
  ],
}

/* 板 `loVfW`（登録者を管理）の186人。先頭3人は絵のとおり、有効180・
 * 取消済み6で数（`items.length` と `status` から数える）。本物は
 * `GET /api/reminders/:id/registrants` の配列。 */
const REMINDER_REGISTRANT_BASE = [
  ['見本 141', 'active', 'manual'],
  ['見本 122', 'active', 'form'],
  ['見本 176', 'active', 'manual'],
]
const REMINDER_REGISTRANT_NAMES = [
  '見本 16', '見本 17', '見本 26太', '中村 美咲', '林 翔太', '小林 葵',
  '加藤 蓮', '吉田 陽菜', '森田 健一', '石井 さくら', '藤田 大輔', '岡田 結衣',
]
export const REMINDER_REGISTRANTS = [
  ...REMINDER_REGISTRANT_BASE.map(([friendName, status, sourceKind], index) => ({
    id: `reminder-enrollment-${index + 1}`, friendId: `friend-reg-${index + 1}`, friendName, targetDate: '2026-09-10',
    status, reminderVersionId: 'reminder-version-1', sourceKind,
    createdAt: '2026-09-01T09:00:00+09:00', updatedAt: '2026-09-01T09:00:00+09:00',
    cancelledAt: null, lockVersion: 1,
  })),
  ...Array.from({ length: 183 }, (_, index) => {
    const number = index + 4
    // 末尾6人は取消済み（186人中 有効180・取消6）。
    const cancelled = number > 180
    return {
      id: `reminder-enrollment-${number}`, friendId: `friend-reg-${number}`,
      friendName: `${REMINDER_REGISTRANT_NAMES[index % REMINDER_REGISTRANT_NAMES.length]}${Math.floor(index / REMINDER_REGISTRANT_NAMES.length) + 1}`,
      targetDate: '2026-09-10',
      status: cancelled ? 'cancelled' : 'active', reminderVersionId: 'reminder-version-1',
      sourceKind: number % 2 === 0 ? 'form' : 'manual',
      createdAt: '2026-09-01T09:00:00+09:00', updatedAt: '2026-09-01T09:00:00+09:00',
      cancelledAt: cancelled ? '2026-09-15T09:00:00+09:00' : null, lockVersion: 1,
    }
  }),
]

/*
 * 板 `AYc6O`・`C67dE`・`piWhz`（共通情報「営業時間」の編集）。撮影は
 * `/contents/vars/edit?id=common-var-hours`。使っている場所は影響の8件と同じ。
 * 期間外は「代わりの値を出す」、決めた日の予定が1件（10/1 から 18:00 まで）。
 */
const COMMON_VAR_HOURS_IMPACT = commonVarChangeImpactHours('平日 10:00〜19:00')
export const COMMON_VAR_HOURS_DELETE_IMPACT = {
  variable: { id: 'common-var-hours', name: '営業時間', varKey: 'shop_hours' },
  total: 8,
  blockingTotal: 8,
  historicalTotal: 0,
  unscopedFormTotal: 0,
  canDelete: false,
  byKind: COMMON_VAR_HOURS_IMPACT.byKind,
  unavailableReferences: [],
  items: COMMON_VAR_HOURS_IMPACT.items.map(({ kind, kindLabel, name, status, blocksDeletion, currentPreview }) => ({
    kind, kindLabel, name, status, blocksDeletion, currentPreview,
  })),
  checkedAt: '2026-09-07T10:00:00.000+09:00',
}
export const COMMON_VAR_HOURS_DETAIL = {
  ...COMMON_VARS.find((variable) => variable.id === 'common-var-hours'),
  memo: '',
  version: 2,
  archivedAt: null,
  status: 'active',
  validFrom: null,
  validUntil: null,
  expiryBehavior: 'fallback',
  fallbackValue: 'お問い合わせください',
  usageByKind: COMMON_VAR_HOURS_DELETE_IMPACT.byKind,
  usages: COMMON_VAR_HOURS_DELETE_IMPACT.items,
  usagePage: { total: 8, shown: 8, hasMore: false, unavailableCount: 0 },
  history: [
    {
      id: 'common-var-hours-version-2', version: 2, name: '営業時間', value: '平日 10:00〜19:00', memo: '',
      changeReason: '夏の営業時間', actorId: 'staff-2', actorName: '見本 18', createdAt: '2026-09-01T10:00:00.000+09:00',
    },
    {
      id: 'common-var-hours-version-1', version: 1, name: '営業時間', value: '平日 10:00〜20:00', memo: '',
      changeReason: '初回登録', actorId: 'staff-3', actorName: '見本 30', createdAt: '2026-04-01T09:00:00.000+09:00',
    },
  ],
}
export const COMMON_VAR_HOURS_SCHEDULES = [
  { id: 'common-var-hours-schedule-1', varId: 'common-var-hours', effectiveFrom: '2026-10-01T00:00', value: '平日 10:00〜18:00', appliedAt: null },
]
