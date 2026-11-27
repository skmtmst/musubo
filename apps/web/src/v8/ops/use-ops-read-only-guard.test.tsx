// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  me: vi.fn(),
}))

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      ops: {
        ...actual.api.ops,
        me: fixture.me,
      },
    },
  }
})

import { useOpsReadOnly, useOpsReadOnlyState } from './use-ops-read-only'

function Probe() {
  const state = useOpsReadOnlyState()
  const readOnly = useOpsReadOnly()
  return (
    <div>
      <span data-testid="state">{state}</span>
      <span data-testid="readonly">{String(readOnly)}</span>
    </div>
  )
}

async function flushMicrotasks() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  vi.resetAllMocks()
})

afterEach(() => {
  cleanup()
})

describe('useOpsReadOnly / useOpsReadOnlyState 不正応答のフェイルクローズ', () => {
  it('data 欠損や readOnly 非真偽値の応答でも writer に昇格させず閲覧のみを維持する', async () => {
    fixture.me.mockResolvedValue({ success: true, data: undefined })
    const first = render(<Probe />)
    await waitFor(() => expect(fixture.me).toHaveBeenCalled())
    await flushMicrotasks()
    expect(screen.getByTestId('state').textContent).toBe('unknown')
    expect(screen.getByTestId('readonly').textContent).toBe('true')
    first.unmount()

    fixture.me.mockClear()
    fixture.me.mockResolvedValue({ success: true, data: { readOnly: undefined } })
    const second = render(<Probe />)
    await waitFor(() => expect(fixture.me).toHaveBeenCalled())
    await flushMicrotasks()
    expect(screen.getByTestId('state').textContent).toBe('unknown')
    expect(screen.getByTestId('readonly').textContent).toBe('true')
    second.unmount()

    fixture.me.mockClear()
    fixture.me.mockResolvedValue({ success: true, data: { readOnly: '' } })
    render(<Probe />)
    await waitFor(() => expect(fixture.me).toHaveBeenCalled())
    await flushMicrotasks()
    expect(screen.getByTestId('state').textContent).toBe('unknown')
    expect(screen.getByTestId('readonly').textContent).toBe('true')
  })

  it('readOnly が明示的な真偽値のときだけ readonly / writer に切り替える', async () => {
    fixture.me.mockResolvedValue({ success: true, data: { readOnly: false } })
    const writerView = render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('writer'))
    expect(screen.getByTestId('readonly').textContent).toBe('false')
    writerView.unmount()

    fixture.me.mockResolvedValue({ success: true, data: { readOnly: true } })
    render(<Probe />)
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('readonly'))
    expect(screen.getByTestId('readonly').textContent).toBe('true')
  })
})
