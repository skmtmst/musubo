// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useInboxPreview } from './use-reservation-warning'

// 前の試験の待ち（250ms）が次の試験の口へ届かないよう、毎回外す。
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('口が解決できなかった差し込みを全部返し（予約に限らない）、修正すれば消す', async () => {
  vi.spyOn(api.chats, 'renderPreview').mockResolvedValue({ success: true, data: { content: '友だち {{var.guest_count}} {{var.closure_datetime}}', unresolved: ['var.guest_count', 'var.closure_datetime'] } } as never)
  const { result, rerender } = renderHook(({ content }) => useInboxPreview('chat-1', content), { initialProps: { content: '{{name}} {{var.guest_count}} {{var.closure_datetime}}' } })
  expect(result.current).toEqual({ status: 'loading' })
  await waitFor(() => expect(result.current).toEqual({ status: 'ready', preview: '友だち {{var.guest_count}} {{var.closure_datetime}}', unresolved: ['var.guest_count', 'var.closure_datetime'] }))
  rerender({ content: '友だち 2名' })
  expect(result.current).toEqual({ status: 'idle' })
})

it('予約がある相手で口が全部入れたときは、入らない差し込みを出さない', async () => {
  vi.spyOn(api.chats, 'renderPreview').mockResolvedValue({ success: true, data: { content: '12月1日 18:00 に2名', unresolved: [] } } as never)
  const { result } = renderHook(() => useInboxPreview('chat-1', '{{var.reservation_datetime}} に{{var.guest_count}}名'))
  await waitFor(() => expect(result.current).toEqual({ status: 'ready', preview: '12月1日 18:00 に2名', unresolved: [] }))
})

it('確かめられなかった時は「問題なし」にせず failed を返す', async () => {
  vi.spyOn(api.chats, 'renderPreview').mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ success: false, error: 'no' } as never)
  const { result, rerender } = renderHook(({ content }) => useInboxPreview('chat-1', content), { initialProps: { content: '{{name}}さん' } })
  await waitFor(() => expect(result.current).toEqual({ status: 'failed' }))
  rerender({ content: '{{name}}様' })
  expect(result.current).toEqual({ status: 'loading' })
  await waitFor(() => expect(result.current).toEqual({ status: 'failed' }))
})

it('宛先を行き来しても前に取得した見本を再表示しない', async () => {
  const apiResponse = { success: true, data: { content: '前の見本', unresolved: [] } } as const
  const preview = vi.spyOn(api.chats, 'renderPreview').mockResolvedValueOnce(apiResponse as never).mockImplementation(() => new Promise(() => {}))
  const { result, rerender } = renderHook(({ chat }) => useInboxPreview(chat, '{{name}}'), { initialProps: { chat: 'one' } })
  await waitFor(() => expect(result.current).toEqual({ status: 'ready', preview: '前の見本', unresolved: [] }))
  rerender({ chat: 'two' })
  expect(result.current).toEqual({ status: 'loading' })
  rerender({ chat: 'one' })
  expect(result.current).toEqual({ status: 'loading' })
  preview.mockRestore()
})

it('遅れて届いた前の本文の応答は、今の本文の結果として使わない', async () => {
  const pending: Array<{ content: string; resolve: (value: unknown) => void }> = []
  vi.spyOn(api.chats, 'renderPreview').mockImplementation((_chat, body) => new Promise(resolve => pending.push({ content: body.content, resolve })) as never)
  const { result, rerender } = renderHook(({ content }) => useInboxPreview('chat-1', content), { initialProps: { content: '{{name}}さん' } })
  await waitFor(() => expect(pending).toHaveLength(1))
  rerender({ content: '{{name}}様' })
  await waitFor(() => expect(pending).toHaveLength(2))
  await act(async () => { pending[0].resolve({ success: true, data: { content: '山田さん', unresolved: [] } }) })
  expect(result.current).toEqual({ status: 'loading' })
  await act(async () => { pending[1].resolve({ success: true, data: { content: '山田様', unresolved: [] } }) })
  expect(result.current).toEqual({ status: 'ready', preview: '山田様', unresolved: [] })
})
