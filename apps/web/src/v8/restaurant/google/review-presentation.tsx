import type { GoogleReview } from '@/lib/restaurant-google-api'
import type { StatusBadgeTone } from '@/components/shared/status-badge'
import { GOOGLE_REPLY_STATUS } from '@/lib/status-labels'
import styles from './google.module.css'

/** 星（★の文字）。評価2以下は赤、ほかは金。非有限の評価は未確定として出す。 */
export function Stars({ rating, small = false }: { rating: number; small?: boolean }) {
  if (!Number.isFinite(rating)) {
    return (
      <span className={`${styles.stars} ${small ? styles.starsSmall : ''}`} aria-label="評価を確認できません" role="img">
        —
      </span>
    )
  }
  const safe = Math.max(0, Math.min(5, Math.round(rating)))
  return (
    <span className={`${styles.stars} ${safe <= 2 ? styles.starsLow : ''} ${small ? styles.starsSmall : ''}`} aria-label={`評価 ${safe}／5`} role="img">
      {'★'.repeat(safe) + '☆'.repeat(5 - safe)}
    </span>
  )
}

export function replyBadge(review: GoogleReview): { label: string; tone: StatusBadgeTone } {
  if (review.replyStatus === 'published') return GOOGLE_REPLY_STATUS.published
  if (review.replyStatus === 'replied' || review.replyStatus === 'pending_confirm') return GOOGLE_REPLY_STATUS.confirming
  if (review.replyStatus === 'draft') return review.replyDraftAiGenerated ? GOOGLE_REPLY_STATUS.aiDraft : GOOGLE_REPLY_STATUS.draft
  if (review.needsAttention) return GOOGLE_REPLY_STATUS.attention
  return GOOGLE_REPLY_STATUS.unreplied
}
