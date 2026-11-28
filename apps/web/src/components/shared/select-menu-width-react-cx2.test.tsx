// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Select from './select'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('選択肢の幅は選択欄以上で固定せず長い候補を表示できる', () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.getAttribute('aria-label') === '状態' ? 240 : 0
    return { x: 20, y: 20, top: 20, left: 20, right: 20 + width, bottom: 56, width, height: 36, toJSON() {} }
  })
  render(<Select aria-label="状態" value="all" onChange={vi.fn()} options={[{ value: 'all', label: 'すべて' }, { value: 'long', label: '長い名前の選択肢' }]} />)
  fireEvent.click(screen.getByRole('button', { name: '状態' }))
  expect(screen.getByRole('option', { name: '長い名前の選択肢' })).toBeTruthy()
  const portal = document.querySelector<HTMLElement>('[data-menu-portal]')
  expect(portal).not.toBeNull()
  expect(portal?.style.minWidth).toBe('240px')
  expect(portal?.style.width).toBe('')
})
