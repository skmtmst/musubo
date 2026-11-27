// @vitest-environment happy-dom
import React, { act } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fixture = vi.hoisted(() => ({ preview: vi.fn() }))
vi.mock('@/lib/api', () => ({ api: { scenarios: { preview: fixture.preview } } }))
vi.mock('@/components/shared/dialog', () => ({ default: ({ children, open }: { children: React.ReactNode, open: boolean }) => open ? <div role="dialog">{children}</div> : null }))
vi.mock('@/components/shared/date-time-field', () => ({ default: ({ value, onChange }: { value: string, onChange: (value: string) => void }) => <input aria-label="起点" value={value} onChange={(event) => onChange(event.target.value)} /> }))
import BulkPreviewModal from './bulk-preview-modal'
beforeEach(() => { vi.useFakeTimers(); fixture.preview.mockReset() })
afterEach(() => { cleanup(); vi.useRealTimers() })

it('連続入力は300ms後の最後の値だけを送る', async () => {
  fixture.preview.mockResolvedValue({ success: true, data: { steps: [] } })
  render(<BulkPreviewModal open scenarioId="s1" onClose={() => {}} />)
  const input = screen.getByRole('textbox', { name: '起点' })
  fireEvent.change(input, { target: { value: '2026-11-28T10:00' } })
  await act(async () => { await vi.advanceTimersByTimeAsync(200) })
  fireEvent.change(input, { target: { value: '2026-11-28T11:00' } })
  await act(async () => { await vi.advanceTimersByTimeAsync(299) })
  expect(fixture.preview).not.toHaveBeenCalled()
  await act(async () => { await vi.advanceTimersByTimeAsync(1) })
  expect(fixture.preview).toHaveBeenCalledTimes(1)
  expect(fixture.preview).toHaveBeenCalledWith('s1', '2026-11-28T11:00:00+09:00', expect.any(AbortSignal))
})
it('取得中に入力を変えると前の通信を中断し、古い結果を表示しない', async () => {
  let resolveOld!: (value: unknown) => void
  fixture.preview.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
  fixture.preview.mockResolvedValueOnce({ success: true, data: { steps: [{ stepOrder: 1, deliveryAt: '', deliveryAtLabel: '新しい結果', messageType: 'テキスト', messageContent: '新しい本文' }] } })
  render(<BulkPreviewModal open scenarioId="s1" onClose={() => {}} />)
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  const signal = fixture.preview.mock.calls[0][2] as AbortSignal
  expect(signal.aborted).toBe(false)
  fireEvent.change(screen.getByRole('textbox', { name: '起点' }), { target: { value: '2026-11-28T12:00' } })
  expect(signal.aborted).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(300) })
  expect(screen.getByText('新しい結果')).toBeTruthy()
  await act(async () => { resolveOld({ success: true, data: { steps: [{ stepOrder: 2, deliveryAtLabel: '古い結果' }] } }); await Promise.resolve() })
  expect(screen.queryByText('古い結果')).toBeNull()
  expect(screen.getByText('新しい結果')).toBeTruthy()
})
