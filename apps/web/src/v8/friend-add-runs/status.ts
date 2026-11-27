import { jstCalendar as japanCalendar } from '@/lib/jst-datetime'
/*
 * 友だち追加時の配信の実行結果で使う、状態の言葉・CSV の1マス・時刻の書き方。
 * 写し元：`app/friend-add-settings/runs/run-status.ts`・`csv.ts`（src/v8 からは import できないので写した）。
 * 一覧と詳細で同じ判定を使う（送達不明を「配信なし」と読ませない）。
 */
import type { FriendAddEventRoutingStatus } from '@line-crm/shared'
import type { StatusBadgeTone } from '@/components/shared/status-badge'
import { formatDateTime } from '@/lib/format'
import { formatDate as polishFormatDate } from '@/lib/format'


const ROUTING_LABELS: Record<FriendAddEventRoutingStatus, { label: string; tone: StatusBadgeTone }> = {
  pending: { label: 'テスト待ち', tone: 'warning' },
  completed: { label: '成功', tone: 'success' },
  failed: { label: '失敗', tone: 'danger' },
  suppressed: { label: '配信なし', tone: 'neutral' },
  partial_failed: { label: '再送待ち', tone: 'warning' },
}

const ROUTING_ACTIONS: Record<FriendAddEventRoutingStatus, string> = {
  pending: '配信・処理を確認中',
  completed: '初回案内を実行',
  failed: '配信・処理に失敗',
  suppressed: '配信・処理なし',
  partial_failed: '送れず再送待ち',
}

/** 送達不明：届いたか分からない。自動では送り直さない（送り直すと二重に届く）。 */
export const DELIVERY_UNKNOWN_CODE = 'delivery_unknown'

export function routingLabel(status: FriendAddEventRoutingStatus, errorCode: string | null): { label: string; tone: StatusBadgeTone } {
  if (errorCode === DELIVERY_UNKNOWN_CODE) return { label: '送達不明', tone: 'danger' }
  return Object.prototype.hasOwnProperty.call(ROUTING_LABELS, status) ? ROUTING_LABELS[status] : { label: '不明', tone: 'neutral' }
}

export function routingAction(status: FriendAddEventRoutingStatus, errorCode: string | null): string {
  if (errorCode === DELIVERY_UNKNOWN_CODE) return '送達不明・要確認（自動では送り直しません）'
  return Object.prototype.hasOwnProperty.call(ROUTING_ACTIONS, status) ? ROUTING_ACTIONS[status] : '状態を確認中'
}

/** DB には JST の時刻をオフセットなしで保存した古い行がある。UTC へ読み替えず、そのまま JST として出す。 */
export function formatJstDateTime(value: string | null): string {
  return polishFormatDate(value, { style: 'detail', fallback: '—' })
}

/** 表の「日時」は時:分だけ（全文は title）。 */
export function jstTime(value: string | null): string {
  const full = formatJstDateTime(value)
  const match = full.match(/(\d{1,2}:\d{2})$/)
  return match ? match[1] : full
}

/** CSV の1マス。先頭が `= + - @` タブなら `'` を付けて式として動かないようにする。 */
export function csvCell(value: string): string {
  const escaped = value.replaceAll('"', '""')
  const guarded = /^[=+\-@\t]/.test(escaped) ? `'${escaped}` : escaped
  return `"${guarded}"`
}

/** 受信から処理までの秒（かかった時間）。 */
export function elapsedText(receivedAt: string, processedAt: string | null): string {
  if (!processedAt) return '—'
  const ms = new Date(processedAt).getTime() - new Date(receivedAt).getTime()
  if (Number.isNaN(ms) || ms < 0) return '—'
  return `${(ms / 1000).toFixed(1)}秒`
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

/** 日本時間の年月日・時分秒・曜日。オフセットなしの古い行は JST として読む。読めなければ null。 */
export function jstParts(value: string | null): { month: number; day: number; hh: string; mm: string; ss: string; weekday: string } | null {
  if (!value) return null
  const bare = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (bare && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) {
    const weekday = WEEKDAYS[new Date(Date.UTC(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3]))).getUTCDay()]
    return { month: Number(bare[2]), day: Number(bare[3]), hh: bare[4], mm: bare[5], ss: bare[6] ?? '00', weekday }
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return null
  const jst = japanCalendar(parsed)
  const pad = (n: number) => String(n).padStart(2, '0')
  return {
    month: jst.getUTCMonth() + 1, day: jst.getUTCDate(),
    hh: pad(jst.getUTCHours()), mm: pad(jst.getUTCMinutes()), ss: pad(jst.getUTCSeconds()),
    weekday: WEEKDAYS[jst.getUTCDay()],
  }
}

/** 詳細の題の下：`9月7日（月）10:14`。 */
export function jstTitleDate(value: string | null): string {
  const p = jstParts(value)
  return p ? `${p.month}月${p.day}日（${p.weekday}）${p.hh}:${p.mm}` : '—'
}

/** 詳細の右の列：`9/7 10:14:01`。 */
export function jstShortDateTime(value: string | null): string {
  const p = jstParts(value)
  return p ? `${p.month}/${p.day} ${p.hh}:${p.mm}:${p.ss}` : '—'
}

/** 行ったことの時刻：`10:14:02`。 */
export function jstClock(value: string | null): string {
  const p = jstParts(value)
  return p ? `${p.hh}:${p.mm}:${p.ss}` : '—'
}
