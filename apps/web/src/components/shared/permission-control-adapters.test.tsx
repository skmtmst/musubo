// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Trash2 } from 'lucide-react'
import IconButton from './icon-button'
import { RowActions, RowQuickAction } from './row-actions'
import ContextMenu from './context-menu'
import StickyBarAction from './sticky-bar-action'

afterEach(cleanup)
const reason = 'この操作はオーナーだけができます。'

it.each(['icon', 'quick'] as const)('%sの権限ロックは焦点・マウス・タップを保ち、送信と親操作を止める', async kind => {
  const run = vi.fn(), parent = vi.fn(), submit = vi.fn((event: Event) => event.preventDefault()), pointer = vi.fn()
  const button = kind === 'icon'
    ? <IconButton aria-label="変更する" disabled lockedReason={reason} onClick={run} onPointerDown={pointer} size="compact" variant="attention" pressed>印</IconButton>
    : <RowQuickAction label="変更する" ariaLabel="変更する" disabled lockedReason={reason} onClick={run} onPointerDown={pointer} />
  render(<form onSubmit={submit as never}><div onClick={parent}>{button}</div></form>)
  const control = screen.getByRole('button', { name: '変更する' }) as HTMLButtonElement
  expect(control.disabled).toBe(false)
  expect(control.getAttribute('aria-disabled')).toBe('true')
  expect(control.hasAttribute('data-permission-locked')).toBe(true)
  expect(document.getElementById(control.getAttribute('aria-describedby')!)?.textContent).toBe(reason)
  fireEvent.pointerEnter(control, { pointerType: 'mouse' })
  expect(screen.getByRole('tooltip').textContent).toBe(reason)
  fireEvent.pointerLeave(control, { pointerType: 'mouse' })
  expect(screen.queryByRole('tooltip')).toBeNull()
  act(() => control.focus())
  fireEvent.scroll(window)
  await waitFor(() => expect(screen.getByRole('tooltip').textContent).toBe(reason))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('tooltip')).toBeNull()
  fireEvent.blur(control)
  fireEvent.pointerDown(control, { pointerType: 'touch' })
  expect(screen.getByRole('tooltip').textContent).toBe(reason)
  expect(fireEvent.keyDown(control, { key: 'Enter' })).toBe(false)
  expect(fireEvent.keyDown(control, { key: ' ' })).toBe(false)
  fireEvent.click(control)
  fireEvent.doubleClick(control)
  expect(run).not.toHaveBeenCalled()
  expect(pointer).not.toHaveBeenCalled()
  expect(parent).not.toHaveBeenCalled()
  expect(submit).not.toHaveBeenCalled()
  if (kind === 'icon') {
    expect(control.dataset.size).toBe('compact')
    expect(control.dataset.variant).toBe('attention')
    expect(control.getAttribute('aria-pressed')).toBe('true')
  }
})

it.each(['icon', 'quick'] as const)('%sの入力理由はnative disabledのまま、正規操作へ戻れば実行できる', kind => {
  const run = vi.fn()
  const control = (disabled: boolean) => kind === 'icon'
    ? <IconButton aria-label="変更する" disabled={disabled} onClick={run}>印</IconButton>
    : <RowQuickAction label="変更する" ariaLabel="変更する" disabled={disabled} onClick={run} />
  const { rerender } = render(control(true))
  const button = screen.getByRole('button', { name: '変更する' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  expect(button.hasAttribute('data-permission-locked')).toBe(false)
  fireEvent.click(button)
  expect(run).not.toHaveBeenCalled()
  rerender(control(false))
  fireEvent.click(button)
  expect(run).toHaveBeenCalledTimes(1)
})

it('行の既存の主操作と詳細を保ち、編集だけ権限ロックをメニューへ渡す', async () => {
  const approve = vi.fn(), view = vi.fn(), edit = vi.fn()
  render(<RowActions subjectName="対象" primary={{ label: '承認する', onClick: approve }}
    detail={{ label: '詳細を見る', onClick: view }} edit={{ onClick: edit, lockedReason: reason }} />)
  fireEvent.click(screen.getByRole('button', { name: '承認する' }))
  expect(approve).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: '対象のその他操作' }))
  const locked = await screen.findByRole('menuitem', { name: '編集する' })
  expect(locked.getAttribute('aria-disabled')).toBe('true')
  expect((locked as HTMLButtonElement).disabled).toBe(false)
  fireEvent.click(locked)
  expect(edit).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('menuitem', { name: '詳細を見る' }))
  expect(view).toHaveBeenCalledTimes(1)
})

it('行の主リンクの権限ロックはhrefをDOMへ残さない', () => {
  render(<RowActions primary={{ label: '編集する', href: '/tags/new', lockedReason: reason }} />)
  const button = screen.getByRole('button', { name: '編集する' })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(button.hasAttribute('href')).toBe(false)
  expect(screen.queryByRole('link')).toBeNull()
})

it('右クリックでも読取項目を保ち、書込と権限リンクを起動しない', async () => {
  const write = vi.fn(), read = vi.fn()
  render(<ContextMenu label="操作" items={[
    { id: 'write', label: '編集する', lockedReason: reason, onSelect: write, href: '/tags/new' },
    { id: 'read', label: '詳細を見る', onSelect: read },
  ]}><span>対象行</span></ContextMenu>)
  fireEvent.contextMenu(screen.getByText('対象行'), { clientX: 80, clientY: 100 })
  const locked = await screen.findByRole('menuitem', { name: '編集する' })
  expect(locked.getAttribute('aria-disabled')).toBe('true')
  expect(locked.hasAttribute('href')).toBe(false)
  fireEvent.click(locked)
  expect(write).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('menuitem', { name: '詳細を見る' }))
  expect(read).toHaveBeenCalledTimes(1)
})

it('下の削除入口は本線の文字だけの形を保ち、権限理由を吹き出しへ渡す', () => {
  const run = vi.fn()
  const { container } = render(<StickyBarAction label="削除する" icon={Trash2} destructive lockedReason={reason} disabledReason="入力を確かめてください" onClick={run} />)
  const button = screen.getByRole('button', { name: '削除する' })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(container.querySelector('svg')).toBeNull()
  expect(screen.queryByRole('note')).toBeNull()
  fireEvent.click(button)
  expect(run).not.toHaveBeenCalled()
})

it('下の帯の入力不足はnative disabledと既存の理由1行を保つ', () => {
  const run = vi.fn()
  render(<StickyBarAction label="削除する" icon={Trash2} destructive disabledReason="確認を入力してください" onClick={run} />)
  const button = screen.getByRole('button', { name: '削除する' }) as HTMLButtonElement
  expect(button.disabled).toBe(true)
  expect(button.hasAttribute('data-permission-locked')).toBe(false)
  expect(screen.getByRole('note').textContent).toBe('確認を入力してください')
  fireEvent.click(button)
  expect(run).not.toHaveBeenCalled()
})

it.each(['icon', 'quick'] as const)('%sは既存の読み上げ説明と権限の理由を両方保つ', kind => {
  render(<><p id="action-description">変更した結果は担当者へ通知します</p>{kind === 'icon'
    ? <IconButton aria-label="変更する" aria-describedby="action-description" lockedReason={reason}>印</IconButton>
    : <RowQuickAction label="変更する" ariaLabel="変更する" aria-describedby="action-description" lockedReason={reason} />}</>)
  const button = screen.getByRole('button', { name: '変更する' })
  const ids = button.getAttribute('aria-describedby')!.split(' ')
  expect(ids).toHaveLength(2)
  expect(ids[0]).toBe('action-description')
  expect(ids.map(id => document.getElementById(id)?.textContent)).toEqual(['変更した結果は担当者へ通知します', reason])
})
