import { EVENT_DETAIL, EVENT_SLOTS } from './fixtures.mjs'

export const EVENT_ADMIN_RAW_PATTERNS = [
  [/^\/api\/events\/admin\/events\/[^/]+$/, EVENT_DETAIL],
  [/^\/api\/events\/admin\/events\/[^/]+\/slots$/, { items: EVENT_SLOTS }],
  [/^\/api\/events\/admin\/events\/[^/]+\/bookings\/summary$/, {
    total: 6, requested: 2, confirmed: 3, rejected: 0, cancelled: 1, expired: 0, attended: 0, noShow: 0,
    waitlist: 2, requestedSeats: 2, confirmedSeats: 3, waitingSeats: 2, offeredSeats: 0, activeSeats: 5, totalCapacity: 36,
  }],
]
