// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import BulkRunDialog from './bulk-run-dialog'

const calls = vi.hoisted(() => ({ preview: vi.fn(), create: vi.fn(), get: vi.fn(), operators: vi.fn(), scenarios: vi.fn(), resources: vi.fn(), marks: vi.fn(), reminders: vi.fn() }))
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return { ...actual, api: { ...actual.api, friends: { ...actual.api.friends, bulkPreview: calls.preview, bulkCreate: calls.create, bulkGet: calls.get },
    operators: { ...actual.api.operators, list: calls.operators }, scenarios: { ...actual.api.scenarios, listPage: calls.scenarios },
    commonActions: { ...actual.api.commonActions, resources: calls.resources },
    supportMarks: { ...actual.api.supportMarks, list: calls.marks }, reminders: { ...actual.api.reminders, list: calls.reminders },
  } }
})
// 候補部品自体の試験ではなく、選んだ操作と確認・実行・結果のつながりを検査する。
vi.mock('@/components/shared/combobox', () => ({
  default: ({ value, onChange, options, disabled, 'aria-label': label }: { value: string; disabled: boolean; 'aria-label': string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) => (
    <select aria-label={label} disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="">選んでください</option>
      {options.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
    </select>
  ),
}))
vi.mock('@/components/shared/date-time-field', () => ({ default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
  <input aria-label="予定日時" value={value} onChange={(event) => onChange(event.target.value)} />
) }))

let host: HTMLDivElement
let root: Root
const closed = vi.fn()
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  calls.preview.mockResolvedValue({ success: true, data: { selectedCount: 2, targetCount: 1, excludedCount: 1, accountBreakdown: [], exclusions: [], sample: [], reversible: true } })
  calls.create.mockResolvedValue({ success: true, data: { id: 'run-1' } })
  calls.operators.mockResolvedValue({ success: true, data: [{ id: 'operator-a', name: '担当A' }] })
  calls.marks.mockResolvedValue({ success: true, data: [{ id: 'mark-a', name: '相談中' }] })
  calls.reminders.mockResolvedValue({ success: true, data: [{ id: 'reminder-a', name: '予約の通知' }] })
  calls.scenarios.mockResolvedValue({ success: true, data: { items: [{ id: 'scenario-a', name: 'シナリオA' }], total: 1 } })
  calls.resources.mockResolvedValue({ success: true, data: {
    commonActions: [{ id: 'action-a', name: '登録した操作', currentPublishedVersionId: 'version-a' }],
  } })
  calls.get.mockResolvedValue({ success: true, data: { id: 'run-1', status: 'success', operation: { kind: 'add_tag', tagId: 'vip' }, successCount: 1, skippedCount: 0, temporaryFailureCount: 0, permanentFailureCount: 0, items: [], reversible: true } })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(<BulkRunDialog open friendIds={['a', 'b']} selectedFriends={[]} tags={[{ id: 'vip', name: 'VIP' }]} accountId="account-a" onClose={closed} onDone={() => {}} />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
})
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"]')!
async function press(text: string) {
  const button = [...dialog().querySelectorAll('button')].find((item) => item.textContent?.trim() === text)
  expect(button, text).toBeTruthy()
  await act(async () => button!.click())
}
async function preview() {
  const select = dialog().querySelector<HTMLSelectElement>('select')!
  await act(async () => { select.value = 'vip'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  await press('実行内容を確認 →')
}
async function enter(label: string, value: string) {
  const field = dialog().querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!
  expect(field, label).toBeTruthy()
  await act(async () => {
    Object.getOwnPropertyDescriptor(field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('一括操作の小窓の確認と実行', () => {
  it('結果取得に失敗しても再作成せず結果だけ読み直す', async () => {
    calls.get.mockRejectedValueOnce(new Error('offline'))
    await preview()
    await press('1人に実行する')
    expect(calls.create).toHaveBeenCalledTimes(1)
    expect(calls.get).toHaveBeenCalledWith('run-1')
    expect(dialog().querySelector('[role="alert"]')).not.toBeNull()
    await press('読み直す')
    expect(calls.get).toHaveBeenCalledTimes(2)
    expect(calls.get).toHaveBeenLastCalledWith('run-1')
    expect(calls.create).toHaveBeenCalledTimes(1)
  })
  it('確認するまで書き込まず、実行する人数はサーバーが数えた対象を使う', async () => {
    expect(calls.create).not.toHaveBeenCalled()
    await preview()
    expect(calls.preview).toHaveBeenCalledWith({ kind: 'explicit', friendIds: ['a', 'b'] }, { kind: 'add_tag', tagId: 'vip' })
    expect(calls.create).not.toHaveBeenCalled()
    expect(dialog().textContent).toContain('1人に実行する')
    await press('1人に実行する')
    expect(calls.create).toHaveBeenCalledTimes(1)
    expect(calls.create.mock.calls[0][2]).not.toHaveProperty('confirmIrreversible')
    await press('読み直す')
    expect(calls.create).toHaveBeenCalledTimes(1)
    expect(calls.get).toHaveBeenCalledTimes(2)
  })
  it('確認から戻っても選んだタグが残り、再確認だけでは実行しない', async () => {
    await preview()
    await press('← 戻る')
    expect(dialog().querySelector<HTMLSelectElement>('select')?.value).toBe('vip')
    await press('実行内容を確認 →')
    expect(calls.preview).toHaveBeenCalledTimes(2)
    expect(calls.create).not.toHaveBeenCalled()
  })
  it('閉じる操作では友だちへの変更を送らない', async () => {
    await press('閉じる')
    expect(closed).toHaveBeenCalledTimes(1)
    expect(calls.preview).not.toHaveBeenCalled()
    expect(calls.create).not.toHaveBeenCalled()
  })
  it.each([
    ['タグを外す', 'vip', { kind: 'remove_tag', tagId: 'vip' }],
    ['担当者を変更', 'operator-a', { kind: 'assign_operator', operatorId: 'operator-a' }],
    ['担当者を変更', '__none', { kind: 'assign_operator', operatorId: null }],
    ['シナリオを開始', 'scenario-a', { kind: 'start_scenario', scenarioId: 'scenario-a' }],
    ['シナリオを停止', 'scenario-a', { kind: 'stop_scenario', scenarioId: 'scenario-a' }],
    ['対応マークを変更', 'mark-a', { kind: 'set_support', markId: 'mark-a' }],
    ['対応マークを変更', '__none', { kind: 'set_support', markId: null }],
    ['リマインダを設定', 'reminder-a', { kind: 'set_reminder', reminderId: 'reminder-a', targetDate: '2026-10-05T01:00:00.000Z' }],
    ['アクションを実行', 'action-a', { kind: 'run_common_action', commonActionId: 'action-a', commonActionVersionId: 'version-a' }],
  ])('%sで入力した内容を確認に送り、確認だけでは実行しない', async (label, value, expected) => {
    await press(label)
    expect(dialog().querySelector<HTMLButtonElement>('button[aria-pressed="true"]')?.disabled).toBe(false)
    expect([...dialog().querySelectorAll('button')].find((button) => button.textContent?.trim() === '実行内容を確認 →')?.disabled).toBe(true)
    const select = dialog().querySelector<HTMLSelectElement>('select')!
    await act(async () => { select.value = value; select.dispatchEvent(new Event('change', { bubbles: true })) })
    if (label === 'リマインダを設定') await enter('予定日時', '2026-10-05T10:00')
    await press('実行内容を確認 →')
    expect(calls.preview).toHaveBeenCalledWith({ kind: 'explicit', friendIds: ['a', 'b'] }, expected)
    expect(calls.create).not.toHaveBeenCalled()
    await press('1人に実行する')
    expect(calls.create).toHaveBeenCalledWith({ kind: 'explicit', friendIds: ['a', 'b'] }, expected, expect.objectContaining({ idempotencyKey: expect.any(String) }))
  })
  it('送信は本文の確認と取り消せない操作の追加確認を通してから実行する', async () => {
    calls.preview.mockResolvedValueOnce({ success: true, data: { selectedCount: 2, targetCount: 1, excludedCount: 1, accountBreakdown: [], exclusions: [], sample: [], reversible: false } })
    await press('メッセージを送る')
    await enter('送るメッセージ', '確認して送る本文')
    await press('実行内容を確認 →')
    expect(dialog().textContent).toContain('確認して送る本文')
    const submit = [...dialog().querySelectorAll('button')].find((button) => button.textContent?.trim() === '1人に実行する')!
    expect(submit.disabled).toBe(true)
    expect(dialog().textContent).toContain('この操作は取り消せません')
    expect(calls.create).not.toHaveBeenCalled()
    await act(async () => dialog().querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    await press('1人に実行する')
    expect(calls.create).toHaveBeenCalledWith({ kind: 'explicit', friendIds: ['a', 'b'] }, { kind: 'send_message', content: '確認して送る本文', messageType: 'text' }, expect.objectContaining({ confirmIrreversible: true }))
  })
  it('候補を取得できないときは一度だけ失敗を出し、再読込だけで書き込まない', async () => {
    calls.operators.mockRejectedValueOnce(new Error('unavailable'))
    await press('担当者を変更')
    expect(dialog().textContent?.match(/候補を読み込めませんでした/g)).toHaveLength(1)
    await press('もう一度読み込む')
    expect(dialog().textContent).toContain('担当A')
    expect(calls.create).not.toHaveBeenCalled()
    expect(calls.preview).not.toHaveBeenCalled()
  })
  it('別アカウントへ切り替えたあとで古い候補が届いても採用しない', async () => {
    let resolve!: (value: unknown) => void
    calls.reminders.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    await press('リマインダを設定')
    calls.reminders.mockResolvedValue({ success: true, data: [{ id: 'b', name: 'Bの通知' }] })
    await act(async () => root.render(<BulkRunDialog open friendIds={['a', 'b']} selectedFriends={[]} tags={[]} accountId="account-b" onClose={closed} onDone={() => {}} />))
    await act(async () => resolve({ success: true, data: [{ id: 'a', name: 'Aの通知' }] }))
    expect(dialog().textContent).toContain('Bの通知')
    expect(dialog().textContent).not.toContain('Aの通知')
    expect(calls.reminders).toHaveBeenLastCalledWith({ accountId: 'account-b' })
    expect(calls.preview).not.toHaveBeenCalled()
    expect(calls.create).not.toHaveBeenCalled()
  })
  it('対応マークが無効なアカウントでは入口も候補取得も出さない', async () => {
    await act(async () => root.render(<BulkRunDialog open friendIds={['a', 'b']} selectedFriends={[]} tags={[]} accountId="account-a" supportMarksEnabled={false} onClose={closed} onDone={() => {}} />))
    expect(dialog().textContent).not.toContain('対応マークを変更')
    expect(calls.marks).not.toHaveBeenCalled()
  })
})

// 選ぶ物の欄も、保存/API境界の試験では以前のSelectと同じ差し替えにする。
vi.mock('@/components/shared/entity-select', () => import('@/test-utils/entity-select-mock'))
