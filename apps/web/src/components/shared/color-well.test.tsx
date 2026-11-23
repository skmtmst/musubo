// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ColorWell from './color-well'

/**
 * 色を選ぶ（Pencil ★BG-2 `P8ZUj`／ピッカー本体 `d6PU4a`）の試験。
 *
 * - 閉じている間はピッカーを出さない。押すと「単色」の見出し・面・バー・
 *   よく使う色・「指定なしに戻す」「この色にする」が出る。
 * - 扱えないグラデーションは、押せないタブとしても描かない（共通ルール 2-2・5-5）。
 * - よく使う色、十六進の入力、色あい、すけ具合で呼び出し元へ色が返る。
 * - すけ具合を下げたときは 8 桁（`#rrggbbaa`）で返す。
 * - 寸法（288 幅・面 168・バー 12・ボタン 36）は承認した版のまま。
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(HERE, 'color-well.module.css'), 'utf8')

afterEach(cleanup)

const openWell = () => {
  fireEvent.click(screen.getByRole('button', { expanded: false }))
}

describe('ColorWell（★BG-2 カラーピッカー）', () => {
  it('閉じている間はピッカーを出さない', () => {
    render(<ColorWell value="#d7263d" onChange={vi.fn()} label="メインカラー" />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'メインカラー（今の色 #d7263d）' })).toBeTruthy()
  })

  it('開くと「単色」の見出し・面・バー・よく使う色・決定の操作が出る', () => {
    render(<ColorWell value="#d7263d" onChange={vi.fn()} />)
    openWell()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('単色')).toBeTruthy()
    // グラデーションはまだ扱えないので、押せないタブとしても置かない。
    expect(screen.queryByText('グラデーション')).toBeNull()
    expect(screen.queryAllByRole('tab').length).toBe(0)
    expect(screen.getByRole('slider', { name: '鮮やかさと明るさ' })).toBeTruthy()
    expect(screen.getByRole('slider', { name: '色あい' })).toBeTruthy()
    expect(screen.getByRole('slider', { name: 'すけ具合' })).toBeTruthy()
    expect(screen.getByRole('listbox', { name: 'よく使う色' }).querySelectorAll('[role="option"]').length).toBe(24)
    expect(screen.getByRole('button', { name: '指定なしに戻す' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'この色にする' })).toBeTruthy()
  })

  it('切り取られる領域の外に窓を出し、中の操作と外側で閉じる操作を保つ', () => {
    const onChange = vi.fn()
    const { container } = render(<div style={{ overflow: 'hidden' }}><ColorWell value="#06c755" onChange={onChange} /></div>)
    openWell()
    const dialog = screen.getByRole('dialog')
    const portal = dialog.closest('[data-menu-portal]')
    expect(portal?.parentElement).toBe(document.body)
    expect(container.contains(dialog)).toBe(false)
    expect(screen.getByRole('slider', { name: '色あい' })).toBeTruthy()
    const hex = screen.getByLabelText('色を十六進で入力')
    fireEvent.pointerDown(hex)
    fireEvent.change(hex, { target: { value: 'ff0000' } })
    fireEvent.keyDown(hex, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('#ff0000')
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('窓の中で Escape を押すと閉じて色の欄へ戻る', () => {
    render(<ColorWell value="#06c755" onChange={vi.fn()} />)
    openWell()
    const input = screen.getByLabelText('色を十六進で入力')
    input.focus()
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /色を選ぶ/ }))
  })

  it('よく使う色を押すとその色を返す', () => {
    const onChange = vi.fn()
    render(<ColorWell value="#d7263d" onChange={onChange} />)
    openWell()
    fireEvent.click(screen.getByRole('option', { name: '#06c755' }))
    expect(onChange).toHaveBeenCalledWith('#06c755')
  })

  it('十六進を入れて Enter で返す（# や大文字でも受ける）', () => {
    const onChange = vi.fn()
    render(<ColorWell value="#d7263d" onChange={onChange} />)
    openWell()
    const input = screen.getByLabelText('色を十六進で入力')
    fireEvent.change(input, { target: { value: 'FFD400' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('#ffd400')
  })

  it('読めない十六進は返さず、今の色に戻す', () => {
    const onChange = vi.fn()
    render(<ColorWell value="#d7263d" onChange={onChange} />)
    openWell()
    const input = screen.getByLabelText('色を十六進で入力') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'ズレ' } })
    fireEvent.blur(input)
    expect(onChange).not.toHaveBeenCalled()
    expect(input.value).toBe('D7263D')
  })

  it('すけ具合を下げると 8 桁で返す', () => {
    const onChange = vi.fn()
    render(<ColorWell value="#d7263d" onChange={onChange} />)
    openWell()
    fireEvent.change(screen.getByLabelText('すけ具合を数字で入力'), { target: { value: '50' } })
    expect(onChange).toHaveBeenCalledWith('#d7263d80')
  })

  it('色あいは矢印キーでも動く', () => {
    const onChange = vi.fn()
    render(<ColorWell value="#d7263d" onChange={onChange} />)
    openWell()
    fireEvent.keyDown(screen.getByRole('slider', { name: '色あい' }), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange.mock.calls[0][0]).not.toBe('#d7263d')
    expect(onChange.mock.calls[0][0]).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('指定なしに戻すと null を返して閉じる', () => {
    const onChange = vi.fn()
    render(<ColorWell value="#d7263d" onChange={onChange} />)
    openWell()
    fireEvent.click(screen.getByRole('button', { name: '指定なしに戻す' }))
    expect(onChange).toHaveBeenCalledWith(null)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('この色にするで確定して閉じる', () => {
    const onChange = vi.fn()
    render(<ColorWell value={null} onChange={onChange} />)
    openWell()
    fireEvent.click(screen.getByRole('button', { name: 'この色にする' }))
    expect(onChange).toHaveBeenCalledWith('#ffffff')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('色がないときは見本を空にし、読み上げも「指定なし」にする', () => {
    render(<ColorWell value={null} onChange={vi.fn()} label="ベースカラー" />)
    expect(screen.getByRole('button', { name: 'ベースカラー（今の色 指定なし）' })).toBeTruthy()
    expect(screen.getByRole('button', { expanded: false }).textContent).toContain('指定なし')
  })

  it('呼び出し元に今の色を文字でも出す（★BG-2 `xeedd` の「値」）', () => {
    render(<ColorWell value="#d7263d" onChange={vi.fn()} label="メインカラー" />)
    expect(screen.getByRole('button', { expanded: false }).textContent).toContain('#D7263D')
  })

  it('このデザインの色を渡すと保存の欄が出る', () => {
    const onSaveColor = vi.fn()
    render(
      <ColorWell value="#d7263d" onChange={vi.fn()} savedColors={['#ffffff', '#ffd400']} onSaveColor={onSaveColor} />,
    )
    openWell()
    const saved = screen.getByRole('listbox', { name: 'このデザインの色' })
    expect(saved.querySelectorAll('[role="option"]').length).toBe(2)
    fireEvent.click(screen.getByRole('button', { name: '＋この色を保存' }))
    expect(onSaveColor).toHaveBeenCalledWith('#d7263d')
  })

  it('すけ具合を使わない呼び出しではバーと入力を出さない', () => {
    render(<ColorWell value="#d7263d" onChange={vi.fn()} allowAlpha={false} allowClear={false} />)
    openWell()
    expect(screen.queryByRole('slider', { name: 'すけ具合' })).toBeNull()
    expect(screen.queryByLabelText('すけ具合を数字で入力')).toBeNull()
    expect(screen.queryByRole('button', { name: '指定なしに戻す' })).toBeNull()
  })

  it('承認した寸法を CSS が保つ', () => {
    expect(css).toMatch(/width:\s*288px/) // ピッカー本体
    expect(css).toMatch(/height:\s*168px/) // 彩度・明度の面
    expect(css).toMatch(/:root \.pop\s*\{[^}]*border-radius:\s*var\(--polish-radius-dialog\)/)
    expect(css).toMatch(/\.tabs\s*\{[^}]*height:\s*36px/)
    expect(css).toMatch(/\.bar\s*\{[^}]*height:\s*12px/)
    expect(css).toMatch(/\.cell\s*\{[^}]*height:\s*28px/)
    // V8 ではコントロールの枠色トークンを使う（直書きの #c9ced6 は使わない）。
    expect(css).toMatch(/:root[^{]*\{\s*border-color:\s*var\(--color-control-border\)/)
    expect(css).not.toMatch(/#c9ced6/i)
  })
})
