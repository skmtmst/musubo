// @vitest-environment happy-dom
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReminderDraftSettings } from '@line-crm/shared'
const mocks = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/contexts/account-context', () => ({ useAccount: () => ({ selectedAccountId: 'a1', selectedAccount: { id: 'a1', name: '確認用' } }) }))
vi.mock('@/lib/api', async original => { const actual = await original<typeof import('@/lib/api')>(); return { ...actual, api: { ...actual.api, friendFields: { ...actual.api.friendFields, list: mocks.list } } } })
import { MessagesStageV8 } from './edit-messages'
const initial = { deliveryMode: 'time', triggerType: 'booking', steps: [{ stableStepId: 's1', offsetMinutes: 0, offsetDays: -1, sendAtTime: '18:00', messageType: 'text', messageContent: '入力を残す' }] } as ReminderDraftSettings
function Example() { const [settings, setSettings] = useState(initial); return <MessagesStageV8 frame={{ title: '本文' }} notice={null} narrow={false} settings={settings} onChange={setSettings} busy={false} onNext={() => {}} onSaveDraft={() => {}} onCancel={() => {}} /> }
afterEach(() => { cleanup(); vi.resetAllMocks() })
it('差し込み候補の失敗を知らせ、本文を残したまま読み直す', async () => {
  mocks.list.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ success: true, data: [{ id: 'field-1', name: 'ペット名', fieldKey: 'pet_name' }] })
  render(<Example />)
  await screen.findByText('友だち情報の差し込み候補を読み込めませんでした。本文はそのまま編集できます。')
  fireEvent.change(screen.getByLabelText('1 通目の本文'), { target: { value: '変更した本文' } })
  fireEvent.click(screen.getByRole('button', { name: '差し込み候補を読み直す' }))
  expect((screen.getByLabelText('1 通目の本文') as HTMLTextAreaElement).value).toBe('変更した本文')
  await screen.findByLabelText('1 通目の本文')
  await vi.waitFor(() => expect(screen.queryByText('友だち情報の差し込み候補を読み込めませんでした。本文はそのまま編集できます。')).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: '友だち情報' }))
  expect(await screen.findByText('ペット名')).toBeTruthy()
  expect(mocks.list).toHaveBeenCalledTimes(2)
})
