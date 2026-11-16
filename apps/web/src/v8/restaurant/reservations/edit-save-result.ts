import { ApiError } from '@/lib/api'

/** 入力を残して、その編集窓で直せる失敗だけを返す。 */
export type ReservationEditSaveResult = { saved: boolean; inputError?: unknown }

export function isReservationInputError(error: unknown): error is ApiError {
  return error instanceof ApiError && (error.status === 400 || error.status === 422
    || error.status === 409 && (error.code === 'availability_conflict' || error.code === 'table_conflict'))
}
