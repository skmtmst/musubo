import type { WebinarCtaCard } from '@/lib/api'
import { fmtMinSec } from './cta-validation'
import { emptyValue } from '@/components/shared/empty-value'

export function describeCard(card: WebinarCtaCard | undefined, time?: string): string {
  if (!card) return '（なし）'
  const text = (value: unknown, empty: string) => value == null || value === '' ? empty : typeof value === 'string' ? value : '確認できません'
  const title = text(card.title, '（見出しなし）')
  const button = text(card.buttonLabel, '（言葉なし）')
  const timing = time != null ? `${time}から` : Number.isSafeInteger(card.atSeconds) && card.atSeconds >= 0 ? `${fmtMinSec(card.atSeconds)}から` : '時刻を確認できません'
  return `「${title}」／ボタン「${button}」／${timing}`
}

/** 最新が未取得なら「無し」と混ぜず、両方の枚数まで比べる。 */
export function buildCompareRows(mine: { formName: string; cards: WebinarCtaCard[]; formId?: string | null; times?: string[] }, theirsFormName: string, theirsCards: WebinarCtaCard[] | null) {
  const rows = [{ key: 'form', label: '申込フォーム', mine: mine.formName, theirs: theirsFormName }]
  for (let index = 0; index < Math.max(mine.cards.length, theirsCards?.length ?? 0); index += 1) {
    rows.push({ key: `card-${index}`, label: `カード${index + 1}`, mine: describeCard(mine.cards[index], mine.times?.[index]), theirs: theirsCards === null ? emptyValue('unknown') : describeCard(theirsCards[index]) })
  }
  return rows
}
