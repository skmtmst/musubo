// @vitest-environment happy-dom
import { useRef } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fitListColumns } from './list-column-sizing.mjs'
import { useListColumnSizing } from './use-list-column-sizing'
import { useListRowDensity } from './use-list-row-density'
import { useTableActionWidth } from './use-table-action-width'

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

beforeEach(() => {
  nextFrame = 0
  frames = new Map()
  notifyResize = []
  delete (document as Document & { __listColumnProbe?: unknown }).__listColumnProbe
  document.documentElement.querySelectorAll('[data-column-probe-host]').forEach(el => el.remove())
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

const originalFontsDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts')

afterEach(() => {
  cleanup()
  if (originalFontsDescriptor) Object.defineProperty(document, 'fonts', originalFontsDescriptor)
  else delete (document as Document & { fonts?: unknown }).fonts
  document.documentElement.querySelectorAll('[data-column-probe-host]').forEach(el => el.remove())
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function SampleTable({ rows, enabled = true }: { rows: { name: string; note: string }[]; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useListColumnSizing(ref, enabled)
  return (
    <div ref={ref} data-testid="frame" data-column-layout="" data-column-sizing="content" data-table-density="">
      <table>
        <colgroup>
          <col style={{ width: '1fr' }} />
          <col style={{ width: '120px' }} />
        </colgroup>
        <thead>
          <tr>
            <th>名前</th>
            <th>詳細</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              <td data-cell-grow=""><span data-list-name="">{row.name}</span></td>
              <td data-testid={`note-${index}`}><span>{row.note}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

it('measures wrapped long-text columns with the same width via a persistent contain:strict probe without touching document.body', () => {
  const longNote = 'とても長い補足テキストが二行以上に折り返されるケースの計測検証用サンプル'
  let probeReads = 0
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
    const text = this.toString().trim()
    if (text === longNote) return [rect(120, 20), rect(120, 20)] as unknown as DOMRectList
    return [rect(Math.max(24, text.length * 10), 20)] as unknown as DOMRectList
  })
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
    const text = this.toString().trim()
    return rect(Math.max(24, text.length * 10), 20)
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-column-probe')) {
      probeReads += 1
      return rect((this.textContent?.length ?? 0) * 10, 20)
    }
    if (this.dataset.testid === 'frame' || this.tagName === 'TABLE' || this.tagName === 'TR') return rect(1200, 40)
    return rect(120, 24)
  })

  const bodyAppend = vi.spyOn(document.body, 'append')
  const bodyAppendChild = vi.spyOn(document.body, 'appendChild')

  const { getByTestId } = render(
    <SampleTable
      rows={[
        { name: 'テンプレート1', note: longNote },
        { name: 'テンプレート2', note: longNote },
        { name: 'テンプレート3', note: longNote },
      ]}
      enabled={false}
    />,
  )
  const frame = getByTestId('frame')
  bodyAppend.mockClear()
  bodyAppendChild.mockClear()

  fitListColumns(frame)

  expect(bodyAppend).not.toHaveBeenCalled()
  expect(bodyAppendChild).not.toHaveBeenCalled()
  // Duplicate wrapped strings in the same pass are cached so the probe is read only once
  expect(probeReads).toBe(1)
  const hosts = document.documentElement.querySelectorAll<HTMLElement>('[data-column-probe-host]')
  expect(hosts).toHaveLength(1)
  expect(hosts[0].style.contain).toBe('strict')
  expect(hosts[0].parentElement).toBe(document.documentElement)
  expect(getByTestId('note-0').style.getPropertyValue('--list-content-column-width')).toBe(`${longNote.length * 10}px`)

  // Re-running fitListColumns reuses the same probe host without adding new elements
  fitListColumns(frame)
  expect(bodyAppend).not.toHaveBeenCalled()
  expect(document.documentElement.querySelectorAll('[data-column-probe-host]')).toHaveLength(1)
})

it('coalesces repeated mutations and same-width resizes into a single pass per frame without redundant fonts.ready runs', async () => {
  let frameWidth = 1000
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'frame' || this.tagName === 'TABLE' || this.tagName === 'TR') return rect(frameWidth, 40)
    return rect(120, 24)
  })
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { status: 'loaded', ready: Promise.resolve() },
  })

  const { rerender } = render(<SampleTable rows={[{ name: 'A', note: 'メモ1' }]} />)
  expect(frames.size).toBe(1)

  for (let i = 0; i < 8; i++) notifyResize[0]()
  rerender(<SampleTable rows={[{ name: 'A', note: 'メモ2' }]} />)
  rerender(<SampleTable rows={[{ name: 'A', note: 'メモ3' }]} />)
  await act(async () => { await Promise.resolve() })
  expect(frames.size).toBe(1)
  expect(window.cancelAnimationFrame).not.toHaveBeenCalled()

  await flushFrame()
  await act(async () => { await Promise.resolve() })
  expect(frames.size).toBe(0)

  for (let i = 0; i < 10; i++) notifyResize[0]()
  expect(frames.size).toBe(0)

  frameWidth = 1280
  notifyResize[0]()
  notifyResize[0]()
  expect(frames.size).toBe(1)
  await flushFrame()
  expect(frames.size).toBe(0)
})

it('still re-measures once when document.fonts finishes loading after mount', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'frame' || this.tagName === 'TABLE' || this.tagName === 'TR') return rect(1000, 40)
    return rect(120, 24)
  })
  let resolveFonts!: () => void
  const fontsReady = new Promise<void>((resolve) => { resolveFonts = resolve })
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { status: 'loading', ready: fontsReady },
  })

  render(<SampleTable rows={[{ name: 'A', note: 'メモ1' }]} />)
  expect(frames.size).toBe(1)
  await flushFrame()
  expect(frames.size).toBe(0)

  resolveFonts()
  await act(async () => { await fontsReady })
  expect(frames.size).toBe(1)
  await flushFrame()
  expect(frames.size).toBe(0)
})

function CombinedTable() {
  const ref = useTableActionWidth<HTMLDivElement>()
  useListRowDensity(ref)
  useListColumnSizing(ref, true)
  return (
    <section data-list-skeleton="">
      <div ref={ref} data-testid="combined-frame" data-column-layout="" data-column-sizing="content">
        <table>
          <thead><tr><th>名前</th><th>補足</th><th>操作</th></tr></thead>
          <tbody>
            <tr data-testid="combined-row">
              <td data-cell-grow=""><span data-list-name="">標準テンプレート</span></td>
              <td data-testid="combined-note"><span>公開中</span></td>
              <td data-row-actions=""><button type="button">編集する</button></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  )
}

it('batches action-width, row-density, and column-sizing reads before any DOM write in a single frame', async () => {
  const order: string[] = []
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'combined-frame') {
      order.push('read-frame')
      return rect(1200, 40)
    }
    if (this.tagName === 'TABLE' || this.tagName === 'TR') return rect(1200, 40)
    return rect(100, 24)
  })
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(() => [rect(60, 20)] as unknown as DOMRectList)
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(() => rect(60, 20))

  const { getByTestId } = render(<CombinedTable />)
  const frame = getByTestId('combined-frame')
  const note = getByTestId('combined-note')
  const origSetProperty = frame.style.setProperty.bind(frame.style)
  vi.spyOn(frame.style, 'setProperty').mockImplementation((name, value) => {
    order.push(`write:${name}`)
    return origSetProperty(name, value)
  })
  const origNoteSetProperty = note.style.setProperty.bind(note.style)
  vi.spyOn(note.style, 'setProperty').mockImplementation((name, value) => {
    order.push(`write:${name}`)
    return origNoteSetProperty(name, value)
  })

  // All 3 hooks share 1 single animation frame
  expect(frames.size).toBe(1)
  await flushFrame()

  const firstWriteIdx = order.findIndex(entry => entry.startsWith('write:'))
  const lastReadIdx = order.lastIndexOf('read-frame')
  expect(firstWriteIdx).toBeGreaterThan(lastReadIdx)
  expect(note.style.getPropertyValue('--list-content-column-width')).not.toBe('')

  // Re-running fitListColumns on flexibleContent with unchanged widths performs zero style removes/rewrites
  const removeProp = vi.spyOn(note.style, 'removeProperty')
  const setProp = vi.spyOn(note.style, 'setProperty')
  setProp.mockClear()
  ;(frame as HTMLDivElement & { listColumnScope?: string }).listColumnScope = ''
  fitListColumns(frame)
  expect(removeProp).not.toHaveBeenCalled()
  expect(setProp).not.toHaveBeenCalled()
})
