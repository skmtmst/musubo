// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StaffMember } from '@line-crm/shared'
import { verifiedStaffRole } from '@/test-utils/verified-staff-role'
import { forgetStaffIdentity, readStaffIdentity, rememberStaffIdentity } from '@/lib/staff-identity-state'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'
const fixture = vi.hoisted(() => ({ id: 'sc-a', account: 'a', loading: false, newStep: false }))
const calls = vi.hoisted(() => ({ read: vi.fn(), tags: vi.fn(), templates: vi.fn(), add: vi.fn(), update: vi.fn(), push: vi.fn(), invalidate: vi.fn(), draftGet: vi.fn(), draftSave: vi.fn(), draftDelete: vi.fn() }))
const held = vi.hoisted(() => ({ save: undefined as undefined | (() => unknown), cancel: undefined as undefined | (() => unknown), skip: undefined as undefined | (() => unknown), clear: undefined as undefined | (() => unknown) }))
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('id='+fixture.id), useRouter: () => ({ push: calls.push }) }))
vi.mock('next/link', () => ({ default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ accounts: [{ id: 'a', name: '見本' }], selectedAccountId: fixture.account, loading: fixture.loading }) }))
vi.mock('@/components/shell/page-chrome', () => ({ usePageTitle: () => {}, usePageCrumbs: () => {} }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => readStaffIdentity()?.role ?? null }))
vi.mock('@/components/scenarios/scenario-reference-data', () => ({ scenarioReferenceData: { scenario: calls.read, tags: calls.tags, templates: calls.templates, invalidateScenario: calls.invalidate } }))
vi.mock('@/components/scenarios/insert-toolbar', () => ({ default: () => null }))
vi.mock('@/components/templates', async original => {
  const actual = await original<typeof import('@/components/templates')>()
  const text = (value: React.ReactNode): string => React.Children.toArray(value).map(item => React.isValidElement<{ children?: React.ReactNode }>(item) ? text(item.props.children) : String(item)).join('')
  const capture = (value: React.ReactNode): void => { React.Children.forEach(value, item => {
    if (!React.isValidElement<{ children?: React.ReactNode; onClick?: () => unknown }>(item)) return
    const label = text(item.props.children)
    if (item.props.onClick) {
      if (label.includes('作って編集へ')) held.save = item.props.onClick
      if (label.includes('1通目はあとで書く')) held.skip = item.props.onClick
      if (label === 'キャンセル') held.cancel = item.props.onClick
    }
    capture(item.props.children)
  }) }
  return { ...actual, CreatePage: (props: React.ComponentProps<typeof actual.CreatePage>) => { capture(props.footerActions); return <actual.CreatePage {...props} /> } }
})
vi.mock('@/v8/autosave/public/use-scenario-draft/index', async original => {
  const actual = await original<typeof import('@/v8/autosave/public/use-scenario-draft/index')>()
  return { ...actual, useScenarioDraft: <T,>(options: Parameters<typeof actual.useScenarioDraft<T>>[0]) => { const draft = actual.useScenarioDraft(options); held.clear = draft.clear; return draft } }
})
vi.mock('@/lib/api', async original => {
  const actual = await original<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, scenarios: { ...actual.api.scenarios, addStep: calls.add, updateStep: calls.update }, scenarioDrafts: { get: calls.draftGet, save: calls.draftSave, delete: calls.draftDelete } } }
})
import FirstStep from './first-step'
import { ApiError } from '@/lib/api'
const step = { id: 'step-a', scenarioId: 'sc-a', stepOrder: 1, messageType: 'text', messageContent: '手元の本文', offsetDays: 0, offsetMinutes: 90, delayMinutes: 0, deliveryTime: null, templateId: null, question: null, targetCondition: null }
const row = (id = fixture.id) => ({ id, name: '見本のシナリオ', lineAccountId: 'a', deliveryMode: 'elapsed', steps: fixture.newStep ? [] : [{ ...step, scenarioId: id, id: id === 'sc-a' ? 'step-a' : 'step-b' }] })
const person = (role: 'owner' | 'admin' | 'staff' | 'viewer', extra: Partial<StaffMember> = {}) => { verifiedStaffRole(role); rememberStaffIdentity({ ...readStaffIdentity()!, ...extra }) }
const proxy = () => rememberSessionSnapshot({ stepUpMethod: 'totp', unfamiliarAt: null, impersonation: { mode: 'read' } as never })
const body = () => screen.getByRole('textbox', { name: '本文', exact: true }) as HTMLInputElement
const ready = async () => { const view = render(<FirstStep />); await screen.findByRole('textbox', { name: '本文', exact: true }); return view }
const invoke = async (fn: (() => unknown) | undefined) => { expect(fn).toBeTypeOf('function'); await act(async () => { await fn!() }) }
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { resolve, promise } }
beforeEach(() => {
  forgetSessionSnapshot(); person('owner'); fixture.id = 'sc-a'; fixture.account = 'a'; fixture.loading = false; fixture.newStep = false
  Object.values(calls).forEach(call => call.mockReset()); held.save = held.cancel = held.skip = held.clear = undefined
  calls.read.mockImplementation(async (id: string) => ({ success: true, data: row(id) })); calls.tags.mockResolvedValue({ success: true, data: [] }); calls.templates.mockResolvedValue({ success: true, data: [] })
  calls.update.mockImplementation(async (_scenarioId: string, stepId: string) => ({ success: true, data: { ...step, id: stepId } })); calls.add.mockResolvedValue({ success: true, data: { ...step, id: 'step-new' } })
  calls.draftGet.mockRejectedValue(new ApiError(404, 'not_found', 'not_found'))
  calls.draftSave.mockImplementation(async (account: string, key: string, value: { content: unknown }) => ({ success: true, data: { key, lineAccountId: account, content: value.content, version: 'version-a', updatedAt: new Date().toISOString() } }))
  calls.draftDelete.mockResolvedValue({ success: true }); document.documentElement.dataset.theme = 'v8'
})
afterEach(() => { cleanup(); forgetStaffIdentity(); forgetSessionSnapshot(); vi.useRealTimers(); localStorage.clear(); sessionStorage.clear() })

it('未知の配信方式は既存の通を別の方式として開かず、読み直せる', async () => {
  calls.read.mockResolvedValueOnce({ success: true, data: { ...row(), deliveryMode: 'future' } })
  render(<FirstStep />)
  expect(await screen.findByText('シナリオを読み込めませんでした')).toBeTruthy()
  expect(calls.update).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByRole('textbox', { name: '本文', exact: true })).toBeTruthy()
})
it('保存済みの遅延が負の値なら0分と見せず、読み直せる', async () => {
  calls.read.mockResolvedValueOnce({ success: true, data: { ...row(), deliveryMode: 'relative', steps: [{ ...step, delayMinutes: -1 }] } })
  render(<FirstStep />)
  expect(await screen.findByText('シナリオを読み込めませんでした')).toBeTruthy()
  expect(calls.update).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'もう一度読み込む' }))
  expect(await screen.findByRole('textbox', { name: '本文', exact: true })).toBeTruthy()
})
it('未知の方式で新しく1通目を保存せず、入力を保つ', async () => {
  fixture.newStep = true
  calls.read.mockResolvedValueOnce({ success: true, data: { ...row(), deliveryMode: 'future', steps: [] } })
  await ready()
  fireEvent.change(body(), { target: { value: '書きかけの本文' } })
  await invoke(held.save)
  expect(calls.add).not.toHaveBeenCalled()
  expect(body().value || body().textContent).toBe('書きかけの本文')
  expect(screen.getByText(/保存できませんでした/)).toBeTruthy()
})
