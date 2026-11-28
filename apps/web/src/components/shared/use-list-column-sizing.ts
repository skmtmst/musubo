'use client'
import { useLayoutEffect, type RefObject } from 'react'
import { clearGridContentColumns, fitGridContentColumns } from './grid-content-columns.mjs'
import { fitListColumns } from './list-column-sizing.mjs'
import { scheduleTableMeasure } from './table-measure-batch'

type DomTracker = { dirty: boolean; observer: MutationObserver | null }
type SizedFrame = HTMLDivElement & {
  listColumnScope?: string
  listColumnCeilingScope?: string
  listColumnFormState?: string
  listColumnSameTurn?: boolean
  gridContentScope?: string
  gridContentSameTurn?: boolean
  gridContentCache?: unknown
  __listColumnDomTracker?: DomTracker
  __gridColumnDomTracker?: DomTracker
}

const SIBLING_ATTRS = new Set(['data-list-content-lines', 'data-list-density-scope'])

export function useListColumnSizing(ref: RefObject<HTMLDivElement | null>, enabled: boolean) {
  useLayoutEffect(() => {
    const frame = ref.current as SizedFrame | null
    if (!frame) return
    if (!enabled) { clearGridContentColumns(frame); return }
    const view = frame.ownerDocument.defaultView
    if (!view?.requestAnimationFrame) return
    let active = true, lastWidth = -1
    let cancel: (() => void) | null = null
    const taskKey = {}
    const isProbeNode = (node: Node) =>
      node instanceof HTMLElement && (
        node.hasAttribute('data-column-probe')
        || node.hasAttribute('data-column-probe-host')
        || node.hasAttribute('data-grid-column-probe-host')
      )
    const isExternalMutation = (record: MutationRecord) => {
      if (record.type === 'childList') {
        const changed = [...record.addedNodes, ...record.removedNodes]
        return changed.length > 0 && !changed.every(isProbeNode)
      }
      if (record.type === 'attributes') {
        if (record.attributeName && SIBLING_ATTRS.has(record.attributeName)) return false
        if (record.target === frame && record.attributeName === 'style') return false
        return true
      }
      return true
    }
    const mutation = new MutationObserver(records => {
      if (!records.some(isExternalMutation)) return
      if (frame.__listColumnDomTracker) frame.__listColumnDomTracker.dirty = true
      if (frame.__gridColumnDomTracker) frame.__gridColumnDomTracker.dirty = true
      frame.listColumnSameTurn = false
      frame.gridContentSameTurn = false
      schedule()
    })
    const run = () => {
      cancel = null
      if (!active) return
      // 計測開始前の通知は今回分の計測へ反映されるため、ここで区切る。
      mutation.takeRecords()
      lastWidth = Math.round(frame.getBoundingClientRect().width)
      const commit = frame.getAttribute('role') === 'table'
        ? fitGridContentColumns(frame, true)
        : fitListColumns(frame, true, schedule)
      if (typeof commit !== 'function') return
      return () => {
        // 測ってから commit するまでの間に起きた外部変更を1件ずつ確かめる（捨てない）。
        const beforeRecords = mutation.takeRecords()
        const externalBefore = beforeRecords.some(isExternalMutation)
        const ownWrites = commit() as Map<Node, Set<string>> | undefined
        const afterRecords = mutation.takeRecords()
        const isOwnWrite = (record: MutationRecord) =>
          record.type === 'attributes'
          && Boolean(record.attributeName)
          && Boolean(ownWrites?.get(record.target)?.has(record.attributeName!))
        const externalDuring = afterRecords.some(record => !isOwnWrite(record) && isExternalMutation(record))
        if (externalBefore || externalDuring) {
          if (frame.__listColumnDomTracker) frame.__listColumnDomTracker.dirty = true
          if (frame.__gridColumnDomTracker) frame.__gridColumnDomTracker.dirty = true
          frame.listColumnSameTurn = false
          frame.gridContentSameTurn = false
          schedule()
        }
      }
    }
    const schedule = () => {
      if (!active || cancel) return
      cancel = scheduleTableMeasure(view, taskKey, run)
    }
    mutation.observe(frame, { childList: true, subtree: true, characterData: true, attributes: true })
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
        frame.listColumnScope = ''
        frame.listColumnCeilingScope = ''
        frame.listColumnSameTurn = false
        frame.gridContentScope = ''
        frame.gridContentSameTurn = false
        frame.gridContentCache = undefined
        if (frame.__listColumnDomTracker) frame.__listColumnDomTracker.dirty = true
        if (frame.__gridColumnDomTracker) frame.__gridColumnDomTracker.dirty = true
        schedule()
      })
    }
    return () => {
      active = false
      cancel?.()
      cancel = null
      mutation.disconnect()
      resize?.disconnect()
      frame.__listColumnDomTracker?.observer?.disconnect()
      delete frame.__listColumnDomTracker
      clearGridContentColumns(frame)
    }
  }, [ref, enabled])
}
