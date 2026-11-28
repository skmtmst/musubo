// @vitest-environment happy-dom
import React, { type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import HqTemplateDetail from './detail'

const version = (n: number, draft: boolean, current: boolean) => ({ id: `v${n}`, version: n, created_by: 's', creator_name: '担当', created_at: '2026-08-21T09:02:00Z', is_draft: draft, is_current: current })
const definition = { schemaVersion: 1, template: { id: 'm', name: '見本', messageType: 'text', messageContent: '本文', questionJson: null }, media: [] }
const comparison = (body: string) => ({ from: { version: version(1, false, false), definition: { template: { messageContent: body } } }, to: { version: version(3, true, true), definition: { template: { messageContent: '現在' } } }, changed: true })
const noop = () => {}
function props(overrides: Record<string, unknown> = {}) {
  return { detail: { template: { id: 't', name: '見本', description: '', template_type: 'template', revision: 3, updated_at: '2026-08-21T09:02:00Z' }, definition }, row: null, accounts: [], folderName: null, folderColor: null, canEdit: true, busy: false, versions: [version(3, true, true), version(2, false, false), version(1, false, false)], versionsError: false, received: [], onReloadVersions: noop, onCompare: vi.fn(), onRestore: vi.fn(), onBack: noop, onEdit: noop, onDistribute: noop, onDuplicate: noop, onEnterAccount: noop, ...overrides } as unknown as ComponentProps<typeof HqTemplateDetail>
}
afterEach(cleanup)

it('同じ版の比較をもう一度開いた後は古い結果を使わない', async () => {
  let oldFinish!: (value: ReturnType<typeof comparison>) => void
  let newFinish!: (value: ReturnType<typeof comparison>) => void
  const compare = vi.fn().mockImplementationOnce(() => new Promise(resolve => { oldFinish = resolve })).mockImplementationOnce(() => new Promise(resolve => { newFinish = resolve }))
  render(<HqTemplateDetail {...props({ onCompare: compare })} />)
  const button = within(screen.getByRole('region', { name: '版の履歴' })).getByRole('button', { name: '比べる' })
  fireEvent.click(button); fireEvent.click(button); fireEvent.click(button)
  expect(compare).toHaveBeenCalledTimes(2)
  await act(async () => { newFinish(comparison('新しい結果')) })
  expect(screen.getByText('－ 新しい結果')).toBeTruthy()
  await act(async () => { oldFinish(comparison('古い結果')) })
  expect(screen.getByText('－ 新しい結果')).toBeTruthy()
  expect(screen.queryByText('－ 古い結果')).toBeNull()
})

it('比較結果が不正なときは読み込めないと案内する', async () => {
  const compare = vi.fn().mockResolvedValue({})
  render(<HqTemplateDetail {...props({ onCompare: compare })} />)
  fireEvent.click(within(screen.getByRole('region', { name: '版の履歴' })).getByRole('button', { name: '比べる' }))
  expect(await screen.findByText('版を比べられませんでした。もう一度お試しください。')).toBeTruthy()
})
