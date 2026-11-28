// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearGridContentColumns, fitGridContentColumns } from './grid-content-columns.mjs'
import { fitListColumns } from './list-column-sizing.mjs'
import { useListColumnSizing } from './use-list-column-sizing'
import { useListRowDensity } from './use-list-row-density'

let nextFrame: number
let frames: Map<number, FrameRequestCallback>
let notifyResize: (() => void)[]

function rect(width: number, height = 24): DOMRect {
  return {
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON() { return {} },
  } as DOMRect
}

function flushFrame() {
  const batch = [...frames.values()]
  frames.clear()
  return act(async () => { for (const callback of batch) callback(0) })
}

const originalFontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts')

beforeEach(() => {
  vi.resetAllMocks()
  nextFrame = 0
  frames = new Map()
  notifyResize = []
  delete (document as Document & { __listColumnProbe?: unknown }).__listColumnProbe
  delete (document as Document & { __gridColumnProbeHost?: unknown }).__gridColumnProbeHost
  document.documentElement
    .querySelectorAll('[data-column-probe-host], [data-grid-column-probe-host]')
    .forEach(el => el.remove())
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    const id = ++nextFrame
    frames.set(id, callback)
    return id
  })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id) })
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { notifyResize.push(callback) }
    observe() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  if (originalFontsDescriptor) Object.defineProperty(document, 'fonts', originalFontsDescriptor)
  else delete (document as Document & { fonts?: unknown }).fonts
  document.documentElement
    .querySelectorAll('[data-column-probe-host], [data-grid-column-probe-host]')
    .forEach(el => el.remove())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function SampleGridTable({ rows, enabled = true }: { rows: { name: string; email: string; role: string }[]; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useListColumnSizing(ref, enabled)
  useListRowDensity(ref)
  return (
    <div ref={ref} data-testid="grid-frame" role="table" className="grid-table">
      <div role="row" data-head="">
        <span>名前</span>
        <span>メールアドレス</span>
        <span>権限</span>
        <span>操作</span>
      </div>
      {rows.map((row, index) => (
        <div key={index} role="row" data-shared-part="list-row" data-testid={`grid-row-${index}`}>
          <span>{row.name}</span>
          <span>{row.email}</span>
          <span>{row.role}</span>
          <span data-row-actions=""><button type="button">変更</button></span>
        </div>
      ))}
    </div>
  )
}

function TemplateLikeTable({ rows }: { rows: { name: string; preview: string; status: string }[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useListColumnSizing(ref, true)
  return (
    <div ref={ref} data-testid="tpl-frame" data-column-sizing="content" data-table-presentation="template-list">
      <table>
        <colgroup>
          <col />
          <col style={{ width: '200px' }} />
          <col style={{ width: '100px' }} />
        </colgroup>
        <thead>
          <tr>
            <th>テンプレート</th>
            <th>見え方</th>
            <th>公開</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td data-cell-grow=""><span data-list-name="">{row.name}</span></td>
              <td data-testid={`tpl-preview-${index}`}><span>{row.preview}</span></td>
              <td data-testid={`tpl-status-${index}`}><span>{row.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

describe('grid-content-columns の常駐プローブ・deferCommit・同一 scope 省略', () => {
  it('生の行要素へプローブを挿さず contain:strict の常駐ホストで測り、同一 scope の再実行と幅のみ変化の再クローンを省く', () => {
    let clientWidth = 800
    let probeReads = 0
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'grid-frame' ? clientWidth : 100
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-column-probe')) {
        probeReads += 1
        return rect(Math.max(40, (this.textContent?.length ?? 0) * 10), 20)
      }
      return rect(clientWidth, 40)
    })

    const { getByTestId } = render(
      <SampleGridTable
        rows={[
          { name: '担当者 1', email: 'long.member@example-company.test', role: '有効' },
          { name: '担当者 2', email: 'other@example.test', role: '招待中' },
        ]}
        enabled={false}
      />,
    )
    const frame = getByTestId('grid-frame')
    const row0 = getByTestId('grid-row-0')
    const liveRowAppend = vi.spyOn(row0, 'append')
    const bodyAppend = vi.spyOn(document.body, 'append')

    fitGridContentColumns(frame)

    expect(liveRowAppend).not.toHaveBeenCalled()
    expect(bodyAppend).not.toHaveBeenCalled()
    expect(probeReads).toBe(12)
    const hosts = document.documentElement.querySelectorAll<HTMLElement>('[data-grid-column-probe-host]')
    expect(hosts).toHaveLength(1)
    expect(hosts[0].style.contain).toBe('strict')
    expect(document.querySelectorAll('[data-column-probe]')).toHaveLength(0)
    const cols800 = frame.style.getPropertyValue('--grid-table-content-columns')
    expect(cols800).not.toBe('')

    // 同一 scope の再実行ではプローブ計測を完全に省略する
    probeReads = 0
    fitGridContentColumns(frame)
    expect(probeReads).toBe(0)
    expect(frame.style.getPropertyValue('--grid-table-content-columns')).toBe(cols800)

    // 幅だけが変わったリサイズではセルの測り直し（クローン）を省いて配分だけ更新する
    clientWidth = 640
    fitGridContentColumns(frame)
    expect(probeReads).toBe(0)
    expect(frame.style.getPropertyValue('--grid-table-content-columns')).not.toBe(cols800)

    // テキストが変わったときは再計測する
    row0.children[1].textContent = 'short@a.test'
    fitGridContentColumns(frame)
    expect(probeReads).toBe(12)
    expect(liveRowAppend).not.toHaveBeenCalled()

    clearGridContentColumns(frame)
    expect(frame.style.getPropertyValue('--grid-table-content-columns')).toBe('')
  })

  it('useListColumnSizing は GridTable でも deferCommit で全フックの読取完了後にまとめて DOM へ書き込む', async () => {
    const order: string[] = []
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'grid-frame') {
        order.push('read-frame')
        return rect(900, 40)
      }
      if (this.hasAttribute('data-column-probe')) {
        order.push('read-probe')
        return rect(Math.max(40, (this.textContent?.length ?? 0) * 10), 20)
      }
      return rect(120, 24)
    })
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(() => {
      order.push('read-density')
      return [rect(60, 20)] as unknown as DOMRectList
    })
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(() => rect(60, 20))
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { status: 'loaded', ready: Promise.resolve(), addEventListener: vi.fn(), removeEventListener: vi.fn() },
    })

    const { getByTestId } = render(
      <section data-list-skeleton="">
        <SampleGridTable rows={[{ name: '山田', email: 'yamada@example.com', role: '管理者' }]} />
      </section>,
    )
    const frame = getByTestId('grid-frame')
    const origSetProp = frame.style.setProperty.bind(frame.style)
    vi.spyOn(frame.style, 'setProperty').mockImplementation((name, value) => {
      order.push(`write:${name}`)
      return origSetProp(name, value)
    })

    expect(frames.size).toBe(1)
    await flushFrame()

    const firstWriteIdx = order.findIndex(item => item.startsWith('write:'))
    const lastReadIdx = Math.max(
      order.lastIndexOf('read-frame'),
      order.lastIndexOf('read-probe'),
      order.lastIndexOf('read-density'),
    )
    expect(firstWriteIdx).toBeGreaterThan(-1)
    expect(firstWriteIdx).toBeGreaterThan(lastReadIdx)
    expect(frame.style.getPropertyValue('--grid-table-content-columns')).not.toBe('')
  })
})

describe('list-column-sizing の読取中書込の排除と同一 scope 省略', () => {
  it('同一 scope の再実行では Range 計測やプローブ計測をやり直さない', () => {
    const longNote = 'とても長い補足テキストが二行以上に折り返される検証用サンプル文字列'
    let rangeCalls = 0
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      rangeCalls += 1
      const text = this.toString().trim()
      if (text === longNote) return [rect(120, 20), rect(120, 20)] as unknown as DOMRectList
      return [rect(Math.max(24, text.length * 10), 20)] as unknown as DOMRectList
    })
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
      return rect(Math.max(24, this.toString().trim().length * 10), 20)
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-column-probe')) return rect((this.textContent?.length ?? 0) * 10, 20)
      if (this.dataset.testid === 'tpl-frame' || this.tagName === 'TABLE' || this.tagName === 'TR') return rect(1100, 40)
      return rect(180, 24)
    })

    const { getByTestId } = render(
      <TemplateLikeTable rows={[{ name: 'テンプレート1', preview: longNote, status: '公開中' }]} />,
    )
    const frame = getByTestId('tpl-frame')

    fitListColumns(frame)
    expect(rangeCalls).toBeGreaterThan(0)
    const widthAfterFirst = getByTestId('tpl-preview-0').style.getPropertyValue('--list-content-column-width')
    expect(widthAfterFirst).not.toBe('')

    // 同じ幅・同じ内容の再実行では Range 計測が 0 回で終わる
    rangeCalls = 0
    fitListColumns(frame)
    expect(rangeCalls).toBe(0)
    expect(getByTestId('tpl-preview-0').style.getPropertyValue('--list-content-column-width')).toBe(widthAfterFirst)
  })

  it('同じ内容の後ろの行が新しい DOM に置き換わったときも必ず測り直し、列の印と幅を付け直す', () => {
    let rangeCalls = 0
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      rangeCalls += 1
      return [rect(Math.max(24, this.toString().trim().length * 10), 20)] as unknown as DOMRectList
    })
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
      return rect(Math.max(24, this.toString().trim().length * 10), 20)
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'tpl-frame' || this.tagName === 'TABLE' || this.tagName === 'TR') return rect(1100, 40)
      return rect(180, 24)
    })

    const { getByTestId } = render(
      <TemplateLikeTable
        rows={[
          { name: 'テンプレート1', preview: '見本A', status: '公開中' },
          { name: 'テンプレート2', preview: '見本B', status: '下書き' },
        ]}
      />,
    )
    const frame = getByTestId('tpl-frame')
    fitListColumns(frame)
    const expectedWidth = getByTestId('tpl-preview-1').style.getPropertyValue('--list-content-column-width')
    expect(expectedWidth).not.toBe('')

    // 2行目だけを同じ内容の新しい DOM へ入れ替える（DOM 変更なので必ず測り直す）
    const tbody = frame.querySelector('tbody')!
    const fresh = document.createElement('tr')
    fresh.innerHTML = '<td data-cell-grow=""><span data-list-name="">テンプレート2</span></td><td><span>見本B</span></td><td><span>下書き</span></td>'
    tbody.replaceChild(fresh, tbody.children[1])

    rangeCalls = 0
    const commit = fitListColumns(frame, true)
    expect(rangeCalls).toBeGreaterThan(0)
    expect(typeof commit).toBe('function')
    commit?.()

    expect(fresh.children[0].hasAttribute('data-content-name-column')).toBe(true)
    expect(fresh.children[1].hasAttribute('data-content-support-column')).toBe(true)
    expect((fresh.children[1] as HTMLElement).style.getPropertyValue('--list-content-column-width')).toBe(expectedWidth)
    expect(fresh.children[2].hasAttribute('data-content-support-column')).toBe(true)

    // 変更が無い再実行では測り直しを省略する
    rangeCalls = 0
    expect(fitListColumns(frame, true)).toBeUndefined()
    expect(rangeCalls).toBe(0)
  })

  it('非 flexibleContent 表のリサイズ時でも deferCommit の読取フェーズ中は DOM へ書き込まず、書込フェーズ後に測り直す', async () => {
    let frameWidth = 1100
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      return [rect(Math.max(24, this.toString().trim().length * 10), 20)] as unknown as DOMRectList
    })
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
      return rect(Math.max(24, this.toString().trim().length * 10), 20)
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'tpl-frame' || this.tagName === 'TABLE' || this.tagName === 'TR') return rect(frameWidth, 40)
      return rect(180, 24)
    })
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { status: 'loaded', ready: Promise.resolve(), addEventListener: vi.fn(), removeEventListener: vi.fn() },
    })

    const { getByTestId } = render(
      <TemplateLikeTable rows={[{ name: '案内テンプレート', preview: '本文見本', status: '公開中' }]} />,
    )
    const frame = getByTestId('tpl-frame')
    const previewCell = getByTestId('tpl-preview-0')

    await flushFrame()
    expect(previewCell.style.getPropertyValue('--list-content-column-width')).not.toBe('')

    // リサイズ発生時に deferCommit の読取フェーズで DOM 書込が 0 回であることを確認
    frameWidth = 860
    const removeAttrSpy = vi.spyOn(previewCell, 'removeAttribute')
    const removePropSpy = vi.spyOn(previewCell.style, 'removeProperty')
    const onReset = vi.fn()
    const commit = fitListColumns(frame, true, onReset)
    expect(removeAttrSpy).not.toHaveBeenCalled()
    expect(removePropSpy).not.toHaveBeenCalled()
    expect(typeof commit).toBe('function')

    // 書込フェーズ（commit）で初めて初期化し、onReset で次フレーム再計測を予約する
    commit?.()
    expect(onReset).toHaveBeenCalledTimes(1)
    const commit2 = fitListColumns(frame, true, onReset)
    expect(typeof commit2).toBe('function')
    commit2?.()
    expect(previewCell.style.getPropertyValue('--list-content-column-width')).not.toBe('')
  })

  it('2段表示（data-content-stacked）中も読取フェーズで data-content-stacked を剥がさない', () => {
    vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
      return [rect(Math.max(24, this.toString().trim().length * 10), 20)] as unknown as DOMRectList
    })
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
      return rect(Math.max(24, this.toString().trim().length * 10), 20)
    })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'stacked-frame' || this.tagName === 'TABLE' || this.tagName === 'TR') return rect(200, 40)
      return rect(120, 24)
    })

    const { getByTestId } = render(
      <div data-testid="stacked-frame" data-column-layout="" data-column-sizing="content">
        <table>
          <thead>
            <tr data-table-layout="columns">
              <th data-cell-grow="">名前</th>
              <th>補足</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr data-table-layout="columns">
              <td data-cell-grow=""><span data-list-name="">長いテンプレート名</span></td>
              <td><span>長い補足の文字列</span></td>
              <td><button type="button">詳細を見る</button></td>
            </tr>
          </tbody>
        </table>
      </div>,
    )
    const frame = getByTestId('stacked-frame')
    fitListColumns(frame)
    expect(frame.hasAttribute('data-content-stacked')).toBe(true)

    const removeAttrSpy = vi.spyOn(frame, 'removeAttribute')
    ;(frame as HTMLDivElement & { listColumnScope?: string }).listColumnScope = ''
    const commit = fitListColumns(frame, true)
    expect(removeAttrSpy).not.toHaveBeenCalled()
    commit?.()
    expect(frame.hasAttribute('data-content-stacked')).toBe(true)
  })
})
