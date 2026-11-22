/** 予約の受付一覧を、画面確認用の固定データから返す。 */
export function respondBookingReception(_req, res, url, { pool, query, menuName, from, to, limit, offset }) {
  const reception = url.searchParams.get('reception')
  if (!reception) return false
  if (!['all', 'requested', 'unassigned', 'attention'].includes(reception)) {
    res.writeHead(400).end(JSON.stringify({ error: 'invalid_reception_filter' }))
    return true
  }
  const base = pool.filter((item) =>
    ['requested', 'confirmed'].includes(item.status)
    && (!query || (item.friend_name || '').includes(query))
    && (!menuName || item.menu_name === menuName)
    && (!from || item.starts_at >= from)
    && (!to || item.starts_at < to),
  )
  const unassigned = (item) => item.assignment_method === 'automatic' && !item.assignment_reviewed_at
  const attention = (item) => item.status === 'requested' || unassigned(item)
  const filtered = base.filter((item) => reception === 'all' || (reception === 'requested' ? item.status === 'requested' : reception === 'unassigned' ? unassigned(item) : attention(item)))
    .sort((a, b) => Number(attention(b)) - Number(attention(a)) || a.starts_at.localeCompare(b.starts_at) || a.id.localeCompare(b.id))
  res.writeHead(200).end(JSON.stringify({
    requests: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset,
    requestedCount: base.filter((item) => item.status === 'requested').length,
    unassignedCount: base.filter(unassigned).length,
    attentionCount: base.filter(attention).length,
    unknownCount: base.filter((item) => (item.assignment_method ?? 'unknown') === 'unknown').length,
  }))
  return true
}

export function respondBookingRequests(req, res, url, BOOKING_REQUESTS, BOOKING_TODAY_REQUESTS) {
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50)))
    const offset = Math.max(0, Number(url.searchParams.get('offset') || 0))
    const status = url.searchParams.get('status') || 'requested'
    const query = url.searchParams.get('query') || ''
    const menuName = url.searchParams.get('menu_name')
    const from = url.searchParams.get('from')
    const to = url.searchParams.get('to')
    const pool = from && from.startsWith('2026-09-30T15') ? [...BOOKING_REQUESTS, ...BOOKING_TODAY_REQUESTS] : BOOKING_REQUESTS
    if (respondBookingReception(req, res, url, { pool, query, menuName, from, to, limit, offset })) return
    const filtered = pool.filter((item) =>
      (status === 'all' || item.status === status)
      && (!query || (item.friend_name || '').includes(query))
      && (!menuName || item.menu_name === menuName)
      && (!from || item.starts_at >= from)
      && (!to || item.starts_at < to),
    )
    res.writeHead(200).end(JSON.stringify({
      requests: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset,
    }))
    return
}
