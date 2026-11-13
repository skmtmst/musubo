export const VISUAL_QA_PASSKEYS = [
  { id: 'pk-1', createdAt: '2026-08-20T01:02:03.000Z', lastUsedAt: '2026-09-30T10:02:00.000Z' },
  { id: 'pk-2', createdAt: '2026-09-01T04:05:06.000Z', lastUsedAt: null },
]

export function conversionReportForPeriod(query, report) {
  const from = query.get('from') ?? ''
  const to = query.get('to') ?? ''
  return {
    success: true,
    data: {
      ...report,
      range: { from: `${from} 00:00:00`, to: `${to} 23:59:59`, timeZone: 'Asia/Tokyo' },
      daily: report.daily.filter((item) => item.day >= from && item.day <= to),
    },
  }
}
