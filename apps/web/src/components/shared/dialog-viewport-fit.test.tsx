// @vitest-environment happy-dom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Dialog from './dialog'

afterEach(cleanup)
describe('Dialogの画面内への収まり', () => {
  it('ガイドの窓は指定したときだけ共通の閉じる操作を表示する', () => {
    const cancel = vi.fn()
    const view = render(<Dialog open title="案内" designLayout="stacked-guided" onCancel={cancel} />)
    expect(screen.queryByRole('button', { name: '閉じる' })).toBeNull()
    view.rerender(<Dialog open title="案内" designLayout="stacked-guided" showCloseButton onCancel={cancel} />)
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }))
    expect(cancel).toHaveBeenCalledOnce()
  })
  it('上位置のある窓は既定で残り高さを使い、本文・閉じる・実行の接続を保つ', () => {
    const cancel = vi.fn(), confirm = vi.fn()
    render(<Dialog open title="来店を記録" designTop={140} onCancel={cancel} onConfirm={confirm} confirmLabel="記録する"><input aria-label="お客さま" defaultValue="田中" /></Dialog>)
    const overlay = screen.getByRole('dialog').closest('[role="presentation"]') as HTMLElement
    expect(overlay.getAttribute('data-viewport-fit')).toBe('true')
    expect(overlay.hasAttribute('data-design-top')).toBe(true)
    expect(overlay.style.getPropertyValue('--dialog-design-top')).toBe('140px')
    fireEvent.click(screen.getByRole('button', { name: '記録する' }))
    expect(confirm).toHaveBeenCalledOnce()
    expect((screen.getByRole('textbox', { name: 'お客さま' }) as HTMLInputElement).value).toBe('田中')
    fireEvent.click(screen.getByRole('button', { name: '閉じる', exact: true }))
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('明示falseと上位置を持たない窓の配置条件を保つ', () => {
    const view = render(<Dialog open title="特殊配置" designTop={140} fitViewport={false} onCancel={() => {}} />)
    const overlay = screen.getByRole('dialog').closest('[role="presentation"]') as HTMLElement
    expect(overlay.hasAttribute('data-viewport-fit')).toBe(false)
    expect(overlay.style.getPropertyValue('--dialog-design-top')).toBe('140px')
    view.rerender(<Dialog open title="中央配置" onCancel={() => {}} />)
    const centered = screen.getByRole('dialog').closest('[role="presentation"]') as HTMLElement
    expect(centered.hasAttribute('data-design-top')).toBe(false)
    expect(centered.style.getPropertyValue('--dialog-design-top')).toBe('')
  })
})
