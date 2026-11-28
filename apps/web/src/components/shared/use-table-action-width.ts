'use client'

import { useLayoutEffect, useRef } from 'react'
import { scheduleTableMeasure } from './table-measure-batch'

/** ：列内のいちばん長い主操作にそろえる。文字や権限が変われば測り直す。 */
export function useTableActionWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const table = ref.current
    if (!table) return
    const view = table.ownerDocument.defaultView
    if (!view?.requestAnimationFrame || !view.cancelAnimationFrame) return
    let cancel: (() => void) | null = null
    let disposed = false
    const taskKey = {}
    const measure = () => {
      if (disposed || cancel) return
      cancel = scheduleTableMeasure(view, taskKey, () => {
        cancel = null
        if (disposed) return
        const buttons = [...table.querySelectorAll<HTMLElement>('[data-row-actions] > :is(button,a):not([data-row-menu]), [data-row-quick-action], [data-list-action-cell] :is(button,a):not([data-row-menu])')]
          .filter(el => el.getBoundingClientRect().width > 0)
        // width は伸ばした後の値なので使わない。自然な中身の幅で最大を取る。
        const width = Math.max(0, ...buttons.map(el => {
          const range = document.createRange(); range.selectNodeContents(el)
          const css = getComputedStyle(el)
          return (typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect().width : 0) + parseFloat(css.paddingLeft || '0') + parseFloat(css.paddingRight || '0') + parseFloat(css.borderLeftWidth || '0') + parseFloat(css.borderRightWidth || '0')
        }))
        const value = `${Math.ceil(width)}px`
        return () => {
          if (table.style.getPropertyValue('--row-action-width') !== value) table.style.setProperty('--row-action-width', value)
        }
      })
    }
    const Observer = table.ownerDocument.defaultView?.MutationObserver
    const mutations = Observer ? new Observer(measure) : null
    mutations?.observe(table, { childList: true, subtree: true, characterData: true })
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    sizes?.observe(table)
    const fonts = table.ownerDocument.fonts
    if (fonts && fonts.status !== 'loaded') void fonts.ready.then(() => { if (!disposed) measure() })
    measure()
    return () => { disposed = true; cancel?.(); cancel = null; mutations?.disconnect(); sizes?.disconnect() }
  }, [])
  return ref
}
