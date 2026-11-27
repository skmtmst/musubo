// @vitest-environment happy-dom
import React, { useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ToastHost, { clearToastsForTest } from '@/components/shared/toast'
const fixture = vi.hoisted(() => ({ account: 'a', create: vi.fn(), list: vi.fn() }))
vi.mock('next/navigation', async () => (await import('@/test-utils/navigation-mock')).navigationMock())
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: fixture.account }) }))
vi.mock('@/lib/staff-role', async original => ({ ...await original<typeof import('@/lib/staff-role')>(), useStaffRole: () => 'owner' }))
vi.mock('@/lib/api', async original => { const actual = await original<typeof import('@/lib/api')>(); return { ...actual, api: { ...actual.api, folders: { ...actual.api.folders, list: fixture.list, create: fixture.create } } } })
import { EMPTY_BASICS, ReminderBasicsFormV8 } from './basics-form'
function Host() { const [value, onChange] = useState(EMPTY_BASICS); return <ReminderBasicsFormV8 {...{ value, onChange }} appliedTemplateId={null} pendingFieldMatch={null} onRequestTemplate={() => {}} onFieldMatchHandled={() => {}} onFieldsReady={() => {}} onEventsReady={() => {}} /> }
beforeEach(() => { fixture.account = 'a'; fixture.create.mockReset(); fixture.list.mockReset().mockResolvedValue({ success: true, data: [] }) })
afterEach(() => { cleanup(); clearToastsForTest() })
async function open() { const view = render(<><Host /><ToastHost /></>); fireEvent.click(await screen.findByRole('button', { name: 'フォルダ', exact: true })); fireEvent.click(screen.getByRole('button', { name: '新しいフォルダを作る' })); fireEvent.change(screen.getByRole('textbox', { name: '新しいフォルダの名前' }), { target: { value: '見本' } }); return view }
it('フォルダ作成が成功すると知らせ、選択する', async () => { fixture.create.mockResolvedValueOnce({ success: true, data: { id: 'f', name: '見本' } }); await open(); await act(async () => { fireEvent.click(screen.getByRole('button', { name: '作って選ぶ' })) }); expect(await screen.findByText('リマインダのフォルダを作りました。')).toBeTruthy(); expect(screen.getByRole('button', { name: 'フォルダ', exact: true }).textContent).toBe('見本') })
it('フォルダ作成が失敗したら知らせず入力を残す', async () => { fixture.create.mockResolvedValueOnce({ success: false, error: '作れませんでした' }); await open(); await act(async () => { fireEvent.click(screen.getByRole('button', { name: '作って選ぶ' })) }); expect(screen.queryByText('リマインダのフォルダを作りました。')).toBeNull(); expect(screen.getByDisplayValue('見本')).toBeTruthy() })
it('アカウント切替後の古い結果で通知しない', async () => { let resolve!: (v: unknown) => void; fixture.create.mockImplementationOnce(() => new Promise(done => { resolve = done })); const view = await open(); fireEvent.click(screen.getByRole('button', { name: '作って選ぶ' })); fixture.account = 'b'; view.rerender(<><Host /><ToastHost /></>); await act(async () => { resolve({ success: true, data: { id: 'f', name: '見本' } }) }); expect(screen.queryByText('リマインダのフォルダを作りました。')).toBeNull() })
