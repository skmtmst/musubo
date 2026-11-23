export default function scanCloseButtons() {
  return [...document.querySelectorAll('[data-close-control]')].flatMap(button => {
    if (button.matches(':focus-visible, :hover')) return []
    const style = getComputedStyle(button)
    const visibleBorder = ['Top', 'Right', 'Bottom', 'Left'].some(side => parseFloat(style[`border${side}Width`]) > 0 && style[`border${side}Style`] !== 'none' && style[`border${side}Color`] !== 'rgba(0, 0, 0, 0)')
    const visibleOutline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== 'rgba(0, 0, 0, 0)'
    const background = style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent'
    return visibleBorder || visibleOutline || style.boxShadow !== 'none' || background ? [{ label: button.getAttribute('aria-label') }] : []
  })
}
