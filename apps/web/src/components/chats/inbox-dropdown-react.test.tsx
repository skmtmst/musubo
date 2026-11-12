// @vitest-environment happy-dom
/*
 * 担当者の選び口（OperatorDropdown）を描いて見る。行の並びは inbox-dropdown.test.ts が見る。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { OperatorDropdown } from './inbox-dropdown'

afterEach(() => { cleanup() })

const OPERATORS = [
  { id: 'operator-1', name: '見本 太郎' },
  { id: 'operator-2', name: ' 見本 112' },
]

describe('担当者の選び口', () => {
  it('担当者は顔の印（名前の1文字目）と名前を並べ、未割り当ては「－」の印', () => {
    render(<OperatorDropdown value="all" operators={OPERATORS} onChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '担当者を選ぶ' }))
    const row = (name: string) => screen.getAllByRole('option').find((option) => option.textContent?.includes(name))!
    expect(row('見本 太郎').textContent).toMatch(/^見見本 太郎/)
    // 名前の前の空白は印にしない。
    expect(row('見本 112').textContent).toMatch(/^見 見本 112/)
    expect(row('未割り当て').textContent).toMatch(/^－未割り当て/)
  })

  it('未読数を取得できないときは数を「—」にし、理由と次の行動を注意の帯で出す', () => {
    render(<OperatorDropdown value="all" operators={OPERATORS} onChange={vi.fn()} unreadOf={() => null} unreadUnavailable />)
    fireEvent.click(screen.getByRole('button', { name: '担当者を選ぶ' }))
    expect(screen.getAllByRole('option').find((option) => option.textContent?.includes('見本 太郎'))!.textContent).toContain('—')
    const notice = screen.getByText('未読の数をいま数えられません').closest('[data-tone]')
    expect(notice?.getAttribute('data-tone')).toBe('warn')
    expect(notice?.textContent).toContain('0件とは違います。少し待ってからもう一度開いてください。')
  })

  it('取得できているときは帯を出さない', () => {
    render(<OperatorDropdown value="all" operators={OPERATORS} onChange={vi.fn()} unreadOf={() => 2} />)
    fireEvent.click(screen.getByRole('button', { name: '担当者を選ぶ' }))
    expect(screen.queryByText('未読の数をいま数えられません')).toBeNull()
  })
})
