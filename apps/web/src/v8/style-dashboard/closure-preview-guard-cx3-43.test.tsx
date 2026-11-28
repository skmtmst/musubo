// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ClosureDialog } from './settings-panels'

afterEach(cleanup)
it.each([
  ['一覧が配列でない', { rows: {}, snapshot: 'version' }],
  ['予約の名前が文字列でない', { rows: [{ time: '19:00', name: null, sub: '1名' }], snapshot: 'version' }],
])('%s場合は休みを登録せず、読み直しを案内する', async (_label, invalid) => {
  const save = vi.fn()
  const preview = vi.fn().mockResolvedValueOnce(invalid).mockResolvedValueOnce({ rows: [], snapshot: 'new-version' })
  render(<ClosureDialog open date="2026-11-03" targets={{ staff: [{ id: 's1', name: '担当者' }], seats: [] }} seatNoun="担当者" busy={false} onClose={() => {}} onSave={save} preview={preview} />)
  fireEvent.click(screen.getByRole('button', { name: '休みを入れる' }))
  expect(await screen.findByText(/予約を確認できませんでした/)).toBeTruthy()
  expect(save).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '休みを入れる' }))
  await vi.waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ expectedSnapshot: 'new-version' })))
})
