// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useInboxPreview } from './use-reservation-warning'

afterEach(() => vi.restoreAllMocks())
it('予約の値がない場合、送信前に未解決の変数名を知らせ、修正すれば消す', async () => {
  vi.spyOn(api.chats, 'renderPreview').mockResolvedValue({ success: true, data: { content: '友だち {{var.guest_count}}', unresolved: ['var.guest_count'] } } as never)
  const { result, rerender } = renderHook(({ content }) => useInboxPreview('chat-1', content), { initialProps: { content: '{{name}} {{var.guest_count}}' } })
  await waitFor(() => expect(result.current.warning).toContain('{{var.guest_count}}'))
  expect(result.current.warning).toContain('予約')
  rerender({ content: '友だち 2名' })
  expect(result.current.warning).toBe('')
})
it('宛先を行き来しても前に取得した見本を再表示しない', async () => {
  const apiResponse = { success: true, data: { content: '前の見本', unresolved: [] } } as const
  const preview = vi.spyOn(api.chats, 'renderPreview').mockResolvedValueOnce(apiResponse as never).mockImplementation(() => new Promise(() => {}))
  const { result, rerender } = renderHook(({ chat }) => useInboxPreview(chat, '{{name}}'), { initialProps: { chat: 'one' } })
  await waitFor(() => expect(result.current.preview).toBe('前の見本'))
  rerender({ chat: 'two' })
  expect(result.current.preview).toBeNull()
  rerender({ chat: 'one' })
  expect(result.current.preview).toBeNull()
  preview.mockRestore()
})
