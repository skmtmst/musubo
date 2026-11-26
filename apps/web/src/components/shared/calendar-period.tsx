'use client'

import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from 'react'
import styles from './calendar-period.module.css'
import { motionEasing } from './overlay-utils'

const CalendarMotion = createContext(false)

/** 日付の順で移動方向を決める。再取得・表示方式の変更では動かさない。 */
export default function CalendarPeriod({ period, scope = '', bleed = true, children }: { period: string; scope?: string; bleed?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const previous = useRef({ period, scope })
  const nested = useContext(CalendarMotion)
  useLayoutEffect(() => {
    if (nested) return
    const before = previous.current
    if (!period && before.scope === scope) return
    previous.current = { period, scope }
    const node = ref.current
    if (!node || before.scope !== scope || before.period === period || !before.period || !period) return
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (preference.matches || typeof node.animate !== 'function') return
    const tokens = getComputedStyle(document.documentElement)
    const duration = Number.parseFloat(tokens.getPropertyValue('--motion-base'))
    if (!(duration > 0)) return
    const distance = tokens.getPropertyValue('--polish-space-card').trim() || '0px'
    const animation = node.animate([
      { transform: `translateX(${period > before.period ? distance : `calc(${distance} * -1)`})` },
      { transform: 'translateX(0)' },
    ], { duration, easing: motionEasing() })
    const stop = () => { if (preference.matches) animation.cancel() }
    preference.addEventListener('change', stop)
    return () => { animation.cancel(); preference.removeEventListener('change', stop) }
  }, [period, scope, nested])
  if (nested) return children
  return <CalendarMotion.Provider value><div className={styles.viewport} data-bleed={bleed}><div ref={ref}>{children}</div></div></CalendarMotion.Provider>
}
