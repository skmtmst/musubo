// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GuideOverlay } from './guide-overlay'

/*
  承認済み Pen 枠 14 (orKSi) 共通ルール izsr5 のふるまいを見張る。
  文面は枠 04-1 (dQfu4) ほかの承認済みの語。
*/

const nineSegments = [true, true, true, false, false, false, false, false, false]

function mountTarget(name: string) {
  const element = document.createElement('button')
  element.setAttribute('data-guide-anchor', name)
  element.textContent = '+ 卓を作る'
  element.getBoundingClientRect = () => ({ left: 276, top: 312, width: 106, height: 43, right: 382, bottom: 355, x: 276, y: 312, toJSON: () => ({}) }) as DOMRect
  document.body.appendChild(element)
  return element
}

function renderOverlay(overrides: Partial<Parameters<typeof GuideOverlay>[0]> = {}) {
  const props = {
    active: true,
    stepKey: 'attributes',
    stepLabel: '卓と席を登録する',
    stepOrder: 4,
    procedureIndex: 1,
    segments: nineSegments,
    onAdvanceProcedure: vi.fn(),
    onPause: vi.fn(),
    ...overrides,
  }
  render(<GuideOverlay {...props} />)
  return props
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.useRealTimers()
})

describe('手順別ガイドの重ね表示', () => {
  it('承認済みの文面と手順の数え方を出す（④ 手順 1/3）', () => {
    mountTarget('tables.create')
    renderOverlay()
    expect(screen.getByText('手順 1/3')).toBeTruthy()
    expect(screen.getByText('まず卓を作りましょう')).toBeTruthy()
    expect(screen.getByText(/「\+ 卓を作る」を押すと、卓の名前と席数を入れるフォームが開きます/)).toBeTruthy()
    expect(screen.getByText('④ 卓と席を登録する（手順 1/3）')).toBeTruthy()
    expect(screen.getByText('開店準備ガイド')).toBeTruthy()
  })

  it('吹き出しを読み上げに乗せる（aria-live）', () => {
    mountTarget('tables.create')
    renderOverlay()
    const balloon = document.querySelector('[data-guide-balloon]')
    expect(balloon?.getAttribute('aria-live')).toBe('polite')
    expect(balloon?.getAttribute('role')).toBe('status')
  })

  it('「この手順をスキップ」で次の手順へ進める', () => {
    mountTarget('tables.create')
    const props = renderOverlay()
    fireEvent.click(screen.getByText('この手順をスキップ'))
    expect(props.onAdvanceProcedure).toHaveBeenCalledTimes(1)
  })

  it('対象を押した手順（クリック）は押した時に進む', () => {
    const element = mountTarget('tables.create')
    const props = renderOverlay()
    fireEvent.click(element)
    expect(props.onAdvanceProcedure).toHaveBeenCalledTimes(1)
  })

  it('保存で進む手順では、対象を押しただけでは進めない', () => {
    const element = mountTarget('menu.save')
    const props = renderOverlay({ stepKey: 'friendAdd', stepOrder: 6, procedureIndex: 3 })
    fireEvent.click(element)
    expect(props.onAdvanceProcedure).not.toHaveBeenCalled()
  })

  it('ESCと帯の「一時停止」でその場で止める', () => {
    mountTarget('tables.create')
    const props = renderOverlay()
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByText('一時停止'))
    expect(props.onPause).toHaveBeenCalledTimes(2)
  })

  it('ガイド対象外の画面（対象が無い）では自動で一時停止する', () => {
    vi.useFakeTimers()
    const props = renderOverlay()
    act(() => { vi.advanceTimersByTime(700) })
    expect(props.onPause).toHaveBeenCalled()
  })

  it('台本の無い段（①②③⑨）では何も出さない', () => {
    renderOverlay({ stepKey: 'richMenu', stepOrder: 3 })
    expect(document.querySelector('[data-guide-balloon]')).toBeNull()
  })

  it('一時停止中・未開始では出さない', () => {
    mountTarget('tables.create')
    renderOverlay({ active: false })
    expect(document.querySelector('[data-guide-balloon]')).toBeNull()
  })

  it('進み線は9本で、済みは実データ計測の値のまま出す', () => {
    mountTarget('tables.create')
    renderOverlay()
    const segments = document.querySelectorAll('[class*="segment"]')
    expect(segments.length).toBe(9)
    expect(Array.from(segments).filter(node => node.className.includes('segmentDone')).length).toBe(3)
  })
})
