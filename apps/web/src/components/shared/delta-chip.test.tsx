// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import DeltaChip, { isZeroDelta } from './delta-chip'

afterEach(cleanup)

it('差が 0 の札は出さない（+0・−0・0.0%）', () => {
  for (const text of ['+0', '−0', '0', '0.0%', '±0', '0 pt']) expect(isZeroDelta(text)).toBe(true)
  for (const text of ['+1', '−1', '0.1%', '要確認']) expect(isZeroDelta(text)).toBe(false)
})

it('0 の差は数の横に描かない。0 でない差は今までどおり描く', () => {
  const zero = render(<DeltaChip tone="up">+0</DeltaChip>)
  expect(zero.container.textContent).toBe('')
  cleanup()
  const plus = render(<DeltaChip tone="up">+3</DeltaChip>)
  expect(plus.container.textContent).toContain('+3')
})

it('要確認の札は 0 の文字でも消さない', () => {
  const { container } = render(<DeltaChip tone="attention">0</DeltaChip>)
  expect(container.textContent).toContain('0')
  expect(container.querySelector('svg.lucide-triangle-alert')).not.toBeNull()
  expect(container.querySelector('[data-delta-word]')).toBeNull()
})

it('数の向きと良し悪しを分け、符号は二重にしない', () => {
  for (const [value, direction, expected] of [
    [3, 'up', '+3'], ['3件', 'down', '−3件'], ['+3件', 'down', '+3件'],
    ['−0.6pt', 'down', '−0.6pt'], ['-2', 'down', '-2'], ['＋2', 'up', '＋2'],
    ['¥1,200', 'down', '−¥1,200'], ['—', 'up', '—'], ['比較未取得', 'down', '比較未取得'],
  ] as const) {
    const { container } = render(<DeltaChip tone="up" direction={direction}>{value}</DeltaChip>)
    expect(container.querySelector('span > span')?.textContent).toBe(expected)
    const arrow = container.querySelector('svg[data-delta-direction]')
    if (['—', '比較未取得'].includes(String(value))) expect(arrow).toBeNull()
    else {
      const signed = String(value).startsWith('−') || String(value).startsWith('-') ? 'down' : String(value).startsWith('+') || String(value).startsWith('＋') ? 'up' : direction
      expect(arrow?.getAttribute('data-delta-direction')).toBe(signed)
      expect(arrow?.getAttribute('aria-hidden')).toBe('true')
    }
    expect(container.querySelector('[data-delta-word]')?.textContent ?? null).toBe(['—', '比較未取得'].includes(String(value)) ? null : '改善')
    cleanup()
  }
})

it('子の数値と読み上げを保ち、悪化は赤側の言葉で示す', () => {
  const { container } = render(<DeltaChip tone="down" direction="up"><span aria-hidden="true">+0.3pt</span><span className="sr-only">前より0.3ポイント多い</span></DeltaChip>)
  expect(container.querySelector('span[aria-hidden="true"]')?.textContent).toBe('+0.3pt')
  expect(container.querySelector('.sr-only')?.textContent).toBe('前より0.3ポイント多い')
  expect(container.querySelector('[data-delta-word]')?.textContent).toBe('悪化')
  expect(container.querySelector('[data-delta-direction="up"]')).not.toBeNull()
})
