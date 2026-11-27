import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

const PAGE = fs.readFileSync(path.join(__dirname, '../../v8/inflow-links/rows.ts'), 'utf8')
const DETAIL = fs.readFileSync(path.join(__dirname, '../../v8/inflow-links/detail.tsx'), 'utf8')

/**
 * IDEA-18「流入と計測」: 経路→友だち→注文・返金を同じ条件で結び、
 * 集計と明細がつき合わせられること、未計測を0件と見せないことを
 * 画面側の契約として固定する。
 */
describe('IDEA-18: 経路別の購入・返金は集計と明細で同じ口から出す', () => {
  it('経路別集計の購入・返金・取消をAPIの型に持つ', () => {
    expect(PAGE).toContain('orderCount?:')
    expect(PAGE).toContain('refundedOrderCount?:')
    expect(PAGE).toContain('cancelledOrderCount?:')
  })

  it('詳細ページにも同じ明細を置き、購入・返金カードは明細の集計と同じ値を使う', () => {
    expect(DETAIL).toContain('import RefOrdersPanel')
    expect(DETAIL).toContain('注文の明細')
    expect(DETAIL).toContain('返金・取消')
    // カードの数はパネルが取った集計(onSummaryChange)と同じ口
    expect(DETAIL).toContain('onSummaryChange={setOrdersSummary}')
    expect(DETAIL).toContain('ordersSummary ? formatNumber(ordersSummary.total)')
  })
})

describe('IDEA-18: 読めていない注文を0件と見せない', () => {
  it('詳細の購入カードは集計を取れていないとき数を出さない', () => {
    // ordersSummary が null のままなら「—」表示
    expect(DETAIL).toContain('ordersSummary ? formatNumber(ordersSummary.total)')
    expect(DETAIL).toContain('集計を取得できていません')
  })
})
