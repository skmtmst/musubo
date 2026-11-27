// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const calls = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), delete: vi.fn() }))
vi.mock('@/lib/api', async (original: () => Promise<typeof import('@/lib/api')>) => {
  const actual = await original()
  return { ...actual, api: { ...actual.api, scenarioDrafts: calls } }
})
import { ApiError } from '@/lib/api'
import { useScenarioDraft } from './use-scenario-draft'
import { ScenarioDraftLoadNotice } from './public/scenario-draft-load-notice'

function Screen() {
  const [value, setValue] = React.useState('')
  const draft = useScenarioDraft({ accountId: 'a', draftKey: 'key', baseline: '', value })
  return <><input aria-label="入力" value={value} onChange={e => setValue(e.target.value)} />
    <ScenarioDraftLoadNotice failed={draft.loadFailed} onRetry={draft.retryLoad} />
    {draft.pendingAgo && <button onClick={() => setValue(draft.restore() ?? '')}>前の入力を戻す</button>}</>
}

beforeEach(() => { vi.useFakeTimers(); calls.get.mockReset(); calls.save.mockReset(); calls.delete.mockReset() })
afterEach(() => { cleanup(); vi.useRealTimers() })

it('読み込み失敗中は自動保存せず、再読み込み後に既存の下書きを戻せる', async () => {
  calls.get.mockRejectedValueOnce(new ApiError(500, 'failure', 'failure')).mockResolvedValueOnce({ success: true, data: {
    version: 'version-1', content: { value: '前の入力' }, updatedAt: '2026-11-27T00:00:00Z',
  } })
  render(<Screen />)
  await act(async () => {})
  expect(screen.getByText('下書きを読み込めませんでした。読み直すまで自動保存を停止しています。')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('入力'), { target: { value: '現在の入力' } })
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(calls.save).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  await act(async () => {})
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '前の入力を戻す' }))
  expect((screen.getByLabelText('入力') as HTMLInputElement).value).toBe('前の入力')
})

it('404 は下書きなしとして保存を開始できる', async () => {
  calls.get.mockRejectedValueOnce(new ApiError(404, 'not_found', 'not_found'))
  calls.save.mockResolvedValue({ success: true, data: { version: 'v1' } })
  render(<Screen />)
  await act(async () => {})
  expect(screen.queryByRole('alert')).toBeNull()
  fireEvent.change(screen.getByLabelText('入力'), { target: { value: '新しい入力' } })
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(calls.save).toHaveBeenCalledWith('a', 'key', expect.objectContaining({ expectedVersion: 0 }))
})
