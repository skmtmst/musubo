import { knownValue } from '@/lib/known-value'
/*
 * ★V8 テンプレートの一覧で使う言葉と、読み込みの状態の分け方。
 * 今までの一覧（app/templates の list-state-kind・template-message-type・
 * template-delete-message）から写した。import はしない（src/v8 の決まり）。
 */
import { ApiError } from '@/lib/api'

export type TemplatesFailureKind = 'forbidden' | 'error'

export interface TemplatesFailure {
  kind: TemplatesFailureKind
  title: string
  description: string
}

/** 読み込めなかった理由。権限が無いのと、通信の失敗を混ぜない。 */
export function failureOf(error: unknown): TemplatesFailure {
  if (error instanceof ApiError && error.status === 403) {
    return {
      kind: 'forbidden',
      title: '見る権限がありません',
      description: '見るには権限が要ります。オーナーか管理者に追加を依頼してください。',
    }
  }
  return {
    kind: 'error',
    title: '読み込めませんでした',
    description: '通信が途切れたか、応答がありませんでした。',
  }
}

export function failureOfResponse(): TemplatesFailure {
  return {
    kind: 'error',
    title: '読み込めませんでした',
    description: '時間をおいて、もう一度読み直してください。',
  }
}

export type TemplatesListView = 'loading' | 'forbidden' | 'error' | 'empty' | 'no-match' | 'ready'

/** 一覧に何を出すか。読込中・失敗・権限不足・空・0件を混ぜない。 */
export function listView(input: {
  loading: boolean
  failure: TemplatesFailure | null
  total: number
  matched: number
}): TemplatesListView {
  if (input.loading) return 'loading'
  if (input.failure) return input.failure.kind
  if (input.total === 0) return 'empty'
  if (input.matched === 0) return 'no-match'
  return 'ready'
}

/** 「テンプレートを作る」を押せない理由。押せるときは null。 */
export function createBlockedReason(input: {
  loading: boolean
  failure: TemplatesFailure | null
}): string | null {
  if (input.loading) return '読み込んでいます'
  if (input.failure?.kind === 'forbidden') return '操作する権限がありません'
  if (input.failure) return '読み込めませんでした。読み直してからお試しください。'
  return null
}

/** 種類の呼び方。LINE の作りの名前（flex・carousel）を運用の言葉にする。知らない種類は「その他」。 */
const MESSAGE_TYPE_LABELS: Record<string, string> = {
  text: 'テキスト',
  image: '画像',
  flex: 'カード型',
  carousel: 'カルーセル',
  question: '質問',
}

export function messageTypeText(type: string): string {
  return knownValue(MESSAGE_TYPE_LABELS, type, 'その他')
}

/** 削除の確認窓の説明。使っていないものだけがここへ来る。 */
export const DELETE_UNUSED_DESCRIPTION =
  'どこからも使われていないので、ほかの画面の動きは止まりません。すでに送ったメッセージは残ります。'

/** 削除できない窓の説明。 */
export function blockedDeleteDescription(usageCount: number): string {
  return `${usageCount} か所で使われています。消すと、その配信や自動応答が送れなくなるためです。先に別のテンプレートへ差し替えてください。`
}

/** 一斉配信の状態の札。 */
function broadcastStatusText(status: string): string {
  if (status === 'scheduled') return '予約済み'
  if (status === 'sending') return '送信中'
  if (status === 'sent') return '送信済み'
  if (status === 'draft') return '下書き'
  return '状態を確認できません'
}

/** 削除できない窓に出す「使っている所」の明細（`api.templates.usages` の返り）。 */
export interface UsageDetail {
  autoReplies?: Array<{ id: string; keyword: string; lineAccountId: string | null; templateVersion: number | null }>
  automations?: Array<{ id: string; name: string; eventType: string }>
  scenarioSteps?: Array<{ scenarioId: string; scenarioName: string; stepId: string; stepOrder: number; displayOrder?: number; templateVersion: number | null }>
  reminderSteps?: Array<{ reminderId: string; reminderName: string; stepId: string }>
  richMenuAreas?: Array<{ groupId: string; groupName: string; pageName: string; areaId: string; label: string | null }>
  trackedLinks?: Array<{ id: string; name: string }>
  broadcasts?: Array<{ broadcastId: string; title: string; status: string; scheduledAt: string | null; templateVersionNumber: number | null; referenceMode: 'fixed' | 'latest' }>
  reminderEnrollments?: Array<{ enrollmentId: string; reminderId: string; reminderName: string; versionNumber: number; enrollmentStatus: string; targetDate: string }>
}

export interface UsageRow {
  key: string
  /** 左の種類（一斉配信・自動応答など）。 */
  kind: string
  /** 使っている所の名前。 */
  name: string
  /** 状態（一斉配信の予約済みなど）。名前の title で見せる。 */
  status?: string
  /** 開ける画面。旧形式のオートメーションは開けないので null。 */
  href: string | null
}

/** 「使っている所」の明細を、開ける画面への行へ並べる（今までの一覧と同じ分け方・同じ行き先）。 */
export function usageRows(detail: UsageDetail): UsageRow[] {
  return [
    ...(detail.broadcasts ?? []).map((u) => ({
      key: `broadcast-${u.broadcastId}`,
      kind: '一斉配信',
      name: u.title,
      status: broadcastStatusText(u.status),
      href: `/broadcasts/detail?id=${u.broadcastId}`,
    })),
    ...(detail.autoReplies ?? []).map((u) => ({
      key: `auto-reply-${u.id}`,
      kind: '自動応答',
      name: u.keyword,
      href: `/auto-replies/edit?id=${u.id}`,
    })),
    ...(detail.scenarioSteps ?? []).map((u) => ({
      key: `scenario-${u.stepId}`,
      kind: 'シナリオ配信',
      name: `${u.scenarioName}・${u.displayOrder ?? u.stepOrder} 通目`,
      href: `/scenarios/detail?id=${u.scenarioId}`,
    })),
    ...(detail.reminderSteps ?? []).map((u) => ({
      key: `reminder-${u.stepId}`,
      kind: 'リマインダ',
      name: u.reminderName,
      href: `/reminders/edit?id=${u.reminderId}`,
    })),
    // 旧公開版に固定された登録は版と状態を出す。
    ...(detail.reminderEnrollments ?? []).map((u) => ({
      key: `reminder-enrollment-${u.enrollmentId}`,
      kind: 'リマインダ',
      name: `${u.reminderName} 第${u.versionNumber}版（${u.enrollmentStatus === 'cancelled' ? '取消ずみ' : u.enrollmentStatus === 'active' ? '送信待ち' : u.enrollmentStatus === 'completed' ? '完了' : '状態を確認できません'}）`,
      href: `/reminders/detail?id=${u.reminderId}`,
    })),
    ...(detail.richMenuAreas ?? []).map((u) => ({
      key: `rich-menu-${u.areaId}`,
      kind: 'リッチメニュー',
      name: `${u.groupName}・${u.pageName}`,
      href: `/rich-menus/edit?id=${u.groupId}`,
    })),
    ...(detail.trackedLinks ?? []).map((u) => ({
      key: `tracked-link-${u.id}`,
      kind: '流入リンク',
      name: u.name,
      href: `/inflow-links/detail?id=${u.id}`,
    })),
    ...(detail.automations ?? []).map((u) => ({
      key: `automation-${u.id}`,
      kind: u.eventType === 'inbox_favorite' ? '受信箱' : 'オートメーション',
      name: u.eventType === 'inbox_favorite' ? '「よく使う」（担当が登録）' : `${u.name}（旧形式・画面からは開けません）`,
      href: null,
    })),
  ]
}
