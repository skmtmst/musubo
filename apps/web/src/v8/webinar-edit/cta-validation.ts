import type { WebinarCtaCard } from '@/lib/api'

export function fmtMinSec(total: number): string {
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}
export function parseMinSec(text: string): number | null {
  const match = /^(\d{1,4}):([0-5]?\d)$/.exec(text.trim())
  if (match) return Number(match[1]) * 60 + Number(match[2])
  return /^\d{1,7}$/.test(text.trim()) ? Number(text.trim()) : null
}
function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && Boolean(url.hostname)
  } catch {
    return false
  }
}
/** 1枚のカードの欄ごとの誤り。欄の真下に出すので「n枚目」は付けない。 */
export function cardFieldProblems(card: WebinarCtaCard, time: string, durationSeconds: number): { time: string | null; title: string | null; button: string | null; link: string | null } {
  const at = parseMinSec(time)
  const url = card.url?.trim() ?? ''
  return {
    time: at === null
      ? '出す時刻は 分:秒 で入れてください（例：45:00）'
      : durationSeconds > 0 && at > durationSeconds ? `出す時刻が動画の長さ（${Math.floor(durationSeconds / 60)}分）を超えています。動画の中の時刻に直してください` : null,
    title: card.title?.trim() ? null : 'カードの見出しを入れてください',
    button: card.buttonLabel?.trim() ? null : 'ボタンに出す文字を入れてください',
    link: card.kind !== 'form' && card.kind !== 'url' ? 'カードの種類を確認できません。種類を選び直してください'
      : card.kind === 'form'
      ? (card.formId ? null : '公開中のフォームを選ぶか、種類を URL へ変えてください')
      : !url ? 'https:// から始まる URL を入れてください' : !/^https:\/\//.test(url) ? 'URL は https:// で始めてください（http は使えません）' : !isHttpsUrl(url) ? '正しい URL を入れてください' : null,
  }
}
