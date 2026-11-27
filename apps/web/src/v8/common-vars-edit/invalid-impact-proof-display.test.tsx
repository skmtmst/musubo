// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const add = vi.hoisted(() => vi.fn())
const preview = vi.hoisted(() => vi.fn())
const update = vi.hoisted(() => vi.fn())
const scheduleState = vi.hoisted(() => ({ account: 'a', rows: [] as Array<Record<string, unknown>>, remove: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams('id=var-1') }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: scheduleState.account, loading: false }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api,
    folders: { ...actual.api.folders, list: async () => ({ success: true, data: [] }) },
    commonVars: { ...actual.api.commonVars,
      detail: async () => ({ success: true, data: { id: 'var-1', name: '営業時間', key: 'hours', type: 'text', value: '10時', memo: '', status: 'active', validFrom: null, validUntil: null, version: 1, usages: [], history: [], usageCount: 0, usagePage: { total: 0, shown: 0 } } }),
      schedules: async () => ({ success: true, data: scheduleState.rows }), addSchedule: add, deleteSchedule: scheduleState.remove, impactPreview: preview, update,
    },
  } }
})
import Editor from './edit'
afterEach(() => { cleanup(); scheduleState.rows = []; scheduleState.account = 'a'; scheduleState.remove.mockReset() })

it('影響の確認結果に証明がないときは保存を送らない', async () => {
  preview.mockResolvedValue({ success: true, data: {} })
  update.mockResolvedValue({ success: true, data: {} })
  render(<Editor />)
  await screen.findByLabelText('名前')
  fireEvent.change(screen.getByLabelText('変える理由（記録に残ります）'), { target: { value: '店舗情報の変更' } })
  fireEvent.click(screen.getByRole('button', { name: '保存する' }))
  expect(await screen.findByText('影響を確認できませんでした。しばらく待って保存し直してください')).toBeTruthy()
  expect(update).not.toHaveBeenCalled()
})
