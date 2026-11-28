// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ create: vi.fn(), replace: vi.fn() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a' }) }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => 'owner', canManageRole: () => true }))
vi.mock('@/lib/api', () => ({ api: { automations: { createDraftFromAutomation: state.create } } }))
vi.mock('@/components/shared/list-navigation', () => ({ useListNavigationRouter: () => router }))
vi.mock('@/components/shared/target-missing', () => ({ default: ({ title, onRetry }: { title: string; onRetry?: () => void }) => <div>{title}{onRetry && <button onClick={onRetry}>再試行</button>}</div> }))
const router = { replace: state.replace }
import AutomationDefinitionEntry from './definition-entry'
afterEach(() => { cleanup(); vi.clearAllMocks() })
it('下書きの番号がない応答では失敗を表示し、読み直しで開ける', async () => {
  state.create.mockResolvedValueOnce({ success: true, data: {} }).mockResolvedValueOnce({ success: true, data: { id: 'draft-a' } })
  render(<AutomationDefinitionEntry automationId="rule-a" />)
  expect(await screen.findByText('ルールを読み込めませんでした')).toBeTruthy()
  expect(state.replace).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('再試行'))
  await waitFor(() => expect(state.replace).toHaveBeenCalledWith('/automations/drafts?id=draft-a'))
})
