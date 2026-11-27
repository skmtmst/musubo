/*
 * G2 の言葉と権限（要件 G2 §2-6・§2-7）。
 * 使わない言葉：「ボット」「生成」「プロンプト」「信頼度」。
 */
import type { StatusBadgeTone } from '@/components/shared/status-badge'
import type { AiMode, AnswerAction, QaStatus } from './api'

export const MODE_TITLE: Record<AiMode, string> = {
  off: 'AI を使っていません',
  draft_only: 'AI の使い方：返信案だけ（人が確かめて送る）',
  auto_qa: 'AI の使い方：Q&A で自動で答える',
  suspended: '自動で答えるのを止めています',
}

export const MODE_NOTE: Record<AiMode, string> = {
  off: '使うと、受信箱に要約と返信案が出ます。送るのはいつも担当者です。',
  draft_only: '自動では答えません。公開中の Q&A は返信案の元になります。',
  auto_qa: '公開中の Q&A の答えをそのまま返します。お金・予約の変更・苦情・個人情報の質問は人へ回します。',
  suspended: '届いた質問は人へ回しています。',
}

export const MODE_CHOICE_LABEL: Record<Exclude<AiMode, 'suspended'>, string> = {
  off: '使わない',
  draft_only: '返信案だけ',
  auto_qa: '自動で答える',
}

export const QA_STATUS_LABEL: Record<QaStatus, string> = { draft: '下書き', published: '公開', stopped: '止めた' }
export const QA_STATUS_TONE: Record<QaStatus, StatusBadgeTone> = { draft: 'warning', published: 'success', stopped: 'neutral' }

export const ACTION_LABEL: Record<AnswerAction, string> = {
  answered: '答えた',
  handed_off: '人へ回した',
  customer_asked_human: 'お客さまが「人と話したい」',
}
export const ACTION_TONE: Record<AnswerAction, StatusBadgeTone> = { answered: 'success', handed_off: 'warning', customer_asked_human: 'warning' }

export const HANDOFF_REASON: Record<string, string> = {
  low_confidence: '当たる答えが見つからない',
  money: 'お金の質問',
  booking_change: '予約の変更',
  complaint: '苦情',
  pii: '個人情報を含む',
  media: '画像・スタンプだけ',
  rate: '同じ人に続けて答えた',
  typing: '担当が書いている',
  suspended: 'AI が止まっている',
}

export function handoffReasonText(reason: string | null): string {
  if (!reason) return '—'
  return Object.prototype.hasOwnProperty.call(HANDOFF_REASON, reason) ? HANDOFF_REASON[reason] : '人へ回しました'
}

/** AI の段を変えられる人と、選べる段（要件 §2-6）。 */
export interface AiPermissions {
  /** 要約を見られる（閲覧のみ・代理ログインも見える）。 */
  seeSummary: boolean
  /** 返信案のカード・［入れる］を出す。 */
  useDraft: boolean
  /** Q&A を作る・直す（スタッフは下書きまで）。 */
  editQa: boolean
  /** Q&A を公開・止める・削除する（管理者以上）。 */
  publishQa: boolean
  /** 取り込む（PDF・Web）。 */
  importQa: boolean
  /** ［変える］で選べる段。空なら［変える］を出さない。 */
  modeChoices: Array<Exclude<AiMode, 'suspended'>>
  /** 閲覧のみの帯を出す。 */
  viewer: boolean
}

export function aiPermissions(role: string | null, impersonating: boolean, currentMode: AiMode): AiPermissions {
  const viewer = role === 'viewer'
  const owner = role === 'owner'
  const manager = owner || role === 'admin'
  if (role === null) return { seeSummary: false, useDraft: false, editQa: false, publishQa: false, importQa: false, modeChoices: [], viewer: false }
  if (impersonating) {
    // 代理ログイン：見るだけ。自動で答えるを止める（返信案だけに戻す）ことだけできる（緊急停止）。
    return { seeSummary: true, useDraft: false, editQa: false, publishQa: false, importQa: false, modeChoices: currentMode === 'auto_qa' ? ['draft_only'] : [], viewer: false }
  }
  return {
    seeSummary: true,
    useDraft: !viewer,
    editQa: !viewer,
    publishQa: manager,
    importQa: manager,
    modeChoices: owner ? ['off', 'draft_only', 'auto_qa'] : manager ? ['off', 'draft_only'] : [],
    viewer,
  }
}
