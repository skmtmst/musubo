import React, { type ComponentProps } from 'react'
import { X } from 'lucide-react'
import IconButton from './icon-button'

/** 閉じる・外すの「×」。文字の「×」「✕」ではなく、SVG の印で描く共通のボタン。 */
export default function CloseButton({
  'aria-label': ariaLabel = '閉じる',
  size = 'small',
  ...props
}: Omit<ComponentProps<typeof IconButton>, 'children' | 'aria-label' | 'size' | 'variant'> & { 'aria-label'?: string; size?: ComponentProps<typeof IconButton>['size'] | 'standard' }) {
  return (
    <IconButton data-close-control="" aria-label={ariaLabel} size={size === 'standard' ? undefined : size} variant="plain" {...props}>
      <X aria-hidden="true" />
    </IconButton>
  )
}
