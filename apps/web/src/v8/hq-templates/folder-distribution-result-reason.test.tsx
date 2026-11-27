// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import FolderDistributionResult from './folder-distribution-result'
import type { FolderRun } from './folder-distribution'
afterEach(cleanup)
it('未配布分の確認が必要なとき、失敗分を再確認できない理由を表示する', () => {
  const template = { id:'t',name:'見本',description:null,template_type:'tag',folder_id:null,revision:1,updated_at:'2026-10-09' } as const
  const runs: FolderRun[] = [
    {template,accountIds:['a'],runId:'r',result:{runId:'r',status:'completed',stores:[{accountId:'a',accountName:'見本店',status:'failed',counts:{created:0,overwritten:0,aliased:0}}]}},
    {template:{...template,id:'t2'},accountIds:['a']},
  ]
  const retry=vi.fn()
  render(<FolderDistributionResult name="見本" runs={runs} accounts={[{id:'a',name:'見本店'}]} busy={false} error="" onBack={() => {}} onRefresh={() => {}} onRetry={retry} onRecheck={() => {}} />)
  expect(screen.getByText('先に未配布分を再確認してください。')).toBeTruthy()
  const button=screen.getByRole('button',{name:'失敗した 1 件だけ再確認'}) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(retry).not.toHaveBeenCalled()
})
