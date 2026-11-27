import type { GooglePost } from '@/lib/restaurant-google-api'
import type { StatusBadgeTone } from '@/components/shared/status-badge'
import { GOOGLE_POST_STATUS } from '@/lib/status-labels'
import { knownValue } from '@/lib/known-value'

/** 投稿の状態の札。言葉と色は言葉の表（lib/status-labels）にあり、ここでは引くだけ。 */
export function statusBadge(post: GooglePost): { label: string; tone: StatusBadgeTone } {
  return knownValue(GOOGLE_POST_STATUS, post.status, { label: '状態を確認できません', tone: 'neutral' })
}
