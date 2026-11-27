import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { describe, expect, it } from 'vitest'
import type { AffiliateOffer } from '@/lib/api'
import {
  OFFER_CSV_HEADER,
  OFFER_FILTERS,
  OFFER_PAGE_SIZES,
  OFFER_SORTS,
  csvCell,
  offersCsv,
  pageCountOf,
  pageOf,
  selectOffers,
} from './offer-list-view'

const TABS = readFileSync(new URL('../../v8/affiliates/offers.tsx', import.meta.url), 'utf8')
const DISPLAY = readFileSync(new URL('../../v8/affiliates/display.ts', import.meta.url), 'utf8')
const NEW_PAGE = readFileSync(new URL('./new-affiliate-v8.tsx', import.meta.url), 'utf8')

function offer(over: Partial<AffiliateOffer> & { id: string }): AffiliateOffer {
  return {
    name: over.id,
    description: null,
    rewardAmount: null,
    rewardMiles: 0,
    mileageProgramId: 'prog',
    lineAccountId: null,
    tagId: null,
    scenarioId: null,
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

const OFFERS: AffiliateOffer[] = [
  offer({ id: 'a', name: '初回購入', rewardAmount: 500, rewardMiles: 0, isActive: true, createdAt: '2026-03-01T00:00:00.000Z' }),
  offer({ id: 'b', name: '無料相談', description: '面談で成果', rewardAmount: null, rewardMiles: 100, isActive: false, createdAt: '2026-02-01T00:00:00.000Z' }),
  offer({ id: 'c', name: '定期便', rewardAmount: 1200, rewardMiles: 50, isActive: true, createdAt: '2026-01-15T00:00:00.000Z' }),
]

describe("管理画面 案件一覧（GH8VL）の見せ方", () => {
  it('絞り込みの札は読み込んだ行から数えられるものだけ持つ', () => {
    expect(OFFER_FILTERS.map((f) => f.key)).toEqual(['open', 'draft', 'hasYen', 'hasMiles'])
  })

  it('札を押すと、その札に合う案件だけ残る', () => {
    const shown = selectOffers(OFFERS, { filters: ['draft'], query: '', sort: 'newest' })
    expect(shown.map((o) => o.id)).toEqual(['b'])
  })

  it('札を2つ押すと足し合わせる。どちらかに合えば残る', () => {
    const shown = selectOffers(OFFERS, { filters: ['open', 'draft'], query: '', sort: 'newest' })
    expect(shown.map((o) => o.id)).toEqual(['a', 'b', 'c'])
  })

  it('報酬ありの札は、円が0またはnullの案件を外す', () => {
    const shown = selectOffers(OFFERS, { filters: ['hasYen'], query: '', sort: 'newest' })
    expect(shown.map((o) => o.id)).toEqual(['a', 'c'])
  })

  it('検索は案件名と説明の両方を見る', () => {
    expect(selectOffers(OFFERS, { filters: [], query: '定期', sort: 'newest' }).map((o) => o.id))
      .toEqual(['c'])
    expect(selectOffers(OFFERS, { filters: [], query: '面談', sort: 'newest' }).map((o) => o.id))
      .toEqual(['b'])
  })

  it('空白だけの検索語では絞り込まない', () => {
    expect(selectOffers(OFFERS, { filters: [], query: '   ', sort: 'newest' })).toHaveLength(3)
  })

  it('並び順は新しい順・名前順・報酬が高い順の3つが動く', () => {
    expect(OFFER_SORTS.map((s) => s.value)).toEqual(['newest', 'name', 'reward'])
    expect(selectOffers(OFFERS, { filters: [], query: '', sort: 'newest' }).map((o) => o.id))
      .toEqual(['a', 'b', 'c'])
    expect(selectOffers(OFFERS, { filters: [], query: '', sort: 'reward' }).map((o) => o.id))
      .toEqual(['c', 'a', 'b'])
  })

  it('並び替えても元の配列は動かさない', () => {
    const before = OFFERS.map((o) => o.id)
    selectOffers(OFFERS, { filters: [], query: '', sort: 'reward' })
    expect(OFFERS.map((o) => o.id)).toEqual(before)
  })

  it('ページ送りは0件でも1ページ、範囲外のページは最後へ寄せる', () => {
    expect(pageCountOf(0, 20)).toBe(1)
    expect(pageCountOf(41, 20)).toBe(3)
    expect(pageOf([1, 2, 3, 4, 5], 2, 2)).toEqual([3, 4])
    expect(pageOf([1, 2, 3, 4, 5], 99, 2)).toEqual([5])
  })

  it('表示件数は設計の3段', () => {
    expect(OFFER_PAGE_SIZES).toEqual([20, 50, 100])
  })

  it('CSVは列がずれない。カンマ・引用符・改行を含む名前を包む', () => {
    expect(csvCell('あ,い')).toBe('"あ,い"')
    expect(csvCell('あ"い')).toBe('"あ""い"')
    expect(csvCell('あ\nい')).toBe('"あ\nい"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(0)).toBe('0')
  })

  it('CSVは数式として実行されない。=+-@始まりに引用符を付ける', () => {
    expect(csvCell('=1+1')).toBe("'=1+1")
    expect(csvCell('+cmd')).toBe("'+cmd")
    expect(csvCell('-2')).toBe("'-2")
    expect(csvCell('@sum')).toBe("'@sum")
    expect(csvCell('田中')).toBe('田中')
    // 引用符が必要な文字と組み合わさっても守る
    expect(csvCell('=あ,い')).toBe("\"'=あ,い\"")
  })

  it('CSVは画面に出ている行だけを、設計の見出しで書き出す', () => {
    const shown = selectOffers(OFFERS, { filters: ['draft'], query: '', sort: 'newest' })
    const csv = offersCsv(shown, {
      account: () => undefined,
      tag: () => undefined,
      scenario: () => undefined,
      date: (iso) => iso.slice(0, 10),
    })
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe(OFFER_CSV_HEADER.join(','))
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('無料相談')
    expect(lines[1]).toContain('下書き')
    expect(csv).not.toContain('初回購入')
  })

  it('名前が引けない参照は、内部IDを出さず未取得と分かる言葉にする', () => {
    const csv = offersCsv([offer({ id: 'x', name: 'X', tagId: 'tag_9' })], {
      account: () => undefined,
      tag: () => undefined,
      scenario: () => undefined,
      date: () => '2026-01-01',
    })
    expect(csv).toContain('—（名前を確認できません）')
    expect(csv).not.toContain('tag_9')
  })
})

describe("管理画面 案件一覧（GH8VL）の画面", () => {
  it('口の無い「並び順を保存」を操作として置かない', () => {
    // 注記としては書いてよい。押せる形（JSXの本文）で出ていないことを見る。
    expect(TABS).not.toMatch(/>\s*並び順を保存\s*</)
  })

  it('押せない検索欄・並び順を置かない', () => {
    expect(TABS).not.toContain('準備中')
    expect(TABS).not.toMatch(/<SearchField[^>]*disabled/)
  })

  it('参照名を引けなくても内部IDを画面へ出さない', () => {
    expect(TABS).not.toContain('?? offer.lineAccountId')
    expect(TABS).not.toContain('?? offer.tagId')
    expect(TABS).not.toContain('?? offer.scenarioId')
  })
})

describe("管理画面 アフィリエイターを作る（xqT1Z）", () => {
  it("未接続の断り書きは出さない", () => {
    expect(NEW_PAGE).not.toContain('まだ繋がっていません')
  })

  it('URLのコピーは、コードが決まっているときだけ押せる', () => {
    expect(NEW_PAGE).toContain('{issuedUrl ? <div>')
    expect(NEW_PAGE).toContain('<CopyTextButton value={issuedUrl}')
  })

  it('基本情報の作成後に追加情報だけ失敗しても、再押下で同じ人を増やさない', () => {
    expect(NEW_PAGE).toContain('const [createdId, setCreatedId]')
    expect(NEW_PAGE).toContain('let affiliateId = createdId')
    expect(NEW_PAGE).toContain('if (!affiliateId) {')
    expect(NEW_PAGE).toContain('if (!update.success)')
    expect(NEW_PAGE).toContain('もう一度押すと、追加情報だけを保存します。')
  })

  it('割合と保留期間をWorkerが受ける範囲で止める', () => {
    expect(NEW_PAGE).toContain('rate < 0 || rate > 100')
    expect(NEW_PAGE).not.toContain('rate <= 0')
    expect(NEW_PAGE).toContain('!Number.isInteger(days) || days < 0 || days > 365')
  })

  it('KPIの元の承認は打ち切らず全件取る (#505 重大2)', () => {
    // `limit: 200` で止めると数が小さく出て支払い判断を誤る。
    // offset で送って短い頁まで取り、安全弁のときだけ注記を出す。
    expect(DISPLAY).toContain('offset: startOffset + page * APPROVAL_PAGE_SIZE')
    // KPI 用の読み出し（紹介者タブの pending/approved、案件タブの3状態）に
    // 加え、成果承認の作業列も同じ読み方へ替えた(N-207)。「各状態
    // 最大200件」の注記は残さない。
    expect(TABS).not.toContain("api.conversionApprovals.list({ status: 'pending', limit: 200 })")
    expect(TABS).not.toContain('api.conversionApprovals.list({ status, limit: 200 })')
    expect(TABS).not.toContain('合計 ${formatYen(pendingYen)}（直近最大200件）')
    expect(TABS).not.toContain('直近最大200件')
  })
})
