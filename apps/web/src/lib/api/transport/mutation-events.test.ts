import { afterEach, expect, it, vi } from 'vitest'
import { announceApiMutation, API_MUTATION_SUCCEEDED } from './mutation-events'

afterEach(() => vi.unstubAllGlobals())

it('更新の通知はアカウントと対象を引き継ぐ', () => {
  const dispatchEvent = vi.fn()
  vi.stubGlobal('window', { dispatchEvent })
  announceApiMutation('/api/tags?account_id=a', 'a')
  expect(dispatchEvent).toHaveBeenCalledOnce()
  expect(dispatchEvent.mock.calls[0][0]).toMatchObject({ type: API_MUTATION_SUCCEEDED, detail: { accountId: 'a' } })
})

it('通知の失敗が保存成功を失敗扱いにしない', () => {
  vi.stubGlobal('window', { dispatchEvent: () => { throw new Error('unavailable') } })
  expect(() => announceApiMutation('/api/tags', 'a')).not.toThrow()
})

it('ガイドとプレビューの更新は通知しない', () => {
  const dispatchEvent = vi.fn()
  vi.stubGlobal('window', { dispatchEvent })
  announceApiMutation('/api/getting-started/guide', 'a')
  announceApiMutation('/api/forms/1/preview', 'a')
  expect(dispatchEvent).not.toHaveBeenCalled()
})
