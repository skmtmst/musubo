import { readUiSource as readFileSync } from '../../../scripts/test-ui-source.mjs'
import { describe, expect, it } from 'vitest'

const KPI = readFileSync(new URL('./kpi-collapse.tsx', import.meta.url), 'utf8')

/**
 * #975 U060: 390pxで4枚以上の集計カードが日常作業を画面外へ
 * 押し出さない。先頭2件だけを出し、残りは「集計を見る」で開く。
 */
describe('KPIの折りたたみ部品（#975 U060）', () => {
  it('狭い幅では先頭2件だけを出し、残りは開いて見る', () => {
    expect(KPI).toContain('mobileVisible = 2')
    expect(KPI).toContain('max-sm:hidden')
    expect(KPI).toContain('aria-expanded={open}')
    expect(KPI).toContain('件の集計を見る')
  })

  it('640px以上では全件を並べる（開閉ボタンは狭い幅だけ）', () => {
    expect(KPI).toContain('sm:hidden')
  })
})

// V8で数の帯へ作り直した画面は、旧KpiCollapseの採用を強制しない。
// 集計を消さず、狭い幅で帯を2列にする現在の仕組みを確認する。
describe('V8の数の帯とメンバー一覧', () => {
  const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

  it('ダッシュボードは共通の数の帯へ集約する', () => {
    const source = read('v8/dashboard/dashboard.tsx')
    expect(source).toContain('<KpiBand')
    expect(source).toContain('presentation="band"')
    expect(source).toContain('todayCells.map')
  })

  it('ウェビナーは数の帯を狭い幅で1列にする', () => {
    expect(read('app/webinars/list-v8.tsx')).toContain('<KpiBand>')
    expect(read('components/shared/kpi-card.module.css')).toMatch(/@media \(max-width: 639px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/)
  })

  it('自動応答V8は集計を共通の数の帯へ渡す', () => {
    const page = read('v8/auto-replies/list.tsx')
    expect(page).toContain("import KpiBand from '@/components/shared/kpi-band'")
    expect(page).toContain('<KpiBand data-design="KPIs">')
    expect(page).toContain('kpis.map((kpi) => (')
    expect(page).toContain('presentation="band"')
    const shared = read('components/shared/kpi-band.tsx')
    expect(shared).toContain('data-kpi-strip')
    const css = read('components/shared/kpi-band-v8.css')
    expect(css).toMatch(/@media \(max-width: 639px\)[\s\S]*?grid-auto-flow: row;/)
  })

  it('写真審査は集計4件を狭い板で2列にする', () => {
    const page = read('app/nen-members/photo-review-v8.tsx')
    expect(page.match(/<KpiCard\b/g)).toHaveLength(4)
    expect(read('components/shared/kpi-card.module.css')).toMatch(/@media \(max-width: 639px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/)
  })

  it('LINE通知の数の帯は小さい幅で1列、640px以上で2列にする', () => {
    const page = read('app/line-notifications/page.tsx')
    expect(page).toContain('<KpiBand presentation="band"')
    expect(read('components/shared/kpi-card.module.css')).toMatch(/@media \(max-width: 639px\)[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/)
    expect(page).toContain('kpisWithSendCountsState.map(renderKpiCard)')
  })
})

/** 旧来の折りたたみ部品を引き続き使う画面。 */
describe('KPI折りたたみの適用（#975 U060）', () => {
  const targets: Array<[string, string]> = [
    ['v8/conversions/list.tsx', 'KpiBand'],
    ['v8/automations/shell.tsx', 'KpiBand'],
    ['app/automations/runs/page.tsx', 'KpiBand'],
    // app/hq/page.tsx は V8 のホーム（v8/hq/home.tsx・絵どおりの数の帯）を出すだけになったので外した（2026-10-09 管理画面 削除）。
    ['v8/nen-campaigns/list.tsx', 'KpiBand'],
    ['v8/settings/ec-commerce/screen.tsx', 'KpiBand'],
    ['v8/settings/emergency/history-details.tsx', 'KpiBand'],
    ['v8/nen-members/members.tsx', 'KpiBand'],
    ['v8/nen-members/members.tsx', 'KpiBand'],
    ['v8/nen-pets/pets.tsx', 'KpiBand'],
    ['v8/nen-health/health.tsx', 'KpiBand'],
    ['v8/hq-banners/list.tsx', 'KpiBand'],
  ]

  for (const [path, marker] of targets) {
    it(`${path} が KpiCollapse を使う`, () => {
      const source = readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
      expect(source).toContain(marker === 'KpiBand' ? `from '@/components/shared/kpi-band'` : `from '@/components/ui/kpi-collapse'`)
      expect(source).toContain(`<${marker}`)
    })
  }
})
