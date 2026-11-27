import type { Webinar, WebinarParticipantPage } from '@/lib/api'
import { formatDate as polishFormatDate } from '@/lib/format'


/*
 * ウェビナーの編集（V8）が使う時刻・分類・段の決まり。
 */

/** 秒を「分:秒」に。負の数は開始前（待機ルーム）。-330 → -5:30。 */
export function fmtSec(sec: number): string {
  const sign = sec < 0 ? '−' : ''
  const abs = Math.abs(sec)
  const h = Math.floor(abs / 3600)
  const m = Math.floor((abs % 3600) / 60)
  const s = abs % 60
  return h > 0
    ? `${sign}${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${sign}${m}:${String(s).padStart(2, '0')}`
}

/** 「分:秒」「-分:秒」「秒」を秒へ。読めないときは null。 */
export function parseSec(text: string): number | null {
  const trimmed = text.trim().replace(/^[−ー]/, '-')
  if (trimmed === '') return null
  const match = /^(-?)(?:(\d+):)?(\d+)(?::(\d+))?$/.exec(trimmed)
  if (!match) return null
  const [, sign, a, b, c] = match
  const parts = [a, b, c].filter((part) => part !== undefined).map(Number)
  const seconds = parts.length === 3
    ? parts[0] * 3600 + parts[1] * 60 + parts[2]
    : parts.length === 2 ? parts[0] * 60 + parts[1] : parts[0]
  return sign ? -seconds : seconds
}

/** 14分32秒。 */
export function fmtJaDuration(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return s === 0 ? `${m}分` : `${m}分${s}秒`
}

export function percent(value: number, total: number): string {
  return total > 0 ? `${Math.round((value / total) * 100)}%` : '—'
}

/** 9/30 10:12。サーバーの記録時刻を日本時間で短く出す。 */
export function shortDateTime(value: string | null): string {
  return polishFormatDate(value, { style: 'list', fallback: '—' })
}

export function webinarStatusLabel(status: Webinar['status']): string {
  if (status === 'active') return '公開中'
  if (status === 'draft') return '下書き'
  return 'アーカイブ'
}

export type ParticipantRow = WebinarParticipantPage['items'][number]

/** 行の注。参加の回数と、予約から来たか直接来たか。 */
export function joinNote(participant: ParticipantRow): string {
  const sessions = participant.sessions
  if (!Number.isSafeInteger(sessions) || sessions < 0) return '参加回数を確認できません'
  if (sessions === 0) return '申込のみ'
  const origin = participant.registered === true ? '予約から参加' : participant.registered === false ? '直接参加' : '参加経路を確認できません'
  return `${sessions} 回参加・${origin}`
}

/** 入場がライブ時間内か終了後（録画）かを回数つきで短く示す。 */
export function joinKindLabel(participant: ParticipantRow): string {
  const live = participant.liveSessions ?? 0
  const replay = participant.replaySessions ?? 0
  if (live === 0 && replay === 0) return ''
  const parts: string[] = []
  if (live > 0) parts.push(`ライブ${live}`)
  if (replay > 0) parts.push(`録画${replay}`)
  return `（${parts.join('・')}）`
}

/** 行の成果の札。CTA・フォーム・視聴だけ。 */
export function actionBadge(participant: ParticipantRow): { label: string; done: boolean } {
  if (participant.formSubmittedAt) return { label: 'フォーム送信', done: true }
  if (participant.ctaClickedAt) return { label: '案内ボタンを押した', done: true }
  if (participant.maxWatchedSeconds > 0) return { label: '視聴のみ', done: false }
  return { label: '—', done: false }
}

/**
 * 参加者行の分類。サーバーの classification を優先し、無い古い応答だけ
 * 従来の推測へ落とす。
 */
export function participantStateLabel(participant: ParticipantRow, durationSeconds: number): string {
  const rate = Math.min(100, Math.round((participant.maxWatchedSeconds / Math.max(1, durationSeconds)) * 100))
  const hasWatchError = participant.staffIntegrationStatus === 'needs_attention' || Boolean(participant.errorDetail)
  if (participant.classification === undefined) {
    return participant.maxWatchedSeconds === 0
      ? hasWatchError ? '視聴エラー' : participant.latestJoinedAt ? '入場のみ' : '見ていない・見逃し案内の対象'
      : rate >= 90 ? '視聴完了' : '途中で離れた'
  }
  switch (participant.classification) {
    case 'unmeasured': return '計測外'
    case 'unviewed': return '見ていない・見逃し案内の対象'
    case 'completed': return '視聴完了'
    case 'dropped_off':
      return participant.maxWatchedSeconds === 0
        ? hasWatchError ? '視聴エラー' : '入場のみ'
        : '途中で離れた'
  }
}

export const PARTICIPANTS_PAGE_SIZE = 50

export type StepKey = 'basic' | 'video' | 'cta' | 'notifications' | 'review'
export type ExtraKey = 'participants' | 'analytics' | 'comments' | 'actions' | 'preview'
export type PaneKey = StepKey | ExtraKey

export const STEPS: ReadonlyArray<{ key: StepKey; no: number; title: string }> = [
  { key: 'basic', no: 1, title: '基本設定' },
  { key: 'video', no: 2, title: '動画' },
  { key: 'cta', no: 3, title: '案内ボタン・フォーム' },
  { key: 'notifications', no: 4, title: '通知' },
  { key: 'review', no: 5, title: '確認' },
]

export const PANE_KEYS: readonly PaneKey[] = [
  'basic', 'video', 'cta', 'notifications', 'review',
  'participants', 'analytics', 'comments', 'actions', 'preview',
]

/** 段の印。「済み」は入力があるときだけ。 */
export function stepStateOf(key: StepKey, current: StepKey, webinar: Webinar | null, ctaCount?: number): 'done' | 'current' | 'todo' {
  if (key === current) return 'current'
  if (!webinar) return 'todo'
  switch (key) {
    case 'basic':
      return webinar.title.trim() && webinar.slug.trim() ? 'done' : 'todo'
    case 'video':
      return webinar.videoPrefix && webinar.durationSeconds > 0 && webinar.schedule.length > 0 ? 'done' : 'todo'
    case 'cta':
      return (ctaCount !== undefined ? ctaCount > 0 : Boolean(webinar.cta)) ? 'done' : 'todo'
    /* 通知と確認は、この画面の値だけでは済みと言えない。ただし後ろの段にいるときは通った印を出す。 */
    default:
      return 'todo'
  }
}

export function nextStepOf(key: StepKey): StepKey | null {
  const index = STEPS.findIndex((step) => step.key === key)
  return index >= 0 && index < STEPS.length - 1 ? STEPS[index + 1].key : null
}

/** 実際の次へ進む口も、現在の段の名前に合わせる。 */
export function nextLabelOf(key: StepKey): string | null {
  return { basic: '動画の設定へ', video: '案内ボタン・フォームへ', cta: '通知へ', notifications: '確認へ', review: null }[key]
}

export const READONLY_REASON = 'この操作にはオーナーか管理者の権限が要ります'

/** 今月の申込（サーバーの集計日 UTC で数える）。 */
export function thisMonthReservations(daily: Array<{ date: string; reservations: number }>, now: Date = new Date()): number {
  const key = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
  return daily.filter((day) => day.date.slice(0, 7) === key).reduce((total, day) => total + day.reservations, 0)
}
