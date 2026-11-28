// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import KpiDelta from './kpi-delta'

describe('比較する数が不正な場合', () => {
  it('増減を断定せず確認できないと表示する', () => {
    render(<KpiDelta current={Number.NaN} previous={10} better="high" unit="人" />)
    expect(screen.getByText('比較を確認できません')).toBeTruthy()
    expect(screen.queryByText(/NaN/)).toBeNull()
  })
})
