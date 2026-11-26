'use client'

import { knownValue } from '@/lib/known-value'

import { jstCalendar as japanCalendar } from '@/lib/jst-datetime'
import { scheduledJstIso } from '@/lib/jst-datetime';
import type { HqBroadcastInput, HqBroadcastRun, SegmentCondition } from '@line-crm/shared';
import { japaneseDetailOf } from '@/components/shared/api-error-message';
import { ApiError, describeSaveFailure, type BroadcastMessageAsset } from '@/lib/api';
import { fromApiContent } from './model';
import { HQ_KIND_LABEL, fromApiBubble, newHqBubble, type HqBubble } from './bubbles';
import { permissionDeniedMessage } from '@/components/shared/api-error-message';
import { withPermissionFailure } from '@/components/shared/api-error-message';

/** 配信対象（店の一斉配信と同じ4つ。名前は店の口と同じ：詳細条件は advanced）。 */
type Audience = 'all' | 'scenario' | 'tag' | 'advanced'

/** 吹き出し1つ（店の一斉配信と同じく5つまで）。種類と口への形は bubbles.ts。 */
type Bubble = HqBubble

const MAX_BUBBLES = 5

const newBubble = newHqBubble


function errorText(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError) {
    if (caught.status === 403) return permissionDeniedMessage('hq')
    if (caught.status === 409) return japaneseDetailOf(caught) || 'ほかの人が先に操作しました。もう一度確かめてください。'
    return withPermissionFailure(caught, describeSaveFailure(caught), 'hq')
  }
  // 「API error: 500」のような内部の文は出さない。
  return japaneseDetailOf(caught) || fallback
}


/** 配信の中身の種類（「テキスト＋カルーセル」）。 */
function runKinds(run: HqBroadcastRun): string {
  return [...new Set(bubblesFromInput(run.input ?? { messageContent: '' }).map((b) => knownValue(HQ_KIND_LABEL, b.kind, '種類を確認できません')))].join('＋')
}


/** 日付（YYYY-MM-DD）と時刻（HH:MM）を日本時間として ISO にする（店の一斉配信と同じ「日本時間」の欄）。 */
function jstIso(date: string, time: string): string | null {
  return scheduledJstIso(date, time)
}


/** 下書きの日時（ISO）を、日本時間の日付と時刻の欄に戻す。 */
function splitJst(iso: string): { date: string; time: string } | null {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const j = japanCalendar(d)
  return { date: `${j.getUTCFullYear()}-${String(j.getUTCMonth() + 1).padStart(2, '0')}-${String(j.getUTCDate()).padStart(2, '0')}`, time: `${String(j.getUTCHours()).padStart(2, '0')}:${String(j.getUTCMinutes()).padStart(2, '0')}` }
}


/** 素材（クーポン・リッチメッセージ）を吹き出しの中身にする。口の messageBubblesJson と同じ形（店側の一斉配信と同じ）。 */
function assetContent(asset: BroadcastMessageAsset): Record<string, unknown> {
  return { assetId: asset.id, assetName: asset.name, ...asset.payload }
}


/** 保存した吹き出し（messageBubblesJson）を画面の吹き出しに戻す。読めなければ本文1つ。 */
function bubblesFromInput(saved: Pick<HqBroadcastInput, 'messageBubblesJson' | 'messageContent'>): Bubble[] {
  let raw: Array<{ id?: string; type?: string; content?: Record<string, unknown> }> = []
  try { raw = saved.messageBubblesJson ? JSON.parse(saved.messageBubblesJson) : [] } catch { raw = [] }
  const list = (Array.isArray(raw) ? raw : []).flatMap((item): Bubble[] => { const b = fromApiBubble(item); return b ? [b] : [] })
  return list.length ? list.slice(0, MAX_BUBBLES) : [{ ...newBubble('text'), body: fromApiContent(saved.messageContent ?? '') }]
}


/** 読み直すと失われるメッセージを含む場合は編集しない。 */
function hasUnsupportedBubbles(saved: Pick<HqBroadcastInput, 'messageBubblesJson' | 'messageType'>): boolean {
  if (!saved.messageBubblesJson) return saved.messageType !== 'text'
  try {
    const raw: unknown = JSON.parse(saved.messageBubblesJson)
    if (!Array.isArray(raw) || raw.length > MAX_BUBBLES || (raw.length === 0 && saved.messageType !== 'text')) return true
    return raw.some((item: unknown) => !item || typeof item !== 'object' || Array.isArray(item) || !fromApiBubble(item as { type?: string; content?: Record<string, unknown> }))
  } catch { return true }
}


/** 保存した配信対象を画面の選び方に戻す（シナリオ1つだけの条件はシナリオ、ほかは詳細条件）。 */
function audienceFromInput(saved: HqBroadcastInput): { audience: Audience; tagName: string; scenarioName: string; condition: SegmentCondition | null; savedName: string } {
  const empty = { tagName: '', scenarioName: '', condition: null, savedName: '' }
  if (saved.audience?.kind === 'tag') return { ...empty, audience: 'tag', tagName: saved.audience.tagName }
  if (saved.targetType === 'segment') {
    const rules = saved.segmentConditions?.rules ?? []
    if (!saved.savedSearchId && rules.length === 1 && rules[0].type === 'scenario_subscribed' && !(saved.segmentConditions?.groups ?? []).length) {
      return { ...empty, audience: 'scenario', scenarioName: String(rules[0].value ?? '') }
    }
    return { ...empty, audience: 'advanced', condition: saved.segmentConditions ?? null, savedName: saved.savedSearchId ?? '' }
  }
  return { ...empty, audience: 'all' }
}
export { type Audience, type Bubble, MAX_BUBBLES, newBubble, errorText, runKinds, jstIso, splitJst, assetContent, bubblesFromInput, hasUnsupportedBubbles, audienceFromInput }
