// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EntityKindField } from './entity-picker-sources'

afterEach(cleanup)

it.each(['form', 'tag'] as const)('無効の%sの選択に原因を渡し、解除後は古い理由を出さない', async kind => {
  const onChange = vi.fn()
  const props = { kind, label: '送り先', value: 'one', options: [{ id: 'one', name: '元の送り先' }], onChange, disabledReason: 'ほかの人が更新しました。最新の内容を読み込んでください。' }
  const { rerender } = render(<EntityKindField {...props} disabled />)
  const locked = screen.getByRole('button', { name: '送り先：変更する' }) as HTMLButtonElement
  expect(locked.disabled).toBe(true)
  expect(locked.title).toBe(props.disabledReason)
  fireEvent.click(locked)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(onChange).not.toHaveBeenCalled()
  expect(screen.getByText('元の送り先')).toBeTruthy()
  rerender(<EntityKindField {...props} disabled={false} />)
  const unlocked = screen.getByRole('button', { name: '送り先：変更する' }) as HTMLButtonElement
  expect(unlocked.disabled).toBe(false)
  expect(unlocked.title).toBe('')
  fireEvent.click(unlocked)
  expect(await screen.findByRole('dialog')).toBeTruthy()
})
