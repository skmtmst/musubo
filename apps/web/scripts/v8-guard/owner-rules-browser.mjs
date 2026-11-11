/** 描画された箱が親の切り抜きで欠けていないかを測る。 */
export default function scanOwnerRules() {
  const findings = [], root = document.querySelector('main') || document.body
  const styles = new Map()
  const css = el => { if (!styles.has(el)) styles.set(el, getComputedStyle(el)); return styles.get(el) }
  const visible = el => {
    for (let p = el; p; p = p.parentElement) {
      // 閉じた設定は描画されない。開いた設定とsummaryは検査する。
      if (p !== el && p.matches('details:not([open])') && !p.querySelector(':scope > summary')?.contains(el)) return false
      const c = css(p)
      if (c.display === 'none' || c.visibility === 'hidden' || c.visibility === 'collapse' || +c.opacity === 0 || c.clipPath === 'inset(50%)' || /^rect\(0px[, ]+0px[, ]+0px[, ]+0px\)$/.test(c.clip) || p.hasAttribute('inert')) return false
    }
    const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0
  }
  const selector = el => {
    const parts = []
    for (let p = el; p && p !== root.parentElement; p = p.parentElement) {
      const cls = typeof p.className === 'string' ? p.className.trim().split(/\s+/)[0] : ''
      const peers = p.parentElement ? [...p.parentElement.children].filter(s => s.tagName === p.tagName) : [p]
      parts.unshift(p.tagName.toLowerCase() + (cls ? '.' + cls.replace(/__[A-Za-z0-9_-]+$/, '') : '') + ':nth-of-type(' + (peers.indexOf(p)+1) + ')')
    }
    return parts.join(' > ')
  }
  const add = (kind, el, measure, text = '', other) => findings.push({kind,target:selector(el),text:text.replace(/\s+/g,' ').slice(0,120),measure,...(other?{other:selector(other)}:{})})
  const hasBorder = c => ['Top','Right','Bottom','Left'].every(side => c[`border${side}Style`] !== 'none' && parseFloat(c[`border${side}Width`]) > 0) || c.boxShadow !== 'none'
  // 小窓・吹き出し・通知はmainの外へ描かれる。面の検査はその口にも届かせる。
  const portals = [...document.querySelectorAll('[role="dialog"],[role="tooltip"],[aria-label="知らせ"]')]
  // 浮く面は背景の文字を通さない。bodyの白ではなく、その面自身の塗りを測る。
  const floating = [...document.querySelectorAll('[data-menu-portal],[role="tooltip"],[data-design-part="notification-panel"],[role="note"][id]')]
  for (const portal of floating.filter(visible)) {
    const own = css(portal)
    if (portal.matches('[role="note"]') && !['fixed', 'absolute'].includes(own.position)) continue
    const surface = own.backgroundColor !== 'rgba(0, 0, 0, 0)' ? portal
      : [...portal.children].find(el => visible(el) && css(el).backgroundColor !== 'rgba(0, 0, 0, 0)') ?? portal
    const c = css(surface), color = c.backgroundColor
    const alpha = color === 'transparent' ? 0 : color.startsWith('rgba(') ? Number(color.split(',').at(-1).replace(')', ''))
      : color.includes('/') ? Number(color.split('/').at(-1).replace(')', '').trim()) : 1
    let opacity = 1
    for (let p = surface; p; p = p.parentElement) opacity *= Number(css(p).opacity)
    if (alpha < 1 || opacity < 0.999 || c.backdropFilter && c.backdropFilter !== 'none') {
      add('floating-surface-transparency', surface, { alpha, opacity }, surface.getAttribute('aria-label') || '')
    }
  }
  const surfaces = [...new Set([root,...root.querySelectorAll('*'),...portals.flatMap(el => [el,...el.querySelectorAll('*')])])]
  // ダイアログ・カード・固定の下帯で、子の影や輪が overflow の切り抜き端に当たらないか測る。
  // box-shadow は DOM の外枠より広がるため、要素の矩形だけを見る boxclip とは分ける。
  const shadowOutsets = el => {
    const c = css(el), out = { top: 0, right: 0, bottom: 0, left: 0 }
    for (const shadow of c.boxShadow.split(/,(?![^()]*\))/)) {
      if (/\binset\b/.test(shadow)) continue
      const lengths = [...shadow.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]))
      if (lengths.length < 2) continue
      const [x, y, blur = 0, spread = 0] = lengths
      const soft = Math.max(0, spread + blur * 2)
      out.top = Math.max(out.top, soft - y); out.bottom = Math.max(out.bottom, soft + y)
      out.left = Math.max(out.left, soft - x); out.right = Math.max(out.right, soft + x)
    }
    if (c.outlineStyle !== 'none' && parseFloat(c.outlineWidth) > 0) {
      const ring = Math.max(0, parseFloat(c.outlineWidth) + (parseFloat(c.outlineOffset) || 0))
      for (const side of Object.keys(out)) out[side] = Math.max(out[side], ring)
    }
    return out
  }
  const checkedScrollWindows = new Set()
  const clipPixels = value => value > 1e-6 ? Math.ceil(value) : 0
  for (const el of surfaces.filter(visible)) {
    if (!el.closest('[role="dialog"],[data-design-part="card"],[data-shared-part="sticky-bar"]')) continue
    const out = shadowOutsets(el)
    if (!Object.values(out).some(value => value > 0)) continue
    const r = el.getBoundingClientRect()
    // viewport固定の要素は、包含ブロックを作らない祖先のoverflowでは切れない。
    let fixedContainer = null
    if (css(el).position === 'fixed') {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const style = css(p)
        if (style.transform !== 'none' || style.perspective !== 'none' || style.filter !== 'none' || style.backdropFilter && style.backdropFilter !== 'none' || /transform|filter|perspective/.test(style.willChange) || /paint|layout|strict|content/.test(style.contain)) { fixedContainer = p; break }
      }
      if (!fixedContainer) continue
    }
    for (let p = fixedContainer ?? el.parentElement; p && p !== document.body; p = p.parentElement) {
      const pc = css(p), clipsX = pc.overflowX !== 'visible', clipsY = pc.overflowY !== 'visible'
      if (!clipsX && !clipsY) continue
      let stickyX = false, stickyY = false
      for (let host = el; host && host !== p; host = host.parentElement) {
        const style = css(host)
        if (style.position === 'sticky') { stickyX ||= style.left !== 'auto' || style.right !== 'auto'; stickyY ||= style.top !== 'auto' || style.bottom !== 'auto' }
      }
      const scrollX = !stickyX && ['auto','scroll'].includes(pc.overflowX) && p.scrollWidth > p.clientWidth
      const scrollY = !stickyY && ['auto','scroll'].includes(pc.overflowY) && p.scrollHeight > p.clientHeight
      const q = p.getBoundingClientRect(), edge = {
        left: q.left + p.clientLeft - (scrollX ? p.scrollLeft : 0), top: q.top + p.clientTop - (scrollY ? p.scrollTop : 0),
        right: q.left + p.clientLeft - (scrollX ? p.scrollLeft : 0) + (scrollX ? p.scrollWidth : p.clientWidth),
        bottom: q.top + p.clientTop - (scrollY ? p.scrollTop : 0) + (scrollY ? p.scrollHeight : p.clientHeight),
      }
      const cut = {
        left: clipsX ? clipPixels(edge.left - (r.left - out.left)) : 0,
        right: clipsX ? clipPixels((r.right + out.right) - edge.right) : 0,
        top: clipsY ? clipPixels(edge.top - (r.top - out.top)) : 0,
        bottom: clipsY ? clipPixels((r.bottom + out.bottom) - edge.bottom) : 0,
      }
      if (Object.values(cut).some(value => value > 0)) add('shadow-clip', el, cut, '', p)
      // スクロール窓の途中で隠れる部分は読み進められる。窓自体の外側の切れはその窓の要素を検査する。
      if (scrollX || scrollY) {
        if (!checkedScrollWindows.has(p)) {
          checkedScrollWindows.add(p)
          const windowRect = p.getBoundingClientRect()
          for (let outer = p.parentElement; outer && outer !== document.body; outer = outer.parentElement) {
            const c = css(outer), b = outer.getBoundingClientRect()
            const sx = ['auto','scroll'].includes(c.overflowX) && outer.scrollWidth > outer.clientWidth
            const sy = ['auto','scroll'].includes(c.overflowY) && outer.scrollHeight > outer.clientHeight
            const cutWindow = {
              left: !sx && c.overflowX !== 'visible' ? clipPixels(b.left + outer.clientLeft - windowRect.left) : 0,
              right: !sx && c.overflowX !== 'visible' ? clipPixels(windowRect.right - b.left - outer.clientLeft - outer.clientWidth) : 0,
              top: !sy && c.overflowY !== 'visible' ? clipPixels(b.top + outer.clientTop - windowRect.top) : 0,
              bottom: !sy && c.overflowY !== 'visible' ? clipPixels(windowRect.bottom - b.top - outer.clientTop - outer.clientHeight) : 0,
            }
            if (Object.values(cutWindow).some(value => value > 0)) add('scroll-window-clip', p, cutWindow, '', outer)
            if (sx || sy) break
          }
        }
        break
      }
    }
  }
  for (const el of surfaces.filter(visible)) {
    const c = css(el), r = el.getBoundingClientRect(), name = el.getAttribute('data-pencil-name') || ''
    // 時間×卓、スマホの見え方、画像そのものは意図した端接触。ALLOW.tsvと同じ対象限定。
    // 古いbaseにも同じ判定を当てる。共通部品の既存の印も読む。
    const phone = el.closest('[data-line-preview-part],[class*="line-preview_phoneRoot__"]')
    const media = phone || el.closest('video,[data-media-slot],[data-qr-code], [data-booking-calendar],[role="grid"]') || /写真|画像の枠|サムネ|時間×卓|スマホ|見え方/.test(name)
    if (!media && hasBorder(c) && r.width>=80 && r.height>=40) {
      for (let p=el.parentElement; p && p!==document.body; p=p.parentElement) {
        const pc=css(p)
        if (pc.overflowY==='visible') continue
        const q=p.getBoundingClientRect()
        // 明示したスクロール欄は、先へ送る操作が実在する場合だけ許す。
        if (['auto','scroll'].includes(pc.overflowY) && p.scrollHeight>p.clientHeight) break
        if (r.bottom>q.bottom+2 && r.top<q.bottom-8) add('boxclip',el,{excess:Math.ceil(r.bottom-q.bottom)},'',p)
        break
      }
    }
  }
  // 画面の題と、固定表示する吹き出しが重なる配置を検出する。
  for (const tooltip of portals.filter(el => el.matches('[role="tooltip"]') && visible(el))) {
    const a = tooltip.getBoundingClientRect()
    for (const heading of root.querySelectorAll('h1,h2,h3,[data-page-title]')) {
      if (!visible(heading)) continue
      const b = heading.getBoundingClientRect(), width = Math.min(a.right, b.right) - Math.max(a.left, b.left), height = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
      if (width > 0 && height > 0) add('tooltip-heading-overlap', tooltip, { width: Math.ceil(width), height: Math.ceil(height) }, heading.textContent ?? '', heading)
    }
  }
  // 横に並ぶカードの高さと下端の操作の位置が1pxもずれない。
  // 対象は高さをそろえる段（data-card-height="equal"）と、印の無い段で同じ幅の列に並ぶカード（カードの格子）。
  // 幅の違う本文と横の欄、data-card-height="natural" の段は対象外。
  const groups = new Set([...root.querySelectorAll('[data-design-part="card"]')].map(card => card.parentElement).filter(Boolean))
  for (const group of groups) {
    if (group.dataset.cardHeight === 'natural') continue
    const rows = new Map()
    for (const card of [...group.children].filter(el => el.matches('[data-design-part="card"]') && visible(el))) {
      const top = Math.round(card.getBoundingClientRect().top)
      rows.set(top, [...rows.get(top) ?? [], card])
    }
    const sameWidths = row => { const w = row.map(card => card.getBoundingClientRect().width); const max = Math.max(...w); return max > 0 && (max - Math.min(...w)) / max <= 0.1 }
    for (const row of [...rows.values()].filter(row => row.length > 1 && (group.dataset.cardHeight === 'equal' || sameWidths(row)))) {
      const heights = row.map(card => card.getBoundingClientRect().height)
      const bottoms = row.map(card => card.querySelector(':scope > [data-card-actions]')).filter(Boolean).map(el => el.getBoundingClientRect().bottom)
      const spread = values => values.length > 1 ? Math.max(...values) - Math.min(...values) : 0
      if (spread(heights) > 1 || spread(bottoms) > 1) add('cardrow', row[0], { height: Math.ceil(spread(heights)), actions: Math.ceil(spread(bottoms)) }, '', row[row.length - 1])
    }
  }
  // 列に入らない文字があるのに、同じ行で80px以上を余らせない。
  for (const table of root.querySelectorAll('table,[role="table"]')) {
    const rows = [...table.querySelectorAll('tr,[role="row"]')].filter(visible)
    const head = rows.find(row => row.querySelector('th,[role="columnheader"]'))
    const spareInCells = cells => cells.map(cell => {
          const box = cell.getBoundingClientRect(), c = css(cell)
          const content = [...cell.childNodes].flatMap(node => {
            if (node.nodeType === 3 && node.textContent.trim()) { const range = document.createRange(); range.selectNodeContents(node); return [range.getBoundingClientRect()] }
            if (node.nodeType !== 1) return []
            const range = document.createRange(); range.selectNodeContents(node)
            return [...range.getClientRects(), ...node.querySelectorAll('button,input,svg,img')].map(el => el.getBoundingClientRect ? el.getBoundingClientRect() : el)
          }).filter(rect => rect.width > 0)
          const used = content.length ? Math.min(box.width, Math.max(...content.map(rect => rect.right)) - box.left) : 0
          return Math.max(0, box.width - used - (parseFloat(c.paddingRight) || 0) - (parseFloat(c.paddingLeft) || 0))
        })

    // 見出しや別の行が必要とする幅は空きに数えず、列全体で回せる余りだけを数える。
    const spareRows = rows.map(row => spareInCells([...row.children].filter(visible)))
    for (const row of rows.filter(row => row !== head)) {
      const cells = [...row.children].filter(visible)
      const clipped = cells.flatMap(cell => [cell, ...cell.querySelectorAll('*')]).filter(el => {
        const c = css(el)
        return c.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1 && el.textContent.trim()
      })
      if (clipped.length) {
        const spare = cells.reduce((sum, _, index) => sum + Math.min(...spareRows.filter(widths => widths.length === cells.length).map(widths => widths[index])), 0)
        if (spare >= 80) add('table-unused-space', clipped[0], { spare: Math.floor(spare) }, clipped[0].textContent)
      }
      if (!head || cells.length !== head.children.length) continue
      for (const [index, header] of [...head.children].entries()) {
        const match = header.textContent.match(/（([^）]+)）/)
        if (!match) continue
        const terms = match[1].split('・')
        const text = cells[index]?.querySelector('[data-list-name-description]')?.textContent.trim() ?? ''
        const matches = term => term === '質問の数' ? /質問\s*\d+/.test(text) : term === '大きさ' ? /^(大|小)(?:\s|・|$)/.test(text) : term === 'ボタン' ? /\d+\s*(?:ボタン|面)/.test(text) : null
        const missing = terms.filter(term => matches(term) === false)
        if (cells[index]?.textContent.trim() && missing.length) add('table-missing-detail', cells[index], { missing }, header.textContent)
      }
    }
  }
  for (const button of root.querySelectorAll('button')) {
    if (visible(button) && button.textContent.trim() === '詳細' && button.querySelector('.lucide-log-in')) add('action-icon', button, {}, '詳細')
  }
  // 14px 未満の UI 文字を太さ 400 で描かない。
  // お客さまのスマホの見え方（LINE の見本）は LINE と同じ太さなので数えない。
  // V8 の画面（<html data-theme="v8">）だけを見る。アプリの CSS の無い素の見本はブラウザ既定の太さなので数えない。
  for (const el of document.documentElement.dataset.theme === 'v8' ? surfaces.filter(visible) : []) {
    if (el.closest('svg,[data-line-preview-part],[class*="line-preview_phoneRoot__"],[class*="liff-phone-frame_"]')) continue
    const text = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim()
    if (!text) continue
    const c = css(el), size = parseFloat(c.fontSize), weight = Number(c.fontWeight)
    if (size < 14 && weight < 500) add('thintext', el, { size, weight }, text)
  }
  // 同じ段の押せるもの同士は、外枠が 1px でも重ならない（予約管理の予約元と印刷が重なった）。
  // 欄の中に収めた印（消すボタンなど）は欄の内側にあるので数えない。見える範囲は切り抜きの内側だけ、
  // 追従の帯・浮く窓など別の層にあるもの同士は比べない。
  const CONTROLS = 'button,a[href],input:not([type="hidden"]),textarea,select,[role="button"],[role="combobox"],[role="tab"],[role="switch"],[role="checkbox"],[role="radio"]'
  const layerOf = el => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (/^(fixed|sticky)$/.test(css(p).position)) return p; return null }
  const painted = el => {
    const r = el.getBoundingClientRect()
    let left = r.left, right = r.right, top = r.top, bottom = r.bottom
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const c = css(p), q = p.getBoundingClientRect()
      if (c.overflowX !== 'visible') { left = Math.max(left, q.left); right = Math.min(right, q.right) }
      if (c.overflowY !== 'visible') { top = Math.max(top, q.top); bottom = Math.min(bottom, q.bottom) }
    }
    return { left, right, top, bottom }
  }
  const scopes = [root, ...portals]
  const controls = [...new Set(scopes.flatMap(scope => [...scope.querySelectorAll(CONTROLS)]))]
    .filter(el => visible(el) && css(el).pointerEvents !== 'none')
    .map(el => ({ el, r: painted(el), layer: layerOf(el) }))
    .filter(({ r }) => r.right - r.left > 2 && r.bottom - r.top > 2)
  const inside = (a, b) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5
  const label = el => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 40)
  const mediaSelectionIsAbovePreview = (first, second) => {
    const preview = first.matches('button[data-media-preview]') ? first : second.matches('button[data-media-preview]') ? second : null
    const selection = first.matches('input[data-media-select]') ? first : second.matches('input[data-media-select]') ? second : null
    if (!preview || !selection) return false
    const thumbnail = preview.closest('[data-media-thumbnail-actions]')
    const corner = selection.closest('[data-media-select-corner]')
    if (!thumbnail || !corner || !thumbnail.contains(corner)) return false
    const rect = selection.getBoundingClientRect()
    const onScreen = rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth
    if (!onScreen) return Number(css(corner).zIndex) > (Number(css(preview).zIndex) || 0)
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
    if (hit && thumbnail.contains(hit)) return corner.contains(hit)
    return Number(css(corner).zIndex) > (Number(css(preview).zIndex) || 0)
  }
  for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
    const a = controls[i], b = controls[j]
    if (a.layer !== b.layer || a.el.contains(b.el) || b.el.contains(a.el)) continue
    const width = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left)
    const height = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top)
    if (width < 1 || height < 1 || mediaSelectionIsAbovePreview(a.el, b.el) || (a.el.matches('input,textarea') && inside(b.r, a.r) && a.el.parentElement?.contains(b.el)) || (b.el.matches('input,textarea') && inside(a.r, b.r) && b.el.parentElement?.contains(a.el))) continue
    add('control-collide', a.el, { width: Math.round(width), height: Math.round(height) }, `${label(a.el)} ⟂ ${label(b.el)}`, b.el)
  }
  // カードに置いた操作は、カードの外へ出さない（無効な操作も見た目を測る）。
  for (const el of [...root.querySelectorAll(CONTROLS)].filter(visible)) {
    const card = el.closest('[data-design-part="card"],article')
    if (!card || el.closest('[data-line-preview-part]')) continue
    const r = el.getBoundingClientRect(), q = card.getBoundingClientRect()
    if (r.left < q.left - 0.5 || r.right > q.right + 0.5) add('card-control-overflow', el, { left: Math.max(0, Math.ceil(q.left - r.left)), right: Math.max(0, Math.ceil(r.right - q.right)) })
  }
  for (const heading of root.querySelectorAll('[data-template-region="heading"]')) {
    const actions = heading.querySelector('[data-page-heading-actions]')
    if (!actions) continue
    const controls = [...actions.querySelectorAll('button,a[href]')].filter(visible)
    const primary = controls.filter(el => el.dataset.variant === 'primary')
    const secondary = controls.filter(el => el.dataset.variant !== 'primary' && el.getAttribute('aria-haspopup') !== 'menu')
    if (primary.length > 1) add('heading-primary-count', actions, { count: primary.length })
    if (secondary.length > 1) add('heading-secondary-count', actions, { count: secondary.length })
    for (const el of secondary) if (el.dataset.variant && el.dataset.variant !== 'text') add('heading-secondary-style', el, { count: 1 })
  }
  for (const body of root.querySelectorAll('[data-list-folders]')) {
    const frame = body.closest('[data-page-template]')
    if (!frame) continue
    const folders = body.dataset.listFolders === 'true'
    const rail = [...body.querySelectorAll('[data-template-region="folders"]')].find(visible)
    for (const el of [...frame.querySelectorAll('[data-variant="primary"]')].filter(visible)) {
      if (!/作る|つくる|新規|追加/.test(el.textContent) || el.closest('table,[role="dialog"],[data-shared-part="sticky-bar"],[data-design-part="card"]')) continue
      const correct = frame.dataset.listCreatePlacement === 'heading' || !folders
        ? el.closest('[data-template-region="heading"]')
        : rail ? rail.contains(el) : el.closest('[data-template-region="toolbar"]')
      if (!correct) add('create-action-placement', el, { folders: Number(folders), rail: Number(Boolean(rail)) })
    }
  }
  // 札と本文は最初の文字の基準線を合わせる。文字ごとの書体の下降分も差し引く。
  const metricsContext = document.createElement('canvas').getContext('2d')
  const firstBaseline = (element, excluded) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    let text
    while ((text = walker.nextNode())) {
      if (excluded?.contains(text) || !visible(text.parentElement)) continue
      const index = text.textContent.search(/\S/u)
      if (index < 0) continue
      const character = String.fromCodePoint(text.textContent.codePointAt(index))
      const range = document.createRange(); range.setStart(text, index); range.setEnd(text, index + character.length)
      const rect = range.getBoundingClientRect()
      if (!rect.width || !rect.height) continue
      const c = css(text.parentElement)
      metricsContext.font = `${c.fontStyle} ${c.fontWeight} ${c.fontSize} ${c.fontFamily}`
      const descent = metricsContext.measureText(character).fontBoundingBoxDescent
      return rect.bottom - descent
    }
    return null
  }
  for (const word of [...document.querySelectorAll('[data-notice-status-word]')].filter(visible)) {
    const notice = word.closest('[data-design-part="notice"]')
    if (!notice) continue
    const message = word.closest('[data-notice-heading]') || notice.querySelector('[data-notice-message]')
    const label = firstBaseline(word), body = message ? firstBaseline(message, word) : null
    if (label === null || body === null) { add('notice-status-line', word, { missing: 1 }, notice.textContent); continue }
    const delta = Math.abs(label - body)
    if (delta > 0.5) add('notice-status-line', word, { delta }, notice.textContent)
  }
  // 色点は、余白を持つ段落でも最初の文字の行の中央へ追従する。
  for (const notice of [...document.querySelectorAll('[data-design-part="notice"]')].filter(visible)) {
    const dot = notice.querySelector('[data-notice-dot]'), message = notice.querySelector('[data-notice-message]')
    if (dot && message && visible(dot)) {
      const baseline = firstBaseline(message), box = dot.getBoundingClientRect(), c = css(dot.parentElement)
      metricsContext.font = `${c.fontStyle} ${c.fontWeight} ${c.fontSize} ${c.fontFamily}`
      const strut = metricsContext.measureText('\u200b')
      const lineCenter = baseline === null ? null : baseline + (strut.fontBoundingBoxDescent - strut.fontBoundingBoxAscent) / 2
      if (lineCenter === null) add('notice-dot-line', dot, { missing: 1 }, notice.textContent)
      else if (Math.abs(box.top + box.height / 2 - lineCenter) > 1) add('notice-dot-line', dot, { delta: Math.abs(box.top + box.height / 2 - lineCenter) }, notice.textContent)
    }
    for (const button of [...notice.querySelectorAll('button')].filter(visible)) {
      if (button.hasAttribute('data-shared-button') || button.hasAttribute('data-notice-close') || button.hasAttribute('data-help-trigger') || button.querySelector('[data-help-mark]')) continue
      add('notice-native-button', button, { count: 1 }, button.textContent)
    }
  }
  return findings
}
