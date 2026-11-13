// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import MessageTypeTabs from './message-type-tabs'

afterEach(cleanup)
it('選べない紹介の理由をフォーカスで示し、選択しない', () => {
  const onChange = vi.fn()
  render(<MessageTypeTabs value="text" onChange={onChange} />)
  const tab = screen.getByRole('tab', { name: '紹介' })
  expect(tab.getAttribute('aria-disabled')).toBe('true')
  fireEvent.focus(tab)
  expect(screen.getByRole('tooltip').textContent).toContain('LINE側に該当するメッセージの種別がありません')
  fireEvent.click(tab)
  expect(onChange).not.toHaveBeenCalled()
})
