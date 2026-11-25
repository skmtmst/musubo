// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Button from './button'
import Dialog from './dialog'
afterEach(cleanup)
it.each([
  { role: null, stateReason: undefined, permission: false, allowed: false },
  { role: 'viewer', stateReason: undefined, permission: true, allowed: false },
  { role: 'owner', stateReason: '作成者本人には使えません', permission: false, allowed: false },
  { role: 'owner', stateReason: undefined, permission: false, allowed: true },
])('未知・権限不足・作成者本人の状態理由・許可を混同しない: %j', ({ role, stateReason, permission, allowed }) => {
  const activate = vi.fn()
  render(<Button disabled={!allowed} lockedReason={permission ? 'この操作を行う権限がありません' : undefined} disabledReason={stateReason} onClick={() => { if (!allowed) return; activate() }}>変更する</Button>)
  const button = screen.getByRole('button') as HTMLButtonElement
  expect(button.hasAttribute('data-permission-locked')).toBe(permission)
  expect(button.disabled).toBe(!permission && !allowed)
  if (role === null) {
    expect(screen.queryByRole('status')).toBeNull()
    expect(button.hasAttribute('aria-describedby')).toBe(false)
  }
  if (stateReason) expect(screen.getByRole('status').textContent).toBe(stateReason)
  fireEvent.click(button)
  expect(activate).toHaveBeenCalledTimes(allowed ? 1 : 0)
})

it('入力で直せる理由は常に見え、権限の理由は吹き出しにする', () => {
  const { rerender } = render(<Button variant="primary" disabled disabledReason="値を選ぶと保存できます。">保存する</Button>)
  expect(screen.getByRole('status').textContent).toBe('値を選ぶと保存できます。')
  expect(screen.getByRole('button').getAttribute('aria-description')).toBe('値を選ぶと保存できます。')
  expect(screen.getByRole('button').getAttribute('title')).toBeNull()
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('button').hasAttribute('data-permission-locked')).toBe(false)
  expect(screen.queryByRole('tooltip')).toBeNull()
  const save = vi.fn()
  rerender(<Button variant="secondary" lockedReason="管理者に頼んでください。" onClick={save}>保存する</Button>)
  expect(screen.queryByRole('status')).toBeNull()
  const button = screen.getByRole('button')
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect((button as HTMLButtonElement).disabled).toBe(false)
  expect(button.getAttribute('aria-describedby')).toBeTruthy()
  fireEvent.focus(button)
  expect(screen.getByRole('tooltip').textContent).toBe('管理者に頼んでください。')
  fireEvent.keyDown(button, { key: 'Enter' })
  fireEvent.keyDown(button, { key: ' ' })
  fireEvent.click(button)
  expect(save).not.toHaveBeenCalled()
  expect(screen.getByRole('tooltip').textContent).toBe('管理者に頼んでください。')
  fireEvent.blur(button)
  fireEvent.pointerDown(button, { pointerType: 'touch' })
  expect(screen.getByRole('tooltip').textContent).toBe('管理者に頼んでください。')
  rerender(<Button busy lockedReason="管理者に頼んでください。">保存する</Button>)
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false)
  expect(screen.getByRole('button').getAttribute('aria-busy')).toBe('true')
})

it('権限で止めるリンクも移動先を残さず、説明・属性・条件数を保つ', () => {
  const click = vi.fn(), pointer = vi.fn(), key = vi.fn(), focus = vi.fn()
  const { rerender } = render(<Button href="/settings" external lockedReason="オーナーだけが使えます" count={2} aria-label="設定" data-probe="retained" onClick={click} onPointerDown={pointer} onKeyDown={key} onFocus={focus}>設定</Button>)
  const button = screen.getByRole('button', { name: '設定 2件の条件' }) as HTMLButtonElement
  expect(screen.queryByRole('link')).toBeNull()
  expect(button.hasAttribute('href')).toBe(false)
  expect(button.dataset.probe).toBe('retained')
  expect(button.disabled).toBe(false)
  act(() => button.focus())
  expect(document.activeElement).toBe(button)
  expect(focus).toHaveBeenCalledOnce()
  expect(screen.getByRole('tooltip').textContent).toBe('オーナーだけが使えます')
  fireEvent.click(button); fireEvent.keyDown(button, { key: 'Enter' }); fireEvent.keyDown(button, { key: ' ' }); fireEvent.pointerDown(button, { pointerType: 'touch' })
  expect(click).not.toHaveBeenCalled(); expect(pointer).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled()
  expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toBe('オーナーだけが使えます')
  rerender(<Button href="/settings" external count={2}>設定</Button>)
  expect(screen.getByRole('link').getAttribute('href')).toBe('/settings')
  expect(screen.queryByRole('tooltip')).toBeNull()
})

it('Dialogは入力理由を本文に、権限理由を焦点可能な吹き出しに出せる', () => {
  const { rerender } = render(<Dialog open title="確認" confirmLabel="保存する" confirmDisabled confirmDisabledReason="項目を入力してください" onCancel={() => {}} onConfirm={() => {}} />)
  expect(screen.getByRole('status').textContent).toBe('項目を入力してください')
  expect(screen.getByRole('button', { name: '保存する' }).getAttribute('title')).toBeNull()
  rerender(<Dialog open title="確認" confirmLabel="保存する" confirmLockedReason="権限がありません" onCancel={() => {}} onConfirm={() => {}} />)
  expect(screen.queryByRole('status')).toBeNull()
  const button = screen.getByRole('button', { name: '保存する' })
  expect((button as HTMLButtonElement).disabled).toBe(false)
  expect(button.getAttribute('aria-disabled')).toBe('true')
  fireEvent.focus(button)
  expect(screen.getByRole('tooltip').textContent).toBe('権限がありません')
})

it('権限不足ではキーやタップの副処理も実行せず、aria-disabledのfalseは操作を妨げない', () => {
  const activate = vi.fn(), key = vi.fn(), pointer = vi.fn()
  const { rerender } = render(<Button lockedReason="権限がありません" onClick={activate} onKeyDown={key} onPointerDown={pointer}>保存する</Button>)
  const button = screen.getByRole('button', { name: '保存する' })
  fireEvent.keyDown(button, { key: 'Enter' }); fireEvent.keyDown(button, { key: ' ' })
  fireEvent.pointerDown(button, { pointerType: 'touch' }); fireEvent.click(button)
  expect(activate).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled(); expect(pointer).not.toHaveBeenCalled()
  expect(screen.getByRole('tooltip')).toBeTruthy()
  rerender(<Button aria-disabled="true" onClick={activate}>保存する</Button>)
  fireEvent.click(button)
  expect(activate).not.toHaveBeenCalled()
  rerender(<Button aria-disabled="false" onClick={activate}>保存する</Button>)
  fireEvent.click(button)
  expect(activate).toHaveBeenCalledOnce()
})

it('危険な操作の確認は赤い塗りのボタンにする', () => {
  const confirm = vi.fn()
  const { rerender } = render(<Dialog open tone="destructive" title="削除しますか？" confirmLabel="削除する" confirmIcon={<svg />} onCancel={() => {}} onConfirm={confirm} />)
  const remove = screen.getByRole('button', { name: '削除する' })
  expect(remove.getAttribute('data-variant')).toBe('danger')
  expect(remove.className).toContain('danger')
  expect(remove.querySelector('svg')).toBeNull()
  fireEvent.click(remove)
  expect(confirm).toHaveBeenCalledOnce()
  rerender(<Dialog open tone="destructive" title="保管しますか？" confirmLabel="保管する" onCancel={() => {}} onConfirm={confirm} />)
  expect(screen.getByRole('button', { name: '保管する' }).getAttribute('data-variant')).toBe('danger')
})
