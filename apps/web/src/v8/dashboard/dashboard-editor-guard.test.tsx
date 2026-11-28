// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  V8_DASHBOARD_DEFAULT_VISIBILITY,
  defaultDashboardPreferences,
  type DashboardPreferences,
} from '@/components/dashboard/dashboard-preference-defaults'
import DashboardEditorV8 from './dashboard-editor'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe('DashboardEditorV8 ガード', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('最新の配置を読み直している間は反映・初期化・閉じるが無効になり、多重読み込みも防ぐ', async () => {
    const prefs = defaultDashboardPreferences(V8_DASHBOARD_DEFAULT_VISIBILITY)
    const reloadDef = deferred<DashboardPreferences | null>()
    const onReloadPreferences = vi.fn().mockReturnValue(reloadDef.promise)
    const onApply = vi.fn()
    const onReset = vi.fn()
    const onCancel = vi.fn()

    render(
      <DashboardEditorV8
        open
        preferences={prefs}
        saveError="ほかの人が先に保存しました"
        saveConflict
        onReloadPreferences={onReloadPreferences}
        onApply={onApply}
        onReset={onReset}
        onCancel={onCancel}
      />,
    )

    const reloadBtn = screen.getByRole('button', { name: '最新を読み込んで続ける' })
    fireEvent.click(reloadBtn)
    fireEvent.click(reloadBtn)
    expect(onReloadPreferences).toHaveBeenCalledTimes(1)

    const applyBtn = screen.getByRole('button', { name: 'ダッシュボードに反映' }) as HTMLButtonElement
    const resetBtn = screen.getByRole('button', { name: '初期状態に戻す' }) as HTMLButtonElement
    expect(applyBtn.disabled).toBe(true)
    expect(resetBtn.disabled).toBe(true)

    fireEvent.click(applyBtn)
    expect(onApply).not.toHaveBeenCalled()

    reloadDef.resolve(prefs)
    await waitFor(() => {
      expect((screen.getByRole('button', { name: 'ダッシュボードに反映' }) as HTMLButtonElement).disabled).toBe(false)
    })
  })
})
