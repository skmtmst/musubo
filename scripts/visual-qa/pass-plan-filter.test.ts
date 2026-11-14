import { expect, test } from 'vitest'
import { gap3Respond } from './mock-gap3.mjs'

test('画面確認の券一覧も種類で絞ってから件数とページを返す', () => {
  const read = (query: string) => {
    const response = gap3Respond('GET', '/api/booking/admin/pass-plans', {}, new URLSearchParams(query))
    if (!response) throw new Error('券一覧の見本 API が応答しませんでした')
    return response[1].data as { total: number; items: Array<{ id: string }> }
  }
  const first = read('kind=ticket&limit=2&offset=0')
  const second = read('kind=ticket&limit=2&offset=2')
  expect(first.total).toBe(3)
  expect(first.items.map((item) => item.id)).toEqual(['pp-1', 'pp-2'])
  expect(second.total).toBe(3)
  expect(second.items.map((item) => item.id)).toEqual(['pp-4'])
  expect(read('kind=monthly').items.map((item) => item.id)).toEqual(['pp-3'])
})
