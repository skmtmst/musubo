// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { RetroactiveDialog, type TagEditorValues } from './tag-editor-v4'

const captured = vi.hoisted(() => ({ apply: undefined as undefined | (() => void), save: undefined as undefined | (() => void) }))
vi.mock('@/components/shared/button', async original => {
  const actual = await original<typeof import('@/components/shared/button')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    const label = React.Children.toArray(props.children).filter(child => typeof child === 'string').join('')
    if (label === '反映しないで保存する') captured.save = props.onClick as () => void
    if (label === 'さかのぼって反映して保存する') captured.apply = props.onClick as () => void
    return <actual.default {...props} />
  } }
})
const values = { name: 'VIP', rewardMiles: 100, referralRewardMiles: 0 } as TagEditorValues
afterEach(cleanup)
it('閉じた遡及確認の保存操作は使えない', () => {
  const onCancel = vi.fn(), onSave = vi.fn(), onSaveWithoutApplying = vi.fn()
  const props = { values, count: 5, tagId: 't1', accountId: 'a1', onCancel, onSave, onSaveWithoutApplying, referenceState: true }
  const first = render(<RetroactiveDialog {...props} />)
  const oldApply = captured.apply!, oldSave = captured.save!
  fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
  expect(onCancel).toHaveBeenCalledTimes(1)
  oldApply(); oldSave()
  first.unmount()
  render(<RetroactiveDialog {...props} />)
  oldApply(); oldSave()
  expect(onSave).not.toHaveBeenCalled()
  expect(onSaveWithoutApplying).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'さかのぼって反映して保存する' }))
  expect(onSave).toHaveBeenCalledTimes(1)
})
