// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import MemberDialog from './member-dialog'
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

afterEach(cleanup)

it('招待の入力中はリンクと戻るを確かめ、権限変更の確認中も入力を守る', () => {
  const close = vi.fn()
  const { rerender } = render(<><a href="/templates">テンプレート</a><MemberDialog open session={1} member={null} onSubmit={vi.fn()} onCancel={close} /></>)
  fireEvent.change(screen.getByLabelText('名前'), { target: { value: '担当者' } })
  fireEvent.click(screen.getByRole('link', { name: 'テンプレート' }))
  expect(screen.getByText('保存していない変更があります')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '編集を続ける' }))
  rerender(<><a href="/templates">テンプレート</a><MemberDialog open={false} active session={1} member={null} onSubmit={vi.fn()} onCancel={close} /></>)
  fireEvent.popState(window)
  expect(screen.getByText('保存していない変更があります')).toBeTruthy()
  expect(close).not.toHaveBeenCalled()
})

it('統括の招待では全アカウントだけを付与する', () => {
  const submit = vi.fn()
  render(<MemberDialog open session={1} member={null} onSubmit={submit} onCancel={() => {}} />)
  expect(screen.queryByText('最初に表示するアカウント')).toBeNull()
  fireEvent.change(screen.getByLabelText('名前'), { target: { value: '担当者' } })
  fireEvent.change(screen.getByLabelText('メールアドレス'), { target: { value: 'staff@example.com' } })
  expect(screen.queryByRole('radio', { name: '指定したアカウントだけ' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '招待メールを送る' }))
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ scopedLineAccountIds: [], accountScope: 'all' }))
})

it('担当者を選ぶと、業務操作と管理者だけの操作の違いが分かる', () => {
  const submit = vi.fn()
  render(<MemberDialog open session={1} member={null} onSubmit={submit} onCancel={() => {}} />)
  fireEvent.change(screen.getByLabelText('名前'), { target: { value: '担当者' } })
  fireEvent.change(screen.getByLabelText('メールアドレス'), { target: { value: 'staff@example.com' } })
  fireEvent.click(screen.getByLabelText('役割'))
  fireEvent.click(screen.getByRole('option', { name: '担当者（業務を操作できる）' }).querySelector('button')!)
  expect(screen.getByText('予約・配信などの業務を操作できます。メンバーの追加や決済の変更はできません。')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '招待メールを送る' }))
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ role: 'staff', accountScope: 'all' }))
})


it('不正なメールの貼り付けはその場で知らせ、招待を送らない', () => {
  const submit = vi.fn()
  render(<MemberDialog open session={1} member={null} onSubmit={submit} onCancel={() => {}} />)
  fireEvent.change(screen.getByLabelText('名前'), { target: { value: '担当者' } })
  fireEvent.paste(screen.getByLabelText('メールアドレス'), { clipboardData: { getData: () => 'bad@' } })
  expect(screen.getByRole('alert').textContent).toContain('正しいメール')
  fireEvent.click(screen.getByRole('button', { name: '招待メールを送る' }))
  expect(submit).not.toHaveBeenCalled()
})
