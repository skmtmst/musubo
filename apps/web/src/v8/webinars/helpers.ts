/* ★V8 ウェビナー一覧が使う失敗理由とCSVの決まり。 */
import { ApiError } from '@/lib/api'
import type { WebinarListItem, WebinarListParams, WebinarListResponse } from '@/lib/api'
import type { ListStateKind } from '@/components/shared/list-state'

/** 読み込めなかった理由。403 は読み直しても直らないので、読み直しの口を出さない。 */
export type WebinarLoadFailure = {
  kind: Extract<ListStateKind, 'error' | 'forbidden'>
  title: string
  description: string
  retryable: boolean
}

export function webinarLoadFailure(error: unknown): WebinarLoadFailure {
  if (error instanceof ApiError && error.status === 403) {
    return {
      kind: 'forbidden',
      title: 'ウェビナーを見る権限がありません',
      description: 'このLINEアカウントを見る権限を、オーナーか管理者に確認してください。',
      retryable: false,
    }
  }
  if (error instanceof ApiError && error.status === 429) {
    return {
      kind: 'error',
      title: 'ウェビナーの読み込みが混み合っています',
      description: '少し待ってから、もう一度読み込んでください。',
      retryable: true,
    }
  }
  return {
    kind: 'error',
    title: 'ウェビナーを表示できませんでした',
    description: '通信状態を確認して、もう一度読み込んでください。',
    retryable: true,
  }
}

function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value)
  if (/^[\s]*[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

/** 表示中の条件に合う全頁を取得。途中で失敗した場合は一部のCSVを返さない。 */
export async function webinarListCsv(args: {
  accountId: string
  params: WebinarListParams
  list: (accountId: string, params: WebinarListParams) => Promise<{ data: WebinarListResponse }>
  isCurrent: () => boolean
}): Promise<string | null> {
  const items: WebinarListItem[] = []
  const ids = new Set<string>()
  let expectedTotal: number | null = null
  for (let page = 1; ; page += 1) {
    const response = await args.list(args.accountId, { ...args.params, page, limit: 100 })
    if (!args.isCurrent()) return null
    const data = response.data
    if (!data || !Array.isArray(data.items) || !Number.isSafeInteger(data.total) || data.total < 0) throw new Error('shape')
    if (expectedTotal !== null && data.total !== expectedTotal) throw new Error('changed')
    expectedTotal = data.total
    for (const item of data.items) {
      if (ids.has(item.id)) throw new Error('changed')
      ids.add(item.id)
      items.push(item)
    }
    if (items.length >= data.total) break
    if (data.items.length === 0) throw new Error('incomplete')
  }
  const rows: unknown[][] = [['ウェビナー名', '公開URLの名前', '状態', '申込人数', '視聴開始人数', '公開開始', '公開終了']]
  for (const item of items) {
    rows.push([item.title, item.slug, statusLabel(item), item.registrationCount, item.viewerCount, item.publicationStartsAt, item.publicationEndsAt])
  }
  return '﻿' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

/*
 * 状態の札。公開期間が終わったものは「非公開」（一覧の絵の の
 * 旧機能説明会の行。公開ページはもう開けない）。公開の予定は「公開予定」。
 */
const knownPublicationStates: readonly string[] = ['period', 'always', 'scheduled', 'ended', 'unset']

export function statusLabel(webinar: WebinarListItem): string {
  if (webinar.status === 'archived') return 'アーカイブ'
  if (webinar.status !== 'active' && webinar.status !== 'draft') return '状態を確認できません'
  if (webinar.status === 'active' && webinar.publicationState != null && !knownPublicationStates.includes(webinar.publicationState)) return '状態を確認できません'
  if (webinar.publicationState === 'scheduled') return '公開予定'
  if (webinar.publicationState === 'ended') return '非公開'
  if (webinar.status === 'draft') return '下書き'
  return '公開中'
}

export type StatusTone = 'active' | 'scheduled' | 'neutral'

export function statusTone(webinar: WebinarListItem): StatusTone {
  if (webinar.status === 'archived') return 'neutral'
  if (webinar.status !== 'active' && webinar.status !== 'draft') return 'neutral'
  if (webinar.status === 'active' && webinar.publicationState != null && !knownPublicationStates.includes(webinar.publicationState)) return 'neutral'
  if (webinar.publicationState === 'scheduled') return 'scheduled'
  if (webinar.status === 'active' && webinar.publicationState !== 'ended') return 'active'
  return 'neutral'
}

/*
 * 申込・視聴を数として出せるか。下書き・期間終了・期間未設定は「—」
 * （COUNT の 0 と未取得を同じ見た目にしない）。アーカイブは記録をそのまま出す。
 */
export function showsCounts(webinar: WebinarListItem): boolean {
  if (webinar.status === 'archived') return true
  if (webinar.status !== 'active') return false
  return webinar.publicationState === 'period' || webinar.publicationState === 'always' || webinar.publicationState === 'scheduled'
}

/** 公開の予定で、まだ始まっていない（視聴の列は「開始前」）。 */
export function beforeStart(webinar: WebinarListItem): boolean {
  return webinar.status === 'active' && webinar.publicationState === 'scheduled'
}

/** 公開ページの道（「/webinar/〇〇」）。 */
export function publicPath(webinar: Pick<WebinarListItem, 'slug'>): string {
  return `/webinar/${webinar.slug}`
}
