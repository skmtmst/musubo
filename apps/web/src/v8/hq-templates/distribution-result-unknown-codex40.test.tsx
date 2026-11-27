// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import DistributionResultDialog from './distribution-result-dialog'
afterEach(cleanup)
it('未知の配布状態は作成中と決めつけず、再確認を案内する', () => {
  const refresh=vi.fn()
  const rows=[{key:'a',name:'見本店',store:{accountId:'a',status:'unexpected',counts:{created:0,overwritten:0,aliased:0}}}] as never
  render(<DistributionResultDialog open title="配った結果" summary="配布の結果" rows={rows} busy={false} onClose={() => {}} onRetry={() => {}} onRefresh={refresh} />)
  expect(screen.getByText('未確認')).toBeTruthy()
  expect(screen.getByText('配布結果を確認できません。結果を再確認してください。')).toBeTruthy()
  expect(screen.queryByText('作成中')).toBeNull()
  screen.getByRole('button',{name:'結果を再確認'}).click()
  expect(refresh).toHaveBeenCalledOnce()
})
