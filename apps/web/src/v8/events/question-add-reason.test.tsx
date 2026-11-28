// @vitest-environment happy-dom
import { fireEvent, render, screen, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('@/lib/api', () => ({ eventsApi: { createEvent: vi.fn(), createSlots: vi.fn() }, ApiError: class extends Error {} }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
vi.mock('next/link', () => ({ default: ({ children, href, ...rest }: React.PropsWithChildren<{ href: string }>) => <a href={href} {...rest}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'account-a' }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {} }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/lib/use-unsaved-guard', () => ({ useUnsavedGuard: () => ({ leaveTarget: null, confirmLeave: vi.fn(), cancelLeave: vi.fn() }) }))
vi.mock('./application-preview', () => ({ default: () => null }))
import EventsCreate from './create'
afterEach(cleanup)
it('質問の入力が必要な理由を表示し、入力すると追加できる', () => {
  render(<EventsCreate />)
  fireEvent.click(screen.getByRole('button', { name: '＋ 質問を足す' }))
  expect(screen.getByText('聞くことを入力してください。')).toBeTruthy()
  expect((screen.getByRole('button', { name: '足す' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(screen.getByRole('textbox', { name: '聞くこと' }), {target:{value:'見本の質問'}})
  fireEvent.click(screen.getByRole('button', { name: '足す' }))
  expect(screen.getByText('見本の質問')).toBeTruthy()
})
