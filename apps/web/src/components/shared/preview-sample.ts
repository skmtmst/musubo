/**
 * 下見（LINEの見え方・お客さまの画面の見本）で、差し込みの記号を見本の値に置き換える。
 *
 * 送るときに置き換わる形（{{name}}・{{reservation_datetime}} など）と、古い書き方（{名前}・{予約日時}）の
 * どちらも、記号のままスマホに出さない。値はここ1か所で持ち、画面ごとに別の見本を書かない。
 */
export const PREVIEW_SAMPLE = {
  name: '見本 143',
  date: '10月2日',
  time: '18:00',
  dateTime: '10月2日 18:00',
  account: 'お店の名前',
  url: 'https://example.com/sample',
  field: '見本の登録値',
  other: '見本の値',
} as const

export type PreviewSampleKind = 'name' | 'date' | 'other'

const DOUBLE = /\{\{\s*([^{}]+?)\s*\}\}/g
/** 古い書き方は日本語の名前だけを拾う（JSON などの波かっこは触らない）。 */
const SINGLE = /\{([぀-ヿ一-鿿々ー・]+)\}/g

function sampleFor(key: string): { value: string; kind: PreviewSampleKind } {
  const k = key.trim()
  if (k === 'name' || k === 'friend.name' || k === '名前' || k === 'お名前' || k === '友だちの名前') return { value: PREVIEW_SAMPLE.name, kind: 'name' }
  if (k === 'reservation_datetime' || k === '予約日時' || k === '日時') return { value: PREVIEW_SAMPLE.dateTime, kind: 'date' }
  if (k === 'date' || k.startsWith('date:') || k.startsWith('date+') || k === '日付' || k === '予約日' || k === '来店日') return { value: PREVIEW_SAMPLE.date, kind: 'date' }
  if (k === '時刻' || k === '予約時刻' || k === 'time') return { value: PREVIEW_SAMPLE.time, kind: 'date' }
  if (k.startsWith('days_until:')) return { value: 'あと3日', kind: 'date' }
  if (k === 'account.name' || k === '店名' || k === 'アカウント名') return { value: PREVIEW_SAMPLE.account, kind: 'other' }
  if (k === 'meet_url' || k.endsWith('_url') || k === 'URL') return { value: PREVIEW_SAMPLE.url, kind: 'other' }
  if (k.startsWith('field.')) return { value: PREVIEW_SAMPLE.field, kind: 'other' }
  return { value: PREVIEW_SAMPLE.other, kind: 'other' }
}

/** 差し込みを見本の値にした文と、置き換えた種類。置き換えが無ければ `kinds` は空。 */
export function fillPreviewSample(text: string): { text: string; kinds: PreviewSampleKind[] } {
  const kinds = new Set<PreviewSampleKind>()
  const swap = (_: string, key: string) => {
    const sample = sampleFor(key)
    kinds.add(sample.kind)
    return sample.value
  }
  const filled = text.replace(DOUBLE, swap).replace(SINGLE, swap)
  return { text: filled, kinds: [...kinds] }
}

/** 下見の下に小さく添える言葉。置き換えが無ければ null。 */
export function previewSampleNote(kinds: readonly PreviewSampleKind[]): string | null {
  if (kinds.length === 0) return null
  if (kinds.includes('name')) return kinds.includes('date') ? '名前と日時は見本です' : '名前は見本です'
  if (kinds.includes('date')) return '日時は見本です'
  return '差し込んだ値は見本です'
}
