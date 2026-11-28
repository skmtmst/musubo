import { knownValue } from '@/lib/known-value'
/*
 * 1通目の入力欄と、保存されている通（ScenarioStep）のあいだの変換。
 *
 * 画面から切り離してあるのは、往復（保存→開く→保存）で値が変わらないかを
 * 通信なしで試験するため。ここがずれると「90分後が60分後になる」のような
 * 黙った書き換えが起きる（SCENARIO-01 / SCENARIO-02）。
 */

import type { DeliveryMode, ScenarioStep } from '@line-crm/shared'
import {
  emptyMessageKindState,
  parseMessageKind,
  serializeMessageKind,
  type MessageKind,
  type MessageKindState,
} from '@/components/scenarios/message-kind-fields'
import type { StepMessageKind } from '@/components/scenarios/message-type-tabs'
import type { ScenarioQuestion } from '@/components/scenarios/question-editor'
import type { SegmentCondition } from '@/lib/segment-condition'
import type { ImageUploaderValue } from '@/components/shared/image-uploader'

/**
 * 予定の入力欄の形。
 *
 * 日・時間・分は分けて持つ。分を時間へ丸めて持つと、触っていないはずの
 * 端数が保存のたびに欠ける（90分→1時間→60分）。
 */
export interface FirstStepSchedule {
  offsetDays: number
  offsetHours: number
  /** 時間に入りきらない分（0..59）。 */
  offsetMinutesRemainder: number
  /** absolute_time の配信時刻 "HH:MM"。 */
  deliveryTime: string
}

export const FIRST_STEP_SCHEDULE_FALLBACK_TIME = '10:00'

const MINUTES_PER_HOUR = 60
const MINUTES_PER_DAY = 1440
/** elapsed の offsetMinutes は worker が 0..1439 しか受け付けない。 */
const MAX_ELAPSED_OFFSET_MINUTES = MINUTES_PER_DAY - 1

function requireDeliveryMode(mode: DeliveryMode): void {
  if (mode !== 'relative' && mode !== 'elapsed' && mode !== 'absolute_time') throw new Error('配信方式を確認できませんでした。')
}

function validStoredOffset(value: number | null | undefined): boolean {
  return value == null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function splitDayMinutes(totalMinutes: number): {
  days: number
  hours: number
  minutes: number
} {
  const safe = Number.isFinite(totalMinutes) ? Math.max(0, Math.floor(totalMinutes)) : 0
  const days = Math.floor(safe / MINUTES_PER_DAY)
  const rest = safe % MINUTES_PER_DAY
  return { days, hours: Math.floor(rest / MINUTES_PER_HOUR), minutes: rest % MINUTES_PER_HOUR }
}

/**
 * 保存されている通の予定を入力欄へ戻す。
 *
 * 方式ごとに意味を持つ欄が違う（worker の validateStepSchedule と同じ切り分け）。
 * elapsed で offsetDays/offsetMinutes を両方持たない旧い行は、残っている
 * delayMinutes を合計の分として日・時間・分へ分解する。これが旧方式の
 * 互換変換で、ここ以外では delayMinutes を読まない。
 */
export function scheduleFromStep(mode: DeliveryMode, step: ScenarioStep): FirstStepSchedule {
  requireDeliveryMode(mode)
  const valid = mode === 'absolute_time' ? validStoredOffset(step.offsetDays)
    : mode === 'elapsed' && (step.offsetDays != null || step.offsetMinutes != null)
      ? validStoredOffset(step.offsetDays) && validStoredOffset(step.offsetMinutes)
      : validStoredOffset(step.delayMinutes)
  if (!valid) throw new Error('配信の時間を確認できませんでした。')
  if (mode === 'absolute_time') {
    return {
      offsetDays: Math.max(0, step.offsetDays ?? 0),
      offsetHours: 0,
      offsetMinutesRemainder: 0,
      deliveryTime: step.deliveryTime ?? FIRST_STEP_SCHEDULE_FALLBACK_TIME,
    }
  }
  if (mode === 'elapsed' && (step.offsetDays != null || step.offsetMinutes != null)) {
    const m = Math.max(0, Math.min(MAX_ELAPSED_OFFSET_MINUTES, step.offsetMinutes ?? 0))
    return {
      offsetDays: Math.max(0, step.offsetDays ?? 0),
      offsetHours: Math.floor(m / MINUTES_PER_HOUR),
      offsetMinutesRemainder: m % MINUTES_PER_HOUR,
      deliveryTime: FIRST_STEP_SCHEDULE_FALLBACK_TIME,
    }
  }
  // relative は常に、elapsed は旧データだけ、delayMinutes が合計の分。
  const { days, hours, minutes } = splitDayMinutes(step.delayMinutes ?? 0)
  return {
    offsetDays: days,
    offsetHours: hours,
    offsetMinutesRemainder: minutes,
    deliveryTime: FIRST_STEP_SCHEDULE_FALLBACK_TIME,
  }
}

/**
 * 入力欄の予定を、保存APIが受け取る形へ戻す。
 *
 * 方式に関係ない欄は送らない（送ると worker が弾く）。分は時間へ丸めず、
 * そのまま足す。
 */
export function scheduleToPayload(
  mode: DeliveryMode,
  value: FirstStepSchedule,
): {
  delayMinutes?: number
  offsetDays?: number
  offsetMinutes?: number
  deliveryTime?: string
} {
  requireDeliveryMode(mode)
  const days = Math.max(0, Math.floor(value.offsetDays) || 0)
  const hours = Math.max(0, Math.floor(value.offsetHours) || 0)
  const minutes = Math.max(0, Math.floor(value.offsetMinutesRemainder) || 0)
  if (mode === 'relative') {
    return { delayMinutes: days * MINUTES_PER_DAY + hours * MINUTES_PER_HOUR + minutes }
  }
  if (mode === 'elapsed') {
    return {
      offsetDays: days,
      offsetMinutes: Math.min(MAX_ELAPSED_OFFSET_MINUTES, hours * MINUTES_PER_HOUR + minutes),
    }
  }
  return { offsetDays: days, deliveryTime: value.deliveryTime }
}

/**
 * 画像の保存値（{originalContentUrl, previewImageUrl} のJSON）を
 * アップローダの値へ戻す。読めなければ null。
 */
export function parseStepImageContent(content: string | null | undefined): ImageUploaderValue | null {
  if (!content) return null
  let raw: Record<string, unknown>
  try {
    const parsed = JSON.parse(content) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    raw = parsed as Record<string, unknown>
  } catch {
    return null
  }
  const original = typeof raw.originalContentUrl === 'string' ? raw.originalContentUrl.trim() : ''
  if (!original) return null
  const preview =
    typeof raw.previewImageUrl === 'string' && raw.previewImageUrl.trim()
      ? raw.previewImageUrl.trim()
      : original
  return { mode: 'line-image', originalContentUrl: original, previewImageUrl: preview }
}

/** 位置情報・動画・音声・スタンプのように、専用の入力欄を持つ種別か。 */
export function isStructuredKind(type: string): type is MessageKind {
  return type === 'location' || type === 'video' || type === 'audio' || type === 'sticker'
}

/**
 * 保存済み JSON を専用欄の形へ戻す。
 *
 * 戻した欄から同じ形の中身が組み立てられなければ null。空欄のまま
 * 上書き保存すると元データが消えるので、呼び出し側は null を
 * 「復元不可」として扱い、元の保存値を保持する。
 */
export function restoreKindState(
  kind: MessageKind,
  content: string | null | undefined,
): MessageKindState | null {
  const state = parseMessageKind(kind, content)
  if (!content) return state
  return serializeMessageKind(kind, state) !== null ? state : null
}

/** 1通ごとの配信対象が「タグ1つだけ」の条件なら、タグ欄へ戻せる。 */
export function tagIdFromCondition(condition: SegmentCondition | null): string | null {
  if (!condition) return null
  if (condition.operator !== 'AND') return null
  if ((condition.groups ?? []).length > 0) return null
  if (condition.rules.length !== 1) return null
  const rule = condition.rules[0]
  if (rule.type !== 'tag_exists' || typeof rule.value !== 'string' || rule.value === '') return null
  return rule.value
}

export interface FirstStepRestore {
  existingStepId: string
  schedule: FirstStepSchedule
  /** 配信対象の選び方。保存条件がタグ1つだけなら tag、それ以外の条件なら advanced。 */
  targetMode: 'all' | 'tag' | 'advanced'
  targetTagId: string
  targetCondition: SegmentCondition | null
  contentMode: 'compose' | 'template'
  kind: StepMessageKind
  body: string
  image: ImageUploaderValue | null
  kindState: MessageKindState
  question: ScenarioQuestion | null
  templateId: string
  /**
   * この画面で読めない保存値（Flex や壊れた JSON など）。
   * 入力を触らずに保存したときは、この中身をそのまま送り返す。
   */
  preserved: { messageType: string; messageContent: string } | null
  /** 復元できなかったときに画面へ出す理由。 */
  restoreNotice: string | null
}

const KIND_LABEL: Record<string, string> = {
  text: 'テキスト',
  image: '画像',
  flex: 'Flex（カードタイプ）',
  sticker: 'スタンプ',
  location: '位置情報',
  video: '動画',
  audio: '音声',
  carousel: 'カルーセル',
}

export function messageKindLabel(type: string): string {
  return knownValue(KIND_LABEL, type, type)
}

/**
 * 既存の1通目をフォームの状態へ戻す。
 *
 * 詳細編集（openEditStep）と同じ復元の考え方：種別ごとに保存値を
 * 対応する入力欄へ戻す。読めない値は空欄で上書きせず、preserved に
 * 元データを残して理由を返す（SCENARIO-02）。
 */
export function restoreFirstStep(step: ScenarioStep, mode: DeliveryMode): FirstStepRestore {
  const base: FirstStepRestore = {
    existingStepId: step.id,
    schedule: scheduleFromStep(mode, step),
    targetMode: 'all',
    targetTagId: '',
    targetCondition: null,
    contentMode: 'compose',
    kind: 'text',
    body: '',
    image: null,
    kindState: emptyMessageKindState(),
    question: null,
    templateId: '',
    preserved: null,
    restoreNotice: null,
  }

  const condition = (step.targetCondition as SegmentCondition | null) ?? null
  const tagId = tagIdFromCondition(condition)
  if (tagId) {
    base.targetMode = 'tag'
    base.targetTagId = tagId
  } else if (condition) {
    base.targetMode = 'advanced'
    base.targetCondition = condition
  }

  // テンプレートを指す通は、テンプレート選択の状態へ戻す。
  // ただしカルーセルは「テンプレートを指す」のが本体なので compose 側へ戻す。
  if (step.templateId && step.messageType !== 'carousel' && !step.question) {
    base.contentMode = 'template'
    base.templateId = step.templateId
    return base
  }

  if (step.question) {
    base.kind = 'question'
    base.question = step.question as ScenarioQuestion
    return base
  }

  const type = step.messageType
  if (type === 'text') {
    base.kind = 'text'
    base.body = step.messageContent
    return base
  }
  if (type === 'image') {
    base.kind = 'image'
    const image = parseStepImageContent(step.messageContent)
    if (image) {
      base.image = image
    } else {
      base.preserved = { messageType: type, messageContent: step.messageContent }
      base.restoreNotice =
        '保存されている画像の内容をこの画面では読み取れませんでした。このまま保存すると元の内容が残ります。別の画像を選ぶか、種別を変えると書き換えられます。'
    }
    return base
  }
  if (type === 'carousel') {
    base.kind = 'carousel'
    base.templateId = step.templateId ?? ''
    return base
  }
  if (isStructuredKind(type)) {
    base.kind = type
    const state = restoreKindState(type, step.messageContent)
    if (state) {
      base.kindState = state
    } else {
      base.preserved = { messageType: type, messageContent: step.messageContent }
      base.restoreNotice = `保存されている${messageKindLabel(type)}の内容をこの画面では読み取れませんでした。このまま保存すると元の内容が残ります。入力し直すと書き換えられます。`
    }
    return base
  }
  // Flex など、この画面の種別タブに無いもの。欄へ散らさず元のまま保持する。
  base.kind = 'text'
  base.preserved = { messageType: type, messageContent: step.messageContent }
  base.restoreNotice = `この1通目は${messageKindLabel(type)}で保存されています。この画面ではその種別を編集できないため、このまま保存すると元の内容が残ります。テキストなどへ書き換える場合は種別を選んで内容を入れてください。`
  return base
}
