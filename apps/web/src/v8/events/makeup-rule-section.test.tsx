// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError, type EventDetail, type EventMakeupRule } from '@/lib/api'
import { forgetSessionSnapshot, rememberSessionSnapshot } from '@/lib/session-snapshot'

const mocks = vi.hoisted(() => ({ role: 'owner' as string | null, save: vi.fn(), list: vi.fn(), get: vi.fn() }))
vi.mock('@/lib/api', async original => ({ ...await original<typeof import('@/lib/api')>(), eventsApi: { listEvents: mocks.list, getEvent: mocks.get } }))
vi.mock('@/lib/api/helpers/gap2', () => ({ bookingMakeupApi: { rule: mocks.save } }))
vi.mock('@/lib/staff-role', () => ({ useStaffRole: () => mocks.role, canManageRole: (role: string) => role === 'owner' || role === 'admin' }))
vi.mock('@/components/shared/use-permission-lock-reason', () => ({ usePermissionLockReason: (allowed: boolean) => allowed ? undefined : 'オーナーか管理者に頼んでください。' }))
vi.mock('@/components/shared/entity-select', () => ({ entityOptionMetadata: () => ({}), default: (props: { values: string[]; options: Array<{value: string; label: string}>; onChange: (ids: string[]) => void; 'aria-label': string; disabled?: boolean }) => <select multiple aria-label={props['aria-label']} value={props.values} disabled={props.disabled} onChange={e => props.onChange(Array.from(e.target.selectedOptions).map(option => option.value))}>{props.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> }))
import { MakeupRuleSection } from './makeup-rule-section'
import { makeupRuleSummary } from './makeup-rule'

const initial: EventMakeupRule = { enabled: true, cutoffHours: 3, validDays: 30, monthlyCap: 2, target: 'same_kind', targetIds: [] }
const event = (rule = initial, version = 4) => ({ id: 'class-a', line_account_id: 'a', name: '教室', version, makeup_rule_json: JSON.stringify(rule) }) as EventDetail
const saved = vi.fn()
const editState = vi.fn()
const view = (row = event()) => <MakeupRuleSection accountId="a" event={row} busy={false} onEditState={editState} onSaved={saved} />
beforeEach(() => {
  mocks.role = 'owner'; mocks.save.mockReset(); mocks.list.mockReset(); mocks.get.mockReset(); saved.mockReset(); editState.mockReset(); forgetSessionSnapshot()
  mocks.list.mockResolvedValue({ items: [{ id: 'class-a', line_account_id: 'a', name: '教室' }], total: 1 })
  mocks.save.mockImplementation(async (_a, _id, rule, version) => ({ success: true, data: { rule, revision: version + 1 } }))
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(() => { cleanup(); forgetSessionSnapshot() })
async function open() {
  fireEvent.click(screen.getByRole('button', { name: '振替の決まりを編集する' }))
  const dialog = await screen.findByRole('dialog', { name: '振替の決まりを編集' })
  await waitFor(() => expect(mocks.list).toHaveBeenCalled())
  return within(dialog)
}

it('保存済みの値で開き、変更値と版を正規の口へ送り、再読取した値で開ける', async () => {
  const rendered = render(view()); const dialog = await open()
  expect((dialog.getByLabelText('振替の期限') as HTMLInputElement).value).toBe('30')
  fireEvent.change(dialog.getByLabelText('振替の期限'), { target: { value: '45' } })
  fireEvent.click(dialog.getByRole('button', { name: '保存する' }))
  await waitFor(() => expect(saved).toHaveBeenCalledWith({ ...initial, validDays: 45 }, 5, 4))
  expect(mocks.save).toHaveBeenCalledWith('a', 'class-a', { ...initial, validDays: 45 }, 4)
  rendered.rerender(view(event({ ...initial, validDays: 45 }, 5)))
  const reopened = await open()
  expect((reopened.getByLabelText('振替の期限') as HTMLInputElement).value).toBe('45')
})

it('指定先は全ページを読み、別店舗の候補を含めず、選択を保存する', async () => {
  mocks.list.mockResolvedValueOnce({ items: [{ id: 'class-a', line_account_id: 'a', name: '教室' }], total: 3 })
    .mockResolvedValueOnce({ items: [{ id: 'class-b', line_account_id: 'a', name: '別クラス' }, { id: 'other', line_account_id: 'b', name: '他店' }], total: 3 })
  render(view()); const dialog = await open()
  await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2))
  fireEvent.click(dialog.getByLabelText('振替先'))
  fireEvent.click(within(await screen.findByRole('option', { name: '指定のクラス' })).getByRole('button'))
  expect(dialog.queryByRole('option', { name: '他店' })).toBeNull()
  const select = dialog.getByLabelText('指定のクラス') as HTMLSelectElement
  select.options[1].selected = true; fireEvent.change(select)
  fireEvent.click(dialog.getByRole('button', { name: '保存する' }))
  await waitFor(() => expect(mocks.save).toHaveBeenCalledWith('a', 'class-a', { ...initial, target: 'list', targetIds: ['class-b'] }, 4))
})

it('空欄・範囲外と指定先0個は欄で知らせ、通信しない', async () => {
  render(view()); const dialog = await open()
  fireEvent.change(dialog.getByLabelText('振替の期限'), { target: { value: '' } })
  fireEvent.change(dialog.getByLabelText('1か月に渡す上限'), { target: { value: '53' } })
  fireEvent.click(dialog.getByLabelText('振替先'))
  fireEvent.click(within(await screen.findByRole('option', { name: '指定のクラス' })).getByRole('button'))
  fireEvent.click(dialog.getByRole('button', { name: '保存する' }))
  expect(await dialog.findByText('1〜366の整数を入れてください')).toBeTruthy()
  expect(dialog.getByText('1〜52の整数を入れてください')).toBeTruthy()
  expect(dialog.getByText('振替先を1つ以上選んでください')).toBeTruthy()
  expect(mocks.save).not.toHaveBeenCalled()
})

it('通信失敗では窓と入力を残し、再送中の二重操作は1回にする', async () => {
  mocks.save.mockRejectedValueOnce(new Error('offline'))
  render(view()); const dialog = await open()
  fireEvent.change(dialog.getByLabelText('振替の期限'), { target: { value: '50' } })
  fireEvent.click(dialog.getByRole('button', { name: '保存する' }))
  await dialog.findByRole('alert')
  expect((dialog.getByLabelText('振替の期限') as HTMLInputElement).value).toBe('50')
  let resolve!: (value: unknown) => void
  mocks.save.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  fireEvent.click(dialog.getByRole('button', { name: '保存する' })); fireEvent.click(dialog.getByRole('button', { name: /保存中/ }))
  expect(mocks.save).toHaveBeenCalledTimes(2)
  await act(async () => resolve({ data: { rule: { ...initial, validDays: 50 }, revision: 5 } }))
  expect(saved).toHaveBeenCalledTimes(1)
})

it('保存先が返した欄の理由を、その欄へ1回だけ表示して入力を保つ', async () => {
  mocks.save.mockRejectedValueOnce(new ApiError(400, '日数を確認', 'invalid_makeup_rule', undefined, undefined, undefined, { validDays: '日数を見直してください' }))
  render(view()); const dialog = await open()
  fireEvent.change(dialog.getByLabelText('振替の期限'), { target: { value: '45' } })
  fireEvent.click(dialog.getByRole('button', { name: '保存する' }))
  await dialog.findByText('日数を見直してください')
  expect(dialog.getAllByText('日数を見直してください')).toHaveLength(1)
  expect(dialog.getByLabelText('振替の期限').getAttribute('aria-invalid')).toBe('true')
  expect((dialog.getByLabelText('振替の期限') as HTMLInputElement).value).toBe('45')
  expect(saved).not.toHaveBeenCalled()
})

it('窓の書きかけと保存中を、画面離脱を守る親へ報告する', async () => {
  render(view()); const dialog = await open()
  expect(editState).toHaveBeenLastCalledWith({ dirty: false, busy: false })
  fireEvent.change(dialog.getByLabelText('振替の期限'), { target: { value: '45' } })
  expect(editState).toHaveBeenLastCalledWith({ dirty: true, busy: false })
  let resolve!: (value: unknown) => void
  mocks.save.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  fireEvent.click(dialog.getByRole('button', { name: '保存する' }))
  expect(editState).toHaveBeenLastCalledWith({ dirty: true, busy: true })
  await act(async () => resolve({ data: { rule: { ...initial, validDays: 45 }, revision: 5 } }))
  expect(editState).toHaveBeenLastCalledWith({ dirty: false, busy: false })
})

it('保存の競合では入力を保って比較・最新の読取へ進み、最新を読み込んだ版で保存する', async () => {
  mocks.save.mockRejectedValueOnce({ status: 409 })
  mocks.get.mockResolvedValue(event({ ...initial, monthlyCap: 5 }, 9))
  render(view()); const dialog = await open()
  fireEvent.change(dialog.getByLabelText('振替の期限'), { target: { value: '45' } })
  fireEvent.click(dialog.getByRole('button', { name: '保存する' }))
  await dialog.findByText('ほかの人が先にクラスを保存しました')
  expect((dialog.getByLabelText('振替の期限') as HTMLInputElement).value).toBe('45')
  fireEvent.click(dialog.getByRole('button', { name: '違いを比べる' }))
  const compare = within(await screen.findByRole('dialog', { name: '最新の保存と比べる' }))
  expect(compare.getByText(/月 5 回まで/)).toBeTruthy()
  fireEvent.click(compare.getByRole('button', { name: '最新を読み込んで続ける' }))
  await waitFor(() => expect((dialog.getByLabelText('1か月に渡す上限') as HTMLInputElement).value).toBe('5'))
  fireEvent.click(dialog.getByRole('button', { name: '保存する' }))
  await waitFor(() => expect(saved).toHaveBeenCalledWith({ ...initial, monthlyCap: 5 }, 10, 9))
})

it.each(['staff', 'viewer', null])('権限が%sのとき、設定を読めても書き込み口を開かない', role => {
  mocks.role = role; render(view())
  fireEvent.click(screen.getByRole('button', { name: '振替の決まりを編集する' }))
  expect(screen.queryByRole('dialog')).toBeNull(); expect(mocks.save).not.toHaveBeenCalled()
})

it('途中で代理ログインへ切り替わると、開いている窓からも送れない', async () => {
  render(view()); const dialog = await open()
  act(() => rememberSessionSnapshot({ impersonation: { id: 'proxy', mode: 'write' } as never, unfamiliarAt: null, stepUpMethod: 'none' }))
  fireEvent.click(dialog.getByRole('button', { name: '保存する' }))
  expect(mocks.save).not.toHaveBeenCalled()
})

it('別の店が持つクラスは変更できず、所有元のアカウントを案内する', () => {
  render(view({ ...event(), line_account_id: 'b' }))
  fireEvent.click(screen.getByRole('button', { name: '振替の決まりを編集する' }))
  expect(screen.getByText('このクラスを持つLINE公式アカウントで編集してください。')).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull(); expect(mocks.save).not.toHaveBeenCalled()
})

it.each([undefined, '{bad'])('未取得・壊れた保存値を既定のオフで上書きしない（%s）', value => {
  render(view({ ...event(), makeup_rule_json: value }))
  fireEvent.click(screen.getByRole('button', { name: '振替の決まりを編集する' }))
  expect(screen.queryByRole('dialog')).toBeNull(); expect(mocks.save).not.toHaveBeenCalled()
})

it('振替を使わないときは条件を表示しない', () => {
  render(view(event({ ...initial, enabled: false })))
  expect(screen.getByText('使わない')).toBeTruthy()
  expect(screen.queryByText(/開始の 3 時間前まで/)).toBeNull()
})

it('比較では振替を使わない場合も条件の違いが分かる', () => {
  const a = makeupRuleSummary({ ...initial, enabled: false, cutoffHours: 3 })
  const b = makeupRuleSummary({ ...initial, enabled: false, cutoffHours: 24 })
  expect(a).toContain('開始の 3 時間前まで')
  expect(b).toContain('開始の 24 時間前まで')
  expect(a).not.toBe(b)
})
