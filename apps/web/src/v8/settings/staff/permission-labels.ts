import { knownValue } from '@/lib/known-value'
/**
 * 権限の表示名の正本（一覧と追加の両画面で共有）。
 *
 * 以前は `staff/page.tsx` の `PERMISSIONS`（21件）と
 * `staff/new/page.tsx` の `PERMISSION_GROUPS`（28件）が別々に表示名を
 * 持っていて、追加側にしか無い7件（予約設定・ウェビナーなど）は一覧の
 * `permissionSummary` が名前を知らず「○機能」と件数表示に落ちていた。
 * どちらで付けた権限でも一覧で名前が出るよう、表示名だけはここに寄せる。
 * 載せる顔ぶれ（どの画面で何を選べるか）は画面ごとの仕様なので変えない。
 */
export const PERMISSION_LABELS: Record<string, string> = {
  '/': 'ダッシュボード',
  '/chats': '受信箱',
  '/friends': '友だち',
  '/tags': 'タグ',
  '/scenarios': 'シナリオ配信',
  '/broadcasts': '一斉配信',
  '/reminders': 'リマインダ',
  '/auto-replies': '自動応答',
  '/friend-add-settings': '友だち追加時の配信',
  '/webinars': 'ウェビナー',
  '/templates': 'テンプレート',
  '/rich-menus': 'リッチメニュー',
  '/form-submissions': '回答フォーム',
  '/contents/vars': '共通情報',
  '/contents': '登録メディア一覧',
  '/conversions': '成果とアフィリエイト',
  'conversion.approval.edit': '成果を承認・却下する',
  '/mileage': 'マイル',
  '/inflow-links': '流入と計測',
  '/analytics': '分析',
  '/automations': 'オートメーション',
  '/webhooks': '外部連携',
  '/booking/bookings': '予約管理',
  '/booking/menus': '予約設定',
  '/events': 'イベント予約',
  '/ec-commerce': 'ECデータ連携',
  '/line-notifications': 'LINE通知',
  '/nen-campaigns': 'フォロー配信',
  '/nen-members': '投稿写真審査',
  'broadcast.definition.edit': '一斉配信の下書き作成・編集',
  'broadcast.test.send': '一斉配信のテスト送信',
  'broadcast.definition.publish': '一斉配信の予約・送信',
  'broadcast.job.stop': '一斉配信の緊急停止',
  'broadcast.job.retry': '一斉配信の失敗再送',
  'broadcast.result.export': '一斉配信の結果書き出し',
}

/** 知らない権限パスが来たら件数表示に落とす前の名前解決。 */
export function permissionLabel(path: string): string {
  return knownValue(PERMISSION_LABELS, path, '')
}

/** 成果承認の表示権限と操作権限。操作だけ・表示なしの組み合わせは作らない。 */
export const CONVERSIONS_VIEW_KEY = '/conversions'
export const CONVERSION_APPROVAL_EDIT_KEY = 'conversion.approval.edit'

/**
 * 権限の付け外し（追加・編集の両画面で共有）。
 *
 * 操作権限を選んだら表示権限も組で付け、表示権限を外したら操作権限も
 * 外す。操作だけ残る・表示なしで操作できる組み合わせを作らないため。
 */
export function toggleStaffPermissionKey(current: string[], key: string): string[] {
  if (current.includes(key)) {
    const next = current.filter((item) => item !== key)
    if (key === CONVERSIONS_VIEW_KEY) {
      return next.filter((item) => item !== CONVERSION_APPROVAL_EDIT_KEY)
    }
    return next
  }
  const next = [...current, key]
  if (key === CONVERSION_APPROVAL_EDIT_KEY && !next.includes(CONVERSIONS_VIEW_KEY)) {
    next.push(CONVERSIONS_VIEW_KEY)
  }
  return next
}

/** 保存直前の組立て直し。操作権限だけが残っていたら表示権限を足す。 */
export function normalizeStaffPermissionKeys(keys: string[]): string[] {
  if (keys.includes(CONVERSION_APPROVAL_EDIT_KEY) && !keys.includes(CONVERSIONS_VIEW_KEY)) {
    return [...keys, CONVERSIONS_VIEW_KEY]
  }
  return keys
}
