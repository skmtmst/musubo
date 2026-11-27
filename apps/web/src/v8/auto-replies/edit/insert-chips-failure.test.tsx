// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import AutoReplyInsertChips from './insert-chips'

afterEach(cleanup)
it('差し込み項目の取得失敗を知らせ、友だち情報を選べない', async () => {
  const insert = vi.fn()
  render(<AutoReplyInsertChips accountId="sample" load={() => Promise.reject(new Error('offline'))} onInsert={insert} />)
  expect(await screen.findByText('差し込み項目を読み込めませんでした。画面を再読み込みしてください。')).toBeTruthy()
  expect((screen.getByRole('button', { name: '友だち情報' }) as HTMLButtonElement).disabled).toBe(true)
  expect(insert).not.toHaveBeenCalled()
})
