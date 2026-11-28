// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EntityPickerDialog } from './entity-picker'
afterEach(cleanup)
it('開いた選ぶ窓は理由が付いても残り、読取とプレビューは続けて確定だけを止める', () => {
  const save = vi.fn(), preview = vi.fn()
  const draw = (confirmLockedReason?: string) => <EntityPickerDialog title="移すフォルダを選ぶ" items={[{ id: 'a', name: '分類A' }, { id: 'b', name: '分類B' }]} onSelect={preview} onConfirm={save} onCancel={() => {}} confirmLockedReason={confirmLockedReason} />
  const { rerender } = render(draw())
  fireEvent.click(screen.getByRole('radio', { name: '分類A' }))
  const dialog = screen.getByRole('dialog')
  rerender(draw('この操作はオーナーか管理者だけができます。'))
  expect(screen.getByRole('dialog')).toBe(dialog)
  const confirm = screen.getByRole('button', { name: '選択する' }) as HTMLButtonElement
  expect(confirm.disabled).toBe(false); expect(confirm.getAttribute('aria-disabled')).toBe('true')
  fireEvent.focus(confirm)
  expect(screen.getByRole('tooltip').textContent).toContain('オーナーか管理者')
  fireEvent.click(confirm)
  fireEvent.keyDown(confirm, { key: 'Enter' }); fireEvent.keyDown(confirm, { key: ' ' })
  expect(save).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('radio', { name: '分類B' }))
  expect(preview).toHaveBeenLastCalledWith('b')
  expect(save).not.toHaveBeenCalled()
  rerender(draw())
  expect(screen.queryByRole('tooltip')).toBeNull()
  expect(confirm.hasAttribute('data-permission-locked')).toBe(false)
  fireEvent.click(confirm); expect(save).toHaveBeenCalledExactlyOnceWith('b')
})

it('理由付きの窓では作成ボタンと作成先リンクも残して止め、閲覧のプレビューは描く', () => {
  const create = vi.fn(), save = vi.fn()
  const draw = (confirmLockedReason?: string) => <EntityPickerDialog title="候補を選ぶ" items={[{ id: 'a', name: '分類A' }]} initialId="a" query="新しい候補" createAction={{ label: q => `${q}を作る`, onCreate: create }} createHref="/tags/new" createLabel="タグを作る" preview={item => <p>見本：{item?.name}</p>} onConfirm={save} onCancel={() => {}} confirmLockedReason={confirmLockedReason} />
  const { rerender } = render(draw('この操作はオーナーか管理者だけができます。'))
  expect(screen.getByText('見本：分類A')).toBeTruthy()
  const createButton = screen.getByRole('button', { name: '新しい候補を作る' })
  const link = screen.getByRole('button', { name: '作る画面へ：タグを作る' })
  expect(screen.queryByRole('link', { name: '作る画面へ：タグを作る' })).toBeNull()
  expect(link.hasAttribute('href')).toBe(false)
  for (const button of [createButton, link]) {
    expect(button.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(button); fireEvent.keyDown(button, { key: 'Enter' }); fireEvent.keyDown(button, { key: ' ' })
  }
  expect(create).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: '選択する' }).hasAttribute('title')).toBe(false)
  rerender(draw())
  expect(screen.getByRole('link', { name: '作る画面へ：タグを作る' }).getAttribute('href')).toBe('/tags/new')
  fireEvent.click(screen.getByRole('button', { name: '新しい候補を作る' }))
  expect(create).toHaveBeenCalledExactlyOnceWith('新しい候補')
})
