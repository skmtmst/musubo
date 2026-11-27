// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/lib/api'
import type { StyleState } from './model'
import { useWizard } from './use-wizard'

const mocks = vi.hoisted(() => ({
  starterSet: vi.fn(),
  starterItems: vi.fn(),
  save: vi.fn(),
  activate: vi.fn(),
  menu: vi.fn(),
  updated: vi.fn(),
  push: vi.fn(),
  closed: vi.fn(),
}))

vi.mock('@/lib/api/helpers/styles', () => ({
  styleApi: {
    starterSet: mocks.starterSet,
    starterItems: mocks.starterItems,
    save: mocks.save,
    activate: mocks.activate,
    menu: mocks.menu,
  },
}))
vi.mock('@/hooks/use-account-style', () => ({ accountStyleUpdated: mocks.updated }))
vi.mock('@/components/shared/list-navigation', () => ({
  useListNavigationRouter: () => ({ push: mocks.push }),
}))

const baseState: StyleState = {
  style: 'standard',
  styleSelected: true,
  styleMode: 'configured',
  version: 3,
  answers: {},
}

function Harness({ state = baseState }: { state?: StyleState }) {
  const wizard = useWizard({
    accountId: 'acc-1',
    state,
    initialStep: 1,
    onClose: mocks.closed,
  })
  return (
    <div>
      <output data-testid="step">{String(wizard.step)}</output>
      <output data-testid="busy">{String(wizard.busy)}</output>
      <output data-testid="choice">{wizard.choice}</output>
      {wizard.error ? <div role="alert">{wizard.error}</div> : null}
      <button type="button" onClick={() => wizard.setChoice('simple')}>シンプル選択</button>
      <button type="button" onClick={() => { wizard.setChoice('existing'); wizard.setResource('rm-existing-1') }}>既存選択</button>
      <button type="button" onClick={() => void wizard.onNext()}>このメニューで進む</button>
    </div>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.starterItems.mockResolvedValue({ success: true, data: { items: [] } })
  mocks.save.mockResolvedValue({ success: true, data: { version: 4 } })
})

afterEach(() => {
  cleanup()
})

describe('useWizard のリッチメニュー確認失敗と二重実行防止', () => {
  it('シンプル選択で starterSet が success:false のときエラーを表示してステップを進めない', async () => {
    mocks.starterSet.mockResolvedValueOnce({ success: false, error: 'failed' })
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: 'このメニューで進む' }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('メニューを確認できませんでした')
    })
    expect(screen.getByTestId('step').textContent).toBe('1')
    expect(screen.getByTestId('busy').textContent).toBe('false')
  })

  it('シンプル選択で starterSet が通信失敗したときエラーを表示し、通信中は二重呼び出ししない', async () => {
    let rejectCall!: (err: unknown) => void
    mocks.starterSet.mockImplementationOnce(() => new Promise((_, reject) => { rejectCall = reject }))
    render(<Harness />)

    const nextButton = screen.getByRole('button', { name: 'このメニューで進む' })
    fireEvent.click(nextButton)
    fireEvent.click(nextButton)

    expect(mocks.starterSet).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(screen.getByTestId('busy').textContent).toBe('true')
    })

    rejectCall(new ApiError(503))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('読み込みに失敗しました')
    })
    expect(screen.getByTestId('step').textContent).toBe('1')
    expect(screen.getByTestId('busy').textContent).toBe('false')
  })

  it('既存メニュー選択で starterSet が success:false のとき無言で進まずエラーを表示して留まる', async () => {
    mocks.starterSet.mockResolvedValueOnce({ success: false, error: 'failed' })
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: '既存選択' }))
    fireEvent.click(screen.getByRole('button', { name: 'このメニューで進む' }))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('メニューを確認できませんでした')
    })
    expect(screen.getByTestId('step').textContent).toBe('1')
    expect(screen.getByTestId('busy').textContent).toBe('false')
  })
})
