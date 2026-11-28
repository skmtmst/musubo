'use client'
import { useLayoutEffect, type RefObject } from 'react'
import { clearGridContentColumns, fitGridContentColumns } from './grid-content-columns.mjs'
import { fitListColumns } from './list-column-sizing.mjs'
import { scheduleTableMeasure } from './table-measure-batch'

export function useListColumnSizing(ref: RefObject<HTMLDivElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    const frame = ref.current
    if (!frame) return
    if (!enabled) { clearGridContentColumns(frame); return }
    const view = frame.ownerDocument.defaultView
    if (!view?.requestAnimationFrame) return
    let active = true, lastWidth = -1
    let cancel: (() => void) | null = null
    const taskKey = {}
    const run = () => {
      cancel = null
      if (!active) return
      lastWidth = Math.round(frame.getBoundingClientRect().width)
      if (frame.getAttribute('role') === 'table') return fitGridContentColumns(frame, true)
      return fitListColumns(frame, true, schedule)
    }
    const schedule = () => {
      if (!active || cancel) return
      cancel = scheduleTableMeasure(view, taskKey, run)
    }
    // 幅を測るための見えない写しの出し入れでは測り直さない。
    const probeOnly = (records: MutationRecord[]) => records.every(record => record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(node => node instanceof HTMLElement && node.hasAttribute('data-column-probe')))
    const mutation = new MutationObserver(records => { if (!probeOnly(records)) schedule() })
    mutation.observe(frame, { childList: true, subtree: true, characterData: true })
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      const nextWidth = Math.round(frame.getBoundingClientRect().width)
      if (lastWidth >= 0 && nextWidth === lastWidth) return
      schedule()
    })
    resize?.observe(frame)
    schedule()
    const fonts = frame.ownerDocument.fonts
    if (fonts && fonts.status !== 'loaded') {
      void fonts.ready.then(() => {
        if (!active) return
        const target = frame as HTMLDivElement & {
          listColumnScope?: string
          listColumnMeasureKey?: string
          listColumnCachedResult?: unknown
          gridContentScope?: string
          gridContentCache?: unknown
        }
        target.listColumnScope = ''
        target.listColumnMeasureKey = ''
        target.listColumnCachedResult = undefined
        target.gridContentScope = ''
        target.gridContentCache = undefined
        schedule()
      })
    }
    return () => { active = false; cancel?.(); cancel = null; mutation.disconnect(); resize?.disconnect(); clearGridContentColumns(frame) }
  }, [ref, enabled])
}
