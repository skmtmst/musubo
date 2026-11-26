// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { NenHealthRow } from '@/lib/nen-pets-api'
import { changeBadges, countText, Pill, SKIN_LABELS, TEAR_LABELS } from './parts'

afterEach(cleanup)
it.each(['toString', 'constructor', '__proto__', 'future'])('未知の変化 %s は記録の説明を表示する', (key) => {
  const row = { count30d: 1, changes: [{ key, label: '見本の変化', tone: 'warn' }] } as unknown as NenHealthRow
  render(<>{changeBadges(row).map((badge) => <Pill key={badge.key} tone={badge.tone}>{badge.label}</Pill>)}</>)
  expect(screen.getByText('見本の変化')).toBeTruthy()
})
it.each(['toString', 'constructor', '__proto__', 'future'])('未知の記録 %s は受け取った種類と件数を表示する', (key) => {
  const counts = Object.fromEntries([[key, 2]])
  render(<div>{countText(counts, { normal: '問題なし' })} / {SKIN_LABELS[key] ?? key} / {TEAR_LABELS[key] ?? key}</div>)
  expect(screen.getByText(`${key} 2回 / ${key} / ${key}`)).toBeTruthy()
})
