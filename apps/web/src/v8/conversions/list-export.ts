
export function downloadCsvBlob(blob: Blob, filename: string): void {
  const href = URL.createObjectURL(blob)
  try {
    const anchor = document.createElement('a')
    anchor.href = href
    anchor.download = filename
    anchor.click()
  } finally {
    URL.revokeObjectURL(href)
  }
}


export const DAY_MS = 24 * 60 * 60 * 1000

export function definitionRange(days: number): { from: string; to: string } {
  const safeDays = typeof days === 'number' && Number.isFinite(days) && days >= 1 ? Math.floor(days) : 1
  const end = new Date()
  const start = new Date(end.getTime() - (safeDays - 1) * DAY_MS)
  const format = (value: Date) => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(value)
  return { from: format(start), to: format(end) }
}
