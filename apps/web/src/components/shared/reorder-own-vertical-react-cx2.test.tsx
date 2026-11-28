// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import ReorderHandle from './reorder-handle'

afterEach(cleanup)

it('並び替えのつまみは上下キーを自分で扱い、行の移動に渡さない', () => {
  const move = vi.fn()
  const rowKeys = vi.fn()
  render(<div onKeyDown={rowKeys}><ReorderHandle label="項目" draggable onDragStart={vi.fn()} onMove={move} /></div>)
  const handle = screen.getByRole('button', { name: '項目を並び替え。上下キーで移動' })
  expect(handle.getAttribute('data-roving-own')).toBe('vertical')
  fireEvent.keyDown(handle, { key: 'ArrowDown' })
  expect(move).toHaveBeenCalledWith(1)
  expect(rowKeys).toHaveBeenCalledTimes(1)
  expect(rowKeys.mock.calls[0][0].defaultPrevented).toBe(true)
})

it('権限の理由があるつまみも上下キーを行の移動に渡さない', () => {
  const move = vi.fn()
  const rowKeys = vi.fn()
  render(<div onKeyDown={rowKeys}><ReorderHandle label="項目" lockedReason="操作できません" onMove={move} /></div>)
  const handle = screen.getByRole('button', { name: '項目を並び替え。上下キーで移動' })
  expect(handle.getAttribute('data-roving-own')).toBe('vertical')
  fireEvent.keyDown(handle, { key: 'ArrowDown' })
  expect(move).not.toHaveBeenCalled()
  expect(rowKeys).not.toHaveBeenCalled()
})
