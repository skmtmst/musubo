// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ approval: vi.fn(), approvalCandidates: vi.fn(), requestApproval: vi.fn() }))
vi.mock('@/lib/hq-broadcasts-api', () => ({ hqBroadcastsApi: net }))
import { HqApprovalBlock, useHqApproval } from './approval'
import type { HqBroadcastRun } from '@/lib/hq-broadcasts-api'
const run = { id: 'run-1', status: 'prepared', version: 1 } as HqBroadcastRun
function Example() {
  const approval = useHqApproval(run)
  return <HqApprovalBlock run={run} approval={approval} requestOpen onRequestClose={() => {}} onChanged={() => {}} scheduledLabel={null} messageSummary="確認用" />
}
afterEach(() => { cleanup(); vi.resetAllMocks() })
it('承認者を取得できない場合は失敗を示し、読み直して選択できる', async () => {
  net.approval.mockResolvedValue({ data: { approval: { status: 'none' }, gate: { required: true, singleOperator: false, threshold: 1000, recipientCount: 1200 }, viewer: { isApprover: false, isRequester: false } } })
  net.approvalCandidates.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ data: [{ id: 'person', name: '確認する人' }] })
  render(<Example />)
  const dialog = within(await screen.findByRole('dialog', { name: '承認を依頼する' }))
  await dialog.findByText('承認できる人を読み込めませんでした。')
  expect(net.requestApproval).not.toHaveBeenCalled()
  fireEvent.click(dialog.getByRole('button', { name: '承認できる人を読み直す' }))
  expect(await dialog.findByRole('button', { name: '承認をお願いする人' })).toBeTruthy()
  expect(dialog.queryByText('承認できる人を読み込めませんでした。')).toBeNull()
  expect(net.approval).toHaveBeenCalledTimes(1)
})
