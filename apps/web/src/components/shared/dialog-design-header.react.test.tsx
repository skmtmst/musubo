
import React from 'react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Dialog from './dialog'
import ConfirmDialog from './confirm-dialog'
// @vitest-environment happy-dom

/*
 * 司令塔 2026-10-07：小窓だけの絵（・・ など）は窓の頭が共通の値より
 * 約 33px 低い。絵の頭の余白・高さを画面から渡せる口（渡さなければ今までどおり）。
 */
afterEach(() => cleanup())
const css = readFileSync(join(process.cwd(), 'src/components/shared/dialog.module.css'), 'utf8')

describe('窓の頭の余白・高さを絵から渡す', () => {
  it('確認と取消の優先度に応じた共通ボタンを使う', () => {
    const props = { open: true, modal: false, title: '確認', confirmLabel: '確定', onCancel: vi.fn(), onConfirm: vi.fn() }
    const view = render(<Dialog {...props} />)
    expect(screen.getByRole('button', { name: '確定' }).getAttribute('data-variant')).toBe('primary')
    view.rerender(<Dialog {...props} tone="destructive" />)
    expect(screen.getByRole('button', { name: '確定' }).getAttribute('data-variant')).toBe('danger')
    view.rerender(<Dialog {...props} primaryAction="cancel" />)
    expect(screen.getByRole('button', { name: '確定' }).getAttribute('data-variant')).toBe('secondary')
    expect(screen.getByRole('button', { name: 'キャンセル' }).getAttribute('data-variant')).toBe('primary')
  })
  it('任意の印を題と説明の左に置き、説明を読み上げに結び付ける', () => {
    render(<Dialog open modal={false} title="新しく作る" headerIcon={<svg data-testid="app-icon" />} description="名前を入力してください。" onCancel={vi.fn()} />)
    const panel = screen.getByRole('dialog', { name: '新しく作る' })
    const icon = screen.getByTestId('app-icon').parentElement!
    expect(icon.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByRole('heading').contains(icon)).toBe(true)
    expect(document.getElementById(panel.getAttribute('aria-describedby')!)?.textContent).toBe('名前を入力してください。')
  })

  it('確認の窓も任意の印を受け、取消と実行を保つ', () => {
    const cancel = vi.fn(), confirm = vi.fn()
    render(<ConfirmDialog open title="作成しますか？" description="内容を確認してください。" headerIcon={<svg data-testid="confirm-icon" />} onCancel={cancel} onConfirm={confirm} />)
    expect(screen.getByTestId('confirm-icon').parentElement?.getAttribute('aria-hidden')).toBe('true')
    screen.getByRole('button', { name: 'キャンセル' }).click()
    expect(cancel).toHaveBeenCalledTimes(1)
    screen.getByRole('button', { name: '実行する' }).click()
    expect(confirm).toHaveBeenCalledTimes(1)
  })
  it('標準の頭では幅と個別の寸法指定を変えない', () => {
    render(<Dialog open modal={false} title="確認" onCancel={vi.fn()} />)
    const panel = screen.getByRole('dialog')
    expect(panel.hasAttribute('data-design-header-padding')).toBe(false)
    expect(panel.hasAttribute('data-design-header-height')).toBe(false)
    expect(panel.style.getPropertyValue('--dialog-design-width')).toBe('560px')
  })

  it('Dialog：渡すと印と変数が付く（幅と一緒でも両方残る）', () => {
    render(<Dialog open modal={false} title="確認" designWidth={560} designHeaderPadding="20px 20px 0" designHeaderHeight={44} onCancel={vi.fn()} />)
    const panel = screen.getByRole('dialog')
    expect(panel.hasAttribute('data-design-header-padding')).toBe(true)
    expect(panel.style.getPropertyValue('--dialog-design-header-padding')).toBe('20px 20px 0')
    expect(panel.style.getPropertyValue('--dialog-design-header-height')).toBe('44px')
    expect(panel.style.getPropertyValue('--dialog-design-width')).toBe('560px')
  })

  it('印を省く指定では装飾を足さず、題と説明を読み上げる', () => {
    render(<Dialog open modal={false} title="入力" description="名前を入力" headerIcon={false} onCancel={vi.fn()} />)
    const panel = screen.getByRole('dialog', { name: '入力' })
    expect(panel.querySelectorAll('svg')).toHaveLength(1)
    expect(document.getElementById(panel.getAttribute('aria-describedby')!)?.textContent).toBe('名前を入力')
  })

  it('取消を主にした未保存の確認へ成功の印を足さない', () => {
    render(<ConfirmDialog open title="入力を破棄しますか？" description="入力が消えます" primaryAction="cancel" onCancel={vi.fn()} onConfirm={vi.fn()} />)
    const panel = screen.getByRole('dialog')
    expect(panel.querySelectorAll('svg')).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'キャンセル' })).toBeTruthy()
  })

  it('明示した印なしの確認でも装飾を補わない', () => {
    render(<ConfirmDialog open title="実行しますか？" description="内容を確認" titleIcon={false} onCancel={vi.fn()} onConfirm={vi.fn()} />)
    expect(screen.getByRole('dialog').querySelectorAll('svg')).toHaveLength(1)
  })

  it('ConfirmDialog も同じ口を素通しする', () => {
    render(<ConfirmDialog open title="消しますか" description="戻せません" designHeaderPadding="24px 24px 0" onCancel={vi.fn()} onConfirm={vi.fn()} />)
    const panel = document.body.querySelector('[data-design-part="dialog"]') as HTMLElement
    expect(panel.style.getPropertyValue('--dialog-design-header-padding')).toBe('24px 24px 0')
  })

  it('CSS：共通の頭の余白の後ろで、印のあるときだけ変数で上書きする', () => {
    const base = css.indexOf(":root .headerRow { width: 100%; padding: 20px 24px 8px;")
    const pad = css.indexOf(":root .panel[data-design-header-padding] > .headerRow { padding: var(--dialog-design-header-padding); }")
    const height = css.indexOf(":root .panel[data-design-header-height] > .headerRow { height: var(--dialog-design-header-height);")
    expect(base).toBeGreaterThan(-1)
    expect(pad).toBeGreaterThan(base)
    expect(height).toBeGreaterThan(base)
  })
})
