import type { ButtonHTMLAttributes } from 'react'
import Button from '@/components/shared/button'
import MediaThumbnail from '@/components/shared/media-thumbnail'
import TruncatedText from '@/components/shared/truncated-text'
import { ErrorCountBadge } from '@/components/shared/error-count-badge'
import styles from './carousel.module.css'

export default function CarouselOrderChip({ index, label, src, errorCount, onClick, ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'className'> & {
  index: number; label: string; src: string; errorCount: number; lockedReason?: string
}) {
  const cardNumber = Number.isFinite(index) && index >= 0 ? Math.floor(index) + 1 : 1
  const safeLabel = label.trim() || `カード${cardNumber}`
  const safeErrors = Number.isFinite(errorCount) && errorCount > 0 ? Math.floor(errorCount) : 0
  const handleClick: ButtonHTMLAttributes<HTMLButtonElement>['onClick'] = onClick
    ? (event) => {
      if (props.disabled || props.lockedReason) return
      onClick(event)
    }
    : undefined
  return <Button {...props} onClick={handleClick} type="button" className={styles.chip} aria-label={`${safeLabel}${safeErrors ? `（直す欄が${safeErrors}か所）` : ''}`}>
    <span className={styles.chipImage}><MediaThumbnail kind="image" size="compact" src={src} alt="" /></span>
    <span className={styles.chipTitle}><TruncatedText value={safeLabel} /></span>
    <ErrorCountBadge count={safeErrors} label={`カード${cardNumber}`} />
  </Button>
}
