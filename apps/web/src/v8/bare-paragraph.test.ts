import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { findBareParagraphs, unexpectedParagraphs, type BareParagraphException } from '../../../../scripts/structure/bare-paragraph.mjs'

const baselinePath = fileURLToPath(new URL('../../../../scripts/structure/bare-paragraph-baseline.json', import.meta.url))
const baselineBytes = readFileSync(baselinePath)
const baseline = JSON.parse(baselineBytes.toString()) as BareParagraphException[]

describe('段落の文字サイズ', () => {
  it('既存の確認待ち一覧を無断で増やさない', () => {
    expect(createHash('sha256').update(baselineBytes).digest('hex')).toBe('88bd40107babe6eac1b88d864119e813aa5a28f84dfa29a851ae6def0e846648')
    expect(baseline.every(item => item.reason.trim())).toBe(true)
  })

  it('className のない段落を新しく足さない', () => {
    const found = findBareParagraphs()
    const unexpected = unexpectedParagraphs(found, baseline)
    expect(unexpected, '新しい段落に文字サイズを指定してください').toEqual([])
    expect(found.length, '直した段落を確認待ち一覧から外してください').toBe(baseline.reduce((sum, item) => sum + item.count, 0))
  })
})
