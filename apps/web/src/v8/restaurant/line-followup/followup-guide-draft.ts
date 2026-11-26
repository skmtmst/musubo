import { readGuideDraft, writeGuideDraft } from '@/lib/scoped-guide-draft'
import { followupTimingError, rowVersionKey, type FollowupCardModel } from './board-model'

export type FollowupDraftContent = Pick<FollowupCardModel, 'timing' | 'bubbles'>
type FollowupGuideDraft = FollowupDraftContent & {
  phase: 'editing' | 'confirmed'
  version: string
}

const bubbleTypes = new Set([
  'text', 'sticker', 'image', 'flex', 'location', 'audio', 'carousel', 'rich_message',
  'rich_video', 'video', 'card_message', 'coupon', 'research',
])

export function readFollowupGuideDraft(key: string | null, row: FollowupCardModel): FollowupGuideDraft | null {
  const draft = readGuideDraft<FollowupGuideDraft>(key)
  if (!draft || draft.version !== rowVersionKey(row) || !['editing', 'confirmed'].includes(draft.phase)) return null
  const timing = draft.timing
  const editing = draft.phase === 'editing'
  if (!(timing?.mode === 'countdown' && (Number.isFinite(timing.offsetMinutes) || editing && timing.offsetMinutes === null))
    && !(timing?.mode === 'time' && (Number.isFinite(timing.offsetDays) || editing && timing.offsetDays === null) && typeof timing.sendAtTime === 'string')
    && !(timing?.mode === 'next_day' && typeof timing.sendAtTime === 'string')) return null
  if (!Array.isArray(draft.bubbles) || !draft.bubbles.every(bubble => bubble && typeof bubble.id === 'string'
    && bubbleTypes.has(bubble.type) && bubble.content && typeof bubble.content === 'object' && !Array.isArray(bubble.content))) return null
  if (!editing && (followupTimingError(row.trigger, timing) || !followupHasMessage(draft.bubbles))) return null
  // Number inputs store NaN for a blank field; JSON stores that intermediate value as null.
  if (timing.mode === 'countdown' && timing.offsetMinutes === null) return { ...draft, timing: { ...timing, offsetMinutes: NaN } }
  if (timing.mode === 'time' && timing.offsetDays === null) return { ...draft, timing: { ...timing, offsetDays: NaN } }
  return draft
}

export function followupHasMessage(bubbles: FollowupDraftContent['bubbles']): boolean {
  return bubbles.length > 0 && bubbles.every(bubble => bubble.type !== 'text' || Boolean(String(bubble.content.text ?? '').trim()))
}

export function saveFollowupGuideDraft(
  key: string | null, row: FollowupCardModel, phase: FollowupGuideDraft['phase'],
) {
  const { timing, bubbles } = row
  writeGuideDraft(key, { timing, bubbles, phase, version: rowVersionKey(row) })
}
