'use client'

import type { ApiResponse } from '@line-crm/shared'


/* Pencil の6枚のHTMLをもとにした投稿画面。既存の審査APIを接続する。 */
export type PhotoStatus = 'pending' | 'adopted' | 'rejected'

export type PhotoView = 'list' | 'detail' | 'publications'

export type ReviewReasonCode = 'quality' | 'privacy' | 'unrelated' | 'duplicate' | 'other'

/* 見送った理由（管理画面 と同じ5つ。選ぶとお客様への文章が自動でつくられる）。 */
export const REVIEW_REASONS: Array<{ value: ReviewReasonCode; label: string; message: string }> = [
  { value: 'quality', label: '暗くて見えにくいです', message: '明るいところで、もう一度お願いできますか。' },
  { value: 'privacy', label: 'ほかの人の顔が写っています', message: 'うしろに他のお客様が写っているようです。もう一度お願いできますか。' },
  { value: 'unrelated', label: 'ほかのお店のロゴや商品名が写っています', message: '商品の名前が入っていない写真をいただけますか。' },
  { value: 'duplicate', label: '同じ写真をすでにもらっています', message: 'すでにいただいた写真と重複しているようです。別のお写真をお願いできますか。' },
  { value: 'other', label: '自分で書く', message: '文章をそのまま書きます。' },
]

// 送信文の理由名は Worker の photoReviewMessage と同じにする。
export const SENT_REASON_LABELS: Record<ReviewReasonCode, string> = {
  quality: '写真が暗い・ぼやけている',
  privacy: '人の顔や個人情報が写っている',
  unrelated: 'ペットと関係のない内容が写っている',
  duplicate: '同じ写真がすでに投稿されている',
  other: 'そのほか',
}

export const PHOTO_PAGE_SIZE = 200

export function photoPagePath(accountId: string, offset: number, q = ''): string {
  const params = new URLSearchParams({ accountId, limit: String(PHOTO_PAGE_SIZE) })
  const safeOffset = Number.isFinite(offset) ? Math.trunc(offset) : 0
  if (safeOffset > 0) params.set('offset', String(safeOffset))
  const query = typeof q === 'string' ? q.trim() : ''
  if (query) params.set('q', query)
  return `/api/nen-members/photos?${params.toString()}`
}

export type PhotoPageResponse = ApiResponse<Array<Record<string, unknown>>>

/** 板ごとの data-design-node（札・見せ方で切り替える外枠の印）。 */
export function boardNode(view: PhotoView, status: PhotoStatus, canEdit: boolean): string {
  if (view === 'publications') return 'SyQA1'
  if (status === 'adopted') return 'cniyw'
  if (!canEdit) return 'Jn95h'
  return 'TkA4D'
}
