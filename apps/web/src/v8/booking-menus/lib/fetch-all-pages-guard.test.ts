import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchAllPages } from './fetch-all-pages'

describe('fetchAllPages の無限ループ・壊れた応答の保護', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('pageSize が 0 以下・小数・非有限のときは無限ループせず即座に失敗する', async () => {
    const fetchPage = vi.fn().mockResolvedValue({ requests: [1], total: 10 })
    for (const bad of [0, -10, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(fetchAllPages(fetchPage, bad, () => true)).rejects.toThrow()
    }
    expect(fetchPage).not.toHaveBeenCalled()
  })

  it('total が非有限・負数や、requests が壊れているときは黙って欠落させず失敗する', async () => {
    const infFetch = vi.fn().mockResolvedValue({ requests: [1], total: Number.POSITIVE_INFINITY })
    await expect(fetchAllPages(infFetch, 10, () => true)).rejects.toThrow()

    const negFetch = vi.fn().mockResolvedValue({ requests: [1], total: -1 })
    await expect(fetchAllPages(negFetch, 10, () => true)).rejects.toThrow()

    const badPage2 = vi
      .fn()
      .mockResolvedValueOnce({ requests: [1, 2], total: 4 })
      .mockResolvedValueOnce({ requests: null, total: 4 })
    await expect(fetchAllPages(badPage2, 2, () => true)).rejects.toThrow()
  })
})
