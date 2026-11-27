import { knownValue } from '@/lib/known-value'
import type { HqSupportKind, HqSupportStatus } from '@/lib/hq-support'
import { formatDate as polishFormatDate } from '@/lib/format'


/** 絵の言葉（・）。運営が見ている間は「対応中」、閉じたら「解決済み」。 */
export const SUPPORT_STATUS_WORDS: Record<HqSupportStatus, string> = {
  open: '対応中',
  answered: '回答済み',
  closed: '解決済み',
}

export function supportStatusWord(status: string): string {
  return knownValue(SUPPORT_STATUS_WORDS, status, '状態を確認できません')
}

export function supportStatusTone(status: string): 'warning' | 'success' | 'neutral' {
  return status === 'open' ? 'warning' : status === 'answered' || status === 'closed' ? 'success' : 'neutral'
}

/** 「9/30 11:00」（日本時間）。読めない値は「—」。 */
export function supportTime(iso: string): string {
  return polishFormatDate(iso, { style: 'list', fallback: '—' })
}

/** 絵の種類の言葉（・：「不具合」「料金」）。受け口の言葉（「不具合の報告」など）は長く、表の列で切れるので短くする。 */
export const SUPPORT_KIND_WORDS: Record<HqSupportKind, string> = {
  usage: '使い方',
  bug: '不具合',
  billing: '料金',
  feature: '要望',
  other: 'その他',
}

/** 種類の短い言葉。知らない種類は受け口の言葉のまま。 */
export function supportKindWord(kind: string | null | undefined, fallback: string): string {
  return kind ? knownValue(SUPPORT_KIND_WORDS, kind, fallback) : fallback
}
