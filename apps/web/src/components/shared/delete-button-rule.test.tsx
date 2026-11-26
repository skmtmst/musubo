// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import ConfirmDialog from './confirm-dialog'
import EventQuestionsEditor from '@/components/events/event-questions-editor'

afterEach(cleanup)

it.each([{ destructive: true }, { confirmVariant: 'danger' as const }])('確認画面の危険な決定は塗りのボタンで実行する', props => {
  const confirm = vi.fn()
  render(<ConfirmDialog open title="項目を削除しますか？" description="削除します。" confirmLabel="削除する" onCancel={() => {}} onConfirm={confirm} {...props} />)
  const dialog = screen.getByRole(props.destructive ? 'alertdialog' : 'dialog')
  const remove = within(dialog).getByRole('button', { name: '削除する' })
  const cancel = within(dialog).getByRole('button', { name: 'キャンセル' })
  expect(remove.getAttribute('data-variant')).toBe('danger')
  expect(remove.getAttribute('data-dialog-action')).toBe('danger')
  expect(cancel.getAttribute('data-variant')).toBe('secondary')
  expect(remove.className).toContain('standard')
  expect(cancel.className).toContain('standard')
  fireEvent.click(remove)
  expect(confirm).toHaveBeenCalledOnce()
})

it('質問欄の削除は赤い文字の操作で、選んだ質問を外す', () => {
  const change = vi.fn()
  render(<EventQuestionsEditor questions={[{ id: 'q1', label: '質問', type: 'text', required: false }]} onChange={change} />)
  const remove = screen.getByRole('button', { name: '削除する' })
  expect(remove.getAttribute('data-variant')).toBe('text')
  expect(remove.className).toContain('textDanger')
  fireEvent.click(remove)
  expect(change).toHaveBeenCalledWith([])
})

it('キャンセルを主操作にしても危険な決定は赤い塗りを保つ', () => {
  render(<ConfirmDialog open title="削除しますか？" description="削除します。" confirmLabel="削除する" destructive primaryAction="cancel" onCancel={() => {}} onConfirm={() => {}} />)
  const remove = screen.getByRole('button', { name: '削除する' })
  expect(remove.getAttribute('data-variant')).toBe('danger')
  expect(remove.getAttribute('data-dialog-action')).toBe('danger')
})
