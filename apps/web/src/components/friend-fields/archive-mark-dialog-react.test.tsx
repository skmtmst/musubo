// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SupportMarkArchiveImpact, SupportMarkListItem } from '@/lib/api'
import { ArchiveMarkDialog } from './mark-list'

const captured = vi.hoisted(() => ({ confirm: undefined as undefined | (() => void) }))
vi.mock('@/components/shared/dialog', async original => {
  const actual = await original<typeof import('@/components/shared/dialog')>()
  return { ...actual, default: (props: React.ComponentProps<typeof actual.default>) => {
    if (props.title?.toString().includes('保管しますか')) captured.confirm = props.onConfirm as () => void
    return <actual.default {...props} />
  } }
})
const mark = { id: 'm1', name: '要対応', isDefault: false, isInherited: false, friendCount: 0, automationRules: [] } as SupportMarkListItem
const impact = { friendCount: 0, canArchive: true, replacementOptions: [] } as SupportMarkArchiveImpact
afterEach(cleanup)
it('閉じた対応マークの確認では保管されない', () => {
  const onCancel = vi.fn(), onConfirm = vi.fn()
  const props = { mark, accountId: 'account-a', impact, replacementMarkId: '', loading: false, saving: false, error: '', onReplacement: vi.fn(), onCancel, onConfirm }
  const first = render(<ArchiveMarkDialog {...props} />)
  const oldConfirm = captured.confirm!
  fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
  expect(onCancel).toHaveBeenCalledTimes(1)
  oldConfirm()
  first.unmount()
  render(<ArchiveMarkDialog {...props} />)
  oldConfirm()
  expect(onConfirm).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: '保管する' }))
  expect(onConfirm).toHaveBeenCalledTimes(1)
})
