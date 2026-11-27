// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import FolderDistributionResult from './folder-distribution-result'
import type { FolderRun } from './folder-distribution'

const run: FolderRun = {
  template: { id: 't1', name: 'ご案内', description: null, template_type: 'template', revision: 1, updated_at: '2026-10-09' },
  accountIds: ['a1'], runId: 'run-1',
  result: { runId: 'run-1', status: 'completed', stores: [{ accountId: 'a1', status: 'succeeded', counts: { created: 1, overwritten: 0, aliased: 0 } }] },
}
const show = (item: FolderRun) => {
  const refresh = vi.fn()
  render(<FolderDistributionResult name="案内" runs={[item]} accounts={[{ id: 'a1', name: '本店' }]} busy={false} error=""
    onBack={vi.fn()} onRefresh={refresh} onRetry={vi.fn()} onRecheck={vi.fn()} />)
  return refresh
}
afterEach(cleanup)

it('知らない全体状態は確定と見せず、結果を再確認できる', () => {
  const refresh = show({ ...run, result: { ...run.result!, status: 'future' } as unknown as FolderRun['result'] })
  expect(screen.getByText(/結果が未確認の行は/)).toBeTruthy()
  expect((screen.getByRole('button', { name: 'ひな形一覧へ' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '結果を再確認' }))
  expect(refresh).toHaveBeenCalledOnce()
})

it.each([null, []])('配布先の一覧が不正（%s）でも結果確認の画面を開ける', (stores) => {
  const refresh = show({ ...run, result: { ...run.result!, stores } as unknown as FolderRun['result'] })
  expect(screen.getByText(/結果が未確認の行は/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '結果を再確認' }))
  expect(refresh).toHaveBeenCalledOnce()
})
