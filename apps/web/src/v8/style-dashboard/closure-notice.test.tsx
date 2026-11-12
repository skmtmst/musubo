// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ClosureDialog } from './settings-panels'

afterEach(cleanup)
it('重なる予約があっても連絡は自動で送らず、休みだけを入れると案内する', async () => {
  const save = vi.fn()
  render(<ClosureDialog open date="2026-11-03" targets={{ staff: [{ id: 's1', name: '担当者' }], seats: [] }} seatNoun="担当者" busy={false} onClose={() => {}} onSave={save} preview={async () => [{ time: '19:00', name: 'お客さま', sub: '1名' }]} />)
  fireEvent.click(screen.getByRole('button', { name: '休みを入れる' }))
  const dialog = await screen.findByRole('dialog', { name: /重なる予約が/ })
  expect(dialog.textContent).toContain('LINEアカウント')
  expect(dialog.textContent).toContain('環境')
  expect(within(dialog).getByText('重なる予約は取り消しません。')).toBeTruthy()
  expect(within(dialog).getByText('重なる予約への連絡は自動では送られません。')).toBeTruthy()
  expect(within(dialog).queryByRole('radiogroup', { name: '予約の扱い' })).toBeNull()
  expect(within(dialog).queryByLabelText(/人に送る LINE/)).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: '休みを入れる' }))
  expect(save).toHaveBeenCalledOnce()
  expect(save.mock.calls[0]).toHaveLength(1)
})

it('確認の取得中にアカウントが変わったら前の休みを保存しない', async () => {
  const save = vi.fn()
  let finish!: (rows: []) => void
  const preview = () => new Promise<[]>(resolve => { finish = resolve })
  const dialog = (account: string) => <ClosureDialog key={account} accountId={account} open date="2026-11-03" targets={{ staff: [{ id: 's1', name: '担当者' }], seats: [] }} seatNoun="担当者" busy={false} onClose={() => {}} onSave={save} preview={preview} />
  const view = render(dialog('a'))
  fireEvent.click(screen.getByRole('button', { name: '休みを入れる' }))
  view.rerender(dialog('b'))
  await act(async () => { finish([]) })
  expect(save).not.toHaveBeenCalled()
})

it('確認した予約の版を固定して休業を登録する', async () => {
  const save = vi.fn()
  const preview = vi.fn(async () => ({ rows: [{ time: '19:00', name: 'お客さま', sub: '1名' }], snapshot: 'fixed-snapshot' }))
  render(<ClosureDialog open date="2026-11-03" targets={{ staff: [{ id: 's1', name: '担当者' }], seats: [] }} seatNoun="担当者" busy={false} onClose={() => {}} onSave={save} preview={preview} />)
  fireEvent.click(screen.getByRole('button', { name: '休みを入れる' }))
  const dialog = await screen.findByRole('dialog', { name: /重なる予約が/ })
  expect(save).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: '休みを入れる' }))
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ expectedSnapshot: 'fixed-snapshot', date: '2026-11-03', ids: ['s1'] }))
})

it('予約を確認できなければ休業を登録しない', async () => {
  const save = vi.fn()
  render(<ClosureDialog open date="2026-11-03" targets={{ staff: [{ id: 's1', name: '担当者' }], seats: [] }} seatNoun="担当者" busy={false} onClose={() => {}} onSave={save} preview={async () => { throw new Error('offline') }} />)
  fireEvent.click(screen.getByRole('button', { name: '休みを入れる' }))
  expect(await screen.findByText(/予約を確認できませんでした/)).toBeTruthy()
  expect(save).not.toHaveBeenCalled()
})
