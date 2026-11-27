// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ list: vi.fn(), impact: vi.fn() }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, media: { ...actual.api.media, list: net.list, replacementImpact: net.impact } } }
})
import MediaReplacementDialog from './media-replacement-dialog'
afterEach(cleanup)
it('差し替え先を選ぶ必要があることを表示し、選ぶと影響を確かめる', async () => {
  net.list.mockResolvedValue({ success: true, data: { items: [{ id: 'next', filename: '見本の画像', kind: 'image', lineAccountId: 'example' }], total: 1 } })
  net.impact.mockResolvedValue({ success: true, data: { replacement: { id: 'next', filename: '見本の画像' }, revision: 'r', canReplace: true, canPartiallyReplace: false, usageCount: 1, replaceableCount: 1, blockedCount: 0, references: [] } })
  render(<MediaReplacementDialog source={{ id: 'source', filename: '元の画像', kind: 'image' } as never} accountId="example" onClose={vi.fn()} onComplete={vi.fn()} />)
  await screen.findByText('差し替え先を選んでください。')
  expect(screen.getByText('必須')).toBeTruthy()
  expect((screen.getByRole('button', { name: '使用先を差し替える' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: /差し替え先/ }))
  const dialog = screen.getAllByRole('dialog').at(-1)!
  fireEvent.click(within(dialog).getByRole('radio', { name: '見本の画像' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '選ぶ' }))
  expect(net.impact).toHaveBeenCalledWith('source', 'next', 'example')
  expect(screen.queryByText('差し替え先を選んでください。')).toBeNull()
})
