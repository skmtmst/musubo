// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import { useReservationWarning } from './use-reservation-warning'

afterEach(() => vi.restoreAllMocks())
it('予約の値がない場合、送信前に未解決の変数名を知らせ、修正すれば消す', async () => {
  vi.spyOn(api.chats, 'renderPreview').mockResolvedValue({ success: true, data: { content: '友だち {{var.guest_count}}', unresolved: ['var.guest_count'] } } as never)
  const { result, rerender } = renderHook(({ content }) => useReservationWarning('chat-1', content), { initialProps: { content: '{{name}} {{var.guest_count}}' } })
  await waitFor(() => expect(result.current).toContain('{{var.guest_count}}'))
  expect(result.current).toContain('予約')
  rerender({ content: '友だち 2名' })
  expect(result.current).toBe('')
})
