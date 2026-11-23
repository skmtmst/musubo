import type { RestaurantReservationAllergy } from '@line-crm/shared'
/*
 * ウォークイン（予約なしの来店）を入れる口。ここ1か所にまとめる。
 *
 * いまは「予約なしの来店」の口が無い（Codex が作り中）ので、今ある手動予約の口
 * （POST /api/restaurant-test/reservations/manual）でその場の時刻から2時間の予約を作り、
 * すぐ来店の印（POST /api/restaurant-test/reservations/:id/visit kind=visited）を付ける。
 * 口ができたら seatWalkIn の中身だけを差し替える（画面は変えない）。
 */
import { restaurantTestApi, type RestaurantReservation } from '@/lib/restaurant-test-api'
import { STAY_MINUTES } from './slots'

/** ウォークインで作った予約の印（メモの頭）。数の内訳でウォークインを数えるのに使う。 */
export const WALK_IN_NOTE = 'ウォークイン（予約なしの来店）'

export function isWalkIn(row: Pick<RestaurantReservation, 'source' | 'note'>): boolean {
  return row.source === 'manual' && (row.note ?? '').startsWith('ウォークイン')
}

export type WalkInResult = { id: string; seated: boolean }

export async function seatWalkIn(accountId: string, input: { storeId: string; guestCount: number; tableId: string; now?: Date; allergies?: RestaurantReservationAllergy[] }): Promise<WalkInResult> {
  const start = input.now ?? new Date()
  const created = await restaurantTestApi.createReservation(accountId, {
    storeId: input.storeId,
    source: 'manual',
    customerName: 'ウォークイン',
    guestCount: input.guestCount,
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + STAY_MINUTES * 60_000).toISOString(),
    tableId: input.tableId,
    allergies: input.allergies,
    note: WALK_IN_NOTE,
    notifyLine: false,
  })
  try {
    await restaurantTestApi.postSeatVisitMark(accountId, created.data.id, { kind: 'visited',expectedVersion:1,requestId:crypto.randomUUID() })
    return { id: created.data.id, seated: true }
  } catch {
    /* 予約は入った。来店の印だけ付かなかったことを画面が知らせる。 */
    return { id: created.data.id, seated: false }
  }
}
