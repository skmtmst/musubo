import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const PAGE = readFileSync(new URL('../../v8/events/list.tsx', import.meta.url), 'utf8')
// cronからの実行は Worker cron-event-waitlist.test.ts、回収は event-waitlist.test.ts で守る。
const WAITLIST = readFileSync(new URL('../../../../worker/src/services/event-waitlist.ts', import.meta.url), 'utf8')

describe('V8 イベント予約の件数状態', () => {
  it('全体平均でなく、次に声をかける回を帯へ出す', () => {
    expect(PAGE).toContain('daysUntilIso(kpi.nearest_low_starts_at)')
  })

  it('終わった回は端末時計で数えず、重複する集計帯ごと出さない(点検#520軽16)', () => {
    // 下の集計カードと同じ数字は重複させない。終わった回は数えない。
    expect(PAGE).not.toContain('一覧の集計（表示のみ）')
    expect(PAGE).not.toContain('終わった回 <strong')
    expect(PAGE).not.toContain('endedCount')
  })

  it('席が空いたあとの自動案内を、実際の定期処理があるときだけ案内する', () => {
    expect(PAGE).toContain('キャンセルが出たら、キャンセル待ちの人に自動で順番が回ります。')
    expect(WAITLIST).toContain('enqueueEventWaitlistPromotion')
    expect(WAITLIST).toContain('DEFAULT_OFFER_HOURS = 24')
  })
})
