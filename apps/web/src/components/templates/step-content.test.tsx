// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StepContent } from './steps'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('進む・戻るの方向を示し、入力と焦点を保って途中の操作も受ける', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const cancel = vi.fn()
  const animate = vi.spyOn(HTMLElement.prototype, 'animate').mockReturnValue({ cancel } as unknown as Animation)
  const content = <input aria-label="名前" defaultValue="元の名前" />
  const { rerender } = render(<StepContent step={1}>{content}</StepContent>)
  const input = screen.getByLabelText('名前') as HTMLInputElement
  fireEvent.change(input, { target: { value: '途中の入力' } }); input.focus()
  rerender(<StepContent step={2}>{content}</StepContent>)
  expect(animate.mock.calls.at(-1)?.[0]).toEqual([{ transform: 'translateX(var(--polish-space-card))' }, { transform: 'translateX(0)' }])
  rerender(<StepContent step={1}>{content}</StepContent>)
  expect(cancel).toHaveBeenCalled()
  expect(animate.mock.calls.at(-1)?.[0]).toEqual([{ transform: 'translateX(calc(-1 * var(--polish-space-card)))' }, { transform: 'translateX(0)' }])
  expect(screen.getByLabelText('名前')).toBe(input)
  expect(input.value).toBe('途中の入力')
  expect(document.activeElement).toBe(input)
})
it('動きを減らす設定では位置を動かさない', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  const animate = vi.spyOn(HTMLElement.prototype, 'animate')
  const { rerender } = render(<StepContent step={1}>入力</StepContent>)
  rerender(<StepContent step={2}>次の入力</StepContent>)
  expect(animate).not.toHaveBeenCalled()
  expect(screen.getByText('次の入力')).toBeTruthy()
})


it('実際の動きを途中で閉じても、未処理の取消エラーを残さず片付ける', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const { rerender, unmount, container } = render(<StepContent step={1}>入力</StepContent>)
  const panel = container.firstElementChild as HTMLElement
  rerender(<StepContent step={2}>次の入力</StepContent>)
  expect(panel.getAnimations()).toHaveLength(1)
  unmount()
  await Promise.resolve()
  expect(panel.getAnimations()).toHaveLength(0)
})

it('横移動しない指定では、段を変えても入力を横へはみ出させない', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  const animate = vi.spyOn(HTMLElement.prototype, 'animate')
  const { rerender } = render(<StepContent step={1} slide={false}>入力</StepContent>)
  rerender(<StepContent step={2} slide={false}>入力</StepContent>)
  expect(animate).toHaveBeenCalledWith([{ opacity: 0 }, { opacity: 1 }], expect.anything())
})
