// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Steps } from '@/components/templates/steps'

afterEach(cleanup)
it('済みと直すところのある段は操作でき、まだの段は進めない', () => {
  const scroll = vi.fn()
  const onAttention = vi.fn()
  const onTodo = vi.fn()
  const target = document.createElement('div')
  target.id = 'done-section'
  target.scrollIntoView = scroll
  document.body.appendChild(target)
  try {
    render(<Steps label="作成の進み" currentKey="now" steps={[
      { key: 'done', label: '入力済み', state: 'done', anchor: 'done-section' },
      { key: 'attention', label: '確認が必要', state: 'attention', onSelect: onAttention },
      { key: 'now', label: '現在', state: 'current' },
      { key: 'todo', label: '未入力', state: 'todo', onSelect: onTodo },
    ]} />)
    expect(screen.getByRole('navigation', { name: '作成の進み' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '入力済みに戻る' }))
    expect(scroll).toHaveBeenCalledWith({ block: 'start' })
    fireEvent.click(screen.getByRole('button', { name: '確認が必要に戻る' }))
    expect(onAttention).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: '未入力に戻る' })).toBeNull()
    expect(onTodo).not.toHaveBeenCalled()
    expect(screen.getByText('現在').closest('[aria-current]')?.getAttribute('aria-current')).toBe('step')
  } finally { target.remove() }
})
