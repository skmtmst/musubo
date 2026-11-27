export default function scanMenuColors() {
  const green = color => {
    const match = color.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/)
    if (!match) return false
    const [, r, g, b] = match.map(Number)
    return g > r * 1.2 && g > b * 1.1 && g > 30
  }
  return [...document.querySelectorAll('[role="menuitem"]')].flatMap(item =>
    [item, ...item.querySelectorAll('svg')].some(el => green(getComputedStyle(el).color)) ? [{ label: item.textContent?.trim() }] : [])
}
