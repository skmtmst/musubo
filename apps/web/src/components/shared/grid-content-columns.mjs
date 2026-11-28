/**
 * 見出しと各行の内容から列幅を配り、長い文字へ残りを渡す。
 * @param {HTMLElement | null} frame
 * @param {boolean} [deferCommit]
 */
export function fitGridContentColumns(frame, deferCommit = false) {
  const rows = frame ? [...frame.querySelectorAll(':scope > [role="row"]')] : []
  if (rows.length < 2 || !frame.clientWidth) return
  const doc = frame.ownerDocument || document
  const number = value => parseFloat(value) || 0
  const clientWidth = frame.clientWidth
  const headCells = [...rows[0].children]
  const count = headCells.length
  if (count === 0) return
  const css = getComputedStyle(rows[0])
  const room = clientWidth - number(css.paddingLeft) - number(css.paddingRight)
  const gap = number(css.columnGap)
  const available = room - gap * (count - 1)
  const headFontSizes = headCells.map(cell => number(getComputedStyle(cell).fontSize))

  // DOM が変わった呼び出しは必ず測り直す。省くのは DOM 変更の無い再呼び出しだけ。
  const siblingAttrs = new Set(['data-list-content-lines', 'data-list-density-scope'])
  const isProbeNode = node => node?.nodeType === 1 && (
    node.hasAttribute('data-column-probe')
    || node.hasAttribute('data-column-probe-host')
    || node.hasAttribute('data-grid-column-probe-host')
  )
  const isExternalMutation = record => {
    if (record.type === 'childList') {
      const changed = [...record.addedNodes, ...record.removedNodes]
      return changed.length > 0 && !changed.every(isProbeNode)
    }
    if (record.type === 'attributes') {
      if (siblingAttrs.has(record.attributeName)) return false
      if (record.target === frame && record.attributeName === 'style') return false
      return true
    }
    return true
  }
  let tracker = frame.__gridColumnDomTracker
  if (!tracker) {
    const view = doc.defaultView
    const MO = view?.MutationObserver || (typeof MutationObserver === 'function' ? MutationObserver : null)
    tracker = { dirty: true, observer: null }
    if (MO) {
      tracker.observer = new MO(records => {
        if (records.some(isExternalMutation)) tracker.dirty = true
      })
      tracker.observer.observe(frame, { childList: true, subtree: true, characterData: true, attributes: true })
    }
    frame.__gridColumnDomTracker = tracker
  } else if (tracker.observer) {
    const pending = tracker.observer.takeRecords()
    if (pending.some(isExternalMutation)) tracker.dirty = true
  }
  const drainOwnMutations = () => {
    if (tracker.observer) tracker.observer.takeRecords()
    tracker.dirty = false
  }

  const formControls = frame.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]),select,textarea')
  const formState = formControls.length === 0
    ? ''
    : [...formControls].map(el => (el.tagName === 'SELECT'
      ? [...el.options].map(option => (option.selected ? '1' : '0')).join('')
      : `${el.value ?? ''}`)).join('\x1f')
  const styleScope = `${rows.length}:${count}:${frame.className}|${frame.dataset.tablePresentation ?? ''}|${css.fontFamily}|${css.fontSize}|${css.fontWeight}|${css.letterSpacing}|${headFontSizes.join(',')}:${formState}`
  const scope = `${clientWidth}:${Math.round(room)}:${Math.round(gap)}:${styleScope}`
  const hasMedia = rows.some(row => row.querySelector('img,video,audio,iframe,object,embed,source,canvas,svg,image,use,input[type="image"]'))
  const appliedIntact = !tracker.dirty
    && frame.gridContentScope === scope
    && (frame.gridContentWasStacked
      ? frame.hasAttribute('data-stacked') && Boolean(frame.style.getPropertyValue('--grid-table-content-rest-columns'))
      : Boolean(frame.style.getPropertyValue('--grid-table-content-columns')))
  if (appliedIntact) return

  const fontKeys = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariantNumeric', 'fontVariationSettings', 'fontFeatureSettings', 'letterSpacing', 'wordSpacing', 'lineHeight']
  let measured
  if (!tracker.dirty && !hasMedia && frame.gridContentScope !== '' && frame.gridContentCache?.styleScope === styleScope) {
    measured = frame.gridContentCache.measured
  } else {
    // 写しは contain:strict の常駐ホストにすべて置いてから幅を読み、最後にまとめて外す。
    const copy = node => {
      if (node.nodeType === 3) return node.cloneNode()
      if (node.nodeType !== 1) return doc.createTextNode('')
      // 通信や接続処理を持つ物は実寸の空要素へ。フォームは名前・所属・選択を外し、自然な幅だけ測る。
      if (node.matches('img,video,audio,iframe,object,embed,source,canvas,svg,image,use,script,style,link,input[type="image"]') || node.localName.includes('-')) {
        const rect = node.getBoundingClientRect(), placeholder = doc.createElement('span')
        placeholder.style.cssText = `display:inline-block;width:${rect.width}px;height:${rect.height}px;flex:none`
        return placeholder
      }
      const clone = node.cloneNode(false)
      for (const attr of ['id', 'name', 'form', 'for', 'autofocus']) clone.removeAttribute(attr)
      if (node.matches('input')) { clone.checked = false; clone.removeAttribute('checked'); if (node.type !== 'file') clone.value = node.value }
      if (node.matches('button')) clone.setAttribute('type', 'button')
      for (const child of node.childNodes) clone.append(copy(child))
      if (node.matches('textarea')) clone.value = node.value
      if (node.matches('select')) [...node.options].forEach((option, index) => { if (clone.options[index]) clone.options[index].selected = option.selected })
      return clone
    }
    const probes = rows.map(row => [...row.children].map(cell => {
      const probe = copy(cell)
      probe.setAttribute('aria-hidden', 'true')
      probe.setAttribute('inert', '')
      probe.setAttribute('data-column-probe', '')
      probe.removeAttribute('id')
      for (const child of probe.querySelectorAll('[id]')) child.removeAttribute('id')
      probe.style.cssText += ';position:absolute;inset:0 auto auto 0;width:max-content;min-width:0;max-width:none;visibility:hidden;pointer-events:none'
      return probe
    }))

    let host = doc.__gridColumnProbeHost
    if (!host || !host.isConnected) {
      host = doc.createElement('div')
      host.setAttribute('data-grid-column-probe-host', '')
      host.setAttribute('aria-hidden', 'true')
      host.setAttribute('inert', '')
      host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;overflow:hidden;visibility:hidden;pointer-events:none;contain:strict'
      doc.documentElement.append(host)
      doc.__gridColumnProbeHost = host
    }
    let probeTable = host.__probeTable
    if (!probeTable || !probeTable.isConnected) {
      probeTable = doc.createElement('div')
      probeTable.setAttribute('data-grid-probe-table', '')
      host.append(probeTable)
      host.__probeTable = probeTable
    }
    probeTable.className = frame.className
    if (frame.dataset.tablePresentation) probeTable.dataset.tablePresentation = frame.dataset.tablePresentation
    else delete probeTable.dataset.tablePresentation
    probeTable.style.cssText = 'position:relative;display:block'
    const frameCss = getComputedStyle(frame)
    for (const key of fontKeys) {
      if (frameCss[key]) probeTable.style[key] = frameCss[key]
    }
    for (let i = 0; i < frame.style.length; i++) {
      const prop = frame.style[i]
      if (prop.startsWith('--')) probeTable.style.setProperty(prop, frame.style.getPropertyValue(prop))
    }

    const probeRows = rows.map((row, rowIndex) => {
      let probeRow = probeTable.children[rowIndex]
      if (!probeRow) {
        probeRow = doc.createElement('div')
        probeRow.setAttribute('data-grid-probe-row', '')
        probeTable.append(probeRow)
      }
      probeRow.className = row.className
      if (row.hasAttribute('data-head')) probeRow.setAttribute('data-head', '')
      else probeRow.removeAttribute('data-head')
      const rowStyle = rowIndex === 0 ? css : getComputedStyle(row)
      for (const key of fontKeys) {
        if (probeRow.style[key] !== rowStyle[key]) probeRow.style[key] = rowStyle[key]
      }
      probeRow.style.position = 'relative'
      probeRow.style.display = 'block'
      return probeRow
    })
    while (probeTable.children.length > rows.length) probeTable.lastElementChild.remove()

    try {
      probeRows.forEach((probeRow, index) => probeRow.append(...probes[index]))
      measured = probes.map(row => row.map(probe => Math.ceil(probe.getBoundingClientRect().width)))
    } finally {
      for (const row of probes) for (const probe of row) probe.remove()
      probeTable.className = ''
      delete probeTable.dataset.tablePresentation
      for (const probeRow of probeRows) {
        probeRow.className = ''
        probeRow.removeAttribute('data-head')
      }
    }
    frame.gridContentCache = { styleScope, measured }
  }

  const wanted = headCells.map((_, index) => Math.max(...measured.map(row => row[index] ?? 0)))
  const fixed = headCells.map((_, index) => rows.some(row => row.children[index]?.querySelector('button,input,[role="button"]')))
  // 見出しが読める実幅を下限にする。無題の列も実際の1文字分を残す。
  const minimum = wanted.map((width, index) => fixed[index] ? width : Math.min(width, Math.max(measured[0][index] ?? 0, headFontSizes[index])))
  const minimumTotal = minimum.reduce((sum, width) => sum + width, 0)

  let commit
  if (minimumTotal > available) {
    const rest = minimum.slice(1)
    const minTrack = Math.min(room, Math.max(...rest, 1))
    const restColumns = `repeat(auto-fit,minmax(${minTrack}px,1fr))`
    commit = () => {
      // 既存の2段表示へ戻す。残りの列も必要なら段を増やし、操作を隠さない。
      if (!frame.hasAttribute('data-stacked')) { frame.gridContentStacked = true; frame.dataset.stacked = '' }
      if (frame.style.getPropertyValue('--grid-table-content-rest-columns') !== restColumns) {
        frame.style.setProperty('--grid-table-content-rest-columns', restColumns)
      }
      if (frame.style.getPropertyValue('--grid-table-content-columns')) {
        frame.style.removeProperty('--grid-table-content-columns')
      }
      frame.gridContentWasStacked = true
      frame.gridContentScope = scope
      drainOwnMutations()
    }
  } else {
    let low = 0, high = Math.max(...wanted)
    for (let i = 0; i < 24; i++) {
      const cap = (low + high) / 2
      if (wanted.reduce((sum, width, index) => sum + (fixed[index] ? width : Math.max(minimum[index], Math.min(width, cap))), 0) > available) high = cap
      else low = cap
    }
    const widths = wanted.map((width, index) => fixed[index] ? width : Math.max(minimum[index], Math.min(width, low)))
    const spare = Math.max(0, available - widths.reduce((sum, width) => sum + width, 0))
    const marked = headCells.findIndex((cell, index) => cell.hasAttribute('data-cell-grow') && !fixed[index])
    const growIndex = marked >= 0 ? marked : wanted.reduce((best, width, index) => !fixed[index] && (best < 0 || width > wanted[best]) ? index : best, -1)
    if (growIndex >= 0) widths[growIndex] += spare
    const columns = widths.map(width => `${width}px`).join(' ')
    commit = () => {
      if (frame.gridContentStacked) delete frame.dataset.stacked
      delete frame.gridContentStacked
      if (frame.style.getPropertyValue('--grid-table-content-rest-columns')) {
        frame.style.removeProperty('--grid-table-content-rest-columns')
      }
      if (frame.style.getPropertyValue('--grid-table-content-columns') !== columns) {
        frame.style.setProperty('--grid-table-content-columns', columns)
      }
      frame.gridContentWasStacked = false
      frame.gridContentScope = scope
      drainOwnMutations()
    }
  }
  if (deferCommit) return commit
  commit()
}

/** 内容計測だけが付けた段組み・幅を外し、既存の段組みの印は変えない。 */
export function clearGridContentColumns(frame) {
  frame.style.removeProperty('--grid-table-content-columns')
  frame.style.removeProperty('--grid-table-content-rest-columns')
  if (frame.gridContentStacked) delete frame.dataset.stacked
  delete frame.gridContentStacked
  delete frame.gridContentWasStacked
  delete frame.gridContentScope
  delete frame.gridContentCache
  frame.__gridColumnDomTracker?.observer?.disconnect()
  delete frame.__gridColumnDomTracker
}
