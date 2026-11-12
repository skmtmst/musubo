import { expect, test } from 'vitest'
import { gap3Respond } from './mock-gap3.mjs'

test('画面確認の券一覧も種類で絞ってから件数とページを返す', () => {
  const read = (query: string) => gap3Respond('GET', '/api/booking/admin/pass-plans', {}, new URLSearchParams(query))![1].data
  const first = read('kind=ticket&limit=2&offset=0')
  const second = read('kind=ticket&limit=2&offset=2')
  expect(first.total).toBe(3)
  expect(first.items.map((item: { id: string }) => item.id)).toEqual(['pp-1', 'pp-2'])
  expect(second.total).toBe(3)
  expect(second.items.map((item: { id: string }) => item.id)).toEqual(['pp-4'])
  expect(read('kind=monthly').items.map((item: { id: string }) => item.id)).toEqual(['pp-3'])
})
