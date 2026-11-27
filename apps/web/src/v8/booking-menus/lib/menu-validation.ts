import { ApiError } from '@/lib/api'

export type BookingMenuBaseDraft = {
  name: unknown
  durationMinutes: unknown
  bufferAfterMinutes?: unknown
  sortOrder?: unknown
  assignedStaffCount: unknown
}

/** 名前欄1欄の直し方。欄を離れたときに出す文。保存時と同じ文。 */
export function bookingMenuNameError(name: unknown): string | null {
  if (typeof name !== 'string' || !name.trim()) {
    return 'メニュー名を入力してください'
  }
  if (name.trim().length > 200) {
    return 'メニュー名は200文字以内で入力してください'
  }
  return null
}

function parseStrictNumber(value: unknown, allowEmptyAsZero = false): number {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return allowEmptyAsZero ? 0 : Number.NaN
    return Number(trimmed)
  }
  return Number.NaN
}

/** かかる時間1欄の直し方。欄を離れたときに出す文。保存時と同じ文。 */
export function bookingMenuDurationError(durationMinutes: unknown): string | null {
  const duration = parseStrictNumber(durationMinutes)
  if (!Number.isInteger(duration) || duration < 1 || duration > 1440) {
    return '所要時間は1〜1440分の整数で入力してください'
  }
  return null
}

/** 後の空き時間1欄の直し方。欄を離れたときに出す文。保存時と同じ文。 */
export function bookingMenuBufferError(bufferAfterMinutes: unknown): string | null {
  const buffer = bufferAfterMinutes === undefined ? 0 : parseStrictNumber(bufferAfterMinutes, true)
  if (!Number.isInteger(buffer) || buffer < 0 || buffer > 1440) {
    return '後の空き時間は0〜1440分の整数で入力してください'
  }
  return null
}

/** 作成画面と編集窓で同じ基準を使い、保存前に直せる入力不備を出す。 */
export function bookingMenuError(draft: BookingMenuBaseDraft): string | null {
  if (!draft || typeof draft !== 'object') return 'メニュー名を入力してください'
  const nameError = bookingMenuNameError(draft.name)
  if (nameError !== null) return nameError
  const durationError = bookingMenuDurationError(draft.durationMinutes)
  if (durationError !== null) return durationError
  const bufferError = bookingMenuBufferError(draft.bufferAfterMinutes)
  if (bufferError !== null) return bufferError
  const sortOrder = draft.sortOrder === undefined ? 0 : parseStrictNumber(draft.sortOrder, true)
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 1_000_000) {
    return '並び順は0〜1000000の整数で入力してください'
  }
  const assignedStaffCount = parseStrictNumber(draft.assignedStaffCount)
  if (!Number.isInteger(assignedStaffCount) || assignedStaffCount < 1) {
    return '担当できる人を1人以上選んでください。0人だと予約画面に枠が出ません'
  }
  return null
}

export function bookingErrorMessage(error: unknown, action: '読み込み' | '保存'): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return `予約メニューを${action}する権限がありません。`
    if (error.status === 409) return `ほかの変更と重なったため、予約メニューを${action}できませんでした。`
  }
  return `予約メニューを${action}できませんでした。通信状態を確認して、もう一度お試しください。`
}

export function bookingRulesErrorMessage(error: unknown, action: '読み込み' | '保存'): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return `予約の基本ルールを${action}する権限がありません。`
    if (error.status === 409) return 'ほかの担当者が先に保存しました。最新の内容を読み直してから、もう一度変更してください。'
  }
  return `予約の基本ルールを${action}できませんでした。通信状態を確認して、もう一度お試しください。`
}
