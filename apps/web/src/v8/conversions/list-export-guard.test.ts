// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { definitionRange, downloadCsvBlob } from './list-export'

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('conversions/list-export ガード', () => {
  it('days が 0 以下・NaN・Infinity でも例外や逆転期間（from > to）にならず安全な日付範囲を返す', () => {
    for (const invalid of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const range = definitionRange(invalid)
      expect(range.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(range.to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(range.from <= range.to).toBe(true)
    }

    const normal = definitionRange(30)
    expect(normal.from < normal.to).toBe(true)
  })

  it('CSV ダウンロードの click が例外を投げても Object URL を必ず解放する', () => {
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test-url')
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new Error('click failed')
    })

    expect(() => downloadCsvBlob(new Blob(['a,b']), 'test.csv')).toThrow('click failed')
    expect(createUrl).toHaveBeenCalledTimes(1)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    expect(revokeUrl).toHaveBeenCalledWith('blob:test-url')
  })
})
