import { describe, expect, it } from 'vitest'
import type { GooglePost } from '@/lib/restaurant-google-api'
import { statusBadge } from './post-status'

describe('Google の投稿状態', () => {
  it.each(['constructor', 'toString', '__proto__', 'future'])('%s は確認できない状態を表示する', status => {
    expect(statusBadge({ status } as GooglePost)).toEqual({ label: '状態を確認できません', tone: 'neutral' })
  })
  it('公開済みの表示は保つ', () => {
    expect(statusBadge({ status: 'published' } as GooglePost)).toEqual({ label: '公開済み', tone: 'success' })
  })
})
