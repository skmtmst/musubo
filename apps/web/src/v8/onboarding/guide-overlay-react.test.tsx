// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    expect(screen.getByText(/「卓を作る」を押すと、卓番・表示名や席の条件を設定できます/)).toBeTruthy()
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
    const props = renderOverlay({ stepKey: 'friendAdd', stepOrder: 6, procedureIndex: 6 })
    fireEvent.click(element)
    expect(props.onAdvanceProcedure).not.toHaveBeenCalled()
  })

  it('コース下書きのガイドには編集画面の保存名を使う', () => {
    const element = mountTarget('menu.save')
    element.textContent = '保存する'
    renderOverlay({ stepKey: 'friendAdd', stepOrder: 5, procedureIndex: 6 })
    expect(screen.getByText('「保存する」を押すと、次の設定へ進みます。')).toBeTruthy()
  })

  it('コースは欄の入力を済ませてから「次へ」で進める', async () => {
    const element = mountTarget('menu.name')
    const props = renderOverlay({ stepKey: 'friendAdd', stepOrder: 5, procedureIndex: 3 })
    const next = screen.getByRole('button', { name: '次へ' })
    expect(next).toHaveProperty('disabled', true)
    element.setAttribute('data-guide-ready', '')
    await waitFor(() => expect(next).toHaveProperty('disabled', false))
    fireEvent.click(element)
    expect(props.onAdvanceProcedure).not.toHaveBeenCalled()
    fireEvent.click(next)
    expect(props.onAdvanceProcedure).toHaveBeenCalledOnce()
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
    /* 画面の移り変わりの猶予（MISSING_ANCHOR_WAIT_MS 1500ms）を過ぎてから止まる。 */
    act(() => { vi.advanceTimersByTime(1600) })
    expect(props.onPause).toHaveBeenCalled()
  })

  /*
    差し戻し R1: Google接続済みだと「接続する」ボタンが出ないので対象が見つからない。
    その手順の画面にいる間は止めず、吹き出しと帯を出したままにして操作を続けられるようにする。
  */
  it('その手順の画面にいる間は、対象が無くても止めず案内を出し続ける', () => {
    vi.useFakeTimers()
    const props = renderOverlay({ stepKey: 'hours', stepOrder: 5, procedureIndex: 1, onTargetScreen: true })
    act(() => { vi.advanceTimersByTime(3000) })
    expect(props.onPause).not.toHaveBeenCalled()
    expect(document.querySelector('[data-guide-balloon]')?.getAttribute('data-guide-balloon')).toBe('hours:1')
    expect(document.querySelector('[data-guide-bar]')).not.toBeNull()
  })

  it('画面を移って対象が遅れて現れたら、一時停止せずそこを光らせる', async () => {
    const props = renderOverlay()
    expect(document.querySelector('[data-guide-spotlight="tables.create"]')).toBeNull()
    /* 画面遷移の後に対象が描かれる状況。見張っていて現れたら測り直す。 */
    mountTarget('tables.create')
    await waitFor(() => {
      expect(document.querySelector('[data-guide-spotlight="tables.create"]')).not.toBeNull()
    })
    expect(props.onPause).not.toHaveBeenCalled()
  })

  it('リッチメニューを選ぶ間も、ガイドの一時停止とスキップを使える', () => {
    const props = renderOverlay({ stepKey: 'richMenu', stepLabel: 'リッチメニューを選ぶ', stepOrder: 2 })
    expect(document.querySelector('[data-guide-balloon]')).toBeNull()
    expect(screen.getByText('② リッチメニューを選ぶ')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'この手順をスキップ' }))
    fireEvent.click(screen.getByRole('button', { name: '一時停止' }))
    expect(props.onAdvanceProcedure).toHaveBeenCalledOnce()
    expect(props.onPause).toHaveBeenCalledOnce()
  })

  it('卓の完了が確認できたら「次へ進む」を使える', () => {
    const props = renderOverlay({ procedureIndex: 3, segments: [true, true, true, true, false], nextLabel: '営業時間を設定する' })
    expect(screen.getByText(/次は「営業時間を設定する」です/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '次へ進む' }))
    expect(props.onAdvanceProcedure).toHaveBeenCalledOnce()
  })

  /* 差し戻し R1: 台本外の手順番号（古い保存値）でも案内を消さない。 */
  it('台本に無い手順番号でも案内を消さず、最後の手順として見せる', () => {
    mountTarget('tables.create')
    renderOverlay({ procedureIndex: 4 })
    expect(document.querySelector('[data-guide-balloon]')?.getAttribute('data-guide-balloon')).toBe('attributes:3')
    expect(screen.getByText('手順 3/3')).toBeTruthy()
    expect(document.querySelector('[data-guide-bar]')).not.toBeNull()
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
