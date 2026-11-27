// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { openAffiliateFriendPicker } from '@/test-utils/affiliate-create'

vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), api: { friends: { list: async () => ({ success: true, data: { items: [], total: 0 } }) } } }))
vi.mock('next/navigation', async () => (await import('@/test-utils/affiliate-navigation-mock')).affiliateNavigationMock())
vi.mock('@/components/shell/page-chrome', async () => (await import('@/test-utils/page-chrome-mock')).pageChromeMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'acc-1', selectedAccount: { id: 'acc-1', name: '本店' } }) }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
const { default: CreateAffiliateV8 } = await import('@/v8/affiliates/create')
afterEach(cleanup)

describe('R295 現役V8の友だち選択窓は共通Dialogの動きをする', () => {
  test('Escapeで閉じる', async () => {
    render(<CreateAffiliateV8 />)
    await openAffiliateFriendPicker()
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  test('Tabは窓の内側を循環し、背景へ抜けない', async () => {
    render(<CreateAffiliateV8 />)
    const { dialog } = await openAffiliateFriendPicker()
    const close = within(dialog).getByRole('button', { name: '閉じる' })
    const last = within(dialog).getByRole('button', { name: '選択する' })
    last.focus()
    await act(async () => { fireEvent.keyDown(document, { key: 'Tab' }) })
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(document.activeElement).toBe(close)
    close.focus()
    await act(async () => { fireEvent.keyDown(document, { key: 'Tab', shiftKey: true }) })
    expect(document.activeElement).toBe(last)
  })

  test('閉じたら起動ボタンへフォーカスが戻る', async () => {
    render(<CreateAffiliateV8 />)
    const { trigger } = await openAffiliateFriendPicker()
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })
})
