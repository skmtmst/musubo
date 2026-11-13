import { describe, expect, it } from 'vitest'
import { csvExportCell, csvExportLine } from '@/v8/friends/list/csv-export'

describe('簡易CSV書き出しの数式インジェクション対策(#496-4)', () => {
  it.each(['=cmd|/c calc', '+1+1', '-2+3', '@attacker'])(
    '先頭 %s のセルに引用符を付ける',
    (value) => {
      expect(csvExportCell(value)).toBe(`"'${value}"`)
    },
  )

  it('ふつうの名前はそのまま引用符で包むだけ', () => {
    expect(csvExportCell('見本 141')).toBe('"見本 141"')
    expect(csvExportCell(null)).toBe('""')
  })

  it('二重引用符は二重化する', () => {
    expect(csvExportCell('彼は"社長"です')).toBe('"彼は""社長""です"')
  })

  it('行全体をカンマでつなぐ', () => {
    expect(csvExportLine(['=1+1', '佐藤', null])).toBe(`"'=1+1","佐藤",""`)
  })
})
