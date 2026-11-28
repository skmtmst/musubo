/**
 * Read existing content and spacing; only the name column receives spare width.
 * @param {HTMLElement | null} frame
 * @param {boolean} [deferCommit]
 * @param {(() => void) | null} [onReset]
 */
export function fitListColumns(frame, deferCommit = false, onReset = null) {
  const table = frame?.querySelector('table')
  const rows = table ? [...table.querySelectorAll(':scope > thead > tr, :scope > tbody > tr')].filter(row => !row.querySelector('[colspan]') && row.getBoundingClientRect().width) : []
  const body = rows.find(row => row.parentElement.tagName === 'TBODY')
  if (!body) return
  const bodyCells = [...body.children]
  const nameIndex = bodyCells.findIndex(cell => cell.hasAttribute('data-cell-grow') || cell.querySelector('[data-list-name], [data-row-link], [data-list-name-cell]'))
  if (nameIndex < 0) return
  const flexibleContent = frame.hasAttribute('data-column-layout') && frame.dataset.columnSizing === 'content'
  const controlsOnly = frame.dataset.columnSizing === 'controls'
  const frameWidth = Math.round(frame.getBoundingClientRect().width)
  const tableRectWidth = table.getBoundingClientRect().width
  const tableWidth = Math.round(tableRectWidth)
  const bodyWidths = bodyCells.map(cell => cell.getBoundingClientRect().width)
  const visibleMask = bodyWidths.map(width => (width > 0 ? '1' : '0')).join('')
  const cols = [...table.querySelectorAll(':scope > colgroup > col')]
  for (const col of cols) if (col.listColumnOriginalWidth === undefined) col.listColumnOriginalWidth = col.style.width

  const layoutScope = `${frameWidth}:${tableWidth}:${bodyCells.length}:${nameIndex}:${visibleMask}:${flexibleContent ? 'F' : controlsOnly ? 'C' : 'S'}:${cols.map(col => col.listColumnOriginalWidth).join(',')}`
  const cellSignature = cell => {
    if (!cell) return ''
    const flags = (cell.hasAttribute('data-cell-weight') ? `w${cell.dataset.cellWeight}` : '')
      + (cell.hasAttribute('data-list-number') ? 'N' : '')
      + (cell.hasAttribute('data-list-date-time') ? 'D' : '')
      + (cell.hasAttribute('data-cell-grow') ? 'G' : '')
    let sig = `${cell.className}:${flags}:${cell.textContent ?? ''}`
    if (cell.childElementCount > 0) {
      const descendants = cell.querySelectorAll('button,a,input,select,textarea,svg,img,[role="button"],[data-design-node="xRvDB"],[data-list-date-time],[hidden],[aria-hidden="true"],.sr-only')
      if (descendants.length > 0) {
        sig += `#${descendants.length}`
        for (const el of descendants) {
          sig += `,${el.tagName}:${el.getAttribute('data-design-node') ?? ''}:${el.hasAttribute('hidden') ? 1 : 0}:${'value' in el ? el.value : ''}`
        }
      }
    }
    return sig
  }
  const measureKey = `${layoutScope}\x1d${rows.length}\x1d${rows.map(row => [...row.children].map(cellSignature).join('\x1f')).join('\x1e')}`
  const usesGridColumns = frame.hasAttribute('data-grid-table') || frame.hasAttribute('data-table-density')
  const appliedIntact = frame.listColumnScope === layoutScope
    && frame.listColumnMeasureKey === measureKey
    && bodyCells[nameIndex]?.hasAttribute('data-content-name-column')
    && (!usesGridColumns || frame.style.getPropertyValue('--table-content-columns') === frame.listColumnAppliedGrid)
  if (appliedIntact) return

  const hasAppliedSizing = () =>
    cols.some(col => col.style.width !== col.listColumnOriginalWidth)
    || bodyCells.some(cell =>
      cell.hasAttribute('data-content-name-column')
      || cell.hasAttribute('data-content-support-column')
      || Boolean(cell.style.getPropertyValue('--list-content-column-width')),
    )
    || (usesGridColumns && Boolean(frame.style.getPropertyValue('--table-content-columns')))

  const resetAppliedSizing = () => {
    for (const col of cols) if (col.style.width !== col.listColumnOriginalWidth) col.style.width = col.listColumnOriginalWidth
    if (usesGridColumns && frame.style.getPropertyValue('--table-content-columns')) {
      frame.style.removeProperty('--table-content-columns')
    }
    for (const row of rows) for (const cell of row.children) {
      if (cell.hasAttribute('data-content-name-column')) cell.removeAttribute('data-content-name-column')
      if (cell.hasAttribute('data-content-support-column')) cell.removeAttribute('data-content-support-column')
      if (cell.style.getPropertyValue('--list-content-column-width')) cell.style.removeProperty('--list-content-column-width')
    }
  }

  let ceilings = frame.listColumnCeilings
  if (frame.listColumnScope !== layoutScope || (!flexibleContent && (!Array.isArray(ceilings) || ceilings.length !== bodyCells.length))) {
    if (!flexibleContent) {
      if (hasAppliedSizing()) {
        if (deferCommit && typeof onReset === 'function') {
          // 読取フェーズではDOMへ書き込まず、書込フェーズで初期化してから次フレームで本来の列幅を測る。
          return () => {
            resetAppliedSizing()
            frame.listColumnScope = ''
            frame.listColumnMeasureKey = ''
            onReset()
          }
        }
        resetAppliedSizing()
        ceilings = bodyCells.map(cell => cell.getBoundingClientRect().width)
      } else {
        ceilings = bodyWidths
      }
      frame.listColumnCeilings = ceilings
    }
  }

  const number = value => parseFloat(value) || 0
  const doc = frame.ownerDocument || document
  const textCache = new Map()
  const fontKeys = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariantNumeric', 'fontVariationSettings', 'fontFeatureSettings', 'letterSpacing', 'wordSpacing']
  const measureIsolatedProbe = (text, css) => {
    const cacheKey = `${fontKeys.map(key => css[key]).join('|')}\0${text}`
    if (textCache.has(cacheKey)) return textCache.get(cacheKey)
    let probe = doc.__listColumnProbe
    if (!probe || !probe.isConnected) {
      const host = doc.createElement('div')
      host.setAttribute('data-column-probe-host', '')
      host.setAttribute('aria-hidden', 'true')
      host.setAttribute('inert', '')
      host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;contain:strict'
      probe = doc.createElement('span')
      probe.setAttribute('data-column-probe', '')
      probe.style.cssText = 'position:fixed;top:0;left:0;white-space:pre;visibility:hidden;pointer-events:none'
      host.append(probe)
      doc.documentElement.append(host)
      doc.__listColumnProbe = probe
    }
    for (const key of fontKeys) {
      if (probe.style[key] !== css[key]) probe.style[key] = css[key]
    }
    probe.textContent = text
    const width = probe.getBoundingClientRect().width
    textCache.set(cacheKey, width)
    return width
  }
  const textWidth = node => {
    const text = node.textContent.trim()
    if (!text) return 0
    const css = getComputedStyle(node.nodeType === 3 ? node.parentElement : node)
    const range = doc.createRange()
    range.selectNodeContents(node)
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0)
    if (rects.length <= 1) return range.getBoundingClientRect().width
    return measureIsolatedProbe(text, css)
  }
  const intrinsicCache = new Map()
  const intrinsic = node => {
    if (intrinsicCache.has(node)) return intrinsicCache.get(node)
    let result = 0
    if (node.nodeType === 3) result = node.textContent.trim() ? textWidth(node) : 0
    else if (node.nodeType === 1) {
      const css = getComputedStyle(node)
      if (css.display !== 'none' && css.visibility !== 'hidden' && !node.matches('.sr-only, [hidden], [role="menu"], [role="tooltip"]')) {
        if (node.matches('button, input, svg, img, video, [role="button"]') && !node.matches('[data-part="row-name"]')) {
          result = node.getBoundingClientRect().width
        } else {
          const pseudo = position => {
            const style = getComputedStyle(node, position)
            return style.content === 'none' || style.content === 'normal' || style.display === 'none' ? 0 : number(style.width)
          }
          const textOnly = node.childElementCount === 0 && node.textContent.trim()
          const sizes = [pseudo('::before'), ...(textOnly ? [textWidth(node)] : [...node.childNodes].map(intrinsic)), pseudo('::after')].filter(size => size > 0)
          if (!sizes.length && !node.textContent.trim()) {
            result = controlsOnly && number(css.flexGrow) > 0 ? 0 : node.getBoundingClientRect().width
          } else {
            const inline = css.display === 'inline' || css.display === 'inline-flex' || (css.display === 'flex' && css.flexDirection === 'row')
            const gapItems = controlsOnly ? [...node.childNodes].filter(child => child.nodeType === 3 ? child.textContent.trim() : child.nodeType === 1 && getComputedStyle(child).display !== 'none').length + Number(pseudo('::before') > 0) + Number(pseudo('::after') > 0) : sizes.length
            const content = inline ? sizes.reduce((sum, size) => sum + size, 0) + number(css.columnGap) * Math.max(0, gapItems - 1) : Math.max(0, ...sizes)
            result = content + number(css.paddingLeft) + number(css.paddingRight) + number(css.borderLeftWidth) + number(css.borderRightWidth)
          }
        }
      }
    }
    intrinsicCache.set(node, result)
    return result
  }
  const widths = bodyCells.map((cell, index) => {
    // 割合を指定した列は、残りを割合で分け合う列。中身で測らない。
    if (index === nameIndex || cell.hasAttribute('data-cell-weight') || !bodyWidths[index]) return null
    const cells = rows.map(row => row.children[index]).filter(Boolean).filter(c => c.getBoundingClientRect().width)
    if (controlsOnly && !cells.some(c => c.querySelector('button, input, [role="button"], [data-design-node="xRvDB"]'))) return null
    const required = Math.max(0, ...cells.map(intrinsic))
    if (controlsOnly) return Math.ceil(Math.max(ceilings[index], required))
    if (flexibleContent) return Math.ceil(required)
    const unbroken = cells.some(c => c.matches('[data-list-number]') || c.querySelector('button, a, input, [data-design-node="xRvDB"], [data-list-date-time]'))
    return Math.ceil(unbroken ? required : Math.min(ceilings[index], required))
  })
  let mustStack = false
  if (flexibleContent && !controlsOnly && !bodyCells.some(cell => cell.hasAttribute('data-cell-weight'))) {
    const header = rows.find(row => row.parentElement.tagName === 'THEAD')
    const shortContentWidth = cell => {
      const content = [cell, ...cell.querySelectorAll('*')].filter(node => node.childElementCount === 0 && node.getBoundingClientRect().height && node.textContent.trim() && !node.closest('[hidden], [aria-hidden="true"], .sr-only, [role="note"]'))
      const leaves = content.filter(node => node.textContent.trim().replace(/\s/g, '').length <= 16)
      if (content.length && leaves.length === content.length) return intrinsic(cell)
      const padding = getComputedStyle(cell)
      return Math.max(0, ...leaves.map(textWidth)) + number(padding.paddingLeft) + number(padding.paddingRight)
    }
    const minimum = widths.map((width, index) => width === null ? 0 : Math.min(width, Math.max(header?.children[index] ? intrinsic(header.children[index]) : 0, number(getComputedStyle(bodyCells[index]).fontSize), ...rows.map(row => row.children[index] ? shortContentWidth(row.children[index]) : 0))))
    const fixed = widths.map((_, index) => rows.some(row => {
      const cell = row.children[index]
      return cell && (cell.matches('[data-list-number], [data-list-date-time]') || cell.querySelector('button,input,a,[role="button"],[data-list-date-time]'))
    }))
    const controls = widths.reduce((sum, width, index) => sum + (fixed[index] ? width ?? 0 : 0), 0)
    const rowStyle = getComputedStyle(body)
    const contentBudget = tableRectWidth - number(rowStyle.paddingLeft) - number(rowStyle.paddingRight) - number(rowStyle.columnGap) * (bodyCells.length - 1)
    const nameContent = Math.max(...rows.map(row => intrinsic(row.children[nameIndex])))
    const nameMinimum = Math.max(number(getComputedStyle(bodyCells[nameIndex]).minWidth), header?.children[nameIndex] ? intrinsic(header.children[nameIndex]) : 0, ...rows.map(row => row.children[nameIndex] ? shortContentWidth(row.children[nameIndex]) : 0))
    const minimumTotal = minimum.reduce((sum, width, index) => sum + (fixed[index] ? 0 : width), 0)
    const nameBudget = Math.max(nameMinimum, Math.min(nameContent, contentBudget - controls - minimumTotal))
    const available = Math.max(0, contentBudget - nameBudget - controls)
    const total = widths.reduce((sum, width, index) => sum + (fixed[index] ? 0 : width ?? 0), 0)
    mustStack = minimumTotal + controls + nameMinimum > contentBudget
    if (mustStack) {
      widths.forEach((width, index) => { if (width !== null && !fixed[index]) widths[index] = minimum[index] })
    } else if (total > available) {
      let low = 0, high = Math.max(...widths.map(width => width ?? 0))
      for (let step = 0; step < 24; step++) {
        const cap = (low + high) / 2
        if (widths.reduce((sum, width, index) => sum + (fixed[index] ? 0 : Math.max(minimum[index], Math.min(width ?? 0, cap))), 0) > available) high = cap
        else low = cap
      }
      widths.forEach((width, index) => { if (width !== null && !fixed[index]) widths[index] = Math.max(minimum[index], Math.min(width, low)) })
    }
  }
  // 割合（weight）を指定した列：測った列を除いた残りの幅を、割合で分ける（実寸の px にして、ほかの測った列と同じ道で渡す）。
  const weights = bodyCells.map(cell => Number(cell.dataset.cellWeight) || 0)
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0)
  if (weightTotal > 0) {
    const fixed = widths.reduce((sum, width, index) => sum + (width && !weights[index] ? width : 0), 0)
    const room = Math.max(0, tableRectWidth - fixed)
    weights.forEach((weight, index) => { if (weight > 0 && bodyWidths[index]) widths[index] = Math.floor(room * weight / weightTotal) })
  }
  const bodyIsFlex = getComputedStyle(body).display === 'flex'
  const gridColumns = usesGridColumns ? widths.map(width => width == null ? 'minmax(0, 1fr)' : `${width}px`).join(' ') : ''
  const commit = () => {
    if (frame.hasAttribute('data-content-stacked') !== mustStack) frame.toggleAttribute('data-content-stacked', mustStack)
    if (usesGridColumns) {
      if (frame.style.getPropertyValue('--table-content-columns') !== gridColumns) frame.style.setProperty('--table-content-columns', gridColumns)
      frame.listColumnAppliedGrid = gridColumns
    }
    // A native fixed-layout table reads <col> before the first row's cell width.
    // Keep its column model in sync with the same measured content budget.
    if (!bodyIsFlex) {
      for (const [index, col] of cols.entries()) {
        const nextWidth = widths[index] != null ? `${widths[index]}px` : col.listColumnOriginalWidth
        if (col.style.width !== nextWidth) col.style.width = nextWidth
      }
    }
    for (const row of rows) for (const [index, cell] of [...row.children].entries()) {
      const isName = index === nameIndex
      const isSupport = widths[index] !== null && widths[index] !== undefined
      if (cell.hasAttribute('data-content-name-column') !== isName) cell.toggleAttribute('data-content-name-column', isName)
      if (cell.hasAttribute('data-content-support-column') !== isSupport) cell.toggleAttribute('data-content-support-column', isSupport)
      if (isSupport) {
        const value = `${widths[index]}px`
        if (cell.style.getPropertyValue('--list-content-column-width') !== value) cell.style.setProperty('--list-content-column-width', value)
      } else if (cell.style.getPropertyValue('--list-content-column-width')) {
        cell.style.removeProperty('--list-content-column-width')
      }
    }
    frame.listColumnScope = layoutScope
    frame.listColumnMeasureKey = measureKey
  }
  if (deferCommit) return commit
  commit()
}
