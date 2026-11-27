// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EmergencyControlFeedback } from './control-feedback'

afterEach(cleanup)

it('状態の読み直しが必要なときは、同じ理由と操作を重ねて表示しない', () => {
  const reload = vi.fn()
  render(<EmergencyControlFeedback message={{ tone: 'danger', text: '最新の停止状態を読み直してください。' }} needsReload reloading={false} stopBlockers={['unavailable']} onReload={reload} />)
  expect(screen.getAllByText('最新の停止状態を読み直してください。')).toHaveLength(1)
  const buttons = screen.getAllByRole('button', { name: '最新の状態を読み直す' })
  expect(buttons).toHaveLength(1)
  fireEvent.click(buttons[0])
  expect(reload).toHaveBeenCalledTimes(1)
})

it('読み直し中の連打を受けず、通常の確認失敗では再読込を残す', () => {
  const reload = vi.fn()
  const view = render(<EmergencyControlFeedback message={null} needsReload reloading stopBlockers={['unavailable']} onReload={reload} />)
  fireEvent.click(screen.getByRole('button', { name: '読み直しています…' }))
  expect(reload).not.toHaveBeenCalled()
  view.rerender(<EmergencyControlFeedback message={null} needsReload={false} reloading={false} stopBlockers={['unavailable']} onReload={reload} />)
  fireEvent.click(screen.getByRole('button', { name: '最新の状態を読み直す' }))
  expect(reload).toHaveBeenCalledTimes(1)
})
