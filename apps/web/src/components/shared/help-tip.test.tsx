// @vitest-environment happy-dom
/* 見出し・ラベル横の「？」（共通ルール 2-1b）。押して開き、Esc・外・他の？で閉じる。 */
import React from 'react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HelpTip from './help-tip'
import Dialog from './dialog'

const DIR = dirname(fileURLToPath(import.meta.url))

afterEach(() => cleanup())

describe('補足の「？」', () => {
  it('閉じている時は吹き出しを出さない', () => {
    const { container, queryByText } = render(<HelpTip label="人数の説明">送る相手の数。</HelpTip>)
    expect(queryByText('送る相手の数。')).toBeNull()
    expect(container.querySelector('button')!.getAttribute('aria-label')).toBe('人数の説明')
  })

  it('押すと開き、吹き出しと aria-describedby でつながる', () => {
    const { container, getByText } = render(<HelpTip label="人数の説明">送る相手の数。</HelpTip>)
    const button = container.querySelector('button')!
    fireEvent.click(button)
    const tip = getByText('送る相手の数。')
    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-describedby')).toBe(tip.getAttribute('id'))
  })

  it('Esc で閉じる', () => {
    const { container, queryByText } = render(<HelpTip label="人数の説明">送る相手の数。</HelpTip>)
    fireEvent.click(container.querySelector('button')!)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(queryByText('送る相手の数。')).toBeNull()
  })

  it('1つ開くと他は閉じる', () => {
    const first = render(<HelpTip label="1つ目の説明">1つ目。</HelpTip>)
    const second = render(<HelpTip label="2つ目の説明">2つ目。</HelpTip>)
    fireEvent.click(first.container.querySelector('button')!)
    fireEvent.click(second.container.querySelector('button')!)
    expect(first.queryByText('1つ目。')).toBeNull()
    expect(second.queryByText('2つ目。')).not.toBeNull()
  })

  it('閉じている時は aria-describedby を付けない', () => {
    const { container } = render(<HelpTip label="人数の説明">送る相手の数。</HelpTip>)
    expect(container.querySelector('button')!.hasAttribute('aria-describedby')).toBe(false)
  })

  it('Esc で閉じると押した？へ戻る', () => {
    const { container, queryByText } = render(<HelpTip label="人数の説明">送る相手の数。</HelpTip>)
    const button = container.querySelector('button')!
    fireEvent.click(button)
    expect(queryByText('送る相手の数。')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(queryByText('送る相手の数。')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('「くわしく」は本文（children）と一緒に渡す', () => {
    const { container, getByText, queryByText } = render(
      <HelpTip label="用語の説明">
        ひとことです。<a href="/manual#word">くわしく</a>
      </HelpTip>,
    )
    // 閉じている間は本文もリンクも出さない。
    expect(queryByText('ひとことです。')).toBeNull()
    fireEvent.click(container.querySelector('button')!)
    expect(getByText('ひとことです。')).not.toBeNull()
    const more = getByText('くわしく')
    expect(more.getAttribute('href')).toBe('/manual#word')
  })

  it('印は丸の中の「?」の図形で、読み上げは説明の名前のまま', () => {
    const { container } = render(<HelpTip label="人数の説明">送る相手の数。</HelpTip>)
    const button = container.querySelector('button')!
    expect(button.querySelector('svg[data-help-mark]')).not.toBeNull()
    expect(button.textContent).toBe('')
    expect(button.getAttribute('aria-label')).toContain('人数の説明')
  })
})

/*
 * G3 はみ出し直し（parity 1004-0513：？印 181 件）。
 * 28px の当たりを透明の ::before ではみ出させると、見えないはみ出しが
 * 判定に載る（枠16＞中21）。V8 では正円を中の箱が持ち、札自体を透明な
 * 28px の当たりにする（#1367 のチェックと同じ構図）。見た目・当たり・
 * 読み上げは変えない。管理画面 の 18px 円＋::before は触らない。
 */
describe('？印の当たりは透明のはみ出しを持たない（G3・V8）', () => {
  it('V8 の札は透明な 28px、円は中の箱、::before は出さない', () => {
    const css = readFileSync(join(DIR, 'help-tip.module.css'), 'utf8')
    expect(css).toMatch(/:root \.button \{[^}]*width:\s*28px/s)
    expect(css).toMatch(/:root \.button \{[^}]*background:\s*transparent/s)
    expect(css).toMatch(/:root \.mark \{[^}]*width:\s*16px/s)
    expect(css).toMatch(/:root \.mark \{[^}]*border-radius:\s*var\(--radius-pill\)/s)
    expect(css).toMatch(/:root \.button::before \{\s*content:\s*none;/s)
  })


})

it('名前に乗せる補足は焦点でも開き、Escで焦点を戻しても開き直さない', () => {
  const view = render(<HelpTip hover label="担当の受付" trigger={<strong>担当A</strong>}>受付1人ずつ</HelpTip>)
  const button = view.getByRole('button', { name: '担当の受付' })
  fireEvent.focus(button)
  expect(view.getByRole('note').textContent).toBe('受付1人ずつ')
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(view.queryByRole('note')).toBeNull()
  button.blur()
  fireEvent.mouseEnter(button.parentElement!)
  expect(view.getByRole('note')).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(view.queryByRole('note')).toBeNull()
})


it('補足内リンクからEscで戻る時だけ再表示を止め、次の焦点では開く', () => {
  const view = render(<>
    <button type="button">補足の外</button>
    <HelpTip hover label="担当の説明" trigger={<strong>担当A</strong>}>
      担当者の受付です。<a href="/manual#staff">くわしく</a>
    </HelpTip>
  </>)
  const trigger = view.getByRole('button', { name: '担当の説明' })
  act(() => trigger.focus())
  expect(view.getByRole('note')).toBeTruthy()
  const more = view.getByRole('link', { name: 'くわしく' })
  act(() => more.focus())
  expect(document.activeElement).toBe(more)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(view.queryByRole('note')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(trigger.hasAttribute('aria-describedby')).toBe(false)
  act(() => view.getByRole('button', { name: '補足の外' }).focus())
  act(() => trigger.focus())
  expect(view.getByRole('note')).toBeTruthy()
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
})

it('既定の補足は焦点だけでは開かず、クリックで開閉する', () => {
  const view = render(<HelpTip label="人数の説明">送る相手の数。</HelpTip>)
  const button = view.getByRole('button', { name: '人数の説明' })
  act(() => button.focus())
  expect(document.activeElement).toBe(button)
  expect(view.queryByRole('note')).toBeNull()
  fireEvent.click(button)
  expect(view.getByRole('note')).toBeTruthy()
  fireEvent.click(button)
  expect(view.queryByRole('note')).toBeNull()
})


it('乗せた・焦点で出た説明は初回クリック後も残り、次の操作で閉じる', () => {
  const view = render(<HelpTip hover label="担当の説明" trigger={<strong>担当A</strong>}>受付1人ずつ</HelpTip>)
  const button = view.getByRole('button', { name: '担当の説明' })
  fireEvent.mouseEnter(button.parentElement!)
  act(() => button.focus())
  expect(view.getByRole('note')).toBeTruthy()
  fireEvent.click(button)
  expect(view.getByRole('note')).toBeTruthy()
  expect(button.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(button)
  expect(view.queryByRole('note')).toBeNull()
  expect(button.getAttribute('aria-expanded')).toBe('false')
  fireEvent.click(button)
  expect(view.getByRole('note')).toBeTruthy()
  fireEvent.pointerLeave(button.parentElement!, { pointerType: 'mouse' })
  expect(view.getByRole('note')).toBeTruthy()
  fireEvent.click(button)
  expect(view.queryByRole('note')).toBeNull()
  fireEvent.mouseEnter(button.parentElement!)
  fireEvent.pointerLeave(button.parentElement!, { pointerType: 'mouse' })
  expect(view.queryByRole('note')).toBeNull()
})

it('操作で開いた後に本文と印へ焦点を移しても次のクリックは閉じる', () => {
  const view = render(<HelpTip hover label="担当の説明" trigger={<strong>担当A</strong>}>
    受付1人ずつ<a href="/manual#staff">くわしく</a>
  </HelpTip>)
  const button = view.getByRole('button', { name: '担当の説明' })
  act(() => button.focus())
  fireEvent.click(button)
  expect(view.getByRole('note')).toBeTruthy()
  const more = view.getByRole('link', { name: 'くわしく' })
  act(() => more.focus())
  expect(document.activeElement).toBe(more)
  act(() => button.focus())
  fireEvent.click(button)
  expect(view.queryByRole('note')).toBeNull()
  expect(button.getAttribute('aria-expanded')).toBe('false')
})


it('touchの離脱では操作表示を閉じず、次の操作で閉じる', () => {
  const view = render(<HelpTip hover label="担当の説明" trigger={<strong>担当A</strong>}>受付1人ずつ</HelpTip>)
  const button = view.getByRole('button', { name: '担当の説明' })
  fireEvent.mouseEnter(button.parentElement!)
  act(() => button.focus())
  fireEvent.click(button)
  expect(view.getByRole('note')).toBeTruthy()
  fireEvent.pointerLeave(button.parentElement!, { pointerType: 'touch' })
  expect(view.getByRole('note')).toBeTruthy()
  expect(button.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(button)
  expect(view.queryByRole('note')).toBeNull()
  expect(button.getAttribute('aria-expanded')).toBe('false')
})

it('押して開いた補足は焦点が外れても残り、外を押すと閉じる', () => {
  const view = render(<><HelpTip hover label="担当の説明">受付1人ずつ</HelpTip><button>外側</button></>)
  const trigger = view.getByRole('button', { name: '担当の説明' })
  act(() => trigger.focus())
  fireEvent.click(trigger)
  const outside = view.getByRole('button', { name: '外側' })
  act(() => outside.focus())
  expect(view.getByRole('note')).toBeTruthy()
  fireEvent.pointerDown(outside)
  expect(view.queryByRole('note')).toBeNull()
})

it('窓内の補足をEscで閉じる時、親の窓は閉じない', () => {
  const onClose = vi.fn()
  const view = render(<Dialog open title="設定" onCancel={onClose}><HelpTip label="人数の説明">送る相手の数。</HelpTip></Dialog>)
  fireEvent.click(view.getByRole('button', { name: '人数の説明' }))
  expect(view.getByRole('note')).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(view.queryByRole('note')).toBeNull()
  expect(onClose).not.toHaveBeenCalled()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(onClose).toHaveBeenCalledOnce()
})

it('説明が本文を覆わないよう、開いた間だけ実寸の余白を確保する', () => {
  const original = HTMLElement.prototype.getBoundingClientRect
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.getAttribute('role') === 'note') return { x: 0, y: 0, top: 0, left: 0, right: 300, bottom: 180, width: 300, height: 180, toJSON: () => ({}) }
    return original.call(this)
  })
  const { getByRole, container } = render(<HelpTip label="説明" reserveSpace>補足</HelpTip>)
  fireEvent.click(getByRole('button', { name: '説明' }))
  expect((container.querySelector('[data-help-reserving]') as HTMLElement).style.marginBottom).toBe('192px')
  fireEvent.click(getByRole('button', { name: '説明' }))
  expect(container.querySelector('[data-help-reserving]')).toBeNull()
  rect.mockRestore()
})
