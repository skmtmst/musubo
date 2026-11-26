// @vitest-environment happy-dom
/* 1枚のカードの中に並べる開閉の項目（DisclosureItem）。開閉・要約・行き先の置き場・キーボード。 */
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DisclosureItem } from './disclosure'

afterEach(cleanup)

const SUMMARY = '3 件・最新 10/18 19:00 佐々木さま'

function Item({ initial = false, onAction = () => {}, summary = SUMMARY, empty, tone }: {
  initial?: boolean
  onAction?: () => void
  summary?: string
  empty?: boolean
  tone?: 'danger' | 'warning'
}) {
  const [open, setOpen] = useState(initial)
  return (
    <DisclosureItem title="新着予約" summary={summary} empty={empty} tone={tone}
      help={<button type="button">新着予約の説明</button>}
      action={<button type="button" onClick={onAction}>一覧</button>}
      open={open} onOpenChange={setOpen}>
      <p>明細の行</p>
    </DisclosureItem>
  )
}

const toggle = () => screen.getByRole('button', { name: '新着予約' })
const placeOf = (element: HTMLElement) => element.closest('[data-disclosure-action]')?.getAttribute('data-disclosure-action')

describe('開閉の項目', () => {
  it('閉じている時は要約と見出しの行き先を出し、中身は描かない', () => {
    render(<Item />)
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText(SUMMARY)).toBeTruthy()
    expect(screen.queryByText('明細の行')).toBeNull()
    // 要約は開閉のボタンの説明として読み上げる。
    expect(document.getElementById(toggle().getAttribute('aria-describedby')!)?.textContent).toBe(SUMMARY)
    expect(placeOf(screen.getByRole('button', { name: '一覧' }))).toBe('head')
  })

  it('見出しを押すと開き、要約は消えて行き先は明細の下へ移る（2か所に出さない）', () => {
    render(<Item />)
    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(toggle().hasAttribute('aria-describedby')).toBe(false)
    const body = document.getElementById(toggle().getAttribute('aria-controls')!)!
    const detail = within(body).getByText('明細の行')
    const actions = screen.getAllByRole('button', { name: '一覧' })
    expect(actions).toHaveLength(1)
    expect(placeOf(actions[0])).toBe('foot')
    expect(body.contains(actions[0])).toBe(true)
    expect(detail.compareDocumentPosition(actions[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.queryByText(SUMMARY)).toBeNull()

    fireEvent.click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('明細の行')).toBeNull()
    expect(placeOf(screen.getByRole('button', { name: '一覧' }))).toBe('head')
  })

  it('行き先と「？」を押しても開閉しない', () => {
    const onAction = vi.fn()
    render(<Item onAction={onAction} />)
    fireEvent.click(screen.getByRole('button', { name: '一覧' }))
    fireEvent.click(screen.getByRole('button', { name: '新着予約の説明' }))
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
  })

  it('キーボード：開閉はネイティブのボタンで、Tab の順は開閉→「？」→行き先。開くと明細→行き先の順になる', () => {
    render(<Item />)
    const button = toggle()
    expect(button.tagName).toBe('BUTTON')
    expect(button.getAttribute('type')).toBe('button')
    expect(button.hasAttribute('tabindex')).toBe(false)
    button.focus()
    expect(document.activeElement).toBe(button)
    const order = () => Array.from(document.querySelectorAll('button')).map((item) => item.textContent)
    expect(order()).toEqual(['新着予約', '新着予約の説明', '一覧'])
    // Enter・Space はネイティブのボタンの押下（click）として届く。
    fireEvent.click(button, { detail: 0 })
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(button)
    expect(order()).toEqual(['新着予約', '新着予約の説明', '一覧'])
    expect(within(document.getElementById(button.getAttribute('aria-controls')!)!).getByRole('button', { name: '一覧' })).toBeTruthy()
  })

  it('中身の無い要約（なし・—）は灰色の印を付け、注意は色の点を文字と一緒に出す', () => {
    const view = render(<Item summary="なし" empty />)
    expect(screen.getByText('なし').closest('p')?.hasAttribute('data-empty')).toBe(true)
    view.unmount()
    render(<Item summary="未払い 1 件" tone="danger" />)
    const summary = screen.getByText('未払い 1 件').closest('p')!
    expect(summary.hasAttribute('data-empty')).toBe(false)
    expect(summary.querySelector('[data-tone="danger"]')?.getAttribute('aria-hidden')).toBe('true')
    expect(summary.textContent).toBe('未払い 1 件')
  })
})
