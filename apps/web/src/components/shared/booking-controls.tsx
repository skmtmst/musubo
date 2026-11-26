'use client'

import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import styles from './booking-controls.module.css'
import stateStyles from './booking-state.module.css'
import { bookingStateLabels, type BookingState } from './booking-state'

type ControlProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> & { children: ReactNode }

/** 行をまたぐ予約を開く操作。内容・予約元は呼び出し側が渡す。 */
export function BookingBlock({ tone = 'confirmed', state, placement, source, children, ...props }: ControlProps & { placement?: 'cell' | 'calendar' | 'month' | 'board' | 'timeline'; ref?: Ref<HTMLButtonElement>; source?: string; state?: BookingState; tone?: 'line' | 'media' | 'phone' | 'pending' | 'hold' | 'confirmed' | 'seated' | 'departed' | 'over' | 'warning' }) {
  const states: Record<string, BookingState> = { line: 'confirmed', media: 'confirmed', phone: 'confirmed', pending: 'pending', hold: 'hold', confirmed: 'confirmed', seated: 'active', departed: 'completed', over: 'attention', warning: 'warning' }
  return <button type="button" {...props} data-placement={placement} aria-description={[props['aria-description'] ?? bookingStateLabels[state ?? states[tone]], source === 'phone' ? '電話' : null].filter(Boolean).join('・')} data-booking-state={state ?? states[tone]} className={`${styles.block} ${stateStyles.surface}`}>{children}</button>
}

/** 空いている枠に予約を追加する。セルに指を乗せるかキーボードで選ぶと表示する。 */
export function BookingSlot({ children, placement, ...props }: ControlProps & { placement?: 'cell' | 'timeline' }) {
  return <button type="button" {...props} className={styles.slotAdd} data-placement={placement} data-booking-add>{children}</button>
}

/** 卓を選ぶ操作。埋まっている卓は選べず、選択状態も読み上げる。 */
export function TableChoice({ selected, unavailable, children, ...props }: ControlProps & { selected: boolean; unavailable: boolean }) {
  return <button type="button" {...props} aria-pressed={selected} disabled={unavailable || props.disabled} className={`${styles.phoneTable} ${unavailable ? styles.phoneTableTaken : selected ? styles.phoneTableChosen : ''}`}>{children}</button>
}
