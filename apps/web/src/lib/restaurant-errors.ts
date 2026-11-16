import { ApiError } from './api'

/** 卓の使用中を、版の競合や人数・休業の制約と区別する。 */
export function isRestaurantTableConflict(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === 'table_conflict' && error.status === 409
}
