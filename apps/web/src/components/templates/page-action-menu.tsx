'use client'

import { cloneElement, useId, useRef, useState, type ReactElement, type MouseEvent } from 'react'
import type { ButtonProps } from '@/components/shared/button'
import { RowMenu, type RowMenuProps } from '@/components/shared/row-actions'
import type { ActionMenuItem } from '@/components/shared/action-menu'
import { actionLabel } from './page-action-nodes'

/** 移した操作も非同期の完了・失敗・無効条件を元のButtonで扱う。 */
export default function PageActionMenu({ buttons, menu, label }: { buttons: ReactElement<ButtonProps>[]; menu?: ReactElement<RowMenuProps>; label: string }) {
  const [localOpen, setLocalOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const inFlight = useRef<Promise<unknown> | null>(null)
  const anchor = useRef<HTMLSpanElement>(null)
  const id = useId()
  const changeOpen = (open: boolean) => { setLocalOpen(open); menu?.props.onOpenChange?.(open) }
  const focusAnchor = () => anchor.current?.querySelector<HTMLElement>('button[aria-haspopup="menu"]')?.focus({ preventScroll: true })
  const items: ActionMenuItem[] = buttons.filter(node => !node.props.hidden).map((node, index) => ({
    id: `${id}-${node.key ?? index}`, label: actionLabel(node.props.children),
    title: node.props.title,
    'aria-label': node.props['aria-label'],
    'aria-description': node.props['aria-description'],
    disabled: node.props.disabled,
    disabledReason: 'disabledReason' in node.props ? node.props.disabledReason ?? undefined : undefined,
    lockedReason: node.props.lockedReason ?? undefined,
    tone: /danger/.test(node.props.variant ?? '') || node.props.textTone === 'danger' ? 'danger' : undefined,
    content: cloneElement(node, {
      variant: 'text', textTone: /danger/.test(node.props.variant ?? '') || node.props.textTone === 'danger' ? 'danger' : 'ink', role: 'menuitem',
      busy: busy || ('busy' in node.props ? node.props.busy : undefined),
      onClick: (event: MouseEvent<HTMLButtonElement> & MouseEvent<HTMLAnchorElement>) => {
        if (inFlight.current) return inFlight.current
        const item = event.currentTarget
        // 窓を開く操作が、消えるメニュー項目を戻り先に覚えないよう、先に自分の開くボタンへ戻す。
        focusAnchor()
        const pending = node.props.onClick?.(event) as unknown
        if (event.defaultPrevented) { item.focus(); return pending }
        if (pending && typeof (pending as PromiseLike<unknown>).then === 'function') {
          setBusy(true)
          if (document.activeElement === anchor.current?.querySelector('button')) item.focus()
          // 失敗時は開いたままButtonのエラーを見せる。成功した時だけ閉じる。
          const operation = Promise.resolve(pending).then(() => { changeOpen(false) }).finally(() => {
            inFlight.current = null
            setBusy(false)
          })
          inFlight.current = operation
          return operation
        }
        changeOpen(false)
        return pending
      },
    }),
  }))
  return <span ref={anchor}><RowMenu {...menu?.props} label={menu?.props.label ?? label} items={[...(menu?.props.items ?? []), ...items]} open={menu?.props.open ?? localOpen} onOpenChange={changeOpen} /></span>
}
