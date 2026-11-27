// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GuideSetupComplete } from './guide-last-step'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('開店準備完了ダイアログの再確認と離脱後ガード', () => {
  it('「もう一度確かめる」の実行中はボタンを処理中にし、重複実行を防いだあとに遷移する', async () => {
    let resolveRetry!: (value: boolean) => void
    const acknowledge = vi.fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveRetry = resolve }))
    const navigate = vi.fn()

    render(<GuideSetupComplete onAcknowledge={acknowledge} onNavigate={navigate} />)

    fireEvent.click(screen.getByRole('button', { name: 'ダッシュボードへ' }))
    const retry = await screen.findByRole('button', { name: 'もう一度確かめる' })
    expect(navigate).not.toHaveBeenCalled()

    fireEvent.click(retry)

    expect(retry.getAttribute('aria-busy')).toBe('true')
    expect((retry as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(retry)
    expect(acknowledge).toHaveBeenCalledTimes(2)

    resolveRetry(true)
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'))
    expect(screen.queryByRole('button', { name: /もう一度確かめる|確かめています/ })).toBeNull()
  })

  it('確認中に画面を離れてアンマウントされたあとは遷移や状態更新を行わない', async () => {
    let resolveAcknowledge!: (value: boolean) => void
    const acknowledge = vi.fn<() => Promise<boolean>>(
      () => new Promise<boolean>(resolve => { resolveAcknowledge = resolve }),
    )
    const navigate = vi.fn()

    const view = render(<GuideSetupComplete onAcknowledge={acknowledge} onNavigate={navigate} />)
    fireEvent.click(screen.getByRole('button', { name: 'ダッシュボードへ' }))

    view.unmount()
    resolveAcknowledge(true)
    await Promise.resolve()
    await Promise.resolve()

    expect(navigate).not.toHaveBeenCalled()
  })
})
