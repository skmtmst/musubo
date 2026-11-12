// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import DateTimeField from './date-time-field'
import ScheduleSendDialog from '@/v8/inbox-chat/schedule-dialog'

beforeEach(() => { document.documentElement.dataset.theme = 'v8' })
afterEach(() => { cleanup(); delete document.documentElement.dataset.theme })

const INITIAL = '2026-10-01T10:00'
function Harness({ controlled, onChange }: { controlled: boolean; onChange: (next: string) => void }) {
  const [value, setValue] = useState(INITIAL)
  return <form aria-label="期間">
    <DateTimeField aria-label="開始" name="start" {...(controlled ? { value } : { defaultValue: INITIAL })}
      onChange={(next) => { setValue(next); onChange(next) }} />
    <DateTimeField aria-label="終了" name="end" defaultValue="2026-10-01T22:00" />
    <output data-testid="parent">{value}</output>
  </form>
}
function clearInside(method: string) {
  fireEvent.click(screen.getByRole('button', { name: '開始' }))
  const time = screen.getByRole('combobox', { name: '時刻' })
  if (method === '消す') {
    fireEvent.click(screen.getByRole('button', { name: '時刻の一覧を開く' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '時刻を選ぶ' })).getByRole('button', { name: '消す' }))
  } else {
    fireEvent.change(time, { target: { value: '' } })
    fireEvent.keyDown(time, { key: 'Enter' })
  }
  fireEvent.click(within(screen.getByRole('dialog', { name: '日時を選ぶ' })).getByRole('button', { name: '確定' }))
}
for (const controlled of [true, false]) {
  it.each(['消す', '空にしてEnter'])(`UI-TIME-CLEAR-1134: ${controlled ? 'value' : 'defaultValue'} / %s で表示・親・保存値が空、隣は保持`, (method) => {
    const onChange = vi.fn()
    render(<Harness controlled={controlled} onChange={onChange} />)
    clearInside(method)
    expect(onChange.mock.calls).toEqual([['']])
    expect(screen.getByTestId('parent').textContent).toBe('')
    const form = screen.getByRole('form') as HTMLFormElement
    expect(new FormData(form).get('start')).toBe('')
    expect(new FormData(form).get('end')).toBe('2026-10-01T22:00')
    expect(screen.getByRole('button', { name: '開始' }).textContent).toContain('日時を選ぶ')
    fireEvent.click(screen.getByRole('button', { name: '開始' }))
    expect((screen.getByRole('combobox', { name: '時刻' }) as HTMLInputElement).value).toBe('')
  })
}
it('外側の日時を消す操作は隣の終了日時を変えない', () => {
  render(<Harness controlled={false} onChange={() => {}} />)
  fireEvent.click(screen.getAllByRole('button', { name: '日時を消す' })[0])
  const data = new FormData(screen.getByRole('form') as HTMLFormElement)
  expect(data.get('start')).toBe('')
  expect(data.get('end')).toBe('2026-10-01T22:00')
})
it.each(['消す', '空にしてEnter'])('予約中時刻の%sは予約を変更・取消せず、取消ボタンは明示操作のまま', (method) => {
  const onReschedule = vi.fn(), onCancelRow = vi.fn()
  render(<ScheduleSendDialog open onClose={() => {}} content="案内" hasImage={false} value="" onChange={() => {}}
    onConfirm={() => {}} busy={false} rowsFailed={false} onRetryRows={() => {}} onReschedule={onReschedule} onCancelRow={onCancelRow}
    rows={[{ id: 'a', label: '10/1 10:00', content: '案内', editable: true, defaultValue: INITIAL }]} />)
  fireEvent.click(screen.getByRole('button', { name: '予約時刻を変更（日本時間）' }))
  const time = screen.getByRole('combobox', { name: '時刻' })
  if (method === '消す') {
    fireEvent.click(screen.getByRole('button', { name: '時刻の一覧を開く' }))
    fireEvent.click(within(screen.getByRole('dialog', { name: '時刻を選ぶ' })).getByRole('button', { name: '消す' }))
  } else {
    fireEvent.change(time, { target: { value: '' } })
    fireEvent.keyDown(time, { key: 'Enter' })
  }
  fireEvent.click(within(screen.getByRole('dialog', { name: '日時を選ぶ' })).getByRole('button', { name: '確定' }))
  expect(screen.getByRole('button', { name: '予約時刻を変更（日本時間）' }).textContent).toContain('日時を選ぶ')
  expect(onReschedule).not.toHaveBeenCalled()
  expect(onCancelRow).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '予約を取り消す' }))
  expect(onCancelRow).toHaveBeenCalledWith('a')
})
