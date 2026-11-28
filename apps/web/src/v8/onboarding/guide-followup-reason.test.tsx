// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { GuideOverlay } from './guide-overlay'
afterEach(() => { cleanup(); document.body.innerHTML = '' })
it('時期と本文が未入力なら理由を示し、入力後に次へ進める', async () => {
  const element = document.createElement('div')
  element.setAttribute('data-guide-anchor', 'followup.body')
  element.getBoundingClientRect = () => ({ left: 276, top: 312, width: 106, height: 43, right: 382, bottom: 355, x: 276, y: 312, toJSON: () => ({}) }) as DOMRect
  document.body.appendChild(element)
  const advance = vi.fn()
  render(<GuideOverlay active stepKey="followup" stepLabel="予約のあとに送る" stepOrder={7} procedureIndex={2} segments={[true, true, false]} onAdvanceProcedure={advance} onPause={vi.fn()} />)
  const next = screen.getByRole('button', { name: '次へ' }) as HTMLButtonElement
  expect(next.disabled).toBe(true)
  expect(screen.getByText('送る時期と本文を入力してください。')).toBeTruthy()
  fireEvent.click(next)
  expect(advance).not.toHaveBeenCalled()
  element.setAttribute('data-guide-ready', '')
  await waitFor(() => expect(next.disabled).toBe(false))
  expect(screen.queryByText('送る時期と本文を入力してください。')).toBeNull()
  fireEvent.click(next)
  expect(advance).toHaveBeenCalledTimes(1)
})
