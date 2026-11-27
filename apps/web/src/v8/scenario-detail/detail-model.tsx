'use client'

import { japaneseDetailOf } from '@/components/shared/api-error-message'

import { type ScenarioQuestion } from '@/components/scenarios/question-editor';
import { type OnCompleteMode } from '@/components/scenarios/scenario-dialogs';
import { emptySchedule, type ScheduleValue } from '@/components/scenarios/schedule-input';
import { type SegmentCondition } from '@/components/shared/condition-builder';
import { type ScenarioTriggerItem } from '@/lib/api';
import { formatDate as polishFormatDate } from '@/lib/format';
import type { DeliveryMode, MessageType, Scenario, ScenarioStep } from '@line-crm/shared';
import { stepListTitle } from './scenario-step-audience';
import { formatDelay } from './schedule-label';

/*
 * ★V8 シナリオ配信の編集（src/v8 に一から組み直した版）。
 * 板：有効 ・始めた直後 ・停止中 ・競合 、
 * 窓：止める確認 ・複製 ・開始の確認 。
 *
 * 動き（読み込み・保存・複製・削除・開始/停止・通の編集）は今までの
 * app/scenarios/detail/detail-v8.tsx から写した（src/v8 は @/app を読めない）。
 * 見た目だけを絵の寸法で組み直した：板の頭／中身（左＝3つの箱・数の帯・
 * 最後の1通の後・メッセージの行・通ごとの数・足すボタン、右＝選んだ通のスマホ）／
 * 下の帯（削除・キャンセル・複製する・保存する）。
 * 閲覧のみの人には、変える操作のボタンを置かない（オーナー決定 2026-10-06）。
 * 動きの一覧は同じ場所の BEHAVIOR.md。
 */

/** 専用の入力欄で書く種別か。 */
export function isStructuredKind(type: MessageType): boolean {
  return type === 'location' || type === 'video' || type === 'audio' || type === 'sticker'
}

/** 開始のきっかけ1件を、画面で読める1行にする（一覧 page.tsx と同じ言い方）。 */
export function describeStartTrigger(trigger: ScenarioTriggerItem, tagName: string | null): string {
  if (trigger.kind === 'friend_add') return '友だち追加のとき'
  if (trigger.kind === 'tag_added') {
    return tagName ? `タグ「${tagName}」が付いたとき` : 'タグが付いたとき（タグ名を確認できません）'
  }
  if (trigger.kind === 'form_answer') return 'フォームに答えたとき'
  if (trigger.kind === 'booking_confirmed') return '予約が確定したとき'
  return '呼ばれたとき'
}

export type ScenarioWithSteps = Scenario & { steps: ScenarioStep[] }

/*
 * 送れる種別（132 で拡張）。
 *
 * Flex はLステップのタブには無いが、こちらには前からある。カードタイプの
 * メッセージを直に書くための口なので残す。
 */
export const messageTypeOptions: { value: MessageType; label: string }[] = [
  { value: 'text', label: 'テキスト' },
  { value: 'image', label: '画像' },
  { value: 'flex', label: 'Flex（カードタイプ）' },
  { value: 'sticker', label: 'スタンプ' },
  { value: 'location', label: '位置情報' },
  { value: 'video', label: '動画' },
  { value: 'audio', label: '音声' },
  { value: 'carousel', label: 'カルーセル' },
]

/** 板の頭の説明の行に出す配信方式の名前（絵 「配信方式：時刻で指定」）。 */
export const MODE_LABEL: Record<DeliveryMode, string> = {
  relative: '従来の方式',
  elapsed: '経過時間で指定',
  absolute_time: '時刻で指定',
}

/** 「最後の1通の後」の行の値。窓の選択肢名より、行として読める言い方にする。 */
export const ON_COMPLETE_SENTENCE: Record<OnCompleteMode, string> = {
  pause: '何もしない（一時停止）',
  resume_previous: '1つ前のシナリオを再開する',
  move: '次のシナリオへ移す',
}

/** ①の箱「保存済み 10月1日 14:02」。 */
export function formatSavedAt(iso: string | null | undefined): string {
  return polishFormatDate(iso, { style: 'detail', fallback: '' })
}

/** 競合の帯「〇〇 が 14:02 に保存しました」。 */
export function formatClock(iso: string | null | undefined): string {
  return polishFormatDate(iso, { style: 'time', fallback: '少し前' })
}

/** 行の札。絵は「テキスト・カルーセル・質問・テンプレート」の短い名前。 */
export function stepKindShort(
  step: { question?: unknown; messageType: string },
  templateName: string | null,
): string {
  if (templateName) return 'テンプレート'
  if (step.question) return '質問'
  return messageTypeOptions.find((o) => o.value === step.messageType)?.label ?? step.messageType
}

/** 行の題。テンプレートを使う通は本文の1行目に「（テンプレート「名前」）」を添える（4通目）。 */
export function stepRowTitle(step: { messageContent: string; question?: unknown }, templateName: string | null): string {
  if (!templateName) return stepListTitle(step, null)
  const bodyLine = (step.messageContent || '').split('\n')[0].slice(0, 60).trim()
  return bodyLine ? `${bodyLine}（テンプレート「${templateName}」）` : templateName
}

/**
 * 行の時刻。時刻指定は1通目だけ「購読開始から0日後 10:00」、2通目からは「1日後 20:00」。
 * ほかの方式は今までの言い方のまま。
 */
export function stepWhenLabel(mode: DeliveryMode, step: ScenarioStep, index: number): string {
  if (mode !== 'absolute_time') return formatScheduleLabel(mode, step)
  if (!step.deliveryTime) return '時刻を入力してください'
  const days = step.offsetDays ?? 0
  if (!Number.isSafeInteger(days) || days < 0) return '配信時刻を確認できません'
  return index === 0 ? `購読開始から${days}日後 ${step.deliveryTime}` : `${days}日後 ${step.deliveryTime}`
}

export function formatScheduleLabel(mode: DeliveryMode | undefined, step: ScenarioStep): string {
  const m = mode ?? 'relative'
  if (m === 'relative') return formatDelay(step.delayMinutes)
  if (m === 'elapsed') {
    const days = step.offsetDays ?? 0
    const mins = step.offsetMinutes ?? 0
    if (!Number.isSafeInteger(days) || days < 0 || !Number.isSafeInteger(mins) || mins < 0) return '配信時刻を確認できません'
    const h = Math.floor(mins / 60)
    const r = mins % 60
    if (days === 0 && mins === 0) return '即時（購読開始）'
    const parts: string[] = []
    if (days > 0) parts.push(`${days}日`)
    if (h > 0) parts.push(`${h}時間`)
    if (r > 0) parts.push(`${r}分`)
    return `購読開始から${parts.join('')}後`
  }
  if (m !== 'absolute_time') return '配信時刻を確認できません'
  // absolute_time
  // R235: 時刻を消したまま「○日後の 」と出すと、設定が済んだように見える。未設定とはっきり言う。
  if (!step.deliveryTime) return '時刻を入力してください'
  if (!Number.isSafeInteger(step.offsetDays ?? 0) || (step.offsetDays ?? 0) < 0) return '配信時刻を確認できません'
  return `購読開始から${step.offsetDays ?? 0}日後の ${step.deliveryTime}`
}

export interface StepFormState {
  stepOrder: number
  schedule: ScheduleValue
  messageType: MessageType
  messageContent: string
  templateId: string | null
  onReachTagId: string | null
  /** この通を送ったあと。'pause' なら次へ進めず止める。 */
  afterSend: 'continue' | 'pause'
  inputMode: 'direct' | 'template'
  /** 1通ごとの配信対象。null は「購読中の全員に配信する」。 */
  targetCondition: SegmentCondition | null
  /** 質問メッセージ。null ならふつうの通。 */
  question: ScenarioQuestion | null
  /** 下書き。1 なら配信しない。 */
  isDraft: boolean
}

/*
 * 次の通番号。通を足す3箇所（直書き・質問・テンプレ）で同じ式にすると、
 * 片方だけ直って番号がずれる（#495 軽18）。
 */
export function nextStepOrder(steps: ReadonlyArray<{ stepOrder: number }>): number {
  return steps.length > 0 ? Math.max(...steps.map((s) => s.stepOrder)) + 1 : 1
}

/*
 * SCENARIO-09: 複製の途中で止まったことを、作りかけのコピーと
 * 一緒に運ぶ印。stage は「どの段階で止まったか」を運用者の言葉で持つ。
 */
export class DuplicateAborted extends Error {
  constructor(
    readonly copyId: string,
    readonly stage: string,
    cause?: unknown,
  ) {
    super(japaneseDetailOf(cause) || '複製できませんでした')
  }
}

/*
 * R216: 複製で送る時刻の欄は、配信方式ごとに必要なものだけにする。
 * 全部送ると、口（validateStepSchedule）が余分な欄を見て 400 で止める。
 * 経過時間なのに delayMinutes を送ると、1通目で止まって作りかけの
 * コピーが残る。保存の buildSchedulePayload と同じ分け方にする。
 */
export function stepScheduleForClone(
  mode: DeliveryMode,
  step: Pick<ScenarioStep, 'delayMinutes' | 'offsetDays' | 'offsetMinutes' | 'deliveryTime'>,
): { delayMinutes?: number; offsetDays?: number; offsetMinutes?: number; deliveryTime?: string } {
  if (mode === 'relative') return { delayMinutes: step.delayMinutes }
  if (mode === 'elapsed') {
    return {
      offsetDays: step.offsetDays ?? 0,
      offsetMinutes: step.offsetMinutes ?? 0,
    }
  }
  return {
    offsetDays: step.offsetDays ?? 0,
    deliveryTime: step.deliveryTime ?? '09:00',
  }
}

export function emptyStepForm(stepOrder: number): StepFormState {
  return {
    stepOrder,
    schedule: { ...emptySchedule },
    messageType: 'text',
    messageContent: '',
    templateId: null,
    onReachTagId: null,
    afterSend: 'continue',
    inputMode: 'direct',
    targetCondition: null,
    question: null,
    isDraft: false,
  }
}

export interface TemplateOpt {
  id: string
  name: string
  category: string
  messageType: string
  messageContent: string
  question: ScenarioQuestion | null
}

export interface TagOpt {
  id: string
  name: string
}

export interface ScenarioStats {
  enrolledTotal: number
  activeNow: number
  completed: number
  paused: number
  steps: Array<{
    stepOrder: number
    reachedCount: number
    reachRate?: number | null
  }>
}


/**
 * 通の編集の1段。
 *
 * 設計では「配信タイミング」「メッセージ」「この通の配信対象」「送信後の
 * アクション」がそれぞれ別の面になっている。実装は1枚に全部入っていて、
 * 到達タグ・配信後・絞り込み・下書きが「到達時のアクション」という1つの
 * 見出しの下にまとめて並んでいた。**どれがどの面の話なのかが読めない。**
 *
 * 段に分けて、段ごとに設計のNodeを持たせる。1枚ずつ直すと同じ画面を
 * 4回触ることになるので、区切りは一度に入れる。
 */
export function FormSection({
  node,
  title,
  description,
  action,
  children,
}: {
  node?: string
  title: string
  description?: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section
      data-design-node={node}
      className="bg-canvas content-card rounded-card border p-4"
    >
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-ink text-sm font-bold">{title}</h4>
          {description && (
            <p className="text-ink-faint mt-0.5 text-xs leading-relaxed">{description}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
