/** 直接文字を持つ要素を実寸で調べる。許可判定は呼び出し側で行う。 */
export function scanInheritedFont() {
  const probe = document.createElement('i')
  probe.style.fontSize = 'var(--text-body)'
  document.body.append(probe)
  const base = parseFloat(getComputedStyle(probe).fontSize)
  probe.remove()
  if (!Number.isFinite(base)) throw new Error('--text-body を測れません')
  return [...document.querySelectorAll('main p,main span,main li,main div')].flatMap((element) => {
    if (element.closest('h1,h2,h3,h4,h5,h6,button,[role="button"],[role="heading"],[aria-hidden="true"],[hidden],.sr-only')) return []
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
    if (!rect.width || !rect.height || style.visibility === 'hidden' || parseFloat(style.fontSize) <= base) return []
    const text = [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent.trim()).join(' ').replace(/[\t\r\n]+/g, ' ')
    if (!text || /^[\d\s,¥￥.%+−\-—/:→]+(?:件|名|時間|分|通目)?$/.test(text)) return []
    return [{ node: element.closest('[data-design-node]')?.getAttribute('data-design-node') || '', tag: element.tagName, text, px: style.fontSize }]
  })
}
