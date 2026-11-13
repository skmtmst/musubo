// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ExecuteConfirmDialog, RollbackConfirmDialog } from './uid-dialogs'
import type { UidMigrationDetail } from './use-uid-migration'
import type { LineAccount } from '@line-crm/shared'
vi.mock('@/lib/admin-version-cache', () => ({ loadAdminVersionDetail: async () => ({ version: '2.7.0', deploy_env: 'staging' }) }))
const accounts = [{ id: 'source', name: '移行元のLINE' }, { id: 'destination', name: '移行先のLINE' }] as LineAccount[]
const active = { id: 'run', fromAccountId: 'source', toAccountId: 'destination', createdBy: 'other', status: 'ready', counts: { total: 2, applied: 2, failed: 0 }, decisionCounts: { link: 2, exclude: 0, create: 0, pending: 0 } } as UidMigrationDetail
afterEach(cleanup)
it.each(['execute', 'rollback'] as const)('UIDの%sは実行履歴の2アカウントと環境を表示し、確定操作だけで書き込む', async kind => {
  const confirm = vi.fn(), cancel = vi.fn()
  const props = { active, accounts, me: { id: 'owner', role: 'owner' }, open: true, busy: false, error: null, canRun: true, onConfirm: confirm, onCancel: cancel }
  render(kind === 'execute' ? <ExecuteConfirmDialog {...props} /> : <RollbackConfirmDialog {...props} conflicts={[]} />)
  const target = within(await screen.findByRole('region', { name: '操作の対象' }))
  expect(target.getByText('移行元のLINE')).toBeTruthy()
  expect(target.getByText('移行先のLINE')).toBeTruthy()
  await target.findByText('検証環境')
  expect(target.queryByText('店舗')).toBeNull()
  expect(screen.getByText(/実行権限：オーナーのみ/)).toBeTruthy()
  expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: kind === 'execute' ? '本移行を実行' : '切り戻す', exact: true }))
  expect(confirm).toHaveBeenCalledTimes(1)
})
