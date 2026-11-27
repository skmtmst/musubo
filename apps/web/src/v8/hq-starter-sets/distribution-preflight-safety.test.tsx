// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const net = vi.hoisted(() => ({ preflight: vi.fn(), distribute: vi.fn() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [] }) }))
vi.mock('@/lib/api/helpers/styles', () => ({ hqStyleApi: { preflight: net.preflight, distribute: net.distribute } }))
vi.mock('@/components/shared/toast', () => ({ notifySaved: vi.fn() }))
import { useDistribute } from './use-distribute'
import { DistributionDialog } from './distribution-dialog'
function View() { const share = useDistribute('salon', 7, () => {}); return <><button onClick={() => share.setDraft({ target: 'style', accounts: [], editedAction: 'notify' })}>窓を開く</button><DistributionDialog share={share} /></> }
beforeEach(() => { net.preflight.mockReset(); net.distribute.mockReset() })
afterEach(cleanup)
it('事前確認のトークンが欠けているときは配る操作を許さない', async () => {
  net.preflight.mockResolvedValue({ success: true, data: { accountCount: 1, editedCount: 0 } })
  render(<View />)
  fireEvent.click(screen.getByRole('button', { name: '窓を開く' }))
  expect(await screen.findByText(/読み込み/)).toBeTruthy()
  const button = screen.getByRole('button', { name: /アカウントへ配る/ }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  fireEvent.click(button)
  expect(net.distribute).not.toHaveBeenCalled()
})
