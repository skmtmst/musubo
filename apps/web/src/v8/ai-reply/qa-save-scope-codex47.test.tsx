// @vitest-environment happy-dom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ create: vi.fn(), update: vi.fn(), toast: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }))
vi.mock('@/components/shared/toast', async original => ({ ...await original<typeof import('@/components/shared/toast')>(), notifyToast: mocks.toast }))
vi.mock('./api', async original => {
  const actual = await original<typeof import('./api')>()
  return { ...actual, aiReplyApi: { ...actual.aiReplyApi, createQa: mocks.create, updateQa: mocks.update } }
})
import QaEditDialog from './qa-edit-dialog'

beforeEach(() => { vi.clearAllMocks(); window.history.replaceState(null, '', '/auto-replies?tab=qa') })
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function fill() {
  fireEvent.change(screen.getByRole('textbox', { name: /質問/ }), { target: { value: '見本の質問' } })
  fireEvent.change(screen.getByRole('textbox', { name: /答え/ }), { target: { value: '見本の答え' } })
}

it('保存を同時に2回押しても下書きは1回だけ作る', () => {
  mocks.create.mockReturnValue(new Promise(() => {}))
  render(<QaEditDialog open accountId="a" seed={null} canPublish onSaved={vi.fn()} onClose={vi.fn()} />)
  fill()
  const button = screen.getByRole('button', { name: '下書きで保存する' }) as HTMLButtonElement
  act(() => { button.click(); button.click() })
  expect(mocks.create).toHaveBeenCalledTimes(1)
})

