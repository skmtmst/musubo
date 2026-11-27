'use client'

import { useLayoutEffect, type RefObject } from 'react'
import { listRowContentLines } from './list-row-density.mjs'
import { scheduleTableMeasure } from './table-measure-batch'

/** : the table owns density, including wrapping, loading and filtering. */
export function useListRowDensity(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const table = ref.current
    const view = table?.ownerDocument.defaultView
    if (!table || !view?.requestAnimationFrame) return
    let cancel: (() => void) | null = null
    let disposed = false
    const taskKey = {}
    const measure = () => {
      if (disposed || cancel) return
      cancel = scheduleTableMeasure(view, taskKey, () => {
        cancel = null
        if (disposed) return
        const list = table.closest('[data-list-skeleton], [data-page-template="list"]')
          || table.dataset.tablePresentation === 'template-list'
        const dedicated = table.dataset.tablePresentation && !['template-list', 'event-list'].includes(table.dataset.tablePresentation)
          || table.dataset.tableDensity || table.dataset.density
        const generalCard = table.closest('[data-design-part="card"]') && !dedicated
          && !table.hasAttribute('data-column-layout') && !table.hasAttribute('data-grid-table')
        const changes: [HTMLElement, string | undefined][] = []
        for (const row of table.querySelectorAll<HTMLElement>('[data-shared-part="list-row"], tbody > tr')) {
          if (row.querySelector('[colspan]') || row.closest('[role="dialog"]')) continue
          const lines = !list || dedicated || generalCard ? undefined : String(listRowContentLines(row))
          if (row.dataset.listContentLines !== lines) changes.push([row, lines])
        }
        return () => {
          // Changing a native row's height before reading the next row forces
          // layout for the entire table. Read every row, then commit together.
          if (generalCard) {
            if (table.dataset.listDensityScope !== 'general') table.dataset.listDensityScope = 'general'
          } else if (table.dataset.listDensityScope) delete table.dataset.listDensityScope
          for (const [row, lines] of changes) {
            if (lines === undefined) delete row.dataset.listContentLines
            else row.dataset.listContentLines = lines
          }
        }
      })
    }
    const mutations = new view.MutationObserver(measure)
    mutations.observe(table, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'data-table-presentation', 'data-table-density', 'data-density'] })
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    sizes?.observe(table)
    view.addEventListener('resize', measure)
    table.addEventListener('load', measure, true)
    const fonts = table.ownerDocument.fonts
    fonts?.addEventListener('loadingdone', measure)
    if (fonts && fonts.status !== 'loaded') void fonts.ready.then(() => { if (!disposed) measure() })
    measure()
    return () => { disposed = true; cancel?.(); cancel = null; mutations.disconnect(); sizes?.disconnect(); view.removeEventListener('resize', measure); table.removeEventListener('load', measure, true); fonts?.removeEventListener('loadingdone', measure) }
  }, [ref])
}
