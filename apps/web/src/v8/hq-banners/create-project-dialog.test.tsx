// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { CreateProjectDialogV8 } from './dialogs'
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
afterEach(cleanup)

test('作成窓は入力を本文幅へ渡し、名前必須・説明・Enterの保存を保つ', () => {
  const submit = vi.fn(), cancel = vi.fn()
  render(<CreateProjectDialogV8 open busy={false} onSubmit={submit} onCancel={cancel} />)
  const dialog = screen.getByRole('dialog', { name: 'プロジェクトを作る' })
  expect(dialog.querySelector('[data-content-layout="form"]')).toBeTruthy()
  expect((screen.getByRole('button', { name: '作って開く' }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByText('プロジェクト名を入力してください')).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: /プロジェクト名/ }), { target: { value: ' 春のご案内 ' } })
  fireEvent.change(screen.getByRole('textbox', { name: /説明/ }), { target: { value: ' 予約のお知らせ ' } })
  fireEvent.submit(dialog.querySelector('form')!)
  expect(submit).toHaveBeenCalledWith({ name: '春のご案内', description: '予約のお知らせ' })
  expect(cancel).not.toHaveBeenCalled()
})
