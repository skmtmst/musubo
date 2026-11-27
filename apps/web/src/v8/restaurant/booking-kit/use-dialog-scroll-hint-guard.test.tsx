// @vitest-environment happy-dom
import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RsDialog } from './parts'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

function setScrollMetrics(el: HTMLElement, metrics: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: metrics.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: metrics.clientHeight })
  Object.defineProperty(el, 'scrollTop', { configurable: true, writable: true, value: metrics.scrollTop })
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('booking-kit/use-dialog-scroll-hint の未計測・負のスクロール位置ガード', () => {
  it('未計測（clientHeight=0）や上端バウンス（scrollTop<0）では「下に続きあり」を誤表示しない', () => {
    act(() => {
      root.render(
        <RsDialog
          open
          title="予約の確認"
          width={560}
          top={100}
          actionsPlacement="footer"
          onCancel={() => {}}
          actions={<button type="button">閉じる</button>}
        >
          <p>本文</p>
        </RsDialog>,
      )
    })

    const viewport = document.querySelector<HTMLElement>('[data-window-body]')
    const hint = document.querySelector<HTMLElement>('[data-scroll-hint]')
    expect(viewport).not.toBeNull()
    expect(hint).not.toBeNull()

    // 未計測（clientHeight = 0）で scrollHeight だけ正でも誤表示しない
    setScrollMetrics(viewport!, { scrollHeight: 240, clientHeight: 0, scrollTop: 0 })
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(hint!.style.visibility).toBe('hidden')
    expect(hint!.getAttribute('aria-hidden')).toBe('true')

    // 収まっている本文で iOS/macOS の上端オーバースクロール（scrollTop < 0）が起きても誤表示しない
    setScrollMetrics(viewport!, { scrollHeight: 300, clientHeight: 300, scrollTop: -12 })
    act(() => { viewport!.dispatchEvent(new Event('scroll')) })
    expect(hint!.style.visibility).toBe('hidden')
    expect(hint!.getAttribute('aria-hidden')).toBe('true')

    // 本当に下に続きがあるときだけ表示され、最下部までスクロールすると隠れる
    setScrollMetrics(viewport!, { scrollHeight: 600, clientHeight: 300, scrollTop: 0 })
    act(() => { viewport!.dispatchEvent(new Event('scroll')) })
    expect(hint!.style.visibility).toBe('visible')
    expect(hint!.getAttribute('aria-hidden')).toBe('false')

    setScrollMetrics(viewport!, { scrollHeight: 600, clientHeight: 300, scrollTop: 299 })
    act(() => { viewport!.dispatchEvent(new Event('scroll')) })
    expect(hint!.style.visibility).toBe('hidden')
    expect(hint!.getAttribute('aria-hidden')).toBe('true')
  })
})
