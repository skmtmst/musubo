import { jstCalendar as japanCalendar } from '@/lib/jst-datetime'
import { HQ_FRIEND_INSERTS } from '@/components/shared/hq-message-inserts'
import { scheduledJstIso } from '@/lib/jst-datetime'
/*
 * 統括の一括配信（提案 E-9）の計算だけを集めた所。画面（create.tsx・detail.tsx・list.tsx）と試験が使う。
 * 口の形は `@line-crm/shared` の HqBroadcast*（正本は apps/worker/src/services/hq-broadcasts.ts）。
 */
import type { HqBroadcastPreflight, HqBroadcastRun } from '@line-crm/shared'
import type { StatusBadgeTone } from '@/components/shared/status-badge'
import type { InsertTokenSpec } from '@/components/shared/insert-tokens'
import { formatNumber as polishFormatNumber } from '@/lib/format'


/** 画面で見せる差し込み（店ごとに変わる）と、口へ送る書き方。 */
export const STORE_INSERTS = [
  { label: '{店名}', token: '{{account.name}}', help: '送る店の名前' },
  { label: '{店の電話番号}', token: '{{var.store_phone}}', help: '店の共通情報「store_phone」' },
  { label: '{予約ページ}', token: '{{var.reservation_url}}', help: '店の共通情報「reservation_url」' },
  { label: '{友だちの名前}', token: '{{name}}', help: '受け取る友だちの LINE の名前' },
  ...HQ_FRIEND_INSERTS,
] as const

/** 本文の欄で札として見せる形（絵 OVCot）。札の文字・乗せたときの説明・印。 */
export const STORE_INSERT_CHIPS: readonly InsertTokenSpec[] = [
  { token: '{店名}', label: '店名', hint: '送る店の名前に置き換わります', icon: 'store' },
  { token: '{店の電話番号}', label: '店の電話番号', hint: '店の共通情報「store_phone」に置き換わります', icon: 'phone' },
  { token: '{予約ページ}', label: '予約ページ', hint: '店の共通情報「reservation_url」に置き換わります', icon: 'link' },
  ...HQ_FRIEND_INSERTS.map(item=>({token:item.label,label:item.label.slice(1,-1),hint:item.help,icon:'idcard' as const})),
  { token: '{友だちの名前}', label: '友だちの名前', hint: '受け取る友だちの LINE の名前に置き換わります', icon: 'user' },
]

/** 画面の差し込み（{店名} など）を口の書き方（{{account.name}} など）に置き換える。 */
export function toApiContent(body: string): string {
  let text = body
  for (const insert of STORE_INSERTS) text = text.split(insert.label).join(insert.token)
  return text
}

/** 口の書き方（{{account.name}} など）を画面の差し込み（{店名} など）に戻す。下書きを読み直すときに使う。 */
export function fromApiContent(content: string): string {
  let text = content
  for (const insert of STORE_INSERTS) {
    const inner = insert.token.slice(2, -2).replace('.', '\\.')
    text = text.replace(new RegExp(`\\{\\{\\s*${inner}\\s*\\}\\}`, 'g'), insert.label)
  }
  return text
}

/** 本文で使っている、店の共通情報から差し込むもの（{店の電話番号}・{予約ページ}）。 */
export function storeVarsUsed(body: string): string[] {
  return STORE_INSERTS.filter((i) => i.token.startsWith('{{var.') && body.includes(i.label)).map((i) => i.label.slice(1, -1))
}

/** 見え方の例：{店名} をその店の名前に、ほかの差し込みは例の値に。 */
export function previewText(body: string, storeName: string): string {
  /* 予約ページの URL は例では省く（「→ {予約ページ}」ごと消す）。 */
  return body
    .replace(/\s*→\s*\{予約ページ\}/g, '')
    .split('{店名}').join(storeName)
    .split('{店の電話番号}').join('03-0000-0000')
    .split('{予約ページ}').join('')
    .split('{友だちの名前}').join('見本 141')
    .trim()
}

/** 配信の名前（口が必ず要る）。絵に名前の欄が無いので、本文の1行目から作る（40字まで）。 */
export function runTitle(body: string): string {
  const first = body.split('\n').map((line) => line.trim()).find(Boolean) ?? ''
  const plain = first.replace(/\{[^{}]*\}/g, '').replace(/[：:]\s*$/, '').trim()
  const text = plain || '統括の一括配信'
  return text.length > 40 ? `${text.slice(0, 39)}…` : text
}

/** 送る前の確かめの札。理由は口の blockedReasons（文）から読む。 */
export function preflightBadge(p: HqBroadcastPreflight, body = ''): { label: string; tone: StatusBadgeTone } {
  const reasons = p.blockedReasons
  if (reasons.length === 0) return { label: '足りる', tone: 'success' }
  if (p.paused || reasons.some((r) => r.includes('停止'))) return { label: '配信を止めている', tone: 'neutral' }
  if (reasons.some((r) => r.includes('LINEに接続'))) return { label: 'LINE の接続切れ', tone: 'danger' }
  if (reasons.some((r) => r.includes('送信枠が足りません'))) {
    const short = p.audienceCount !== null && p.remaining !== null ? Math.max(0, p.audienceCount - p.remaining) : null
    return { label: short !== null ? `${polishFormatNumber(short)} 通 足りない` : '送信枠が足りない', tone: 'danger' }
  }
  if (reasons.some((r) => r.includes('送信枠・LINE接続を確認できません'))) return { label: '送信枠を確かめられない', tone: 'warning' }
  if (reasons.some((r) => r.includes('タグ'))) return { label: '同じ名前のタグが無い', tone: 'warning' }
  if (reasons.some((r) => r.includes('共通情報'))) {
    /* 本文で使っている店の共通情報（電話番号・予約ページ）が、その店に入っていない。 */
    const used = storeVarsUsed(body)
    return { label: used.length > 0 ? `${used.join('・')}が未設定` : '共通情報が足りない', tone: 'warning' }
  }
  if (reasons.some((r) => r.includes('友だちが0人'))) return { label: '友だちが0人', tone: 'neutral' }
  return { label: '確かめが必要', tone: 'warning' }
}

/** 送る店（外していない・問題の無い店）と外す店の数と人数。 */
export function sendTotals(list: HqBroadcastPreflight[]): { sendStores: number; sendPeople: number; skipStores: number; skipPeople: number } {
  let sendStores = 0, sendPeople = 0, skipStores = 0, skipPeople = 0
  for (const p of list) {
    const people = p.audienceCount ?? 0
    if (!p.excluded && p.blockedReasons.length === 0) { sendStores += 1; sendPeople += people } else { skipStores += 1; skipPeople += people }
  }
  return { sendStores, sendPeople, skipStores, skipPeople }
}

/**
 * 表に1行ずつ出す店と、「ほか N店」にまとめる店。外す店（問題のある店・外した店）は必ず1行ずつ出し、
 * 送る店は合わせて limit 行になるまで出す。並びは口の順のまま。まとめる店が1店だけなら、まとめずに出す。
 */
export function splitPreflightRows(list: HqBroadcastPreflight[], limit: number): { shown: HqBroadcastPreflight[]; rest: HqBroadcastPreflight[] } {
  const skipped = (p: HqBroadcastPreflight) => p.excluded || p.blockedReasons.length > 0
  let room = Math.max(0, limit - list.filter(skipped).length)
  const keep = new Set<string>()
  for (const p of list) {
    if (skipped(p)) keep.add(p.accountId)
    else if (room > 0) { keep.add(p.accountId); room -= 1 }
  }
  const rest = list.filter((p) => !keep.has(p.accountId))
  if (rest.length <= 1) return { shown: list, rest: [] }
  return { shown: list.filter((p) => keep.has(p.accountId)), rest }
}

export type ResultTarget = HqBroadcastRun['targets'][number]

/** 送った結果の店ごとの札。 */
export function resultBadge(t: ResultTarget): { label: string; tone: StatusBadgeTone } {
  if (t.excluded || t.status === 'excluded') {
    const why = excludedReason(t)
    return { label: why ? `外した（${why}）` : '外した', tone: 'neutral' }
  }
  if (t.status === 'cancelled') return { label: '取り消した', tone: 'neutral' }
  if (t.stopped && t.status !== 'sent') return { label: '止めた', tone: 'neutral' }
  /* 送り終えた店は「送れた」。届かなかった人の数は失敗の列に太字で出す（絵 xOXuY）。 */
  if (t.status === 'sent') return { label: '送れた', tone: 'success' }
  if (t.status === 'failed' || t.status === 'partial_failed') return { label: '失敗', tone: 'danger' }
  if (t.status === 'sending') return { label: '送っています', tone: 'info' }
  if (t.status === 'scheduled') return { label: '予約中', tone: 'info' }
  if (t.status === 'prepared') return { label: '送る前', tone: 'neutral' }
  return { label: '下書き', tone: 'neutral' }
}

/** 外した理由（短く）。口の blockedReasons から。 */
export function excludedReason(t: Pick<HqBroadcastPreflight, 'blockedReasons' | 'paused'>): string {
  const reasons = t.blockedReasons
  if (reasons.length === 0) return ''
  if (t.paused || reasons.some((r) => r.includes('停止'))) return '配信を止めている'
  if (reasons.some((r) => r.includes('LINEに接続'))) return 'LINE の接続切れ'
  if (reasons.some((r) => r.includes('送信枠'))) return '枠が足りない'
  if (reasons.some((r) => r.includes('タグ'))) return 'タグが無い'
  if (reasons.some((r) => r.includes('共通情報'))) return '共通情報が無い'
  if (reasons.some((r) => r.includes('友だちが0人'))) return '友だちが0人'
  return ''
}

export function failedCount(t: Pick<ResultTarget, 'totalCount' | 'successCount'>): number {
  return Math.max(0, (t.totalCount ?? 0) - (t.successCount ?? 0))
}

/** やり直せる店：一時的な失敗が残っている、または止める前に送れなかった店。 */
export function canRetry(run: Pick<HqBroadcastRun, 'status'>, t: ResultTarget): boolean {
  if (run.status === 'cancelled' || t.excluded) return false
  return (t.retryableCount > 0 && (t.status === 'sent' || (t.status === 'sending' && t.stopped))) || (t.status === 'failed' && !!t.broadcastId)
}

/** 一括配信の全体の札（一覧・詳細の頭）。 */
export function runBadge(run: Pick<HqBroadcastRun, 'status' | 'targets'>): { label: string; tone: StatusBadgeTone } {
  if (run.status === 'prepared') return { label: '下書き', tone: 'neutral' }
  if (run.status === 'cancelled') return { label: '取り消した', tone: 'neutral' }
  if (run.status === 'stopped') return { label: '止めた', tone: 'warning' }
  const live = run.targets.filter((t) => !t.excluded)
  if (live.length > 0 && live.every((t) => t.status === 'sent')) {
    return live.some((t) => failedCount(t) > 0) ? { label: '一部失敗', tone: 'warning' } : { label: '送信済み', tone: 'success' }
  }
  if (live.some((t) => t.status === 'failed')) return { label: '失敗あり', tone: 'danger' }
  if (live.some((t) => t.status === 'sending')) return { label: '送っています', tone: 'info' }
  return { label: '予約中', tone: 'info' }
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土']

/** 「1月15日（木）11:00」。 */
export function jpDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = japanCalendar(new Date(iso))
  if (Number.isNaN(d.getTime())) return '—'
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${WEEK[d.getUTCDay()]}）${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** 日付（YYYY-MM-DD）と時刻（HH:MM）から、日本時間の ISO を作る。 */
export function scheduledIso(date: string, time: string): string | null {
  return scheduledJstIso(date, time)
}

/** 店ごとの失敗の理由（口の failureReasons）。運用者の言葉の label と人数・やり直せるか。 */
export function failureLines(run: Pick<HqBroadcastRun, 'targets'>): Array<{ accountId: string; store: string; text: string; retryable: boolean }> {
  const lines: Array<{ accountId: string; store: string; text: string; retryable: boolean }> = []
  for (const t of run.targets) {
    if (t.excluded) continue
    for (const f of t.failureReasons ?? []) {
      lines.push({
        accountId: t.accountId,
        store: t.accountName,
        text: `${f.label}${f.count > 0 ? `（${polishFormatNumber(f.count)} 人）` : ''}${f.retryable ? '・やり直せます' : ''}`,
        retryable: f.retryable,
      })
    }
  }
  return lines
}

/** 中身の種類（画面）と、配信用素材の種類（口）。種類のタブと吹き出しの組み立ては bubbles.ts。 */
export type HqKind = 'text' | 'image' | 'video' | 'audio' | 'sticker' | 'carousel' | 'rich' | 'location' | 'question' | 'intro' | 'coupon' | 'research' | 'flex'
export const ASSET_KIND = { coupon: 'coupon', rich: 'rich_message' } as const

/** 送った人数（外したアカウントを除く）。 */
export function runPeople(run: HqBroadcastRun): number {
  return run.targets.reduce((sum, t) => sum + (t.excluded ? 0 : t.totalCount || 0), 0)
}
