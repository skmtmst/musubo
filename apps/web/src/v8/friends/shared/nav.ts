/*
 * ★V8 友だちの段のタブ（Pencil ・・・・）。
 *
 * 行き先は今の画面と同じ URL（v8/friends/friends-tabs.ts と同じ名前・同じ順）。
 * 絵のタブは4つ。「CSVで書き出す・取り込む」（/friends/migrations）はタブに置かず、
 * 友だち一覧の「CSVから取り込む」から行く（画面の頭の説明の文だけ残す）。
 */
export type FriendsTabKey = 'list' | 'duplicates' | 'merged' | 'uid-migration' | 'csv'

export const FRIENDS_TABS: ReadonlyArray<{ key: FriendsTabKey; label: string; href: string }> = [
  { key: 'list', label: '友だち一覧', href: '/friends' },
  { key: 'duplicates', label: '重複検出', href: '/friends?tab=duplicates' },
  { key: 'merged', label: '統合ユーザー', href: '/friends?tab=merged' },
  { key: 'uid-migration', label: 'UID移行', href: '/friends/migrations?tab=uid' },
]

/** タブに置かない CSV の画面の呼び名（今いるタブ・説明の文で共用）。 */
export const FRIENDS_CSV_TAB_LABEL = 'CSVで書き出す・取り込む'

/** タブの下に出す1行の説明（絵の「タブの説明」）。 */
export const FRIENDS_TAB_NOTES: Record<FriendsTabKey, string> = {
  list: '友だち一覧：LINE でつながっている人の一覧です。',
  duplicates: '重複検出：同じ人が2人に分かれていないかを探して、結び付けるか決めます。',
  merged: '統合ユーザー：結び付けた人の一覧です。間違えて結び付けたときは、ここで分けます。',
  'uid-migration': 'UID移行：別のLINEアカウントから友だちを引っ越します。照合してから本移行します。',
  csv: `${FRIENDS_CSV_TAB_LABEL}：友だちの一覧を表計算のファイルで出し入れします。`,
}

/**
 * 変えられるかの判定。役割はサーバ（`api.staff.me`）の答えを使い、
 * 手元の保存値の役割（`lh_staff_role`）は見ない（古い値が残ることがある）。
 * 担当者（staff）でも、項目キーで友だち・受信箱の変更を任されていれば変えられる。
 */
export function hasEditKey(permission: string): boolean {
  if (typeof window === 'undefined') return false
  if (typeof permission !== 'string' || permission.trim().length === 0) return false
  try {
    const raw = window.localStorage.getItem('lh_staff_permissions')
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) && parsed.some((item) => typeof item === 'string' && item === permission)
  } catch {
    return false
  }
}
