import type { AccountStyle } from '@line-crm/shared'
import { styleTerm } from '@/lib/terms'

/** 予約の共通画面も、業種ダッシュボードと同じ辞書を使う。EC併用予約は標準語。 */
export function bookingWords(style?: AccountStyle | null) {
  const key = style === 'ec' || !style ? 'standard' : style
  const changed = key === 'consult' || key === 'lesson'
  const actions = styleTerm(key, 'V18').match(/［([^］]+)］/gu)?.map(value => value.slice(1, -1))
  return {
    noun: changed ? styleTerm(key, 'V05') : '予約', active: changed || key === 'salon' ? styleTerm(key, 'V15') : '来店中',
    person: styleTerm(key, 'V12').split('（')[0], menu: styleTerm(key, 'V07'), staff: styleTerm(key, 'V10').split('／')[0],
    completed: changed ? styleTerm(key, 'V16') : '来店した', absent: changed ? styleTerm(key, 'V17') : '来なかった',
    completeAction: changed ? actions?.[0] ?? styleTerm(key, 'V16') : '来店した',
    mark: changed ? `${styleTerm(key, 'V16')}の印` : '来店の印',
    planned: changed ? `${styleTerm(key, 'V05')}の予定` : '来店予定',
    history: changed ? `${styleTerm(key, 'V05')}の履歴` : '来店履歴',
    /* 予約を入れるボタン（TM-V20）。面談・教室は言い換え、ほかは電話で受けた予約を入れる今の言葉。 */
    create: changed ? styleTerm(key, 'V20') : '電話の予約を入れる',
  }
}
