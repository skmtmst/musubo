// @vitest-environment happy-dom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { Status } from './parts'

afterEach(cleanup)
it.each(['constructor', 'toString', '__proto__', 'future'])('未知の状態 %s を確認できないと表示する', value => {
  render(<Status value={value} />)
  expect(screen.getByText('状態を確認できません')).toBeTruthy()
})
it('既知の状態と画面から指定された名前を保持する', () => {
  render(<><Status value="active" /><Status value="paused" /><Status value="future" label="独自の名前" /></>)
  expect(screen.getByText('有効')).toBeTruthy()
  expect(screen.getByText('停止中')).toBeTruthy()
  expect(screen.getByText('独自の名前')).toBeTruthy()
})
